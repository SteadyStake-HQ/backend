/**
 * Where an initial token list comes from.
 *
 * Four providers, deliberately, because no single one answers the question a DCA list actually asks.
 * "Which tokens should a user be offered on this chain?" needs three things at once — that the token
 * is real and identified (symbol, name, decimals), that it is worth something (market cap), and that
 * it can actually be swapped (on-chain liquidity). Ranking by market cap alone offers tokens with no
 * pool on the chain, which is a plan that fails every run.
 *
 *   coingecko      identity + market-cap rank. Free, no key. Two calls: the per-platform token list
 *                  for decimals/logos, and the top-markets list to order it.
 *   geckoterminal  the liquidity signal — the chain's highest-volume pools, so what comes back is
 *                  tradable by construction. Free, no key.
 *   coinmarketcap  a second market-cap opinion. Needs CMC_API_KEY; skipped silently without one.
 *   dex            the chain's own DEX token list (PancakeSwap on BNB, QuickSwap on Polygon). This
 *                  is the list the router itself publishes, so it is the closest thing to "what this
 *                  chain's liquidity venue considers a token".
 *
 * Results are merged by address with the best rank winning, so a token both CoinGecko and the DEX
 * list know keeps its market-cap position rather than being appended twice.
 *
 * Every provider fails soft. A rate-limited CoinGecko or an unreachable DEX list means fewer tokens,
 * never a failed import — the operator is standing at a dashboard waiting for an answer, and a
 * partial list they can add to by hand beats an error.
 */

export interface SourcedToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUrl: string | null;
  /** Which provider supplied it. Stored on the row so an operator can see where the list came from. */
  source: string;
  /** Position within that provider's answer, 0-based. Lower is better; used to merge and to rank. */
  rank: number;
}

export interface SourceResult {
  source: string;
  tokens: SourcedToken[];
  /** Why this provider contributed nothing. Null on success — including a successful empty answer. */
  error: string | null;
  skipped: boolean;
  /**
   * A caveat about an answer that did arrive. Today only one thing sets it, and it is the one worth
   * saying: CoinGecko could not be ranked, so "the top 100" is really "100 of them".
   */
  note?: string | null;
}

export const TOKEN_SOURCES = ['coingecko', 'geckoterminal', 'coinmarketcap', 'dex'] as const;
export type TokenSourceName = (typeof TOKEN_SOURCES)[number];

export function isTokenSourceName(value: unknown): value is TokenSourceName {
  return typeof value === 'string' && (TOKEN_SOURCES as readonly string[]).includes(value);
}

/** CoinGecko's asset-platform id per chain — the path segment in tokens.coingecko.com. */
const COINGECKO_PLATFORM: Record<number, string> = {
  56: 'binance-smart-chain',
  137: 'polygon-pos',
  2222: 'kava',
  8453: 'base',
  677: 'bot-chain',
};

/** GeckoTerminal's own network slugs, which are not CoinGecko's. */
const GECKOTERMINAL_NETWORK: Record<number, string> = {
  56: 'bsc',
  137: 'polygon_pos',
  2222: 'kava',
  8453: 'base',
};

/**
 * CoinMarketCap names its chains in prose ("BNB Smart Chain (BEP20)"), and the string has changed
 * before, so both the platform id and the name are matched — whichever the response carries.
 */
const CMC_PLATFORM: Record<number, { id: number; names: string[] }> = {
  56: { id: 14, names: ['bnb smart chain (bep20)', 'binance smart chain (bep20)', 'bnb'] },
  137: { id: 3890, names: ['polygon'] },
  2222: { id: 4502, names: ['kava'] },
  8453: { id: 27716, names: ['base'] },
};

/** The DEX each chain's swaps actually route through, and the token list it publishes. */
const DEX_TOKEN_LIST: Record<number, { label: string; url: string }> = {
  56: { label: 'PancakeSwap', url: 'https://tokens.pancakeswap.finance/pancakeswap-extended.json' },
  137: {
    label: 'QuickSwap',
    url: 'https://unpkg.com/quickswap-default-token-list@latest/build/quickswap-default.tokenlist.json',
  },
  8453: { label: 'Uniswap', url: 'https://tokens.coingecko.com/base/all.json' },
};

/** One provider's budget. Generous: an import is an operator action, not a request path. */
const FETCH_TIMEOUT_MS = 20_000;

/** Ceiling on one provider's contribution, so a 3,000-token platform list cannot become the list. */
const MAX_PER_SOURCE = 250;

