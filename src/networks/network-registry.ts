/**
 * The registry of every network SteadyStake knows how to talk to, and which of them are mainnets.
 *
 * This is the *static* half of network allocation. It holds what only code can supply — the chain's
 * name, its explorer, its default RPC, and whether it is a mainnet or a testnet. The *dynamic* half
 * (which of these networks is currently enabled, paused, or removed) lives in
 * network-allocations.ts and is edited at runtime by an operator.
 *
 * A genuinely new chain therefore needs an entry here plus a contract deployment; the admin API can
 * only allocate chains this file already describes. That split is deliberate: "add a network" must
 * not be able to point the relayer at a chain whose vault, RPC, and stablecoin nobody has verified.
 */

export const NETWORK_TYPES = ['mainnet', 'testnet'] as const;
export type NetworkType = (typeof NETWORK_TYPES)[number];

export interface NetworkRegistryEntry {
  chainId: number;
  /** Stable slug for logs and admin tooling; never a display string. */
  key: string;
  name: string;
  /** Whether this chain settles real value. Drives the frontend's NETWORK_TYPE filter. */
  type: NetworkType;
  explorerUrl: string;
  defaultRpcUrl: string;
  nativeSymbol: string;
}

/**
 * Order is the display order. BOT Chain leads both lists because it is the partner network —
 * the same rule the frontend's switcher applies (see frontend/config/chains-env.ts).
 */
export const NETWORK_REGISTRY: readonly NetworkRegistryEntry[] = [
  {
    chainId: 677,
    key: 'botchain',
    name: 'BOT Chain',
    type: 'mainnet',
    explorerUrl: 'https://scan.botchain.ai',
    defaultRpcUrl: 'https://rpc.botchain.ai',
    nativeSymbol: 'BOT',
  },
  {
    chainId: 968,
    key: 'botchain-testnet',
    name: 'BOT Chain Testnet',
    type: 'testnet',
    explorerUrl: 'https://scan.bohr.life',
    defaultRpcUrl: 'https://rpc.bohr.life',
    nativeSymbol: 'tBOT',
  },
  {
    chainId: 8453,
    key: 'base',
    name: 'Base',
    type: 'mainnet',
    explorerUrl: 'https://basescan.org',
    defaultRpcUrl: 'https://mainnet.base.org',
    nativeSymbol: 'ETH',
  },
  {
    chainId: 84532,
    key: 'base-sepolia',
    name: 'Base Sepolia',
    type: 'testnet',
    explorerUrl: 'https://sepolia.basescan.org',
    defaultRpcUrl: 'https://sepolia.base.org',
    nativeSymbol: 'ETH',
  },
  {
    chainId: 11155111,
    key: 'eth-sepolia',
    name: 'Ethereum Sepolia',
    type: 'testnet',
    // rpc.sepolia.org frequently times out (522); PublicNode is the reliable default.
    explorerUrl: 'https://sepolia.etherscan.io',
    defaultRpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    nativeSymbol: 'ETH',
  },
  {
    chainId: 56,
    key: 'bsc',
    name: 'BSC',
    type: 'mainnet',
    explorerUrl: 'https://bscscan.com',
    defaultRpcUrl: 'https://bsc-dataseed.binance.org',
    nativeSymbol: 'BNB',
  },
  {
    chainId: 2222,
    key: 'kava',
    name: 'Kava',
    type: 'mainnet',
    explorerUrl: 'https://kavascan.com',
    defaultRpcUrl: 'https://evm.kava.io',
    nativeSymbol: 'KAVA',
  },
  {
    chainId: 137,
    key: 'polygon',
    name: 'Polygon',
    type: 'mainnet',
    explorerUrl: 'https://polygonscan.com',
    // Not polygon-rpc.com: that endpoint now answers 401 "API key disabled, tenant disabled"
    // for unauthenticated callers, which made every Polygon RPC call fail out of the box.
    defaultRpcUrl: 'https://polygon-bor-rpc.publicnode.com',
    nativeSymbol: 'POL',
  },
];

const BY_CHAIN_ID = new Map(NETWORK_REGISTRY.map((entry) => [entry.chainId, entry]));

export function getRegistryEntry(chainId: number): NetworkRegistryEntry | null {
  return BY_CHAIN_ID.get(chainId) ?? null;
}

export function isRegisteredChainId(chainId: number): boolean {
  return BY_CHAIN_ID.has(chainId);
}

/** Registry order, so callers that render the list agree with the frontend's switcher. */
export function getRegisteredChainIds(type?: NetworkType): number[] {
  return NETWORK_REGISTRY.filter((entry) => !type || entry.type === type).map((e) => e.chainId);
}

/**
 * The registry's own classification of a chain. This is the *default* type; an operator can
 * override it per chain through the allocation store, which is what "set for mainnet / set for
 * testnet" writes.
 */
export function getRegistryNetworkType(chainId: number): NetworkType | null {
  return BY_CHAIN_ID.get(chainId)?.type ?? null;
}

export function isNetworkType(value: unknown): value is NetworkType {
  return typeof value === 'string' && (NETWORK_TYPES as readonly string[]).includes(value);
}

/** Display names, keyed by chain ID — the shape the rest of the backend already consumes. */
export const REGISTRY_CHAIN_NAMES: Record<number, string> = Object.fromEntries(
  NETWORK_REGISTRY.map((entry) => [entry.chainId, entry.name]),
);

export const REGISTRY_EXPLORERS: Record<number, string> = Object.fromEntries(
  NETWORK_REGISTRY.map((entry) => [entry.chainId, entry.explorerUrl]),
);

/** RPC per chain: RPC_URL_<chainId> when set, else the registry default. */
export function getRegistryRpc(chainId: number): string | null {
  const entry = BY_CHAIN_ID.get(chainId);
  if (!entry) return null;
  return process.env[`RPC_URL_${chainId}`]?.trim() || entry.defaultRpcUrl;
}
