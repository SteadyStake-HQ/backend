/**
 * Contract addresses and RPC. GasTank must be deployed and set in deployed-addresses.json per chain.
 * Resolves deployed-addresses.json from backend root (works when run from backend or project root).
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  getRegistryRpc,
  REGISTRY_CHAIN_NAMES,
  REGISTRY_EXPLORERS,
} from "./networks/network-registry";

/**
 * Vault settlement stablecoin per chain (always 6 decimals). Named USDC for historical
 * reasons; BOT Chain has no USDC, so bridged USDT fills the same slot there.
 */
const USDC_BY_CHAIN: Record<number, string> = {
  8453: "0x833589fCD6eDb6E08f4C7C32D4f71b54bdA02913",
  // Both Sepolias run the mock stack and have been redeployed since; the live MockUSDC is recorded
  // in deployed-addresses.json and outranks these, which are kept only as a last resort.
  84532: "0x508D52Ed54989700b94c381b54b53f68ED18Ce52",
  11155111: "0x5a55d42682B78a01b69C0EA06731d9cBB2C46A9F",
  56: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  137: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", // Circle native USDC
  // Kava: native Tether USDt. The old Multichain USDC (0xfA9343C3...A40f) is stranded — that
  // bridge shut down in 2023 — so the vault deployed 2026-07-28 settles in USDt instead.
  2222: "0x919C1c267BC06a7039e03fcc2eF738525769109c",
  677: "0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C", // BOT Chain: bridged USDT
  968: "0x75edC9335175Fc0552D51D48439F229c10420fe3", // BOT Chain testnet: bridged USDT
};

/** Display symbol of the settlement stablecoin. Defaults to USDC where not listed. */
const STABLE_SYMBOL_BY_CHAIN: Record<number, string> = {
  677: "USDT",
  968: "USDT",
  2222: "USDT",
};

/**
 * Settlement stablecoin actually wired into the deployed vault on this chain.
 *
 * The table above records the *intended* stablecoin, but a chain can be deployed from the mock
 * stack instead (`DeployBotTestnetWithMockUSDC`), in which case the live vault and GasTank hold
 * MockUSDC and the table address points at a token no contract on that chain uses. Chain 968 is
 * deployed exactly that way today. When the deployment records a MockUSDC, that is the truth.
 */
function resolveStable(chainId: number): { address: string; symbol: string } | null {
  const mock = deployed[String(chainId)]?.MockUSDC;
  if (mock && mock !== ZERO) return { address: mock, symbol: "USDC" };
  const listed = USDC_BY_CHAIN[chainId];
  if (!listed) return null;
  return { address: listed, symbol: STABLE_SYMBOL_BY_CHAIN[chainId] ?? "USDC" };
}

export function getStableSymbol(chainId: number): string {
  return resolveStable(chainId)?.symbol ?? "USDC";
}

/**
 * Decimals of the chain's settlement stablecoin.
 *
 * Every amount the protocol moves — schedule deposits, GasTank balances, per-run prices — is
 * denominated in this token's base units, so this must match the token contract exactly. It is 6
 * everywhere except BNB Chain: BSC has no liquid 6-decimal stablecoin (Binance-Peg USDC/USDT,
 * BUSD, FDUSD, USD1 and DAI are all 18-decimal, and the 6-decimal bridged wrappers — axlUSDC,
 * Wormhole USDCet — hold only a few hundred thousand dollars in total), so chain 56 settles in
 * 18-decimal Binance-Peg USDC.
 *
 * The `Usdc6` suffix on variables and contract fields elsewhere in the codebase predates this and
 * is now a misnomer: those values are in stablecoin base units, which is 1e6 on most chains and
 * 1e18 on BSC. Renaming them would churn the DB column names and the public API, so the names
 * stayed and this function is the single place that knows the scale.
 */
const STABLE_DECIMALS_BY_CHAIN: Record<number, number> = {
  56: 18, // Binance-Peg USD Coin
};

export function getStableDecimals(chainId: number): number {
  // Mock-stack chains (968, 84532) deploy MockUSDC, which is 6-decimal like the real token.
  return STABLE_DECIMALS_BY_CHAIN[chainId] ?? 6;
}

/** One whole settlement token in base units, e.g. 1_000_000n on Base, 10n**18n on BSC. */
export function getStableOne(chainId: number): bigint {
  return 10n ** BigInt(getStableDecimals(chainId));
}