/**
 * Rank added to a source whose order means nothing.
 *
 * The DEX token lists are published alphabetically, so their "rank" is the first letter of the
 * symbol. Merged against CoinGecko's market-cap order as if the two were comparable, an obscure
 * token beginning with a digit lands above CAKE. Pushing them past everything ranked keeps what they
 * are actually good for — coverage, and confirmation that the chain's own router knows the token —
 * without letting the alphabet decide what a user sees first.
 */
const UNRANKED_OFFSET = 100_000;

/** How long to wait out a 429 before the single retry. Both free APIs here rate-limit per minute. */
const RATE_LIMIT_BACKOFF_MS = 2_500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One JSON GET, retried once on 429.
 *
 * CoinGecko and GeckoTerminal both allow ~30 calls a minute without a key, and an import of three
 * chains in a row goes through that. One backoff turns the common case — an operator clicking
 * "import" on each network in turn — from a failed source into a slow one.
 */
async function getJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, {
      headers: { accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.ok) return (await response.json()) as T;
    if (response.status === 429 && attempt === 0) {
      await sleep(RATE_LIMIT_BACKOFF_MS);
      continue;
    }
    throw new Error(`${response.status} ${response.statusText}`);
  }
}

function normalize(address: unknown): string | null {
  if (typeof address !== 'string') return null;
  const addr = (address.trim().startsWith('0x') ? address.trim() : `0x${address.trim()}`).toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(addr) ? addr : null;
}

function toDecimals(value: unknown): number | null {
  const decimals = Number(value);
  return Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : null;
}

function httpUrl(value: unknown): string | null {
  return typeof value === 'string' && /^https?:\/\//.test(value) ? value : null;
}

// -------- Uniswap-style token lists (CoinGecko platform lists and DEX lists share this shape) --------

interface TokenListJson {
  tokens?: Array<{
    chainId?: number;
    address?: string;
    name?: string;
    symbol?: string;
    decimals?: number;
    logoURI?: string;
  }>;
}

/**
 * Parse a Uniswap-standard token list, keeping only this chain's entries.
 *
 * `chainId` is filtered on rather than trusted: the DEX lists are multi-chain, and PancakeSwap's
 * extended list in particular carries entries for chains the router does not serve here.
 */
function parseTokenListJson(json: TokenListJson, chainId: number, source: string): SourcedToken[] {
  const tokens: SourcedToken[] = [];
  const seen = new Set<string>();
  for (const entry of json?.tokens ?? []) {
    if (entry?.chainId != null && Number(entry.chainId) !== chainId) continue;
    const address = normalize(entry?.address);
    const decimals = toDecimals(entry?.decimals);
    if (!address || decimals == null || seen.has(address)) continue;
    const symbol = typeof entry?.symbol === 'string' ? entry.symbol.trim() : '';
    if (!symbol) continue;
    seen.add(address);
    tokens.push({
      address,
      symbol,
      name: typeof entry?.name === 'string' && entry.name.trim() ? entry.name.trim() : symbol,
      decimals,
      logoUrl: httpUrl(entry?.logoURI),
      source,
      rank: tokens.length,
    });
  }
  return tokens;
}

// -------- CoinGecko --------

interface CoinGeckoMarket {
  id?: string;
  market_cap_rank?: number | null;
}

interface CoinGeckoCoin {
  id?: string;
  platforms?: Record<string, string | null>;
}

/** Market-cap position per chain, as `platform -> lowercase address -> rank`. */
type CoinGeckoRanking = Map<string, Map<string, number>>;

/**
 * The ranking is two calls, and both are shared across every chain — so they are made once and held.
 *
 * Without this, importing BNB then Kava then Polygon spends six calls on what is the same global
 * answer three times, and CoinGecko's unauthenticated limit (~30 a minute, and `coins/list` is a
 * 2.8MB response) is reached partway through. The failure was not an error: the import "succeeded"
 * with the platform list's own arbitrary order, so "the top 20" quietly meant "20 of the 800", and
 * nothing in the result said so.
 *
 * Only the derived table is cached, never the 2.8MB body: at most 250 addresses survive the join.
 */
const RANKING_TTL_MS = 15 * 60 * 1000;
let rankingCache: { at: number; ranking: CoinGeckoRanking } | null = null;
let rankingInflight: Promise<CoinGeckoRanking> | null = null;

