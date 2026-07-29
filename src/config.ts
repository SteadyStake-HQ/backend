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
  84532: "0xAbd1a2748Bc70bD439F0438C22D1E92C0Eae3dA8",
  11155111: "0x89A01f63A5F4b42d30483ee17c5f537A4B94b15E",
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

/**
 * Optional fallback: fixed gas cost per execution in USDC (6 decimals).
 *
 * This is a *fallback*, not an override. The GasTank's own `gasCostPerExecutionUsdc6` is the
 * source of truth, because that is the number the frontend quotes to the user and prepays into
 * the tank at plan creation. When this env var outranked the contract the two disagreed —
 * the UI charged the contract price and the relayer deducted the env price — so a plan funded
 * to completion could still run the tank dry mid-way and then fail every deduction silently.
 * Used only when the contract has no price set (returns 0).
 */
export function getGasCostPerExecutionUsdc6Fallback(): bigint | null {
  const raw = process.env.GAS_COST_PER_EXECUTION_USDC?.trim();
  if (!raw) return null;
  const usd = parseFloat(raw);
  if (!Number.isFinite(usd) || usd <= 0) return null;
  return BigInt(Math.round(usd * 1_000_000)); // 6 decimals
}