/**
 * Scale for figures compared or summed across chains — gas-tank balances above all, since a run
 * on one network can be paid out of another network's tank. Fixed at 6 decimals.
 */
export const POOLED_DECIMALS = 6;

/** Native settlement-token base units -> the canonical pooled (6-decimal) scale. */
export function toPooledUsd6(amount: bigint, chainId: number): bigint {
  const decimals = getStableDecimals(chainId);
  if (decimals === POOLED_DECIMALS) return amount;
  return decimals > POOLED_DECIMALS
    ? amount / 10n ** BigInt(decimals - POOLED_DECIMALS)
    : amount * 10n ** BigInt(POOLED_DECIMALS - decimals);
}

/** The canonical pooled (6-decimal) scale -> a chain's native settlement-token base units. */
export function fromPooledUsd6(amount: bigint, chainId: number): bigint {
  const decimals = getStableDecimals(chainId);
  if (decimals === POOLED_DECIMALS) return amount;
  return decimals > POOLED_DECIMALS
    ? amount * 10n ** BigInt(decimals - POOLED_DECIMALS)
    : amount / 10n ** BigInt(POOLED_DECIMALS - decimals);
}

/**
 * Restate an amount from one chain's stablecoin base units into another's.
 *
 * The relayer needs this because the tank it debits is not always the chain it executed on: a cost
 * worked out in 18-decimal BSC units would, deducted verbatim against a 6-decimal tank, ask for a
 * trillion times the intended charge (and revert), while the reverse direction would debit dust.
 */
export function convertStableAmount(amount: bigint, fromChainId: number, toChainId: number): bigint {
  if (getStableDecimals(fromChainId) === getStableDecimals(toChainId)) return amount;
  return fromPooledUsd6(toPooledUsd6(amount, fromChainId), toChainId);
}

/**
 * The same conversion, rounded up.
 *
 * `convertStableAmount` goes through the pooled scale, and stepping down from 18 decimals to 6
 * truncates — harmless when restating a balance, not harmless when restating a charge. A BSC run
 * settled against a 6-decimal tank would round its cost down by up to a hundredth of a cent every
 * time, and the relayer is the one that already paid that gas. Use this wherever the amount is
 * money owed rather than money held.
 */
export function convertStableAmountUp(amount: bigint, fromChainId: number, toChainId: number): bigint {
  const from = getStableDecimals(fromChainId);
  const to = getStableDecimals(toChainId);
  if (from === to || amount <= 0n) return amount;
  if (to > from) return amount * 10n ** BigInt(to - from);
  const divisor = 10n ** BigInt(from - to);
  return (amount + divisor - 1n) / divisor;
}

type DeployedEntry = {
  chainId: number;
  DCAVault?: string;
  DCAResolver?: string;
  ZeroExAdapter?: string;
  GasTank?: string;
  /** Present on chains deployed from the mock stack; when set it is the vault's real stablecoin. */
  MockUSDC?: string;
};
type Deployed = Record<string, DeployedEntry>;

/**
 * Chain names and explorers come from the network registry, which is also what classifies each chain
 * as a mainnet or a testnet. Keeping a second copy here is how the two drifted before: a chain could
 * be named in one table and missing from another.
 */
export const CHAIN_NAMES: Record<number, string> = REGISTRY_CHAIN_NAMES;

const EXPLORERS: Record<number, string> = REGISTRY_EXPLORERS;

let deployed: Deployed = {};
try {
  const candidates = [
    join(__dirname, "..", "deployed-addresses.json"),
    join(process.cwd(), "deployed-addresses.json"),
    join(process.cwd(), "backend", "deployed-addresses.json"),
  ];
  const deployedPath = candidates.find((candidate) => existsSync(candidate));
  if (deployedPath) {
    const raw = readFileSync(deployedPath, "utf-8");
    deployed = JSON.parse(raw) as Deployed;
  }
} catch {
  // use env or empty
}

const ZERO = "0x0000000000000000000000000000000000000000";

/** Chain IDs that have a GasTank deployed (for global gas balance aggregation). */
export function getChainIdsWithGasTank(): number[] {
  return Object.entries(deployed)
    .filter(([, entry]) => {
      const gasTank = entry?.GasTank ?? ZERO;
      return gasTank && gasTank !== ZERO;
    })
    .map(([cid]) => parseInt(cid, 10))
    .filter((n) => !isNaN(n));
}

