/**
 * DCA executor: reads registered users from Supabase, executes ready schedules by sending
 * executeSwap from the relayer wallet, then deducts gas cost from user's GasTank.
 * Run on a schedule via server (dashboard) or once via: node dist/run-executor.js
 */
import "dotenv/config";
import { isSupabaseConfigured } from "./supabase/automation-users";
import { getDcaPlanMembers, recordPlanExecuted } from "./supabase/dca-plans-store";
import { getNonExecutableChainIds } from "./supabase/network-allocations";
import {
  getPlanAdminControlMap,
  planAdminControlKey,
  type PlanAdminControl,
} from "./supabase/plan-admin-controls";
import {
  getPlanExecutionGateMap,
  planExecutionGateKey,
  pruneExpiredPlanExecutionGates,
  type PlanExecutionGate,
} from "./supabase/plan-execution-gates";
import {
  clearPlanExecuting,
  markPlanExecuting,
} from "./plans/plan-execution-state";
import { recordRunGas } from "./gas-profile";
import { getRunPriceUsdc6, refreshRunPrices } from "./run-price";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Chain,
  encodeFunctionData,
} from "viem";
import { base, baseSepolia, bsc, polygon, sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { getVaultUsdcGasTank, getRpc, getGasCostPerExecutionUsdc6Fallback, getChainIdsWithGasTank, usesDirectSwapRouter, getSwapAdapter, CHAIN_NAMES } from "./config";

const ZERO_EX_BASE = "https://api.0x.org";

/** Coingecko asset IDs for native token price (USD). */
const COINGECKO_IDS: Record<number, string> = {
  8453: "ethereum",
  84532: "ethereum",
  11155111: "ethereum", // Ethereum Sepolia
  56: "binancecoin",
  // POL, not MATIC: CoinGecko retired "matic-network" after the token migration and it now
  // returns an empty object, which read as a 0 price for every Polygon run-cost estimate.
  137: "polygon-ecosystem-token",
  2222: "kava",
  // BOT Chain mainnet. CoinGecko's "bot" is the fallback leg of the mainnet BOT fetch
  // (getBotMainnetPriceUsd) — the BOT Chain DEX pool price is tried first. Testnet 968 is
  // pinned via STATIC_PRICE_USD, not fetched.
  677: "bot",
};

/**
 * Statically pinned native USD prices. BOT Chain testnet (968) tBOT is a faucet token with no
 * real market: a feed either has no quote or hands back mainnet BOT's number, a different token
 * at a different price. Pinning it keeps gas cost stable and unmistakably a testnet figure.
 */
const STATIC_PRICE_USD: Record<number, number> = {
  968: 130,
};

/**
 * BOT Chain mainnet (677) BOT price is fetched from two independent sources so a single outage
 * does not zero the quote (which would leave the GasTank undebited): the chain's own DEX pool
 * price for WBOT first, CoinGecko's "bot" ticker as the fallback. WBOT address on the price graph.
 */
const BOT_MAINNET_PRICE_TOKEN = "0xD5452816194a3784dBa983426cCe7c122F4abd30";

/** BOT Chain DEX pool price for WBOT, in USD. 0 on any failure so a fallback can take over. */
async function fetchBotDexPriceUsd(): Promise<number> {
  try {
    const res = await fetch(
      `https://dex-wallet.botchain.ai/api/graph/price?token=${BOT_MAINNET_PRICE_TOKEN}`
    );
    if (!res.ok) return 0;
    const json = (await res.json()) as { success?: boolean; data?: { price?: string } };
    if (!json.success) return 0;
    const usd = parseFloat(json.data?.price ?? "");
    return Number.isFinite(usd) && usd > 0 ? usd : 0;
  } catch {
    return 0;
  }
}

/** Manual native-token USD price per chain: NATIVE_PRICE_USD_<chainId>. Wins over CoinGecko. */
function getNativePriceOverride(chainId: number): number | null {
  const raw = process.env[`NATIVE_PRICE_USD_${chainId}`]?.trim();
  if (!raw) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const GAS_LIMIT_EXECUTE_SWAP = 400_000n;
const ESTIMATE_BUFFER_BPS = 15000; // 1.5x for balance check
const RECORD_BUFFER_BPS = 11000; // 1.1x when recording actual cost
const relayerNonceByChain = new Map<number, number>();

async function getNextRelayerNonce(
  chainId: number,
  publicClient: ReturnType<typeof createPublicClient>,
  address: `0x${string}`
): Promise<number> {
  const pendingNonce = await publicClient.getTransactionCount({
    address,
    blockTag: "pending",
  });
  const cachedNonce = relayerNonceByChain.get(chainId);
  const nextNonce = cachedNonce != null && cachedNonce > pendingNonce ? cachedNonce : pendingNonce;
  relayerNonceByChain.set(chainId, nextNonce + 1);
  return nextNonce;
}

/** CoinGecko price in USD for a single chain's native token. 0 on failure or when unlisted. */
async function fetchCoingeckoPriceUsd(chainId: number): Promise<number> {
  const id = COINGECKO_IDS[chainId];
  if (!id) return 0;
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd`
    );
    if (!res.ok) return 0;
    const data = (await res.json()) as Record<string, { usd?: number }>;
    return data[id]?.usd ?? 0;
  } catch {
    return 0;
  }
}

/** Mainnet BOT price: BOT Chain DEX pool first, CoinGecko as fallback. 0 if both fail. */
async function getBotMainnetPriceUsd(): Promise<number> {
  const dex = await fetchBotDexPriceUsd();
  if (dex > 0) return dex;
  return fetchCoingeckoPriceUsd(677);
}

/** Fetch native token price in USD. Cached per chain for the run. */
const nativePriceCache: Record<number, number> = {};
export async function getNativePriceUsd(chainId: number): Promise<number> {
  const override = getNativePriceOverride(chainId);
  if (override != null) return override;
  const staticUsd = STATIC_PRICE_USD[chainId];
  if (staticUsd != null) return staticUsd;
  if (nativePriceCache[chainId] != null) return nativePriceCache[chainId];
  const price = chainId === 677 ? await getBotMainnetPriceUsd() : await fetchCoingeckoPriceUsd(chainId);
  if (price > 0) nativePriceCache[chainId] = price;
  return price;
}

/** Pre-fill native price cache for multiple chains. CoinGecko chains batch into one request. */
async function prefetchNativePrices(chainIds: number[]): Promise<void> {
  // Pinned (testnet) chains never hit a feed; BOT mainnet uses its own DEX path, not the batch.
  const cgChains = chainIds.filter((cid) => cid !== 677 && STATIC_PRICE_USD[cid] == null);
  const ids = [...new Set(cgChains.map((cid) => COINGECKO_IDS[cid]).filter(Boolean))] as string[];
  if (ids.length > 0) {
    try {
      const res = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids.map((id) => encodeURIComponent(id)).join(",")}&vs_currencies=usd`
      );
      if (res.ok) {
        const data = (await res.json()) as Record<string, { usd?: number }>;
        for (const cid of cgChains) {
          const id = COINGECKO_IDS[cid];
          if (id && data[id]?.usd != null) nativePriceCache[cid] = data[id].usd!;
        }
      }
    } catch {
      // fallback: individual fetches already work via getNativePriceUsd
    }
  }
  // Warm BOT mainnet via its DEX-first path so the batch above never shadows it with a bare ticker.
  if (chainIds.includes(677) && nativePriceCache[677] == null) {
    const price = await getBotMainnetPriceUsd();
    if (price > 0) nativePriceCache[677] = price;
  }
}

