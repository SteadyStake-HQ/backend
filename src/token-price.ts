/**
 * The USD price of an arbitrary ERC-20 — the number a DCA plan is actually about.
 *
 * `native-price.ts` answers "what does gas cost", which is a fixed handful of tokens with a
 * ticker on every exchange. This answers "what is the token this plan buys worth", which is any
 * address an operator has listed or a user has pasted, so the sources have to be address-based:
 *
 *  - **DexScreener**, which quotes the pool a swap would actually route through — the price a DCA
 *    run will really get — and covers tokens too new or too small for anyone to have listed.
 *  - **GeckoTerminal**, the batch feed: thirty addresses per call, keyless. This is what prices a
 *    whole picker's worth of tokens without thirty separate requests.
 *  - **CoinGecko**, via simple/token_price for the chain's asset platform. One address per call on
 *    the keyless tier (see COINGECKO_BATCH), so it is a single-token fallback and nothing more.
 *  - **BOT Chain's own DEX** for BOT Chain, where none of the above has any coverage.
 *
 * Which is tried first depends on how many tokens were asked for, and it is a consequence of their
 * shapes rather than a preference — see fetchBatch.
 *
 * Deliberately shaped like native-price.ts — same TTL, same stale-rather-than-null fallback, same
 * one-request-per-key coalescing — because the failure mode is the same one: a price that is a
 * little old still tells a user what their plan is buying, and a null tells them nothing.
 *
 * Testnet mock tokens have no market and no feed will quote them. `TOKEN_PRICE_USD_<chainId>_<addr>`
 * pins one by hand, the same escape hatch `NATIVE_PRICE_USD_<chainId>` is for gas.
 */

/** Which feed a quote came from. An operator-set price and a market one are not the same claim. */
export type TokenPriceSource =
  | 'override'
  | 'dexscreener'
  | 'coingecko'
  | 'geckoterminal'
  | 'botdex';

export interface TokenPriceQuote {
  chainId: number;
  /** Lowercased contract address this quote is for. */
  address: string;
  /** USD per token. Null only when every source failed and nothing was ever cached. */
  usd: number | null;
  source: TokenPriceSource | null;
  /** When this price was fetched, ISO. Null when there is no price. */
  at: string | null;
  /** True when every live source failed just now and this is the last known good price. */
  stale: boolean;
}

/** DexScreener's chain slugs, which are its own and not CoinGecko's. */
const DEXSCREENER_CHAIN: Record<number, string> = {
  1: 'ethereum',
  56: 'bsc',
  137: 'polygon',
  2222: 'kava',
  8453: 'base',
};

/**
 * GeckoTerminal's own network slugs, which are neither DexScreener's nor CoinGecko's. Kept in step
 * with GECKOTERMINAL_NETWORK in tokens/token-sources.ts, which uses the same ids for the token list.
 */
const GECKOTERMINAL_NETWORK: Record<number, string> = {
  1: 'eth',
  56: 'bsc',
  137: 'polygon_pos',
  2222: 'kava',
  8453: 'base',
};

/**
 * CoinGecko's asset-platform id per chain — the path segment in simple/token_price. Kept in step
 * with COINGECKO_PLATFORM in tokens/token-sources.ts, which uses the same ids for the token list.
 */
const COINGECKO_PLATFORM: Record<number, string> = {
  1: 'ethereum',
  56: 'binance-smart-chain',
  137: 'polygon-pos',
  2222: 'kava',
  8453: 'base',
  677: 'bot-chain',
};

/** Chains whose token prices come from BOT Chain's own DEX, which is the only venue quoting them. */
const BOTDEX_CHAINS = new Set([677]);

/** How long a fetched price is served without going back to the feeds. */
const FRESH_TTL_MS = 60_000;

/**
 * How long a price stays usable after every feed has started failing. Shorter than native-price's
 * day: this figure is shown to a user as "what your token is worth right now", and a small-cap
 * token can move much further in a day than ETH can.
 */
const STALE_MAX_MS = 6 * 60 * 60 * 1000;