async function loadRanking(): Promise<CoinGeckoRanking> {
  const [markets, coins] = await Promise.all([
    getJson<CoinGeckoMarket[]>(
      'https://api.coingecko.com/api/v3/coins/markets' +
        '?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false',
    ),
    getJson<CoinGeckoCoin[]>('https://api.coingecko.com/api/v3/coins/list?include_platform=true'),
  ]);

  const rankByCoinId = new Map<string, number>();
  markets.forEach((market, index) => {
    if (market?.id) rankByCoinId.set(market.id, index);
  });

  const ranking: CoinGeckoRanking = new Map();
  for (const coin of coins) {
    const rank = coin?.id ? rankByCoinId.get(coin.id) : undefined;
    if (rank == null || !coin.platforms) continue;
    for (const [platform, rawAddress] of Object.entries(coin.platforms)) {
      const address = normalize(rawAddress);
      if (!address) continue;
      let byAddress = ranking.get(platform);
      if (!byAddress) {
        byAddress = new Map();
        ranking.set(platform, byAddress);
      }
      // A coin can be listed under one platform once; keep the better rank if it somehow is not.
      const existing = byAddress.get(address);
      if (existing == null || rank < existing) byAddress.set(address, rank);
    }
  }
  return ranking;
}

/** Cached market-cap ranking; concurrent callers share one load. Throws when it cannot be built. */
async function getRanking(): Promise<CoinGeckoRanking> {
  if (rankingCache && Date.now() - rankingCache.at < RANKING_TTL_MS) return rankingCache.ranking;
  if (!rankingInflight) {
    rankingInflight = loadRanking()
      .then((ranking) => {
        rankingCache = { at: Date.now(), ranking };
        return ranking;
      })
      .finally(() => {
        rankingInflight = null;
      });
  }
  return rankingInflight;
}

/**
 * CoinGecko's platform token list, ordered by market cap where that can be established.
 *
 * The platform list has the metadata but no ordering — it is alphabetical-ish and thousands long,
 * so taking its first N is taking noise. The ranking above supplies the order. When it cannot be
 * built the list is still returned, because a list the operator can curate beats a failed import —
 * but it comes back with a note saying so, since an unranked "top 100" is not what was asked for.
 */
async function fromCoinGecko(
  chainId: number,
  limit: number,
): Promise<{ tokens: SourcedToken[]; note: string | null }> {
  const platform = COINGECKO_PLATFORM[chainId];
  if (!platform) throw new Error(`CoinGecko has no asset platform for chain ${chainId}`);

  const list = await getJson<TokenListJson>(`https://tokens.coingecko.com/${platform}/all.json`);
  const tokens = parseTokenListJson(list, chainId, 'coingecko');
  if (tokens.length === 0) return { tokens, note: null };

  const byAddress = new Map(tokens.map((t) => [t.address, t]));
  const ranked: SourcedToken[] = [];
  let note: string | null = null;

  try {
    const byPlatform = (await getRanking()).get(platform) ?? new Map<string, number>();
    for (const [address] of [...byPlatform].sort((a, b) => a[1] - b[1])) {
      const token = byAddress.get(address);
      if (!token) continue;
      byAddress.delete(address);
      ranked.push({ ...token, rank: ranked.length });
    }
  } catch (error) {
    note =
      `market-cap ranking unavailable (${(error as Error).message}) — these are ` +
      `${limit} of CoinGecko's tokens for this chain, not its top ${limit}`;
  }

  // Everything the ranking could not place keeps the platform list's own order, which is not an
  // order at all — so it sits behind every ranked token rather than competing with one. On a chain
  // CoinGecko tracks thinly — Kava — this is most of the answer.
  const rankedCount = ranked.length;
  for (const token of byAddress.values()) {
    ranked.push({ ...token, rank: UNRANKED_OFFSET + (ranked.length - rankedCount) });
  }
  return { tokens: ranked.slice(0, limit), note };
}

// -------- GeckoTerminal --------

interface GeckoTerminalResponse {
  included?: Array<{
    type?: string;
    attributes?: {
      address?: string;
      name?: string;
      symbol?: string;
      decimals?: number;
      image_url?: string;
    };
  }>;
}

/**
 * The tokens in the chain's highest-volume pools.
 *
 * This is the only source that answers "can this actually be swapped", which for a DCA plan is the
 * question that matters most: a plan against a token with no pool fails on every run, and the user
 * paid gas to find out. Pages are walked in order and the page number is the rank, so the top pool's
 * tokens lead the list.
 */
