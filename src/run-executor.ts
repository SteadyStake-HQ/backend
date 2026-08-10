/**
 * DCA executor: reads registered users from Supabase, executes ready schedules by sending
 * executeSwap from the relayer wallet, then deducts gas cost from user's GasTank.
 * Run on a schedule via server (dashboard) or once via: node dist/run-executor.js
 */
import "dotenv/config";
import { isSupabaseConfigured } from "./supabase/automation-users";
import { getDcaPlanMembers, recordPlanExecuted } from "./supabase/dca-plans-store";
import {
  getEffectiveNetworkTypes,
  getNonExecutableChainIds,
} from "./supabase/network-allocations";
import { getRegistryNetworkTypes, type NetworkType } from "./networks/network-registry";
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
import { getGasProfile, recordRun, RECORD_BUFFER_BPS } from "./gas-profile";
import { getNativePriceUsd, prefetchNativePrices } from "./native-price";
import { getTokenPriceUsd } from "./token-price";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Chain,
  encodeFunctionData,
} from "viem";
import { base, baseSepolia, bsc, polygon, sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { getVaultUsdcGasTank, getRpc, getChainIdsWithGasTank, usesDirectSwapRouter, getSwapAdapter, getStableOne, toPooledUsd6, convertStableAmountUp, CHAIN_NAMES } from "./config";

const ZERO_EX_BASE = "https://api.0x.org";

/**
 * Floor for an executeSwap gas limit. The real limit each transaction is sent with comes from
 * `estimateExecuteSwapGas` below.
 *
 * A limit, not a cost: the EVM refunds what a transaction does not use, so nothing prices a run
 * off this. What a run is charged comes from its receipt, and what it is *expected* to cost before
 * it runs comes from the gas real runs on that chain have burned (gas-profile.ts).
 *
 * This was the limit itself, fixed, and that is what broke swaps on BNB Chain: a 0x route through
 * PancakeSwap Infinity CL needs ~540k, so every run stopped a few opcodes into the aggregator. The
 * adapter reaches 0x through a low-level `.call`, so the sub-call ran out of its 63/64 share of the
 * remaining gas and returned false instead of bubbling up — the vault reported "0x swap failed",
 * which reads like a routing or liquidity fault and hid the real cause.
 */
const GAS_LIMIT_EXECUTE_SWAP = 400_000n;
/**
 * Ceiling on an estimated executeSwap limit. A run that genuinely needs more than this is not a
 * route worth paying for, and an absurd estimate from a misbehaving node must not be able to hand
 * the relayer's whole native balance to one transaction.
 */
const GAS_LIMIT_EXECUTE_SWAP_MAX = 3_000_000n;
/** Headroom over eth_estimateGas: routes move between the estimate and the block that mines it. */
const GAS_LIMIT_BUFFER_BPS = 13000; // 1.3x
const ESTIMATE_BUFFER_BPS = 15000; // 1.5x for balance check
/*
 * RECORD_BUFFER_BPS — the headroom on the deduction leg — now lives in gas-profile.ts, beside the
 * measured gas it is applied to and where the API can publish it. Every screen that estimates a
 * charge ahead of a run has to apply the same figure or it quotes under what will be debited.
 */
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

/**
 * Gas limit for one executeSwap, from the node rather than from a constant.
 *
 * How much gas a run needs is a property of the route the aggregator picked this minute, not of the
 * chain: a direct mock-router swap costs ~120k, a two-hop 0x route on BNB Chain costs ~540k, and no
 * single number covers both without either reverting the second or over-reserving on the first.
 *
 * Returns null when the estimate itself reverts. That is not a gas problem — the transaction would
 * revert on-chain for the same reason — so the caller skips the schedule and reports `reason`
 * instead of paying for a failure. It is also the only place the real revert string is visible:
 * once mined, the vault's low-level call has already flattened it into "0x swap failed".
 */
async function estimateExecuteSwapGas(
  publicClient: ReturnType<typeof createPublicClient>,
  account: ReturnType<typeof privateKeyToAccount>,
  vault: `0x${string}`,
  data: `0x${string}`
): Promise<{ gas: bigint } | { gas: null; reason: string }> {
  let estimate: bigint;
  try {
    estimate = await publicClient.estimateGas({ account, to: vault, data });
  } catch (e) {
    const err = e as { shortMessage?: string; details?: string; message?: string };
    return { gas: null, reason: err.details ?? err.shortMessage ?? err.message ?? String(e) };
  }
  const buffered = (estimate * BigInt(GAS_LIMIT_BUFFER_BPS)) / 10000n;
  if (buffered < GAS_LIMIT_EXECUTE_SWAP) return { gas: GAS_LIMIT_EXECUTE_SWAP };
  if (buffered > GAS_LIMIT_EXECUTE_SWAP_MAX) return { gas: GAS_LIMIT_EXECUTE_SWAP_MAX };
  return { gas: buffered };
}

/** keccak256("Transfer(address,address,uint256)") — topic0 of every ERC-20 transfer. */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * How much of the target token the swap actually delivered to the user, from the receipt's own logs.
 *
 * Neither the vault's `ScheduleExecuted` event nor its return value carries the output amount — the
 * event's `amountOut` field is emitted as a literal 0 — so the only record of what a run bought is
 * the ERC-20 `Transfer` the swap itself emitted. The receipt is already in hand at this point, so
 * reading it costs nothing extra, and capturing it now is the only chance: reconstructing it later
 * would mean re-fetching receipts for every historical execution.
 *
 * Transfers are summed rather than taken singly because a route can settle in more than one hop, and
 * a fee-on-transfer token emits its own. Null (rather than 0n) when the token emitted nothing to the
 * user, so "not recorded" stays distinguishable from "the swap delivered nothing".
 */
function tokenDelivered(
  logs: readonly { address?: string; topics?: readonly string[]; data?: string }[],
  token: string,
  user: string,
): bigint | null {
  let total = 0n;
  let seen = false;
  for (const log of logs) {
    if (log.address?.toLowerCase() !== token.toLowerCase()) continue;
    if (log.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    // A non-standard token can emit Transfer with the value indexed and no data; those carry only
    // three topics and no amount to read, so they are skipped rather than counted as zero.
    if (log.topics.length < 3 || !log.data || log.data === "0x") continue;
    const to = `0x${log.topics[2].slice(-40)}`;
    if (to.toLowerCase() !== user.toLowerCase()) continue;
    try {
      total += BigInt(log.data);
      seen = true;
    } catch {
      // Unparseable data means this log is not a standard Transfer; ignore it.
    }
  }
  return seen ? total : null;
}

/** Divide, rounding up. Every gas charge uses this — see gasCostToStable. */
function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (numerator <= 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

/**
 * What a quantity of gas comes to in a stablecoin, at a chain's gas price and its token's USD
 * price: `(gasUnits * gasPriceWei) / 1e18 * nativePriceUsd`, scaled to `scaleChainId`'s stablecoin
 * decimals (1e6 on most chains, 1e18 on BSC) and widened by the buffer (bps).
 *
 * `scaleChainId` is only the unit the answer is stated in — the gas price and token price are the
 * caller's, and are not always the same chain's. A run executed on one network and settled from
 * another network's tank costs the gas of both, at each one's own price, expressed in one currency.
 *
 * Rounded **up**, always. This is the arithmetic that turns money the relayer has already spent
 * into money it asks back, so every fraction of a base unit lost to truncation is a fraction the
 * relayer paid for on the user's behalf and never gets back. It is a rounding either way; it
 * should fall on the side of the party that fronted the gas.
 */
function gasCostToStable(
  scaleChainId: number,
  gasUnits: bigint,
  gasPriceWei: bigint,
  nativePriceUsd: number,
  bufferBps: number = 10000,
): bigint {
  if (nativePriceUsd <= 0 || gasUnits <= 0n || gasPriceWei <= 0n) return 0n;
  // All multiplications happen before any division so the 1e6-scaled native price keeps its
  // precision even when the target scale is smaller than the intermediate.
  const numerator =
    gasUnits *
    gasPriceWei *
    BigInt(Math.round(nativePriceUsd * 1e6)) *
    BigInt(bufferBps) *
    getStableOne(scaleChainId);
  return ceilDiv(numerator, 10n ** 18n * 1_000_000n * 10_000n);
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

export const GAS_TANK_ABI = [
  { type: "function", name: "balanceOf", inputs: [{ name: "user", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  /*
   * `gasCostPerExecutionUsdc6` is not declared here. It still exists on the contract and nothing
   * may read it: `recordExecution` debits the amount this relayer passes, which is what the run's
   * receipt says it burned. An ABI entry for a dead price is how a dead price gets displayed again.
   */
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
export async function get0xQuote(
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

export function netAmountAfterFee(amount: bigint, feeBps: number): bigint {
  const fee = (amount * BigInt(feeBps)) / 10000n;
  return amount - fee;
}

/**
 * The gas tanks allowed to pay for a run on `executionChainId`: every deployed tank on a network of
 * the same type, mainnet or testnet.
 *
 * The pool used to be every deployed tank, full stop, and that let faucet money buy mainnet runs.
 * The tanks on Sepolia and Base Sepolia hold MockUSDC; `pickDeductChain` prefers the largest balance
 * that covers the cost; and a faucet mints as much of that as anyone cares to ask for. So a user
 * holding 9 mock USDC on Sepolia and 1 real USDC on BOT Chain had every BNB Chain run charged to
 * Sepolia — the relayer paid real BNB for the swap and reimbursed itself in play money, while the
 * mainnet tank the user had just topped up sat untouched.
 *
 * A chain the registry does not classify can only pay for itself. An unclassified network is not
 * something to guess is real, and its own tank is the one case that needs no guess.
 */
export function eligibleDeductChainIds(
  executionChainId: number,
  networkTypes: Map<number, NetworkType>,
): number[] {
  const executionType = networkTypes.get(executionChainId);
  if (!executionType) return [executionChainId];
  return getChainIdsWithGasTank().filter(
    (cid) => cid === executionChainId || networkTypes.get(cid) === executionType,
  );
}

/**
 * Gas tank balance aggregated across `chainIds` (CEX-style: one balance for any of them). Fetches
 * them in parallel. The caller decides which chains belong in the pool — see eligibleDeductChainIds.
 */
async function getGlobalGasBalance(
  userAddress: string,
  chainIds: number[],
): Promise<{ globalBalance: bigint; byChain: Record<number, bigint> }> {
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
  // `byChain` keeps each balance in its own chain's base units — that is what recordExecution on
  // that chain expects. `globalBalance` is the cross-chain sum and so has to be normalised to the
  // pooled scale first; adding an 18-decimal BSC balance raw would inflate it by 10^12.
  const byChain: Record<number, bigint> = {};
  let globalBalance = 0n;
  for (const { cid, bal } of results) {
    byChain[cid] = bal;
    globalBalance += toPooledUsd6(bal, cid);
  }
  return { globalBalance, byChain };
}

/** Pick chain to deduct gas cost from: prefer execution chain if enough balance, else chain with largest balance >= cost. */
/**
 * Which chain's tank pays for a run on `executionChainId`: that chain when it can cover the cost,
 * otherwise the richest tank that can.
 *
 * `byChain` holds only the tanks eligible to pay for this run — eligibleDeductChainIds has already
 * excluded the networks of the other kind. "Richest wins" is therefore a choice between tanks whose
 * contents are worth the same per unit, which is the only comparison that makes sense.
 *
 * Every balance is in its own chain's stablecoin base units and `costUsdc6` is in the execution
 * chain's, so all of them are lifted to the pooled scale before being compared — raw, an
 * 18-decimal BSC balance outranks every 6-decimal chain by a factor of 10^12 and would always be
 * picked as "richest" even when it holds less money.
 */
export function pickDeductChain(byChain: Record<number, bigint>, executionChainId: number, costUsdc6: bigint): number | null {
  const costPooled = toPooledUsd6(costUsdc6, executionChainId);
  if (
    byChain[executionChainId] != null &&
    toPooledUsd6(byChain[executionChainId], executionChainId) >= costPooled
  ) {
    return executionChainId;
  }
  let best: number | null = null;
  let bestBal = 0n;
  for (const [cid, bal] of Object.entries(byChain)) {
    const chainId = parseInt(cid, 10);
    const balPooled = toPooledUsd6(bal, chainId);
    if (balPooled >= costPooled && balPooled > bestBal) {
      best = chainId;
      bestBal = balPooled;
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
  /**
   * Target token delivered to the user by this swap, in the token's own base units — the "out" side
   * of the trade. Read from the receipt's Transfer logs; absent when the token emitted none.
   */
  amountOutRaw?: string;
  frequency?: number;
  gasUsed?: string;
  costUsdc6?: string;
  /** False when the swap ran but the GasTank deduction did not land — the run was effectively free. */
  gasDeducted?: boolean;
  /** Chain the gas was actually deducted on (may differ from the execution chain). */
  gasDeductChainId?: number;

  /* ---- What the relayer actually spent -----------------------------------------------------
     `costUsdc6` is what the *user* was charged; it is a price, not a cost, and on a chain with a
     flat rate the two are unrelated. The fields below are the other side of that trade — the
     native token the relayer really burned — so the treasury page can state the margin per run
     instead of inferring it from a gas price it would have to guess at after the fact. */

  /** Effective gas price of the swap tx, wei. */
  gasPriceWei?: string;
  /** Native token the swap tx burned, wei: its gas used x its effective gas price. */
  nativeSpentWei?: string;
  /** USD per native token on the execution chain at execution time, as the run priced it. */
  nativeUsd?: number;

  /** Gas the GasTank deduction burned. Absent when the deduction did not land. */
  recordGasUsed?: string;
  /** Effective gas price of the deduction tx, wei. */
  recordGasPriceWei?: string;
  /**
   * Native the deduction burned, wei — on `gasDeductChainId`, which is not always the execution
   * chain. Kept apart from `nativeSpentWei` for exactly that reason: the two can be different
   * tokens at different prices, and adding them would produce a number in no currency at all.
   */
  recordNativeSpentWei?: string;
  /** USD per native token on the deduct chain, when it differs from the execution chain. */
  recordNativeUsd?: number;
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

  // Which networks are real, once for the whole sweep — this decides whose gas tank may pay for
  // whose run, and two plans in the same run must not be judged against different answers.
  //
  // A failed read falls back to the registry's own classification rather than aborting, unlike the
  // allocation read above. The two are not the same kind of statement: the allocation store is the
  // only record that a network was taken out of service, while the type override is an edit on top
  // of a classification the code already ships. Losing the override widens nothing — mainnet stays
  // mainnet and a faucet chain stays a faucet chain.
  let networkTypes: Map<number, NetworkType>;
  try {
    networkTypes = await getEffectiveNetworkTypes();
  } catch (e) {
    networkTypes = getRegistryNetworkTypes();
    log(
      `Network types could not be read (${(e as Error).message}); using the registry's own mainnet/testnet classification.`,
    );
  }

  if (allowedChains.size === 0) {
    const message = "No network is currently in service for execution.";
    log(message);
    return { ok: true, executed: 0, executedTasks: [], errors: [] };
  }
  log(`Allowed chains for execution: ${[...allowedChains].sort((a, b) => a - b).join(", ")} (from ${chainSource})`);
  // The native price cache used to be cleared here because it never expired and a long-lived
  // process would otherwise price every future run at the first quote it ever saw. It now ages
  // out on its own (native-price.ts), so a sweep gets a fresh price without discarding one that
  // is seconds old — which matters when the feeds are throttling and a refetch may return nothing.
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
  const executed: string[] = [];
  const executedTasksDetail: ExecutedTask[] = [];
  const gasBalances: GasBalanceEntry[] = [];
  const planSnapshots: PlanSnapshotEntry[] = [];
  const portfolioSnapshots: PortfolioSnapshotEntry[] = [];
  const errors: string[] = [];

  // Pre-fetch native token prices for all allowed chains in one Coingecko request
  await prefetchNativePrices([...allowedChains]);
  const gasPriceCache: Record<number, bigint> = {};
  const nativeUsdCache: Record<number, number> = {};

  /**
   * Gas price on a chain, read once for the whole sweep.
   *
   * Held for the sweep on purpose: two users whose plans are executed by the same pass are
   * charged against the same reading, so a block that arrives mid-sweep cannot make one of them
   * pay more than the other for the same work.
   */
  const gasPriceOf = async (cid: number): Promise<bigint> => {
    if (gasPriceCache[cid] === undefined) {
      const rpc = getRpc(cid);
      const chain = getChain(cid);
      if (!rpc || !chain) return 0n;
      gasPriceCache[cid] = await createPublicClient({ chain, transport: http(rpc) })
        .getGasPrice()
        .catch(() => 0n);
    }
    return gasPriceCache[cid];
  };

  const nativeUsdOf = async (cid: number): Promise<number> => {
    if (nativeUsdCache[cid] === undefined) {
      nativeUsdCache[cid] = await getNativePriceUsd(cid).catch(() => 0);
    }
    return nativeUsdCache[cid];
  };

  /**
   * What the deduction transaction will cost on the chain that settles it, stated in
   * `scaleChainId`'s stablecoin base units.
   *
   * Every other figure in a run's price is read from a receipt. This one cannot be: the amount
   * `recordExecution` debits is an argument to it, so it has to be priced before it is sent. It is
   * priced from that chain's own measured record-leg gas (gas-profile.ts) at that chain's current
   * gas price and token price, plus RECORD_BUFFER_BPS.
   *
   * When the settling chain is not the executing one this is where the difference shows up, and
   * why a plan paid out of another network's tank costs more: the swap's gas is the execution
   * chain's, but this leg is charged at the settling chain's gas price, in the settling chain's
   * token, whatever either happens to be worth.
   */
  const recordLegCost = async (scaleChainId: number, settleChainId: number): Promise<bigint> => {
    const [price, usd] = await Promise.all([gasPriceOf(settleChainId), nativeUsdOf(settleChainId)]);
    if (price <= 0n || usd <= 0) return 0n;
    return gasCostToStable(
      scaleChainId,
      BigInt(getGasProfile(settleChainId).recordGasUnits),
      price,
      usd,
      RECORD_BUFFER_BPS,
    );
  };

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

    // Global gas tank balance (CEX-style: top-up on any network of this kind, use on any of them).
    const deductChainIds = eligibleDeductChainIds(chainId, networkTypes);
    let globalGas: { globalBalance: bigint; byChain: Record<number, bigint> };
    try {
      globalGas = await getGlobalGasBalance(userAddress, deductChainIds);
    } catch (e) {
      errors.push(`Global gas balance ${member}: ${(e as Error).message}`);
      log(`  [${member}] Skip: global gas balance failed`);
      continue;
    }

    /*
     * The two live figures every charge on this chain is built from. Nothing sets a price any
     * more: a run is billed the gas it burned, at the price the chain charged for it, valued in
     * the token the chain charges in — so without both of these there is no charge to make, and a
     * run that cannot be charged is not one to perform. It is skipped rather than given away.
     */
    let gasPriceWei = 0n;
    let nativePriceUsd = 0;
    try {
      gasPriceWei = await gasPriceOf(chainId);
      nativePriceUsd = await nativeUsdOf(chainId);
    } catch (e) {
      errors.push(`Gas price / native price ${chainId}: ${(e as Error).message}`);
      log(`  [${member}] Skip: ${(e as Error).message}`);
      continue;
    }
    if (gasPriceWei <= 0n) {
      errors.push(`Gas price unavailable for chain ${chainId}, skipping`);
      log(`  [${member}] Skip: gas price unavailable`);
      continue;
    }
    if (nativePriceUsd <= 0) {
      errors.push(`Native price unavailable for chain ${chainId}, skipping`);
      log(`  [${member}] Skip: native price unavailable`);
      continue;
    }

    /**
     * A run's cost before any of it has happened, for the "can this tank afford to start?" checks.
     *
     * Built from what this chain's runs have really burned (gas-profile.ts) rather than from the
     * transaction's gas *limit*, which the EVM refunds the unused part of and which would overstate
     * a run by more than twice — and now that the charge is the real cost, an inflated pre-check
     * would turn away plans that can comfortably pay. ESTIMATE_BUFFER_BPS is the headroom for a
     * busier block than the one that priced this; the settled charge below is exact regardless.
     */
    const estimatedCostUsdc6 =
      gasCostToStable(
        chainId,
        BigInt(getGasProfile(chainId).gasUnitsPerRun),
        gasPriceWei,
        nativePriceUsd,
        ESTIMATE_BUFFER_BPS,
      ) || 1n;

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
      // globalBalance is on the pooled scale, so the estimate is lifted onto it to compare.
      if (globalGas.globalBalance < toPooledUsd6(estimatedCostUsdc6, chainId)) {
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
            // Naming the pool matters: "insufficient" on its own reads as an empty tank, when the
            // money may simply be sitting on the other side of the mainnet/testnet line.
            errors.push(
              `Insufficient gas tank (preflight) ${member} scheduleId=${item.scheduleId} — no ${networkTypes.get(chainId) ?? "eligible"} tank of ${deductChainIds.join(", ")} covers ${estimatedCostUsdc6}`
            );
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
              // Restated in the preflight chain's own base units, as the real charge below is.
              args: [user, convertStableAmountUp(estimatedCostUsdc6, chainId, preflightChainId)],
              functionName: "recordExecution",
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

        // Size the transaction to the route the quote actually picked, and let a failing estimate
        // stand in for the swap's own preflight — a revert here is the revert the chain would give.
        const swapGas = await estimateExecuteSwapGas(
          publicClient,
          account,
          vault,
          item.executeSwapData,
        );
        if (swapGas.gas === null) {
          errors.push(
            `Skipping swap: executeSwap would revert on chain ${chainId} ${member} scheduleId=${item.scheduleId}: ${swapGas.reason}`
          );
          log(`  [${member}] Schedule ${item.scheduleId}: skip — executeSwap would revert (${swapGas.reason})`);
          continue;
        }

        let hash: `0x${string}`;
        let receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>;
        try {
          const nonce = await getNextRelayerNonce(chainId, publicClient, account.address);
          hash = await walletClient.sendTransaction({
            to: vault,
            data: item.executeSwapData,
            gas: swapGas.gas,
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

        /*
         * What this run actually cost, now that most of it has happened.
         *
         * The swap is no longer an estimate: `gasUsed` and `effectiveGasPrice` are what the chain
         * charged for the transaction that just confirmed, so this leg is exact, unbuffered, and
         * owes nothing to any rate anyone set. The deduction leg still has to be predicted, since
         * the amount it debits is the argument it is about to be sent with — see recordLegCost.
         */
        const swapCostUsdc6 = gasCostToStable(
          chainId,
          receipt.gasUsed,
          receipt.effectiveGasPrice ?? gasPriceWei,
          nativePriceUsd,
        );

        /*
         * Which tank pays, and the total to charge it.
         *
         * These decide each other: the deduction's own gas is part of the bill, and how much that
         * is depends on the chain it settles on. So the chain is chosen against this chain's own
         * deduction cost — the ordinary case, and the cheapest — and the total is then restated
         * against whatever chain that turned out to be. If the cross-network premium pushes the
         * bill past what that tank holds, the choice is made again with the true figure.
         */
        let deductChainId = pickDeductChain(
          globalGas.byChain,
          chainId,
          swapCostUsdc6 + (await recordLegCost(chainId, chainId)),
        );
        let costToRecordUsdc6 = 0n;
        if (deductChainId != null) {
          costToRecordUsdc6 = swapCostUsdc6 + (await recordLegCost(chainId, deductChainId));
          if (
            toPooledUsd6(globalGas.byChain[deductChainId] ?? 0n, deductChainId) <
            toPooledUsd6(costToRecordUsdc6, chainId)
          ) {
            deductChainId = pickDeductChain(globalGas.byChain, chainId, costToRecordUsdc6);
            if (deductChainId != null) {
              costToRecordUsdc6 = swapCostUsdc6 + (await recordLegCost(chainId, deductChainId));
            }
          }
        }
        if (deductChainId == null || costToRecordUsdc6 <= 0n) {
          errors.push(
            `No ${networkTypes.get(chainId) ?? "eligible"} chain of ${deductChainIds.join(", ")} has enough gas balance to deduct ${costToRecordUsdc6} ${member} scheduleId=${item.scheduleId}`
          );
          continue;
        }
        const cfgDeduct = getVaultUsdcGasTank(deductChainId);
        const gasTankDeduct = cfgDeduct?.gasTank as `0x${string}` | undefined;
        if (!cfgDeduct || !gasTankDeduct) {
          errors.push(`Missing GasTank config for deduct chain ${deductChainId}`);
          continue;
        }
        // The tank being debited may be on another chain whose stablecoin has different decimals,
        // so the charge is restated in that chain's base units before it is encoded — rounded up,
        // because this is gas the relayer has already paid and truncation would write some of it off.
        const costOnDeductChain = convertStableAmountUp(costToRecordUsdc6, chainId, deductChainId);
        const recordData = encodeFunctionData({
          abi: GAS_TANK_ABI,
          functionName: "recordExecution",
          args: [user, costOnDeductChain],
        });

        // Deduct, then confirm it. This used to be fire-and-forget with a hardcoded gas limit:
        // the fixed gas skipped estimation (which would have surfaced the revert) and nothing
        // waited for the receipt, so a GasTank whose executor was never set reverted every
        // deduction while the run reported full success and the tank never moved. Simulate to
        // fail fast with the real revert reason, then wait for the receipt before believing it.
        let deductOk = false;
        /** Gas the deduction burned, for the run-cost profile. Null unless it actually landed. */
        let recordGasUsed: bigint | null = null;
        /** Its effective gas price, so the treasury page can price the deduction it paid for. */
        let recordGasPriceWei: bigint | null = null;
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
              // The deduct chain's own base units, as the transaction below is encoded with. This
              // used to pass the execution chain's, so every BSC-to-6-decimal deduction simulated a
              // charge 10^12 times too large, reverted with InsufficientBalance, and reported a
              // failure the send that followed did not have — noise that would have hidden a real one.
              args: [user, costOnDeductChain],
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
              recordGasPriceWei = recordReceipt.effectiveGasPrice ?? null;
              log(`  [${member}] Gas deducted ${costOnDeductChain} on chain ${deductChainId} tx=${recordHash}`);
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
        // Each side is drawn down in its own scale: byChain in the deduct chain's base units (the
        // amount actually charged), globalBalance on the pooled scale it is summed in.
        if (deductOk) {
          globalGas.byChain[deductChainId] -= costOnDeductChain;
          globalGas.globalBalance -= toPooledUsd6(costOnDeductChain, deductChainId);
        }

        /*
         * Teach the next quote what a run on this chain really costs (see gas-profile.ts). Both
         * halves matter and they answer different questions: the gas is what the relayer needs to
         * price the deduction leg of the *next* run, and the charge is what users are shown as the
         * average and the worst case on this network. A run whose deduction never landed reports a
         * charge of zero — it was not charged, and publishing it as if it were would drag the
         * average users are quoted below anything anyone actually pays.
         */
        recordRun({
          chainId,
          swapGasUsed: receipt.gasUsed,
          recordGasUsed,
          chargedUsd6: deductOk ? toPooledUsd6(costOnDeductChain, deductChainId) : 0n,
          crossChain: deductChainId !== chainId,
        });

        // What the swap really cost the relayer, in the execution chain's native token. Recorded
        // now rather than reconstructed later: gas price moves, and a margin worked out from
        // tomorrow's gas price is not this run's margin.
        const swapGasPriceWei = receipt.effectiveGasPrice ?? gasPriceWei;
        const recordNativeUsd =
          deductOk && deductChainId !== chainId
            ? await getNativePriceUsd(deductChainId).catch(() => 0)
            : null;

        executedTasksDetail.push({
          chainId,
          user: userAddress,
          scheduleId: item.scheduleId.toString(),
          txHash: hash,
          targetToken: item.targetToken,
          amountPerIntervalUsdc6: item.amountPerInterval.toString(),
          amountOutRaw:
            item.targetToken != null
              ? (tokenDelivered(receipt.logs, item.targetToken, userAddress)?.toString() ?? undefined)
              : undefined,
          frequency: item.frequency,
          gasUsed: receipt.gasUsed.toString(),
          costUsdc6: costToRecordUsdc6.toString(),
          gasDeducted: deductOk,
          gasDeductChainId: deductOk ? deductChainId : undefined,
          gasPriceWei: swapGasPriceWei > 0n ? swapGasPriceWei.toString() : undefined,
          nativeSpentWei: swapGasPriceWei > 0n ? (receipt.gasUsed * swapGasPriceWei).toString() : undefined,
          nativeUsd: nativePriceUsd > 0 ? nativePriceUsd : undefined,
          recordGasUsed: recordGasUsed != null ? recordGasUsed.toString() : undefined,
          recordGasPriceWei: recordGasPriceWei != null ? recordGasPriceWei.toString() : undefined,
          recordNativeSpentWei:
            recordGasUsed != null && recordGasPriceWei != null
              ? (recordGasUsed * recordGasPriceWei).toString()
              : undefined,
          recordNativeUsd: recordNativeUsd != null && recordNativeUsd > 0 ? recordNativeUsd : undefined,
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
            /*
             * What the token was worth at this buy. Stamped here because now is the only time it can
             * be: no feed will tell us next week what a token cost on the afternoon this run
             * happened, so a price not captured at the run is a price the plan never gets to show.
             * Best-effort by design — the buy is recorded either way, with no price rather than a
             * guessed one (see recordPlanExecuted).
             */
            const tokenPriceUsd =
              item.targetToken != null
                ? await getTokenPriceUsd(chainId, item.targetToken).catch(() => null)
                : null;
            await recordPlanExecuted({
              chainId,
              userAddr: userAddress,
              scheduleId: Number(item.scheduleId),
              executedCount: Number(after.executedCount),
              swappedUsdc6: (after.amountPerInterval * after.executedCount).toString(),
              remainingUsdc6: after.totalAmount.toString(),
              active: Boolean(after.active),
              at: new Date(),
              tokenPriceUsd,
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