/** Every outbound price request is bounded: an unbounded one hangs the page waiting on it. */
const FETCH_TIMEOUT_MS = 8_000;

/**
 * Addresses per DexScreener request — one, deliberately.
 *
 * Its token endpoint accepts thirty, but it answers with at most thirty *pairs* in total, and a
 * liquid token has ten or more pools across chains on its own. Measured: asking for four addresses
 * at once, WETH's pools alone filled the response and USDC came back absent — indistinguishable from
 * "no feed quotes this token". Anything above one address silently loses the tokens that happen to
 * sort after a popular one, so the requests are fanned out per token instead, in parallel.
 */
const DEXSCREENER_BATCH = 1;

/** GeckoTerminal's documented cap for tokens/multi, and the reason it is the batch source. */
const GECKOTERMINAL_BATCH = 30;

/**
 * Addresses per CoinGecko request — one, because that is what the keyless tier allows.
 *
 * This was 50 on the belief that simple/token_price had no hard cap. It does now: anything above one
 * address is rejected outright with `error_code: 10012`, "Number of contract addresses in the
 * request exceeds the allowed limit of 1 contract address". Measured against the live BNB Chain list,
 * every batched CoinGecko call was returning HTTP 400 and therefore nothing, silently — the whole
 * source was dead in the multi-address path while looking like a chain no feed covers.
 *
 * Left at one rather than raised, and CoinGecko dropped from the batch path entirely (see
 * fetchBatch): fanning a hundred tokens out one request each would trip its rate limit long before
 * it answered. GeckoTerminal is the batch feed now.
 */
const COINGECKO_BATCH = 1;

interface CachedPrice {
  usd: number;
  source: TokenPriceSource;
  at: number;
}

const cache = new Map<string, CachedPrice>();
/** In-flight fetch per token, so ten callers in the same tick make one request, not ten. */
const inflight = new Map<string, Promise<TokenPriceQuote>>();
/** Background refreshes started by peekTokenPriceQuotes, which nobody awaits. */
const warming = new Set<string>();