async function fromGeckoTerminal(chainId: number, limit: number): Promise<SourcedToken[]> {
  const network = GECKOTERMINAL_NETWORK[chainId];
  if (!network) throw new Error(`GeckoTerminal has no network for chain ${chainId}`);

  const tokens: SourcedToken[] = [];
  const seen = new Set<string>();
  // 20 pools a page, up to ~40 distinct tokens, so four pages covers the usual 100-token import.
  // Spaced out because the free API allows ~30 calls a minute and an operator importing three
  // networks in a row would otherwise spend the whole budget on the first one.
  for (let page = 1; page <= 4 && tokens.length < limit; page += 1) {
    if (page > 1) await sleep(300);
    let json: GeckoTerminalResponse;
    try {
      json = await getJson<GeckoTerminalResponse>(
        `https://api.geckoterminal.com/api/v2/networks/${network}/pools` +
          `?page=${page}&include=base_token,quote_token&sort=h24_volume_usd_desc`,
      );
    } catch (error) {
      // The rate limit is per minute, so waiting it out inside the request would cost more than the
      // remaining pages are worth. The pages already read are the highest-volume ones — keep them.
      if (tokens.length > 0) break;
      throw error;
    }
    const included = json?.included ?? [];
    if (included.length === 0) break;
    for (const item of included) {
      if (item?.type !== 'token') continue;
      const address = normalize(item.attributes?.address);
      const decimals = toDecimals(item.attributes?.decimals);
      const symbol =
        typeof item.attributes?.symbol === 'string' ? item.attributes.symbol.trim() : '';
      if (!address || decimals == null || !symbol || seen.has(address)) continue;
      seen.add(address);
      tokens.push({
        address,
        symbol,
        name:
          typeof item.attributes?.name === 'string' && item.attributes.name.trim()
            ? item.attributes.name.trim()
            : symbol,
        decimals,
        logoUrl: httpUrl(item.attributes?.image_url),
        source: 'geckoterminal',
        rank: tokens.length,
      });
    }
  }
  return tokens.slice(0, limit);
}

// -------- CoinMarketCap --------

interface CmcListing {
  name?: string;
  symbol?: string;
  cmc_rank?: number;
  platform?: { id?: number; name?: string; token_address?: string } | null;
}

/**
 * CMC's top listings, filtered to the ones issued on this chain.
 *
 * CMC does not publish decimals, so every token here is carried at 18 unless another source knows
 * better — which is why the merge below prefers a source that reports decimals. Getting decimals
 * wrong misprices a plan by orders of magnitude, so a CMC-only token is worth flagging rather than
 * trusting blindly; the dashboard shows the source per row for exactly that reason.
 */
async function fromCoinMarketCap(chainId: number, limit: number): Promise<SourcedToken[]> {
  const apiKey = process.env.CMC_API_KEY?.trim() || process.env.COINMARKETCAP_API_KEY?.trim();
  if (!apiKey) throw new Error('CMC_API_KEY is not set');
  const platform = CMC_PLATFORM[chainId];
  if (!platform) throw new Error(`CoinMarketCap has no platform mapping for chain ${chainId}`);

  const json = await getJson<{ data?: CmcListing[] }>(
    'https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest' +
      '?limit=5000&sort=market_cap&cryptocurrency_type=tokens',
    { 'X-CMC_PRO_API_KEY': apiKey },
  );

  const tokens: SourcedToken[] = [];
  const seen = new Set<string>();
  for (const listing of json?.data ?? []) {
    const listingPlatform = listing?.platform;
    if (!listingPlatform) continue;
    const nameMatch =
      typeof listingPlatform.name === 'string' &&
      platform.names.includes(listingPlatform.name.trim().toLowerCase());
    if (Number(listingPlatform.id) !== platform.id && !nameMatch) continue;
    const address = normalize(listingPlatform.token_address);
    const symbol = typeof listing?.symbol === 'string' ? listing.symbol.trim() : '';
    if (!address || !symbol || seen.has(address)) continue;
    seen.add(address);
    tokens.push({
      address,
      symbol,
      name: typeof listing?.name === 'string' && listing.name.trim() ? listing.name.trim() : symbol,
      decimals: 18,
      logoUrl: null,
      source: 'coinmarketcap',
      rank: tokens.length,
    });
    if (tokens.length >= limit) break;
  }
  return tokens;
}

// -------- DEX lists --------

/**
 * The chain's own DEX token list.
 *
 * Published alphabetically, so every token here is carried at UNRANKED_OFFSET: this source says
 * "the router knows this token", not "this token matters more than that one".
 */
async function fromDex(chainId: number, limit: number): Promise<SourcedToken[]> {
  const dex = DEX_TOKEN_LIST[chainId];
  if (!dex) throw new Error(`No DEX token list is published for chain ${chainId}`);
  const json = await getJson<TokenListJson>(dex.url);
  return parseTokenListJson(json, chainId, 'dex')
    .slice(0, limit)
    .map((token, index) => ({ ...token, rank: UNRANKED_OFFSET + index }));
}

