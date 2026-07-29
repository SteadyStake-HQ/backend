/**
 * ERC-20 identity — symbol, name, decimals — and where to find the token's logo.
 *
 * Two pages need this and they need it about the same tokens: the plan-activity list labels every
 * plan with what it buys, and the treasury page groups executions by the token they bought. Both
 * poll, and a chain can hold hundreds of plans against a handful of distinct tokens, so the read is
 * cached per `chainId:address` for the life of the process and concurrent callers share one call.
 *
 * Nothing here throws. A token that does not answer `symbol()` — a bytes32-symbol token, or a chain
 * that is simply down — is not an error worth surfacing; the caller falls back to the address, which
 * is the thing that actually identifies the token anyway.
 */

import { createPublicClient, http } from 'viem';
import { getRpc } from './config';
import { getChain } from './run-executor';

const ERC20_METADATA_ABI = [
  { type: 'function', name: 'symbol', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
  { type: 'function', name: 'name', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
] as const;

export interface TokenMeta {
  chainId: number;
  address: string;
  /** ERC-20 symbol, or null when the token does not answer `symbol()`. */
  symbol: string | null;
  /** ERC-20 name, or null. Tokens far more often omit this than they omit the symbol. */
  name: string | null;
  /** ERC-20 decimals. Null when unreadable — never assumed to be 18. */
  decimals: number | null;
  /** Best-effort logo URL, or null on a chain with no asset repo. See `logoUrl` below. */
  logoUrl: string | null;
}

/**
 * Trust Wallet's asset repository, keyed by its own chain slugs. It is a CDN of static PNGs with no
 * key and no rate limit, which is why it is used rather than a token-list API: the dashboard asks
 * for a logo once per token per page load, from the browser, and a miss is a 404 the `<img>` handles.
 *
 * BOT Chain (677/968) has no assets repo, so its tokens fall through to no logo and the UI draws a
 * lettered avatar instead. That is the common case on the partner network, not an edge case.
 */
const TRUST_CHAIN_SLUG: Record<number, string> = {
  8453: 'base',
  56: 'smartchain',
  137: 'polygon',
  2222: 'kavaevm',
  11155111: 'ethereum',
};

const TRUST_CDN = 'https://assets-cdn.trustwallet.com/blockchains';

/** Where a token's logo can be fetched from, or null when this chain has no asset repo. */
export function logoUrl(chainId: number, address: string): string | null {
  const slug = TRUST_CHAIN_SLUG[chainId];
  if (!slug) return null;
  const addr = (address.startsWith('0x') ? address : `0x${address}`).toLowerCase();
  return `${TRUST_CDN}/${slug}/assets/${addr}/logo.png`;
}

interface CacheEntry {
  meta: TokenMeta;
  /** When a failed read may be retried. Infinity once anything was read — this never changes. */
  retryAt: number;
}

const cache = new Map<string, CacheEntry>();
/** Reads in flight, so ten plans holding the same token make one call rather than racing. */
const inflight = new Map<string, Promise<TokenMeta>>();

/**
 * How long a completely failed read is held before trying again. A token with no `symbol()` is
 * permanent and an unreachable RPC is not, but the two are not worth telling apart when the retry
 * costs one call every ten minutes.
 */
const RETRY_MS = 10 * 60 * 1000;

const key = (chainId: number, token: string) => `${chainId}:${token.toLowerCase()}`;

function empty(chainId: number, address: string): TokenMeta {
  return { chainId, address, symbol: null, name: null, decimals: null, logoUrl: logoUrl(chainId, address) };
}

async function read(chainId: number, address: string): Promise<TokenMeta> {
  const rpcUrl = getRpc(chainId);
  const chain = getChain(chainId);
  if (!rpcUrl || !chain) return empty(chainId, address);

  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  const token = address as `0x${string}`;
  const call = <T>(functionName: 'symbol' | 'name' | 'decimals') =>
    client.readContract({ address: token, abi: ERC20_METADATA_ABI, functionName }).then(
      (value) => value as T,
      () => null,
    );

  // Settled independently: a token that answers `symbol()` but not `name()` is common, and losing
  // the symbol because the name reverted would be the worse outcome by far.
  const [symbol, name, decimals] = await Promise.all([
    call<string>('symbol'),
    call<string>('name'),
    call<number>('decimals'),
  ]);

  const clean = (value: string | null) => {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
  };

  return {
    chainId,
    address,
    symbol: clean(symbol),
    name: clean(name),
    decimals: typeof decimals === 'number' && Number.isFinite(decimals) ? decimals : null,
    logoUrl: logoUrl(chainId, address),
  };
}

/** Identity of one ERC-20, from cache when known. Never throws. */
export function getTokenMeta(chainId: number, address: string): Promise<TokenMeta> {
  const cacheKey = key(chainId, address);
  const cached = cache.get(cacheKey);
  if (cached && Date.now() < cached.retryAt) return Promise.resolve(cached.meta);

  const existing = inflight.get(cacheKey);
  if (existing) return existing;

  const pending = read(chainId, address)
    .then((meta) => {
      // Anything at all came back means the token answered, so the entry is permanent. Symbols,
      // names and decimals do not change.
      const known = meta.symbol != null || meta.name != null || meta.decimals != null;
      cache.set(cacheKey, { meta, retryAt: known ? Infinity : Date.now() + RETRY_MS });
      return meta;
    })
    .finally(() => {
      inflight.delete(cacheKey);
    });

  inflight.set(cacheKey, pending);
  return pending;
}

/** Just the symbol — the shape the plan list consumes. Null means "show the address". */
export async function getTokenSymbol(chainId: number, address: string): Promise<string | null> {
  return (await getTokenMeta(chainId, address)).symbol;
}

/**
 * Metadata for many tokens at once, keyed by `chainId:loweraddress`.
 *
 * Every distinct token is one call and cache hits cost nothing, so a page listing a thousand
 * executions across six tokens makes at most six requests the first time and none after.
 */
export async function getTokenMetaMap(
  tokens: Array<{ chainId: number; address: string }>,
): Promise<Map<string, TokenMeta>> {
  const distinct = new Map<string, { chainId: number; address: string }>();
  for (const token of tokens) {
    if (!token?.address) continue;
    distinct.set(key(token.chainId, token.address), token);
  }

  const entries = await Promise.all(
    [...distinct].map(async ([cacheKey, token]) => {
      const meta = await getTokenMeta(token.chainId, token.address).catch(() =>
        empty(token.chainId, token.address),
      );
      return [cacheKey, meta] as const;
    }),
  );

  return new Map(entries);
}