const cacheKey = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`;

function isAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

/** Lowercased address, or null when the input is not one. */
export function normalizeTokenAddress(value: unknown): string | null {
  return isAddress(value) ? value.trim().toLowerCase() : null;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function positive(value: unknown): number | null {
  const n = typeof value === 'string' ? parseFloat(value) : (value as number);
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Manual price per token: `TOKEN_PRICE_USD_<chainId>_<address>`. Wins over every feed — it exists
 * for tokens no feed quotes at all, which on a testnet is all of them.
 *
 * The variable name is matched case-insensitively on the address part, and with or without the `0x`.
 * An operator setting this will paste whatever their explorer gave them, which is usually the
 * checksummed mixed-case form, and environment variable names are case-sensitive — so the lookup
 * scans for the prefix rather than guessing which casing was used.
 */
function priceOverride(chainId: number, address: string): number | null {
  const prefix = `TOKEN_PRICE_USD_${chainId}_`;
  const bare = address.toLowerCase().replace(/^0x/, '');
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length).toLowerCase().replace(/^0x/, '');
    if (suffix !== bare) continue;
    const usd = positive(value?.trim());
    if (usd != null) return usd;
  }
  return null;
}

interface DexScreenerPair {
  chainId?: string;
  baseToken?: { address?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
}

/**
 * DexScreener prices for several addresses on one chain, in a single request.
 *
 * A token has many pools and they do not all agree — a stale pool with $40 of liquidity quotes a
 * price a swap could never get — so the deepest pool on the right chain wins. Pairs where the token
 * is the *quote* side are ignored: `priceUsd` there is the other token's price, not this one's.
 */
async function fetchDexScreenerUsd(chainId: number, addresses: string[]): Promise<Record<string, number>> {
  const slug = DEXSCREENER_CHAIN[chainId];
  if (!slug || addresses.length === 0) return {};

  const out: Record<string, number> = {};
  const best: Record<string, number> = {};

  const chunks: string[][] = [];
  for (let i = 0; i < addresses.length; i += DEXSCREENER_BATCH) {
    chunks.push(addresses.slice(i, i + DEXSCREENER_BATCH));
  }

  // In parallel: the picker waits on this, and a list of thirty tokens is eight small requests
  // rather than one big one. Every request is individually bounded (see fetchJson).
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const json = await fetchJson<{ pairs?: DexScreenerPair[] | null }>(
        `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`,
      );
      return { chunk, pairs: json?.pairs ?? [] };
    }),
  );

  for (const { chunk, pairs } of results) {
    for (const pair of pairs) {
      // The response spans every chain the address exists on — the same address is a different
      // token on each — so the chain has to match before the price means anything.
      if (pair.chainId !== slug) continue;
      const base = normalizeTokenAddress(pair.baseToken?.address);
      if (base == null || !chunk.includes(base)) continue;
      const usd = positive(pair.priceUsd);
      if (usd == null) continue;
      const liquidity = typeof pair.liquidity?.usd === 'number' ? pair.liquidity.usd : 0;
      if (out[base] == null || liquidity > best[base]) {
        out[base] = usd;
        best[base] = liquidity;
      }
    }
  }
  return out;
}

interface GeckoTerminalToken {
  attributes?: { address?: string; price_usd?: string | null };
}

/**
 * GeckoTerminal prices for several addresses on one chain, thirty per request.
 *
 * Its price is the token's across the pools it indexes rather than one chosen pool, so it answers
 * for tokens whose deepest pool DexScreener happens not to return — and it does it for a whole
 * picker in a handful of calls, which is the property that matters here.
 */
async function fetchGeckoTerminalUsd(
  chainId: number,
  addresses: string[],
): Promise<Record<string, number>> {
  const network = GECKOTERMINAL_NETWORK[chainId];
  if (!network || addresses.length === 0) return {};

  const chunks: string[][] = [];
  for (let i = 0; i < addresses.length; i += GECKOTERMINAL_BATCH) {
    chunks.push(addresses.slice(i, i + GECKOTERMINAL_BATCH));
  }

  const out: Record<string, number> = {};
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const json = await fetchJson<{ data?: GeckoTerminalToken[] | null }>(
        `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/multi/${chunk.join(',')}`,
      );
      return { chunk, data: json?.data ?? [] };
    }),
  );

  for (const { chunk, data } of results) {
    for (const token of data) {
      const address = normalizeTokenAddress(token.attributes?.address);
      if (address == null || !chunk.includes(address)) continue;
      const usd = positive(token.attributes?.price_usd);
      if (usd != null) out[address] = usd;
    }
  }
  return out;
}

/** CoinGecko prices for several addresses on one chain's asset platform, in a single request. */
async function fetchCoingeckoUsd(chainId: number, addresses: string[]): Promise<Record<string, number>> {
  const platform = COINGECKO_PLATFORM[chainId];
  if (!platform || addresses.length === 0) return {};

  const out: Record<string, number> = {};
  for (let i = 0; i < addresses.length; i += COINGECKO_BATCH) {
    const chunk = addresses.slice(i, i + COINGECKO_BATCH);
    const json = await fetchJson<Record<string, { usd?: number }>>(
      `https://api.coingecko.com/api/v3/simple/token_price/${platform}` +
        `?contract_addresses=${chunk.map((a) => encodeURIComponent(a)).join(',')}&vs_currencies=usd`,
    );
    if (!json) continue;
    // CoinGecko echoes the address back lowercased, but it has not always, so match case-insensitively.
    for (const [key, value] of Object.entries(json)) {
      const address = normalizeTokenAddress(key);
      const usd = positive(value?.usd);
      if (address != null && usd != null && chunk.includes(address)) out[address] = usd;
    }
  }
  return out;
}

/** BOT Chain's DEX pool price for one token, in USD. */
async function fetchBotDexUsd(address: string): Promise<number | null> {
  const json = await fetchJson<{ success?: boolean; data?: { price?: string } }>(
    `https://dex-wallet.botchain.ai/api/graph/price?token=${encodeURIComponent(address)}`,
  );
  if (!json?.success) return null;
  return positive(json.data?.price);
}