/**
 * Compute gas cost in USDC (6 decimals) from gas used and gas price.
 * costUsd = (gasUsed * gasPriceWei) / 1e18 * nativePriceUsd; then * 1e6 for USDC, with buffer (bps).
 */
function gasCostToUsdc6(gasUsed: bigint, gasPriceWei: bigint, nativePriceUsd: number, bufferBps: number): bigint {
  if (nativePriceUsd <= 0) return 0n;
  const weiSpent = gasUsed * gasPriceWei;
  const usdScaled = (weiSpent * BigInt(Math.round(nativePriceUsd * 1e6)) * BigInt(bufferBps)) / (10n ** 18n) / 10000n;
  return usdScaled; // already in 6 decimals
}

export const DCA_VAULT_ABI = [
  { type: "function", name: "getActiveSchedules", inputs: [{ name: "user", type: "address" }], outputs: [{ type: "uint256[]" }], stateMutability: "view" },
  { type: "function", name: "getReadyScheduleIds", inputs: [{ name: "user", type: "address" }], outputs: [{ type: "uint256[]" }], stateMutability: "view" },
  { type: "function", name: "getEnrolledScheduleIds", inputs: [{ name: "user", type: "address" }], outputs: [{ type: "uint256[]" }], stateMutability: "view" },
  {
    type: "function",
    name: "getSchedule",
    inputs: [
      { name: "user", type: "address" },
      { name: "scheduleId", type: "uint256" },
    ],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "targetToken", type: "address" },
          { name: "frequency", type: "uint8" },
          { name: "amountPerInterval", type: "uint256" },
          { name: "lastExecutionTime", type: "uint256" },
          { name: "totalAmount", type: "uint256" },
          { name: "executedCount", type: "uint256" },
          { name: "active", type: "bool" },
        ],
      },
    ],
    stateMutability: "view",
  },
  { type: "function", name: "isScheduleReady", inputs: [{ name: "user", type: "address" }, { name: "scheduleId", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "feePercentage", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  {
    type: "event",
    name: "ScheduleCreated",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "scheduleId", type: "uint256", indexed: true },
      { name: "targetToken", type: "address", indexed: false },
      { name: "frequency", type: "uint8", indexed: false },
      { name: "amountPerInterval", type: "uint256", indexed: false },
    ],
  },
  {
    type: "function",
    name: "executeSwap",
    inputs: [
      { name: "user", type: "address" },
      { name: "scheduleId", type: "uint256" },
      { name: "swapData", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  { type: "function", name: "scheduleCount", inputs: [{ name: "user", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  {
    type: "event",
    name: "ScheduleExecuted",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "scheduleId", type: "uint256", indexed: true },
      { name: "targetToken", type: "address", indexed: false },
      { name: "usdcAmount", type: "uint256", indexed: false },
      { name: "tokenOut", type: "uint256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ScheduleCancelled",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "scheduleId", type: "uint256", indexed: true },
      { name: "returnedAmount", type: "uint256", indexed: false },
      { name: "cancelFee", type: "uint256", indexed: false },
    ],
  },
] as const;

const GAS_TANK_ABI = [
  { type: "function", name: "balanceOf", inputs: [{ name: "user", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "gasCostPerExecutionUsdc6", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  {
    type: "function",
    name: "recordExecution",
    inputs: [
      { name: "user", type: "address" },
      { name: "amountUsdc6", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

const kavaChain: Chain = {
  id: 2222,
  name: "Kava",
  nativeCurrency: { decimals: 18, name: "Kava", symbol: "KAVA" },
  rpcUrls: { default: { http: [process.env.RPC_URL_2222 ?? "https://evm.kava.io"] } },
};

/** BOT Chain mainnet (677). EVM, Parlia consensus (BSC-derived) — legacy gas pricing. */
const botChain: Chain = {
  id: 677,
  name: "BOT Chain",
  nativeCurrency: { decimals: 18, name: "BOT", symbol: "BOT" },
  rpcUrls: { default: { http: [process.env.RPC_URL_677 ?? "https://rpc.botchain.ai"] } },
  blockExplorers: { default: { name: "BOTScan", url: "https://scan.botchain.ai" } },
  contracts: { multicall3: { address: "0x47FA21f684bBAD707A53a0f9BE59F1422F46C265" } },
};

/** BOT Chain testnet (968). */
const botTestnet: Chain = {
  id: 968,
  name: "BOT Chain Testnet",
  nativeCurrency: { decimals: 18, name: "BOT", symbol: "tBOT" },
  rpcUrls: { default: { http: [process.env.RPC_URL_968 ?? "https://rpc.bohr.life"] } },
  blockExplorers: { default: { name: "BOTScan", url: "https://scan.bohr.life" } },
  contracts: { multicall3: { address: "0x47FA21f684bBAD707A53a0f9BE59F1422F46C265" } },
  testnet: true,
};

export function getChain(chainId: number): Chain | undefined {
  if (chainId === 8453) return base;
  if (chainId === 84532) return baseSepolia;
  if (chainId === 11155111) return sepolia;
  if (chainId === 56) return bsc;
  if (chainId === 137) return polygon;
  if (chainId === 2222) return kavaChain;
  if (chainId === 677) return botChain;
  if (chainId === 968) return botTestnet;
  return undefined;
}

/**
 * Chains to process: every chain with a DCAVault + GasTank in deployed-addresses.json.
 *
 * Which of those is actually in service is not decided here — network allocation subtracts the
 * paused and removed ones on each run (see runExecutor below). That is the only chain filter, on
 * purpose: a second, statically configured allow-list would have to be kept in step with the
 * allocation store by hand, and the copy that fell behind would silently drop a deployed chain.
 */
export function getAllowedChainIds(): Set<number> {
  return new Set(getChainIdsWithGasTank());
}

/**
 * Fetch executable swap calldata from 0x Swap API v2 (AllowanceHolder flow).
 *
 * v1 (`/swap/v1/quote`) is sunset and now 404s for every chain, which silently disabled swaps on
 * every 0x chain. v2 differs in three ways that matter here:
 *  - it requires `0x-version: v2` and a `taker`, and builds calldata bound to that taker. The
 *    caller of AllowanceHolder is the vault's swap adapter, so `taker` is the adapter address.
 *  - slippage is `slippageBps` (integer basis points), not v1's fractional `slippagePercentage`.
 *  - it reports "routable but no liquidity" as `liquidityAvailable: false` with a 200, so the
 *    status code alone is not enough to tell a usable quote from an empty one.
 */
async function get0xQuote(
  chainId: number,
  sellToken: string,
  buyToken: string,
  sellAmountWei: string,
  taker: string,
  apiKey?: string,
  slippageBps = 100
): Promise<string | null> {
  const params = new URLSearchParams({
    chainId: String(chainId),
    sellToken,
    buyToken,
    sellAmount: sellAmountWei,
    taker,
    slippageBps: String(slippageBps),
  });
  const url = `${ZERO_EX_BASE}/swap/allowance-holder/quote?${params}`;
  const headers: Record<string, string> = { Accept: "application/json", "0x-version": "v2" };
  if (apiKey) headers["0x-api-key"] = apiKey;
  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    liquidityAvailable?: boolean;
    transaction?: { to?: string; data?: string };
  };
  if (json.liquidityAvailable === false) return null;
  return json.transaction?.data ?? null;
}

function netAmountAfterFee(amount: bigint, feeBps: number): bigint {
  const fee = (amount * BigInt(feeBps)) / 10000n;
  return amount - fee;
}

/** Gas tank balance aggregated across all networks (CEX-style: one balance for any chain). Fetches all chains in parallel. */
async function getGlobalGasBalance(userAddress: string): Promise<{ globalBalance: bigint; byChain: Record<number, bigint> }> {
  const chainIds = getChainIdsWithGasTank();
  const results = await Promise.all(
    chainIds.map(async (cid): Promise<{ cid: number; bal: bigint }> => {
      const cfg = getVaultUsdcGasTank(cid);
      if (!cfg) return { cid, bal: 0n };
      const rpcUrl = getRpc(cid);
      const chain = getChain(cid);
      if (!rpcUrl || !chain) return { cid, bal: 0n };
      try {
        const client = createPublicClient({ chain, transport: http(rpcUrl) });
        const bal = (await client.readContract({
          address: cfg.gasTank as `0x${string}`,
          abi: GAS_TANK_ABI,
          functionName: "balanceOf",
          args: [userAddress as `0x${string}`],
        })) as bigint;
        return { cid, bal };
      } catch {
        return { cid, bal: 0n };
      }
    })
  );
  const byChain: Record<number, bigint> = {};
  let globalBalance = 0n;
  for (const { cid, bal } of results) {
    byChain[cid] = bal;
    globalBalance += bal;
  }
  return { globalBalance, byChain };
}

/** Pick chain to deduct gas cost from: prefer execution chain if enough balance, else chain with largest balance >= cost. */
function pickDeductChain(byChain: Record<number, bigint>, executionChainId: number, costUsdc6: bigint): number | null {
  if (byChain[executionChainId] != null && byChain[executionChainId] >= costUsdc6) return executionChainId;
  let best: number | null = null;
  let bestBal = 0n;
  for (const [cid, bal] of Object.entries(byChain)) {
    const chainId = parseInt(cid, 10);
    if (bal >= costUsdc6 && bal > bestBal) {
      best = chainId;
      bestBal = bal;
    }
  }
  return best;
}

export interface ExecutedTask {
  chainId: number;
  user: string;
  scheduleId: string;
  txHash: string;
  /** Optional detail for UI/history */
  targetToken?: string;
  amountPerIntervalUsdc6?: string;
  frequency?: number;
  gasUsed?: string;
  costUsdc6?: string;
  /** False when the swap ran but the GasTank deduction did not land — the run was effectively free. */
  gasDeducted?: boolean;
  /** Chain the gas was actually deducted on (may differ from the execution chain). */
  gasDeductChainId?: number;
}

export interface GasBalanceEntry {
  chainId: number;
  user: string;
  balanceUsdc6: string;
}

export interface PlanSnapshotEntry {
  member: string;
  scheduleIds: string[];
}

/** Total deposited (USDC 6d) per user per chain at run time, for portfolio history chart */
export interface PortfolioSnapshotEntry {
  user: string;
  chainId: number;
  valueUsdc6: string;
}

export interface ExecutorResult {
  ok: boolean;
  executed: number;
  executedTasks: string[];
  /** Structured for history storage */
  executedTasksDetail?: ExecutedTask[];
  errors?: string[];
  /** Gas tank balance per user after execution (for users we executed) */
  gasBalances?: GasBalanceEntry[];
  /** Active schedule IDs per member at time of run */
  planSnapshots?: PlanSnapshotEntry[];
  /** Total deposited per user per chain for portfolio value history */
  portfolioSnapshots?: PortfolioSnapshotEntry[];
}

/** Optional progress callback for live execution tracking (e.g. SSE in dashboard). */
export type ProgressCallback = (message: string) => void;

export interface RunExecutorOptions {
  /**
   * Explicit plans selected by an operator. When present, only these plans are
   * considered and enrollment is not required because this is a manual backend action.
   */
  targets?: Array<{
    chainId: number;
    userAddress: string;
    scheduleId: string;
  }>;
}


/**
 * Resolve the `${chainId}:${user}` member list to process, from the DB only: everyone with a
 * recorded plan, unioned with the automation registry. Shared by the executor and the plans reader
 * so both see the same set.
 *
 * This deliberately never falls back to on-chain ScheduleCreated discovery. That fallback scanned
 * ~1500 block ranges per chain on every read (minutes of work, frequently rate-limited) to
 * rediscover members the DB already knows, because it triggered whenever the registry was empty.
 * Plans are now recorded at creation, so the DB is the source of truth. To recover members for
 * plans created outside that path, run the manual backfill: POST /api/plans/reindex.
 */
export async function resolveMembers(
  allowedChains: Set<number>,
  log: ProgressCallback = () => {},
): Promise<string[]> {
  if (!isSupabaseConfigured()) {
    log("Supabase not configured — no member registry available. Set SUPABASE_DB_URL.");
    return [];
  }
  try {
    log("Reading members from the database (dca_plans + automation_users)…");
    const startedAt = Date.now();
    const members = await getDcaPlanMembers([...allowedChains]);
    log(`Database returned ${members.length} member(s) in ${Date.now() - startedAt}ms`);
    if (members.length === 0) {
      log("No members recorded yet. New plans register themselves on creation; for plans created earlier, run POST /api/plans/reindex to backfill.");
    }
    return members;
  } catch (e) {
    // Surface the failure rather than silently burning minutes on a block scan.
    log(`Member read from database failed: ${(e as Error).message}`);
    return [];
  }
}

/** Run DCA execution once. Throws on missing env or KV failure. Use from server or CLI. */
export async function runExecutor(onProgress?: ProgressCallback, options?: RunExecutorOptions): Promise<ExecutorResult> {
  const log = (msg: string) => {
    onProgress?.(msg);
  };

  const pk = process.env.RELAYER_PRIVATE_KEY;
  if (!pk) {
    throw new Error("Missing RELAYER_PRIVATE_KEY");
  }

  log("[Run started] Processing all networks — each registered chain:user will be checked for ready schedules.");
  const requestedTargets = options?.targets?.filter(
    (target) =>
      Number.isInteger(target.chainId) &&
      target.chainId > 0 &&
      /^0x[a-fA-F0-9]{40}$/.test(target.userAddress) &&
      /^\d+$/.test(target.scheduleId),
  );
  if (
    options?.targets &&
    requestedTargets?.length !== options.targets.length
  ) {
    throw new Error("Invalid targeted execution request");
  }
  const isTargetedRun = Boolean(options?.targets?.length);
  // A scheduled run scans every deployed chain; only an operator's targeted run narrows that, and
  // only to the plans they picked. There is deliberately no configured allow-list in between:
  // network allocation is the one place a chain is taken out of service, and a static list that
  // predated a deployment used to leave BOT Chain's plans enrolled but never scanned.
  const allowedChains = isTargetedRun
    ? new Set(requestedTargets!.map((target) => target.chainId))
    : getAllowedChainIds();
  const chainSource = isTargetedRun ? "targeted run" : "deployed chains with a GasTank";

  // Network allocation is applied last and only ever subtracts, so pausing or removing a network
  // holds against both sources above — including an operator's targeted run. A pause that either
  // could override would not be a pause.
  //
  // A failed read aborts the run rather than proceeding on the unfiltered set, for the same reason
  // admin plan holds do below: executing on a network an operator has just taken out of service
  // cannot be undone, while a skipped run is picked up by the next tick.
  try {
    const excluded = await getNonExecutableChainIds();
    const blocked = [...allowedChains].filter((cid) => excluded.has(cid));
    if (blocked.length > 0) {
      blocked.forEach((cid) => allowedChains.delete(cid));
      log(
        `Networks not in service, skipped: ${blocked
          .sort((a, b) => a - b)
          .map((cid) => `${CHAIN_NAMES[cid] ?? cid} (${cid})`)
          .join(", ")}`,
      );
    }
  } catch (e) {
    const message = `Network allocation could not be read: ${(e as Error).message}. Aborting the run so no paused or removed network is executed on.`;
    log(message);
    return { ok: false, executed: 0, executedTasks: [], errors: [message] };
  }

  if (allowedChains.size === 0) {
    const message = "No network is currently in service for execution.";
    log(message);
    return { ok: true, executed: 0, executedTasks: [], errors: [] };
  }
  log(`Allowed chains for execution: ${[...allowedChains].sort((a, b) => a - b).join(", ")} (from ${chainSource})`);
  Object.keys(nativePriceCache).forEach((k) => delete nativePriceCache[Number(k)]);
  const members = isTargetedRun
    ? [
        ...new Set(
          requestedTargets!.map(
            (target) => `${target.chainId}:${target.userAddress.toLowerCase()}`,
          ),
        ),
      ]
    : await resolveMembers(allowedChains, log);
  log(`Registered members: ${members.length}`);

  // Admin holds are read once per run rather than per plan. A hold is an explicit instruction not
  // to touch someone's plan, so a failed read aborts the run instead of proceeding without it:
  // executing a paused plan cannot be undone, whereas a skipped run is picked up by the next tick.
  // This matches the rest of the executor, which already does nothing when the database is down.
  let adminControls: Map<string, PlanAdminControl>;
  try {
    adminControls = isSupabaseConfigured()
      ? await getPlanAdminControlMap([...allowedChains])
      : new Map();
    if (adminControls.size > 0) {
      log(`Admin holds in force: ${adminControls.size} plan(s) will not be auto-executed.`);
    }
  } catch (e) {
    const message = `Admin plan holds could not be read: ${(e as Error).message}. Aborting the run so no held plan is executed.`;
    log(message);
    return { ok: false, executed: 0, executedTasks: [], errors: [message] };
  }

  // Resume gates: the wait a plan still owed when it was paused, being served now that it has been
  // resumed. Read and treated exactly like a hold — a failed read aborts the run, because executing
  // a plan whose countdown has not finished cannot be undone and the next tick will pick it up.
  let executionGates: Map<string, PlanExecutionGate>;
  try {
    if (isSupabaseConfigured()) {
      await pruneExpiredPlanExecutionGates().catch(() => undefined);
      executionGates = await getPlanExecutionGateMap([...allowedChains]);
    } else {
      executionGates = new Map();
    }
    if (executionGates.size > 0) {
      log(
        `Resumed plans still finishing their paused countdown: ${executionGates.size} plan(s) will not be auto-executed yet.`,
      );
    }
  } catch (e) {
    const message = `Plan resume gates could not be read: ${(e as Error).message}. Aborting the run so no plan is executed before its countdown finishes.`;
    log(message);
    return { ok: false, executed: 0, executedTasks: [], errors: [message] };
  }

  const account = privateKeyToAccount(pk as `0x${string}`);
  const zeroExKey = process.env.ZERO_EX_API_KEY;
  const gasCostFallbackUsdc6 = getGasCostPerExecutionUsdc6Fallback();
  const executed: string[] = [];
  const executedTasksDetail: ExecutedTask[] = [];
  const gasBalances: GasBalanceEntry[] = [];
  const planSnapshots: PlanSnapshotEntry[] = [];
  const portfolioSnapshots: PortfolioSnapshotEntry[] = [];
  const errors: string[] = [];

  // Pre-fetch native token prices for all allowed chains in one Coingecko request
  await prefetchNativePrices([...allowedChains]);
  // Load the operator's per-chain run prices once for the whole sweep: every lookup below is
  // synchronous, and a price edited mid-sweep must not charge two users in the same run
  // differently. A failure here leaves the last known prices in place (see run-price.ts).
  await refreshRunPrices().catch(() => undefined);
  const gasPriceCache: Record<number, bigint> = {};

  for (const member of members) {
    const [chainIdStr, userAddress] = member.split(":");
    const chainId = parseInt(chainIdStr, 10);
    if (!userAddress || isNaN(chainId)) continue;
    if (!allowedChains.has(chainId)) continue;

    log(`  [${member}] Processing…`);
    const cfg = getVaultUsdcGasTank(chainId);
    if (!cfg) {
      errors.push(`No vault/GasTank config for chain ${chainId} (deploy GasTank and set in backend deployed-addresses.json)`);
      log(`  [${member}] Skip: no vault/GasTank config`);
      continue;
    }

    const rpcUrl = getRpc(chainId);
    const chain = getChain(chainId);
    if (!rpcUrl || !chain) {
      errors.push(`No RPC or chain for ${chainId}`);
      log(`  [${member}] Skip: no RPC/chain`);
      continue;
    }

    const transport = http(rpcUrl);
    const publicClient = createPublicClient({ chain, transport });
    const walletClient = createWalletClient({ account, chain, transport });

    const vault = cfg.vault as `0x${string}`;
    const user = userAddress as `0x${string}`;
    const gasTankAddr = cfg.gasTank as `0x${string}`;

    // Prefer on-chain gas cost per execution (editable by owner) when set
    let gasCostPerExecutionFromContract = 0n;
    try {
      gasCostPerExecutionFromContract = (await publicClient.readContract({
        address: gasTankAddr,
        abi: GAS_TANK_ABI,
        functionName: "gasCostPerExecutionUsdc6",
        args: [],
      })) as bigint;
    } catch {
      // ignore; will fall back to env or gas-price derived
    }

    // Global gas tank balance (CEX-style: top-up on any network, use on any chain)
    let globalGas: { globalBalance: bigint; byChain: Record<number, bigint> };
    try {
      globalGas = await getGlobalGasBalance(userAddress);
    } catch (e) {
      errors.push(`Global gas balance ${member}: ${(e as Error).message}`);
      log(`  [${member}] Skip: global gas balance failed`);
      continue;
    }

    let gasPriceWei = 0n;
    let nativePriceUsd = 0;
    /**
     * The operator's price for this chain, set from the dashboard (backend/src/run-price.ts).
     * It outranks the contract because it is the same number the frontend quotes — both read it
     * from here — whereas `gasCostPerExecutionUsdc6` can only be changed by an owner transaction
     * per network. When none is set this is null and the contract's price stands, unchanged.
     */
    const manualCostUsdc6 = getRunPriceUsdc6(chainId);
    // Operator price first, then the contract price the tank was funded against. Env is only a
    // fallback for a GasTank whose price was never set.
    let estimatedCostUsdc6 = 0n;
    if (manualCostUsdc6 != null && manualCostUsdc6 > 0n) {
      estimatedCostUsdc6 = manualCostUsdc6;
    } else if (gasCostPerExecutionFromContract > 0n) {
      estimatedCostUsdc6 = gasCostPerExecutionFromContract;
    } else if (gasCostFallbackUsdc6 != null && gasCostFallbackUsdc6 > 0n) {
      estimatedCostUsdc6 = gasCostFallbackUsdc6;
    } else {
      try {
        if (gasPriceCache[chainId] === undefined) {
          gasPriceCache[chainId] = await publicClient.getGasPrice();
        }
        gasPriceWei = gasPriceCache[chainId];
        nativePriceUsd = await getNativePriceUsd(chainId);
        if (nativePriceUsd > 0) {
          estimatedCostUsdc6 = gasCostToUsdc6(GAS_LIMIT_EXECUTE_SWAP, gasPriceWei, nativePriceUsd, ESTIMATE_BUFFER_BPS);
        } else {
          errors.push(`Native price unavailable for chain ${chainId}, skipping`);
          log(`  [${member}] Skip: native price unavailable`);
          continue;
        }
      } catch (e) {
        errors.push(`Gas price / native price ${chainId}: ${(e as Error).message}`);
        log(`  [${member}] Skip: ${(e as Error).message}`);
        continue;
      }
    }

    let activeScheduleIds: bigint[];
    try {
      activeScheduleIds = (await publicClient.readContract({
        address: vault,
        abi: DCA_VAULT_ABI,
        functionName: "getActiveSchedules",
        args: [user],
      })) as bigint[];
    } catch (e) {
      errors.push(`getActiveSchedules ${member}: ${(e as Error).message}`);
      continue;
    }
    planSnapshots.push({ member, scheduleIds: activeScheduleIds.map((id) => id.toString()) });

    const memberTargets = isTargetedRun
      ? requestedTargets!.filter(
          (target) =>
            target.chainId === chainId &&
            target.userAddress.toLowerCase() === userAddress.toLowerCase(),
        )
      : [];
    const requestedScheduleIds = new Set(
      memberTargets.map((target) => target.scheduleId),
    );
    if (isTargetedRun) {
      const activeSet = new Set(activeScheduleIds.map((id) => id.toString()));
      for (const requestedId of requestedScheduleIds) {
        if (!activeSet.has(requestedId)) {
          errors.push(`Schedule ${member} scheduleId=${requestedId} is not active`);
          log(`  [${member}] Schedule ${requestedId}: skip (not active)`);
        }
      }
    }

    // Portfolio value = sum over schedules (totalAmount + amountPerInterval * executedCount); fetch all schedules in parallel
    let userTotalDeposited = 0n;
    if (activeScheduleIds.length > 0) {
      const scheduleResults = await Promise.all(
        activeScheduleIds.map((scheduleId) =>
          publicClient
            .readContract({
              address: vault,
              abi: DCA_VAULT_ABI,
              functionName: "getSchedule",
              args: [user, scheduleId],
            })
            .then((s) => s as { totalAmount: bigint; amountPerInterval: bigint; executedCount: bigint })
            .catch(() => null)
        )
      );
      for (const schedule of scheduleResults) {
        if (schedule) userTotalDeposited += schedule.totalAmount + schedule.amountPerInterval * schedule.executedCount;
      }
    }
    if (userTotalDeposited > 0n) {
      portfolioSnapshots.push({ user: userAddress, chainId, valueUsdc6: userTotalDeposited.toString() });
    }

    // Fetch only schedule IDs that are ready to execute (avoids per-schedule isScheduleReady calls)
    let readyScheduleIds: bigint[];
    try {
      readyScheduleIds = (await publicClient.readContract({
        address: vault,
        abi: DCA_VAULT_ABI,
        functionName: "getReadyScheduleIds",
        args: [user],
      })) as bigint[];
    } catch {
      // Fallback for vaults not yet upgraded: filter active schedules by isScheduleReady
      readyScheduleIds = [];
      for (const scheduleId of activeScheduleIds) {
        try {
          const ready = (await publicClient.readContract({
            address: vault,
            abi: DCA_VAULT_ABI,
            functionName: "isScheduleReady",
            args: [user, scheduleId],
          })) as boolean;
          if (ready) readyScheduleIds.push(scheduleId);
        } catch {
          // skip
        }
      }
    }

    if (isTargetedRun) {
      const readySet = new Set(readyScheduleIds.map((id) => id.toString()));
      for (const requestedId of requestedScheduleIds) {
        if (
          activeScheduleIds.some((id) => id.toString() === requestedId) &&
          !readySet.has(requestedId)
        ) {
          errors.push(`Schedule ${member} scheduleId=${requestedId} is not ready`);
          log(`  [${member}] Schedule ${requestedId}: skip (cooldown not finished)`);
        }
      }
      readyScheduleIds = readyScheduleIds.filter((id) =>
        requestedScheduleIds.has(id.toString()),
      );
    }

    // Drop any plan an admin has put on hold. This runs on the targeted path too: an operator who
    // paused a plan and then clicked Execute on it is contradicting themselves, and the explicit
    // error tells them to resume it first rather than silently overriding the hold.
    if (adminControls.size > 0) {
      readyScheduleIds = readyScheduleIds.filter((scheduleId) => {
        const hold = adminControls.get(
          planAdminControlKey(chainId, userAddress, scheduleId),
        );
        if (!hold) return true;
        const detail = hold.reason ? ` — ${hold.reason}` : "";
        if (isTargetedRun) {
          errors.push(
            `Schedule ${member} scheduleId=${scheduleId} is ${hold.status} by an admin${detail}`,
          );
        }
        log(
          `  [${member}] Schedule ${scheduleId}: skip (${hold.status} by admin${detail})`,
        );
        return false;
      });
    }

    // Drop any plan that was resumed with time still on its clock. The contract has long since
    // stopped counting — its cooldown ran throughout the pause — so this is the only thing standing
    // between "resume" and "buys immediately". Targeted runs are filtered too, for the same reason
    // holds are: an operator resuming a plan and then executing it by hand would skip the wait the
    // resume just promised the user.
    if (executionGates.size > 0) {
      const nowMs = Date.now();
      readyScheduleIds = readyScheduleIds.filter((scheduleId) => {
        const gate = executionGates.get(
          planExecutionGateKey(chainId, userAddress, scheduleId),
        );
        if (!gate || gate.notBefore.getTime() <= nowMs) return true;
        const seconds = Math.ceil((gate.notBefore.getTime() - nowMs) / 1000);
        if (isTargetedRun) {
          errors.push(
            `Schedule ${member} scheduleId=${scheduleId} was resumed with ${seconds}s still to wait`,
          );
        }
        log(
          `  [${member}] Schedule ${scheduleId}: skip (resumed from a pause, ${seconds}s of its countdown left)`,
        );
        return false;
      });
    }

    // Only auto-execute schedules that are enrolled for auto-execution (one free per user per network; extra require fee)
    if (!isTargetedRun) {
      let enrolledScheduleIds: bigint[] = [];
      try {
        enrolledScheduleIds = (await publicClient.readContract({
          address: vault,
          abi: DCA_VAULT_ABI,
          functionName: "getEnrolledScheduleIds",
          args: [user],
        })) as bigint[];
      } catch {
        // Old vault without getEnrolledScheduleIds: do not auto-execute any (safe default)
      }
      const enrolledSet = new Set(enrolledScheduleIds.map((id) => id.toString()));
      readyScheduleIds = readyScheduleIds.filter((id) => enrolledSet.has(id.toString()));
    }

    let feeBps = 25;
    try {
      feeBps = Number(await publicClient.readContract({
        address: vault,
        abi: DCA_VAULT_ABI,
        functionName: "feePercentage",
      }));
    } catch {
      // use default
    }

    type PendingItem = {
      scheduleId: bigint;
      targetToken: string;
      amountPerInterval: bigint;
      frequency: number;
      executeSwapData: `0x${string}`;
    };
    const pendingItems: PendingItem[] = [];
    for (const scheduleId of readyScheduleIds) {
      let targetToken: `0x${string}` = "0x0000000000000000000000000000000000000000" as `0x${string}`;
      let amountPerInterval = 0n;
      let frequency = 0;
      try {
        const schedule = (await publicClient.readContract({
          address: vault,
          abi: DCA_VAULT_ABI,
          functionName: "getSchedule",
          args: [user, scheduleId],
        })) as { targetToken: `0x${string}`; amountPerInterval: bigint; frequency: number };
        targetToken = schedule.targetToken;
        amountPerInterval = schedule.amountPerInterval;
        frequency = Number(schedule.frequency ?? 0);
      } catch (e) {
        errors.push(`getSchedule ${member} ${scheduleId}: ${(e as Error).message}`);
        continue;
      }
      if (globalGas.globalBalance < estimatedCostUsdc6) {
        errors.push(`Insufficient gas tank (global) ${member} scheduleId=${scheduleId}`);
        log(`  [${member}] Schedule ${scheduleId}: skip (insufficient gas tank)`);
        continue;
      }
      const netAmount = netAmountAfterFee(amountPerInterval, feeBps);
      let swapData: string | null = null;
      // Chains without a 0x deployment (Sepolia mocks, BOT Chain's BDEX adapter) route
      // on-chain: empty swapData makes DCAVault call ISwapRouter.swap directly.
      if (usesDirectSwapRouter(chainId)) {
        swapData = "0x";
      } else {
        // 0x v2 binds calldata to a taker, and the contract that calls AllowanceHolder is the
        // vault's adapter. Without it the quote would be built for the wrong caller and revert.
        const adapter = getSwapAdapter(chainId);
        if (!adapter) {
          errors.push(`No swap adapter for chain ${chainId} ${member} scheduleId=${scheduleId}`);
          continue;
        }
        swapData = await get0xQuote(chainId, cfg.usdc, targetToken, netAmount.toString(), adapter, zeroExKey);
      }
      if (swapData === null) {
        errors.push(`0x quote failed ${member} ${scheduleId}`);
        continue;
      }
      pendingItems.push({
        scheduleId,
        targetToken: targetToken as string,
        amountPerInterval,
        frequency,
        executeSwapData: encodeFunctionData({
          abi: DCA_VAULT_ABI,
          functionName: "executeSwap",
          args: [user, scheduleId, swapData as `0x${string}`],
        }),
      });
    }

    if (pendingItems.length === 0) continue;

    // Submit executeSwap transactions sequentially and wait for each receipt before sending the next.
    // This avoids "replacement transaction underpriced" when multiple plans are ready on the same chain
    // (parallel sends can use the same nonce; sequential + wait ensures each tx gets a fresh nonce).
    try {
      log(`  [${member}] Executing ${pendingItems.length} schedule(s) sequentially…`);
      for (const item of pendingItems) {
        markPlanExecuting(
          chainId,
          userAddress,
          item.scheduleId,
          isTargetedRun ? "manual" : "auto",
        );
        try {
        // Pre-flight the gas deduction BEFORE swapping. executeSwap is irreversible, so if the
        // GasTank cannot be charged (executor unset, insufficient balance, etc.) we skip the
        // schedule rather than perform the swap for free — "no chargeable tank, no execution".
        // Uses the pre-swap cost estimate and the same pickDeductChain the real charge below uses;
        // the post-swap block still recomputes and settles the exact cost.
        {
          const preflightChainId = pickDeductChain(globalGas.byChain, chainId, estimatedCostUsdc6);
          if (preflightChainId == null) {
            errors.push(`Insufficient gas tank (preflight) ${member} scheduleId=${item.scheduleId}`);
            log(`  [${member}] Schedule ${item.scheduleId}: skip (insufficient gas tank, preflight)`);
            continue;
          }
          const cfgPre = getVaultUsdcGasTank(preflightChainId);
          const gasTankPre = cfgPre?.gasTank as `0x${string}` | undefined;
          if (!cfgPre || !gasTankPre) {
            errors.push(`Missing GasTank config for preflight deduct chain ${preflightChainId}`);
            continue;
          }
          const rpcPre = preflightChainId === chainId ? rpcUrl : getRpc(preflightChainId);
          const chainPre = preflightChainId === chainId ? chain : getChain(preflightChainId);
          if (!rpcPre || !chainPre) {
            errors.push(`No RPC/chain for preflight deduct chain ${preflightChainId}`);
            continue;
          }
          const publicClientPre =
            preflightChainId === chainId
              ? publicClient
              : createPublicClient({ chain: chainPre, transport: http(rpcPre) });
          try {
            await publicClientPre.simulateContract({
              account,
              address: gasTankPre,
              abi: GAS_TANK_ABI,
              functionName: "recordExecution",
              args: [user, estimatedCostUsdc6],
            });
          } catch (e) {
            const reason = (e as Error).message ?? String(e);
            const hint = /OnlyExecutor/i.test(reason)
              ? ` — the relayer ${account.address} is not the GasTank executor on chain ${preflightChainId}; run scripts/set-gastank-executor.js`
              : "";
            errors.push(
              `Skipping swap: gas tank not chargeable (preflight) on chain ${preflightChainId} ${member} scheduleId=${item.scheduleId}: ${reason}${hint}`
            );
            log(`  [${member}] Schedule ${item.scheduleId}: skip — gas deduction would fail (preflight)${hint}`);
            continue;
          }
        }

        let hash: `0x${string}`;
        let receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>;
        try {
          const nonce = await getNextRelayerNonce(chainId, publicClient, account.address);
          hash = await walletClient.sendTransaction({
            to: vault,
            data: item.executeSwapData,
            gas: GAS_LIMIT_EXECUTE_SWAP,
            nonce,
          });
          log(`  [${member}] Submitted scheduleId=${item.scheduleId} tx=${hash}`);
          receipt = await publicClient.waitForTransactionReceipt({ hash });
        } catch (e) {
          errors.push(`executeSwap ${member} scheduleId=${item.scheduleId}: ${(e as Error).message}`);
          log(`  [${member}] Schedule ${item.scheduleId}: ${(e as Error).message}`);
          continue;
        }
        if (receipt.status !== "success") {
          errors.push(`executeSwap reverted ${member} scheduleId=${item.scheduleId} tx=${hash}`);
          log(`  [${member}] Schedule ${item.scheduleId}: reverted tx=${hash}`);
          continue;
        }
        log(`  [${member}] Schedule ${item.scheduleId}: confirmed tx=${hash}`);
        executed.push(`${member} scheduleId=${item.scheduleId} tx=${hash}`);

        // Same precedence as the estimate above — deducting a different number than the user
        // was quoted is what let a fully funded plan drain its tank early.
        let costToRecordUsdc6: bigint;
        if (manualCostUsdc6 != null && manualCostUsdc6 > 0n) {
          costToRecordUsdc6 = manualCostUsdc6;
        } else if (gasCostPerExecutionFromContract > 0n) {
          costToRecordUsdc6 = gasCostPerExecutionFromContract;
        } else if (gasCostFallbackUsdc6 != null && gasCostFallbackUsdc6 > 0n) {
          costToRecordUsdc6 = gasCostFallbackUsdc6;
        } else {
          costToRecordUsdc6 = gasCostToUsdc6(
            receipt.gasUsed,
            receipt.effectiveGasPrice ?? gasPriceWei,
            nativePriceUsd,
            RECORD_BUFFER_BPS
          );
        }

        const deductChainId = pickDeductChain(globalGas.byChain, chainId, costToRecordUsdc6);
        if (deductChainId == null) {
          errors.push(`No chain with enough gas balance to deduct ${costToRecordUsdc6} ${member} scheduleId=${item.scheduleId}`);
          continue;
        }
        const cfgDeduct = getVaultUsdcGasTank(deductChainId);
        const gasTankDeduct = cfgDeduct?.gasTank as `0x${string}` | undefined;
        if (!cfgDeduct || !gasTankDeduct) {
          errors.push(`Missing GasTank config for deduct chain ${deductChainId}`);
          continue;
        }
        const recordData = encodeFunctionData({
          abi: GAS_TANK_ABI,
          functionName: "recordExecution",
          args: [user, costToRecordUsdc6],
        });

        // Deduct, then confirm it. This used to be fire-and-forget with a hardcoded gas limit:
        // the fixed gas skipped estimation (which would have surfaced the revert) and nothing
        // waited for the receipt, so a GasTank whose executor was never set reverted every
        // deduction while the run reported full success and the tank never moved. Simulate to
        // fail fast with the real revert reason, then wait for the receipt before believing it.
        let deductOk = false;
        /** Gas the deduction burned, for the run-cost profile. Null unless it actually landed. */
        let recordGasUsed: bigint | null = null;
        {
          const rpcDeduct = deductChainId === chainId ? rpcUrl : getRpc(deductChainId);
          const chainDeduct = deductChainId === chainId ? chain : getChain(deductChainId);
          if (!rpcDeduct || !chainDeduct) {
            errors.push(`No RPC/chain for deduct chain ${deductChainId}`);
            continue;
          }
          const publicClientDeduct =
            deductChainId === chainId
              ? publicClient
              : createPublicClient({ chain: chainDeduct, transport: http(rpcDeduct) });
          const walletDeduct =
            deductChainId === chainId
              ? walletClient
              : createWalletClient({ account, chain: chainDeduct, transport: http(rpcDeduct) });

          try {
            await publicClientDeduct.simulateContract({
              account,
              address: gasTankDeduct,
              abi: GAS_TANK_ABI,
              functionName: "recordExecution",
              args: [user, costToRecordUsdc6],
            });
          } catch (e) {
            const reason = (e as Error).message ?? String(e);
            const hint = /OnlyExecutor/i.test(reason)
              ? ` — the relayer ${account.address} is not the GasTank executor on chain ${deductChainId}; run scripts/set-gastank-executor.js`
              : "";
            errors.push(
              `recordExecution would revert on chain ${deductChainId} ${member} scheduleId=${item.scheduleId}: ${reason}${hint}`
            );
            log(`  [${member}] Gas deduction FAILED (simulate) on chain ${deductChainId}${hint}`);
          }

          try {
            const recordNonce = await getNextRelayerNonce(deductChainId, publicClientDeduct, account.address);
            const recordHash = await walletDeduct.sendTransaction({
              to: gasTankDeduct,
              data: recordData,
              gas: 100_000n,
              nonce: recordNonce,
            });
            const recordReceipt = await publicClientDeduct.waitForTransactionReceipt({ hash: recordHash });
            if (recordReceipt.status === "success") {
              deductOk = true;
              recordGasUsed = recordReceipt.gasUsed;
              log(`  [${member}] Gas deducted ${costToRecordUsdc6} on chain ${deductChainId} tx=${recordHash}`);
            } else {
              errors.push(
                `recordExecution reverted on chain ${deductChainId} ${member} scheduleId=${item.scheduleId} tx=${recordHash}`
              );
              log(`  [${member}] Gas deduction REVERTED on chain ${deductChainId} tx=${recordHash}`);
            }
          } catch (e) {
            errors.push(
              `recordExecution send failed on chain ${deductChainId} ${member} scheduleId=${item.scheduleId}: ${(e as Error).message}`
            );
            log(`  [${member}] Gas deduction send failed on chain ${deductChainId}: ${(e as Error).message}`);
          }
        }

        // Only draw down the in-memory balance when the chain actually took the money. Decrementing
        // on a failed deduction made every later schedule in the sweep reason about a balance the
        // tank never had.
        if (deductOk) {
          globalGas.byChain[deductChainId] -= costToRecordUsdc6;
          globalGas.globalBalance -= costToRecordUsdc6;
        }

        // Teach the run-cost quote what a run on this chain really burns (see gas-profile.ts).
        // Only same-chain runs are samples: the quote multiplies these units by one chain's gas
        // price, so a total spanning two chains would be priced with the wrong one.
        if (deductChainId === chainId) {
          recordRunGas(chainId, receipt.gasUsed, recordGasUsed);
        }

        executedTasksDetail.push({
          chainId,
          user: userAddress,
          scheduleId: item.scheduleId.toString(),
          txHash: hash,
          targetToken: item.targetToken,
          amountPerIntervalUsdc6: item.amountPerInterval.toString(),
          frequency: item.frequency,
          gasUsed: receipt.gasUsed.toString(),
          costUsdc6: costToRecordUsdc6.toString(),
          gasDeducted: deductOk,
          gasDeductChainId: deductOk ? deductChainId : undefined,
        });

        // Write the swap through to dca_plans while we're here: re-read the struct (one eth_call)
        // so executed count / drawn-down deposit are exact, and a plan that just depleted is
        // recorded as completed. Best-effort — a DB hiccup must not fail an executed swap.
        if (isSupabaseConfigured()) {
          try {
            const after = (await publicClient.readContract({
              address: vault,
              abi: DCA_VAULT_ABI,
              functionName: "getSchedule",
              args: [user, item.scheduleId],
            })) as { amountPerInterval: bigint; totalAmount: bigint; executedCount: bigint; active: boolean };
            await recordPlanExecuted({
              chainId,
              userAddr: userAddress,
              scheduleId: Number(item.scheduleId),
              executedCount: Number(after.executedCount),
              swappedUsdc6: (after.amountPerInterval * after.executedCount).toString(),
              remainingUsdc6: after.totalAmount.toString(),
              active: Boolean(after.active),
              at: new Date(),
            });
          } catch (e) {
            errors.push(`recordPlanExecuted ${member} ${item.scheduleId}: ${(e as Error).message}`);
          }
        }

        try {
          const clientDeduct =
            deductChainId === chainId
              ? publicClient
              : createPublicClient({ chain: getChain(deductChainId)!, transport: http(getRpc(deductChainId)!) });
          const balanceAfter = (await clientDeduct.readContract({
            address: gasTankDeduct,
            abi: GAS_TANK_ABI,
            functionName: "balanceOf",
            args: [user],
          })) as bigint;
          gasBalances.push({ chainId: deductChainId, user: userAddress, balanceUsdc6: balanceAfter.toString() });
        } catch {
          // ignore
        }
        } finally {
          clearPlanExecuting(chainId, userAddress, item.scheduleId, { source: "relayer" });
        }
      }
    } catch (e) {
      errors.push(`executeSwap batch ${member}: ${(e as Error).message}`);
      log(`  [${member}] Error: ${(e as Error).message}`);
    }
  }

  log(`[Run finished] Executed: ${executed.length}, Errors: ${errors.length}`);
  const result: ExecutorResult = {
    ok: true,
    executed: executed.length,
    executedTasks: executed,
    executedTasksDetail,
    ...(errors.length ? { errors } : {}),
    gasBalances: gasBalances.length ? gasBalances : undefined,
    planSnapshots: planSnapshots.length ? planSnapshots : undefined,
    portfolioSnapshots: portfolioSnapshots.length ? portfolioSnapshots : undefined,
  };
  return result;
}

/** CLI entry: run once and exit. */
async function main() {
  const result = await runExecutor();
  console.log(JSON.stringify(result));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
