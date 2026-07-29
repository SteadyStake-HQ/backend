/**
 * The USD price of each chain's native token — the multiplier that turns a gas estimate into money.
 *
 * A run's cost is `gas units x gas price x native token price`. The first two are read from the
 * chain and always answer; the third comes from a public feed and is the leg that fails. It failed
 * often enough that the operator dashboard showed "no feed" on most mainnets, and because the live
 * USD figure needs all three, one missing price also blanked the whole live cost.
 *
 * Three things caused that, all fixed here:
 *
 *  - **One request per chain.** Every chain asked CoinGecko for its own token separately, so a
 *    seven-network page was seven calls in the same instant from the same IP. The free tier answers
 *    the first few and 429s the rest. Prices are now fetched for every chain in a single batched
 *    request, and only the chains that batch cannot cover fall through to their own.
 *
 *  - **One source.** CoinGecko was the only feed, so its rate limit was the whole system's rate
 *    limit. Coinbase and Binance quote the same four tokens (ETH, BNB, POL, KAVA) and are tried in
 *    turn — an outage or a throttle at one no longer reads as "this token has no price".
 *
 *  - **No timeout, no memory.** A hanging fetch hung the caller, and a failed one produced null
 *    forever after. Every request is now bounded, and a price that was good a minute ago is served
 *    (flagged `stale`) rather than thrown away, because a slightly old quote prices a run far
 *    better than no quote at all.
 */

/** Which feed a quote came from. An operator-set price and a market one are not the same claim. */
export type NativePriceSource =
  | 'override'
  | 'static'
  | 'botdex'
  | 'coingecko'
  | 'coinbase'
  | 'binance';

export interface NativePriceQuote {
  chainId: number;
  /** USD per native token. Null only when every source failed and nothing was ever cached. */
  usd: number | null;
  source: NativePriceSource | null;
  /** When this price was fetched, ISO. Null when there is no price. */
  at: string | null;
  /** True when every live source failed just now and this is the last known good price. */
  stale: boolean;
}

/** Coingecko asset IDs for native token price (USD). Testnets quote their mainnet token. */
const COINGECKO_IDS: Record<number, string> = {
  8453: 'ethereum',
  84532: 'ethereum',
  11155111: 'ethereum', // Ethereum Sepolia
  56: 'binancecoin',
  // POL, not MATIC: CoinGecko retired "matic-network" after the token migration and it now
  // returns an empty object, which read as a 0 price for every Polygon run-cost estimate.
  137: 'polygon-ecosystem-token',
  2222: 'kava',
  // BOT Chain mainnet. CoinGecko's "bot" is the fallback leg of the mainnet BOT fetch
  // (fetchBotMainnet) — the BOT Chain DEX pool price is tried first. Testnet 968 is
  // pinned via STATIC_PRICE_USD, not fetched.
  677: 'bot',
};

/**
 * Exchange ticker symbol per chain, for the non-CoinGecko sources. BOT is deliberately absent:
 * it is not listed on either exchange, and its price comes from BOT Chain's own DEX instead.
 */