function quoteFromCache(chainId: number, address: string, stale: boolean): TokenPriceQuote {
  const hit = cache.get(cacheKey(chainId, address));
  if (!hit) return { chainId, address, usd: null, source: null, at: null, stale: false };
  return {
    chainId,
    address,
    usd: hit.usd,
    source: hit.source,
    at: new Date(hit.at).toISOString(),
    stale,
  };
}

function remember(chainId: number, address: string, usd: number, source: TokenPriceSource): TokenPriceQuote {
  cache.set(cacheKey(chainId, address), { usd, source, at: Date.now() });
  return quoteFromCache(chainId, address, false);
}

/** A configured price, when one exists. Not fetched, so it cannot fail or go stale. */
function pinnedQuote(chainId: number, address: string): TokenPriceQuote | null {
  const override = priceOverride(chainId, address);
  if (override == null) return null;
  return { chainId, address, usd: override, source: 'override', at: new Date().toISOString(), stale: false };
}

function fresh(chainId: number, address: string): TokenPriceQuote | null {
  const hit = cache.get(cacheKey(chainId, address));
  if (hit && Date.now() - hit.at < FRESH_TTL_MS) return quoteFromCache(chainId, address, false);
  return null;
}

/** Last known good price when it is still inside the stale window, else an empty quote. */
function fallbackQuote(chainId: number, address: string): TokenPriceQuote {
  const hit = cache.get(cacheKey(chainId, address));
  if (hit && Date.now() - hit.at < STALE_MAX_MS) return quoteFromCache(chainId, address, true);
  return { chainId, address, usd: null, source: null, at: null, stale: false };
}

/**
 * Every live source for one chain's worth of addresses, stopping per address at the first that
 * answers. The order depends on how many were asked for, and it is not a preference — it is the
 * feeds' shapes:
 *
 *  - **One address** (the executor stamping a buy, a plan page): DexScreener first. Its answer is
 *    the price of the pool a swap would actually route through, and it covers tokens too new or too
 *    small for anyone to have listed. CoinGecko and GeckoTerminal then get their turn — at one
 *    address each is as cheap as the other.
 *  - **Many** (the picker): GeckoTerminal first, because thirty addresses per call is the only way
 *    to price a hundred-token list without a hundred requests. DexScreener then fills in what it
 *    does not know, in the single-address chunks its 30-pair response cap forces.
 *
 * CoinGecko is deliberately absent from the many-address path: its keyless tier takes one address
 * per request (see COINGECKO_BATCH), so using it there would mean one request per token.
 */
async function fetchBatch(chainId: number, addresses: string[]): Promise<void> {
  let missing = addresses;
  const stillMissing = () => missing.filter((address) => fresh(chainId, address) == null);

  if (BOTDEX_CHAINS.has(chainId)) {
    const found = await Promise.all(
      missing.map(async (address) => [address, await fetchBotDexUsd(address)] as const),
    );
    for (const [address, usd] of found) {
      if (usd != null) remember(chainId, address, usd, 'botdex');
    }
    missing = stillMissing();
    if (missing.length === 0) return;
  }

  const dexFirst = missing.length === 1;

  if (!dexFirst) {
    const terminal = await fetchGeckoTerminalUsd(chainId, missing);
    for (const [address, usd] of Object.entries(terminal)) {
      remember(chainId, address, usd, 'geckoterminal');
    }
    missing = stillMissing();
    if (missing.length === 0) return;
  }

  const dex = await fetchDexScreenerUsd(chainId, missing);
  for (const [address, usd] of Object.entries(dex)) remember(chainId, address, usd, 'dexscreener');
  missing = stillMissing();
  if (missing.length === 0) return;

  if (dexFirst) {
    const gecko = await fetchCoingeckoUsd(chainId, missing);
    for (const [address, usd] of Object.entries(gecko)) remember(chainId, address, usd, 'coingecko');
    missing = stillMissing();
    if (missing.length === 0) return;

    const terminal = await fetchGeckoTerminalUsd(chainId, missing);
    for (const [address, usd] of Object.entries(terminal)) {
      remember(chainId, address, usd, 'geckoterminal');
    }
  }
}