export function getVaultUsdcGasTank(chainId: number): { vault: string; usdc: string; gasTank: string } | null {
  const entry = deployed[String(chainId)];
  const usdc = resolveStable(chainId)?.address;
  if (!entry?.DCAVault || !usdc) return null;
  const gasTank = entry.GasTank ?? ZERO;
  if (!gasTank || gasTank === ZERO) return null; // skip chains without GasTank
  return { vault: entry.DCAVault, usdc, gasTank };
}

/**
 * The vault's swap adapter (DCAVault.swapRouter). 0x Swap API v2 builds calldata for one specific
 * `taker`, and the contract that actually calls AllowanceHolder is this adapter — not the vault and
 * not the relayer — so quotes must be requested with this address.
 */
export function getSwapAdapter(chainId: number): string | null {
  const adapter = deployed[String(chainId)]?.ZeroExAdapter;
  return adapter && adapter !== ZERO ? adapter : null;
}

export type NetworkContracts = {
  chainId: number;
  name: string;
  explorerUrl: string | null;
  hasGasTank: boolean;
  /** Symbol of the settlement stablecoin on this chain ("USDC", or "USDT" on BOT Chain). */
  stableSymbol: string;
  contracts: {
    DCAVault?: string;
    DCAResolver?: string;
    ZeroExAdapter?: string;
    GasTank?: string;
    USDC?: string;
  };
};

/** All deployed networks with their contract addresses (for the dashboard). */
export function getAllNetworks(): NetworkContracts[] {
  return Object.entries(deployed)
    .map(([cid, entry]) => {
      const chainId = parseInt(cid, 10);
      if (isNaN(chainId)) return null;
      const gasTank = entry.GasTank ?? ZERO;
      return {
        chainId,
        name: CHAIN_NAMES[chainId] ?? `Chain ${chainId}`,
        explorerUrl: EXPLORERS[chainId] ?? null,
        hasGasTank: Boolean(gasTank && gasTank !== ZERO),
        stableSymbol: getStableSymbol(chainId),
        contracts: {
          DCAVault: entry.DCAVault,
          DCAResolver: entry.DCAResolver,
          ZeroExAdapter: entry.ZeroExAdapter,
          GasTank: entry.GasTank,
          // The address the vault really settles in, so it always agrees with stableSymbol —
          // the table alone would name bridged USDT on a chain deployed with MockUSDC.
          USDC: resolveStable(chainId)?.address,
        },
      } as NetworkContracts;
    })
    .filter((n): n is NetworkContracts => n !== null)
    .sort((a, b) => a.chainId - b.chainId);
}

/**
 * RPC per chain: RPC_URL_<chainId> when set, else the registry's default endpoint.
 *
 * Note for BOT Chain: eth_getLogs is disabled on the public mainnet endpoint, so set RPC_URL_677 to
 * a third-party provider if log-heavy indexing is added later.
 */
export function getRpc(chainId: number): string | null {
  return getRegistryRpc(chainId);
}

/**
 * Chains whose vault swapRouter is a direct DEX adapter rather than a 0x aggregator.
 * The relayer sends empty swapData for these so DCAVault takes the ISwapRouter.swap path.
 * - 84532 / 11155111: MockSwapRouter on the Sepolia testnets
 * - 677 / 968: UniV2SwapAdapter over BDEX V2 (BOT Chain has no 0x deployment)
 */
const DIRECT_SWAP_ROUTER_CHAINS = new Set([84532, 11155111, 677, 968]);

export function usesDirectSwapRouter(chainId: number): boolean {
  return DIRECT_SWAP_ROUTER_CHAINS.has(chainId);
}

/*
 * `getGasCostPerExecutionUsdc6Fallback` used to live here: a GAS_COST_PER_EXECUTION_USDC env var
 * that fixed what a run charged when the GasTank's own `gasCostPerExecutionUsdc6` was unset. Both
 * are gone from the pricing path. A run is charged the gas it burned, read from its receipt at the
 * chain's own gas price (backend/src/run-executor.ts), so there is no longer a rate for an env var
 * to stand in for — and a fixed one could only ever be wrong in one of two directions: charging a
 * user more than their run cost, or leaving the relayer to pay the difference.
 *
 * The contract's `gasCostPerExecutionUsdc6` still exists and is still settable; nothing reads it.
 * `recordExecution` debits the amount the relayer passes it, which is now that receipt's cost.
 */