const EXCHANGE_SYMBOLS: Record<number, string> = {
  8453: 'ETH',
  84532: 'ETH',
  11155111: 'ETH',
  56: 'BNB',
  137: 'POL',
  2222: 'KAVA',
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
const BOT_MAINNET_PRICE_TOKEN = '0xD5452816194a3784dBa983426cCe7c122F4abd30';

/** How long a fetched price is served without going back to the feeds. */
const FRESH_TTL_MS = 60_000;

/**
 * How long a price stays usable after every feed has started failing. A day, because the choice
 * during an outage is between yesterday's token price — which prices a run to within a few
 * percent — and no price at all, which prices it at nothing.
 */
const STALE_MAX_MS = 24 * 60 * 60 * 1000;

/** Every outbound price request is bounded: an unbounded one hung the dashboard behind it. */
const FETCH_TIMEOUT_MS = 8_000;

interface CachedPrice {
  usd: number;
  source: NativePriceSource;
  at: number;
}

const cache = new Map<number, CachedPrice>();
/** In-flight fetch per chain, so ten callers in the same tick make one request, not ten. */
const inflight = new Map<number, Promise<NativePriceQuote>>();

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

/** Manual native-token USD price per chain: NATIVE_PRICE_USD_<chainId>. Wins over every feed. */
function priceOverride(chainId: number): number | null {
  return positive(process.env[`NATIVE_PRICE_USD_${chainId}`]?.trim());
}

/** BOT Chain DEX pool price for WBOT, in USD. */
async function fetchBotDexUsd(): Promise<number | null> {
  const json = await fetchJson<{ success?: boolean; data?: { price?: string } }>(
    `https://dex-wallet.botchain.ai/api/graph/price?token=${BOT_MAINNET_PRICE_TOKEN}`,
  );
  if (!json?.success) return null;
  return positive(json.data?.price);
}

/** CoinGecko prices for several asset ids at once — one request, however many chains asked. */
async function fetchCoingeckoUsd(ids: string[]): Promise<Record<string, number>> {
  if (ids.length === 0) return {};
  const query = ids.map((id) => encodeURIComponent(id)).join(',');
  const json = await fetchJson<Record<string, { usd?: number }>>(
    `https://api.coingecko.com/api/v3/simple/price?ids=${query}&vs_currencies=usd`,
  );
  const out: Record<string, number> = {};
  for (const id of ids) {
    const usd = positive(json?.[id]?.usd);
    if (usd != null) out[id] = usd;
  }
  return out;
}

/** Coinbase spot price. Quotes ETH, BNB, POL and KAVA, and answers from datacenter IPs. */
async function fetchCoinbaseUsd(symbol: string): Promise<number | null> {
  const json = await fetchJson<{ data?: { amount?: string } }>(
    `https://api.coinbase.com/v2/prices/${encodeURIComponent(symbol)}-USD/spot`,
  );
  return positive(json?.data?.amount);
}

/**
 * Binance ticker, against USDT rather than USD. Last in the order for that reason, and because it
 * answers 451 from some regions — where it does answer, it is one more independent opinion.
 */
async function fetchBinanceUsd(symbol: string): Promise<number | null> {
  const json = await fetchJson<{ price?: string }>(
    `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}USDT`,
  );
  return positive(json?.price);
}

function quoteFromCache(chainId: number, stale: boolean): NativePriceQuote {
  const hit = cache.get(chainId);
  if (!hit) return { chainId, usd: null, source: null, at: null, stale: false };
  return {
    chainId,
    usd: hit.usd,
    source: hit.source,
    at: new Date(hit.at).toISOString(),
    stale,
  };
}

function remember(chainId: number, usd: number, source: NativePriceSource): NativePriceQuote {
  cache.set(chainId, { usd, source, at: Date.now() });
  return quoteFromCache(chainId, false);
}

/** A configured price, when one exists. Neither is fetched, so neither can fail or go stale. */
function pinnedQuote(chainId: number): NativePriceQuote | null {
  const override = priceOverride(chainId);
  if (override != null) {
    return { chainId, usd: override, source: 'override', at: new Date().toISOString(), stale: false };
  }
  const staticUsd = STATIC_PRICE_USD[chainId];
  if (staticUsd != null) {
    return { chainId, usd: staticUsd, source: 'static', at: new Date().toISOString(), stale: false };
  }
  return null;
}

/** Every live source for one chain, in order, stopping at the first that answers. */
async function fetchOneChain(chainId: number): Promise<NativePriceQuote> {
  if (chainId === 677) {
    const dex = await fetchBotDexUsd();
    if (dex != null) return remember(chainId, dex, 'botdex');
  }

  const cgId = COINGECKO_IDS[chainId];
  if (cgId) {
    const prices = await fetchCoingeckoUsd([cgId]);
    if (prices[cgId] != null) return remember(chainId, prices[cgId], 'coingecko');
  }

  const symbol = EXCHANGE_SYMBOLS[chainId];
  if (symbol) {
    const coinbase = await fetchCoinbaseUsd(symbol);
    if (coinbase != null) return remember(chainId, coinbase, 'coinbase');
    const binance = await fetchBinanceUsd(symbol);
    if (binance != null) return remember(chainId, binance, 'binance');
  }

  // Nothing answered. The last good price beats no price; `stale` says which this is.
  const hit = cache.get(chainId);
  if (hit && Date.now() - hit.at < STALE_MAX_MS) return quoteFromCache(chainId, true);
  return { chainId, usd: null, source: null, at: null, stale: false };
}

/**
 * The USD price of a chain's native token, with the feed it came from and whether it is current.
 * Cached for a minute; concurrent callers for the same chain share one request.
 */
export async function getNativePriceQuote(chainId: number): Promise<NativePriceQuote> {
  const pinned = pinnedQuote(chainId);
  if (pinned) return pinned;

  const hit = cache.get(chainId);
  if (hit && Date.now() - hit.at < FRESH_TTL_MS) return quoteFromCache(chainId, false);

  const existing = inflight.get(chainId);
  if (existing) return existing;

  const pending = fetchOneChain(chainId).finally(() => inflight.delete(chainId));
  inflight.set(chainId, pending);
  return pending;
}

/** Native token price in USD, or 0 when nothing quotes it — the shape the executor consumes. */
export async function getNativePriceUsd(chainId: number): Promise<number> {
  return (await getNativePriceQuote(chainId)).usd ?? 0;
}

/**
 * Warm the cache for several chains at once. This is the call that keeps the free CoinGecko tier
 * usable: the chains it can cover go out as a single request, and only what is left over — BOT
 * Chain's DEX price, and anything CoinGecko did not answer for — falls back to a per-chain fetch.
 */
export async function prefetchNativePrices(chainIds: number[]): Promise<void> {
  const wanted = [...new Set(chainIds)].filter((chainId) => {
    if (pinnedQuote(chainId)) return false;
    const hit = cache.get(chainId);
    return !hit || Date.now() - hit.at >= FRESH_TTL_MS;
  });
  if (wanted.length === 0) return;

  // BOT Chain has its own DEX-first path; batching its bare ticker here would shadow that.
  const batchable = wanted.filter((chainId) => chainId !== 677 && COINGECKO_IDS[chainId]);
  const ids = [...new Set(batchable.map((chainId) => COINGECKO_IDS[chainId]))];
  const prices = await fetchCoingeckoUsd(ids);
  for (const chainId of batchable) {
    const usd = prices[COINGECKO_IDS[chainId]];
    if (usd != null) remember(chainId, usd, 'coingecko');
  }

  // Whatever the batch missed still gets its own chance at the other feeds.
  const remaining = wanted.filter((chainId) => {
    const hit = cache.get(chainId);
    return !hit || Date.now() - hit.at >= FRESH_TTL_MS;
  });
  await Promise.all(remaining.map((chainId) => getNativePriceQuote(chainId).catch(() => undefined)));
}