// -------- Orchestration --------

/** Which providers can say anything at all about a chain. The dashboard offers exactly these. */
export function availableSources(chainId: number): TokenSourceName[] {
  const sources: TokenSourceName[] = [];
  if (COINGECKO_PLATFORM[chainId]) sources.push('coingecko');
  if (GECKOTERMINAL_NETWORK[chainId]) sources.push('geckoterminal');
  if (CMC_PLATFORM[chainId]) sources.push('coinmarketcap');
  if (DEX_TOKEN_LIST[chainId]) sources.push('dex');
  return sources;
}

/** Human label for a provider, for the dashboard and the import report. */
export function sourceLabel(source: string, chainId?: number): string {
  switch (source) {
    case 'coingecko':
      return 'CoinGecko';
    case 'geckoterminal':
      return 'GeckoTerminal (liquidity)';
    case 'coinmarketcap':
      return 'CoinMarketCap';
    case 'dex':
      return chainId != null && DEX_TOKEN_LIST[chainId]
        ? `${DEX_TOKEN_LIST[chainId].label} list`
        : 'DEX list';
    case 'manual':
      return 'Added by operator';
    default:
      return source;
  }
}

export function isCoinMarketCapConfigured(): boolean {
  return Boolean(process.env.CMC_API_KEY?.trim() || process.env.COINMARKETCAP_API_KEY?.trim());
}

type Fetcher = (
  chainId: number,
  limit: number,
) => Promise<{ tokens: SourcedToken[]; note: string | null }>;

/** Only CoinGecko has a caveat to report; the rest are simply what they returned. */
const plain =
  (fetcher: (chainId: number, limit: number) => Promise<SourcedToken[]>): Fetcher =>
  async (chainId, limit) => ({ tokens: await fetcher(chainId, limit), note: null });

const FETCHERS: Record<TokenSourceName, Fetcher> = {
  coingecko: fromCoinGecko,
  geckoterminal: plain(fromGeckoTerminal),
  coinmarketcap: plain(fromCoinMarketCap),
  dex: plain(fromDex),
};

/** One provider, never throwing. A failure is reported as data so the import can report it too. */
export async function fetchFromSource(
  source: TokenSourceName,
  chainId: number,
  limit = MAX_PER_SOURCE,
): Promise<SourceResult> {
  if (!availableSources(chainId).includes(source)) {
    return { source, tokens: [], error: null, skipped: true, note: null };
  }
  if (source === 'coinmarketcap' && !isCoinMarketCapConfigured()) {
    return { source, tokens: [], error: 'CMC_API_KEY is not set', skipped: true, note: null };
  }
  try {
    const { tokens, note } = await FETCHERS[source](chainId, Math.min(limit, MAX_PER_SOURCE));
    return { source, tokens, error: null, skipped: false, note };
  } catch (error) {
    return { source, tokens: [], error: (error as Error).message, skipped: false, note: null };
  }
}

/**
 * Merge several providers into one ordered list.
 *
 * A token's position is its best rank across the providers that returned it, which is what makes
 * agreement count: a token in CoinGecko's top 20 *and* in the chain's most-traded pools lands high,
 * while one that only a single provider knows sits where that provider put it. Ties break toward the
 * order `sources` was given in, so the caller's preference decides.
 *
 * Metadata comes from the first provider that reported real decimals — CMC reports none and is
 * carried at 18, so it must never overwrite a source that knows.
 */
export function mergeSources(results: SourceResult[]): SourcedToken[] {
  const merged = new Map<string, SourcedToken & { best: number; order: number }>();
  results.forEach((result, order) => {
    for (const token of result.tokens) {
      const existing = merged.get(token.address);
      if (!existing) {
        merged.set(token.address, { ...token, best: token.rank, order });
        continue;
      }
      if (token.rank < existing.best) {
        existing.best = token.rank;
        existing.order = order;
      }
      // CMC carries a placeholder 18; anything else is a real reading and wins.
      if (existing.source === 'coinmarketcap' && token.source !== 'coinmarketcap') {
        existing.decimals = token.decimals;
        existing.name = token.name;
        existing.symbol = token.symbol;
        existing.source = token.source;
      }
      if (!existing.logoUrl && token.logoUrl) existing.logoUrl = token.logoUrl;
    }
  });

  return [...merged.values()]
    .sort((a, b) => (a.best !== b.best ? a.best - b.best : a.order - b.order))
    .map((token, index) => ({
      address: token.address,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      logoUrl: token.logoUrl,
      source: token.source,
      rank: index,
    }));
}