/**
 * USD prices for several tokens on one chain. One request per source for the whole list, which is
 * what makes it usable from the token picker: a list of thirty tokens is two calls, not sixty.
 *
 * Always returns one quote per requested address, in the order asked, including for addresses
 * nothing could price — "no feed quotes this token" is an answer the UI has to be able to show.
 */
export async function getTokenPriceQuotes(
  chainId: number,
  addresses: string[],
): Promise<TokenPriceQuote[]> {
  const wanted: string[] = [];
  for (const raw of addresses) {
    const address = normalizeTokenAddress(raw);
    if (address != null && !wanted.includes(address)) wanted.push(address);
  }
  if (wanted.length === 0) return [];

  const needFetch = wanted.filter(
    (address) => pinnedQuote(chainId, address) == null && fresh(chainId, address) == null,
  );
  if (needFetch.length > 0) {
    // A single-token ask goes through the per-token coalescing path so a page that asks for one
    // token in ten components does not fire ten identical batches.
    if (needFetch.length === 1) {
      await getTokenPriceQuote(chainId, needFetch[0]);
    } else {
      await fetchBatch(chainId, needFetch).catch(() => undefined);
    }
  }

  return wanted.map(
    (address) =>
      pinnedQuote(chainId, address) ?? fresh(chainId, address) ?? fallbackQuote(chainId, address),
  );
}

/**
 * The USD price of one token, with the feed it came from and whether it is current. Cached for a
 * minute; concurrent callers for the same token share one request.
 */
export async function getTokenPriceQuote(chainId: number, address: string): Promise<TokenPriceQuote> {
  const normalized = normalizeTokenAddress(address);
  if (normalized == null) {
    return { chainId, address: String(address), usd: null, source: null, at: null, stale: false };
  }

  const pinned = pinnedQuote(chainId, normalized);
  if (pinned) return pinned;

  const hit = fresh(chainId, normalized);
  if (hit) return hit;

  const key = cacheKey(chainId, normalized);
  const existing = inflight.get(key);
  if (existing) return existing;

  const pending = fetchBatch(chainId, [normalized])
    .then(() => fresh(chainId, normalized) ?? fallbackQuote(chainId, normalized))
    .catch(() => fallbackQuote(chainId, normalized))
    .finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
}

/**
 * Whatever is already known about these tokens, without waiting for a feed, and a refresh started
 * in the background for anything missing or gone stale.
 *
 * For callers on a hot path — the plan-timing poll runs every five seconds and a countdown is
 * behind it — where a cache miss must not become an eight-second wait. The first call after a cold
 * start answers `usd: null` and the next one, a few seconds later, has the price.
 */
export function peekTokenPriceQuotes(chainId: number, addresses: string[]): TokenPriceQuote[] {
  const wanted: string[] = [];
  for (const raw of addresses) {
    const address = normalizeTokenAddress(raw);
    if (address != null && !wanted.includes(address)) wanted.push(address);
  }
  if (wanted.length === 0) return [];

  const missing = wanted.filter(
    (address) => pinnedQuote(chainId, address) == null && fresh(chainId, address) == null,
  );
  if (missing.length > 0) {
    // Deliberately not awaited. Coalescing lives in the callers that await, so this needs its own
    // guard — otherwise a five-second poll fires a fresh batch while the previous one is still out.
    const key = `${chainId}:${missing.join(',')}`;
    if (!warming.has(key)) {
      warming.add(key);
      void fetchBatch(chainId, missing)
        .catch(() => undefined)
        .finally(() => warming.delete(key));
    }
  }

  return wanted.map(
    (address) =>
      pinnedQuote(chainId, address) ?? fresh(chainId, address) ?? fallbackQuote(chainId, address),
  );
}

/** Token price in USD, or null when nothing quotes it — the shape the executor records. */
export async function getTokenPriceUsd(chainId: number, address: string): Promise<number | null> {
  return (await getTokenPriceQuote(chainId, address)).usd;
}
