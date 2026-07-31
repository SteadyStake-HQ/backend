import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  clearChainTokens,
  countTokensByChain,
  deleteToken,
  getToken,
  isAddressLike,
  listTokens,
  normalizeAddress,
  setTokenEnabled,
  upsertToken,
  upsertTokens,
  type TokenListEntry,
} from '../supabase/token-list';
import {
  availableSources,
  fetchFromSource,
  isCoinMarketCapConfigured,
  isTokenSourceName,
  mergeSources,
  sourceLabel,
  type SourceResult,
  type TokenSourceName,
} from './token-sources';
import { getStableAddress, getStableSymbol } from '../config';
import { getTokenMeta, logoUrl } from '../token-metadata';
import {
  getRegistryEntry,
  isRegisteredChainId,
  NETWORK_REGISTRY,
} from '../networks/network-registry';

/** One token as every consumer sees it — the dashboard, and (minus the operator fields) the app. */
export interface TokenView {
  chainId: number;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUrl: string | null;
  source: string;
  sourceLabel: string;
  enabled: boolean;
  addedBy: string | null;
  updatedAt: string;
}

export interface ChainTokenSummary {
  chainId: number;
  name: string;
  type: string;
  stableSymbol: string;
  /** Tokens users can currently pick on this chain. */
  enabled: number;
  /** Including the ones an operator has removed. */
  total: number;
  /** Providers that can supply an initial list here. */
  sources: Array<{ id: TokenSourceName; label: string; configured: boolean }>;
}

export interface ImportReport {
  chainId: number;
  requested: TokenSourceName[];
  /** Per provider: how many it returned, why it returned nothing, and any caveat about what it did. */
  sources: Array<{
    id: string;
    label: string;
    count: number;
    error: string | null;
    skipped: boolean;
    note: string | null;
  }>;
  /** Distinct tokens after merging the providers. */
  merged: number;
  /** Rows written. Lower than `merged` when tokens were skipped — see `skipped`. */
  imported: number;
  /** Tokens deliberately not written, with the reason. Currently only the settlement stablecoin. */
  skipped: Array<{ address: string; symbol: string; reason: string }>;
  /** Rows dropped first, when the import was asked to replace rather than merge. */
  cleared: number;
  replaced: boolean;
}

/** A hand-typed name or symbol goes in a table cell and into the app; keep both short. */
const MAX_SYMBOL_LENGTH = 32;
const MAX_NAME_LENGTH = 120;

/**
 * Which tokens each network offers, and where that list came from.
 *
 * The list used to be a build artifact — a JSON file the frontend imported, refreshed by running a
 * script and committing the result — so changing what a network offered meant a redeploy and every
 * deployment offered whatever its bundle happened to contain. This service makes it operator state:
 * imported from providers on demand, edited token by token, read by the app at runtime.
 *
 * Nothing here is cached. A list is at most a few hundred rows on one indexed table, and the point
 * of the feature is that a removal takes effect now rather than at the next deploy.
 */
@Injectable()
export class TokenListService {
  private readonly logger = new Logger(TokenListService.name);

  /** What the app asks for: this chain's live tokens, in display order. */
  async listForChain(chainId: number): Promise<TokenView[]> {
    const tokens = await listTokens(chainId, { includeDisabled: false });
    return tokens.map((token) => this.toView(token));
  }

  /** What the dashboard asks for: the same list plus the tokens an operator has removed. */
  async listForAdmin(chainId: number): Promise<TokenView[]> {
    this.requireRegistered(chainId);
    const tokens = await listTokens(chainId, { includeDisabled: true });
    return tokens.map((token) => this.toView(token));
  }

  /** Every registered network with its token counts and the providers available for it. */
  async summary(): Promise<ChainTokenSummary[]> {
    const counts = await countTokensByChain();
    return NETWORK_REGISTRY.map((entry) => {
      const count = counts.get(entry.chainId) ?? { enabled: 0, total: 0 };
      return {
        chainId: entry.chainId,
        name: entry.name,
        type: entry.type,
        stableSymbol: getStableSymbol(entry.chainId),
        enabled: count.enabled,
        total: count.total,
        sources: availableSources(entry.chainId).map((id) => ({
          id,
          label: sourceLabel(id, entry.chainId),
          // Only CoinMarketCap needs a key; the rest are always usable, so they are always true.
          configured: id === 'coinmarketcap' ? isCoinMarketCapConfigured() : true,
        })),
      };
    });
  }

  /**
   * Add one token by address.
   *
   * The symbol, name and decimals are read off the chain rather than taken from the request, because
   * decimals decide what a plan actually spends: a token stored at 18 that is really 6 turns a $10
   * buy into a $10,000,000,000,000 one. An operator may override the symbol and name — a token whose
   * on-chain symbol is unreadable or misleading is exactly why the manual path exists — but a
   * decimals override has to be given explicitly and is logged.
   */
  async addToken(input: {
    chainId: number;
    address: string;
    symbol?: string;
    name?: string;
    decimals?: number;
    logoUrl?: string | null;
    addedBy?: string | null;
  }): Promise<TokenView> {
    const chainId = this.requireRegistered(input.chainId).chainId;
    const address = this.requireAddress(input.address);
    this.requireNotSettlementToken(chainId, address);

    const onChain = await getTokenMeta(chainId, address);
    const decimals = input.decimals ?? onChain.decimals;
    if (decimals == null) {
      throw new BadRequestException({
        ok: false,
        error:
          `${address} did not answer decimals() on chain ${chainId}. It may not be an ERC-20, or ` +
          `the RPC may be down. Pass decimals explicitly to add it anyway.`,
      });
    }
    if (input.decimals != null && onChain.decimals != null && input.decimals !== onChain.decimals) {
      this.logger.warn(
        `Token ${address} on chain ${chainId} added with decimals=${input.decimals} while the ` +
          `contract reports ${onChain.decimals}. Plans against it will be priced with the override.`,
      );
    }

    const symbol = input.symbol?.trim() || onChain.symbol;
    if (!symbol) {
      throw new BadRequestException({
        ok: false,
        error:
          `${address} did not answer symbol() on chain ${chainId}. Pass a symbol to add it anyway.`,
      });
    }

    const existing = await getToken(chainId, address);
    const stored = await upsertToken({
      chainId,
      address,
      symbol: symbol.slice(0, MAX_SYMBOL_LENGTH),
      name: (input.name?.trim() || onChain.name || symbol).slice(0, MAX_NAME_LENGTH),
      decimals,
      logoUrl: input.logoUrl ?? onChain.logoUrl ?? logoUrl(chainId, address),
      source: 'manual',
      // A manual add of a token an operator had removed is a decision to bring it back.
      enabled: true,
      sortRank: existing?.sortRank ?? 0,
      addedBy: input.addedBy ?? null,
    });
    this.logger.log(
      `Token ${stored.symbol} (${address}) added on chain ${chainId}` +
        `${input.addedBy ? ` by ${input.addedBy}` : ''}.`,
    );
    return this.toView(stored);
  }

  /**
   * Remove a token from the list users see.
   *
   * The row is kept and flagged rather than deleted, so the next import cannot hand the token back:
   * the provider will still be listing it, and an operator's removal has to outlast that. `purge`
   * drops the row outright for the case where that is what is wanted.
   */
  async removeToken(
    chainId: number,
    address: string,
    options?: { purge?: boolean; updatedBy?: string | null },
  ): Promise<{ removed: boolean; purged: boolean; token: TokenView | null }> {
    this.requireRegistered(chainId);
    const addr = this.requireAddress(address);
    if (options?.purge) {
      const purged = await deleteToken(chainId, addr);
      if (purged) this.logger.log(`Token ${addr} purged from chain ${chainId}.`);
      return { removed: purged, purged, token: null };
    }
    const stored = await setTokenEnabled(chainId, addr, false, options?.updatedBy);
    if (!stored) return { removed: false, purged: false, token: null };
    this.logger.log(`Token ${stored.symbol} (${addr}) removed from chain ${chainId}.`);
    return { removed: true, purged: false, token: this.toView(stored) };
  }

  /** Put a removed token back in the list. */
  async restoreToken(
    chainId: number,
    address: string,
    updatedBy?: string | null,
  ): Promise<TokenView | null> {
    this.requireRegistered(chainId);
    const stored = await setTokenEnabled(chainId, this.requireAddress(address), true, updatedBy);
    return stored ? this.toView(stored) : null;
  }

  /**
   * Build a chain's list from the external providers.
   *
   * Merged, not concatenated: a token several providers know keeps its best position rather than
   * appearing three times (see mergeSources). Providers run in parallel and each fails soft, so a
   * rate-limited CoinGecko costs tokens, not the import.
   *
   * `replace` empties the chain first. That also drops the operator's removals, which is why it is
   * not the default — a plain import merges, and a token removed last week stays removed.
   */
  async importChain(input: {
    chainId: number;
    sources?: string[];
    limit?: number;
    replace?: boolean;
    updatedBy?: string | null;
  }): Promise<ImportReport> {
    const chainId = this.requireRegistered(input.chainId).chainId;
    const supported = availableSources(chainId);
    if (supported.length === 0) {
      throw new BadRequestException({
        ok: false,
        error:
          `No token provider covers chain ${chainId}. Tokens can still be added by address on ` +
          `this network.`,
      });
    }

    const requested = this.parseSources(input.sources, supported);
    const limit = this.parseLimit(input.limit);

    const results: SourceResult[] = await Promise.all(
      requested.map((source) => fetchFromSource(source, chainId, limit)),
    );
    const merged = mergeSources(results).slice(0, limit);

    const cleared = input.replace ? await clearChainTokens(chainId) : 0;

    // A plan spends the settlement stablecoin, so it can never also buy it. Every provider lists it
    // — it is among the most-traded tokens on every chain — and it would sit at the top of the list
    // as an option that cannot work.
    const stable = getStableAddress(chainId)?.toLowerCase() ?? null;
    const skipped: ImportReport['skipped'] = [];
    const toStore = merged.filter((token) => {
      if (stable && token.address === stable) {
        skipped.push({
          address: token.address,
          symbol: token.symbol,
          reason: `settlement stablecoin on this network — plans spend it, so they cannot buy it`,
        });
        return false;
      }
      return true;
    });

    const stored = await upsertTokens(
      toStore.map((token, index) => ({
        chainId,
        address: token.address,
        symbol: token.symbol.slice(0, MAX_SYMBOL_LENGTH),
        name: token.name.slice(0, MAX_NAME_LENGTH),
        decimals: token.decimals,
        logoUrl: token.logoUrl ?? logoUrl(chainId, token.address),
        source: token.source,
        sortRank: index + 1,
        addedBy: input.updatedBy ?? null,
        // Left undefined on purpose: a merge must not un-remove a token, and a replace has already
        // dropped the row, so the insert's default (true) applies.
        enabled: input.replace ? true : undefined,
      })),
    );

    this.logger.log(
      `Imported ${stored.length} tokens for chain ${chainId} from ` +
        `${requested.join(', ')}${input.replace ? ' (replaced)' : ''}.`,
    );

    return {
      chainId,
      requested,
      sources: results.map((result) => ({
        id: result.source,
        label: sourceLabel(result.source, chainId),
        count: result.tokens.length,
        error: result.error,
        skipped: result.skipped,
        note: result.note ?? null,
      })),
      merged: merged.length,
      imported: stored.length,
      skipped,
      cleared,
      replaced: Boolean(input.replace),
    };
  }

  // -------- internals --------

  private toView(token: TokenListEntry): TokenView {
    return {
      chainId: token.chainId,
      address: token.address,
      symbol: token.symbol,
      name: token.name,
      logoUrl: token.logoUrl,
      decimals: token.decimals,
      source: token.source,
      sourceLabel: sourceLabel(token.source, token.chainId),
      enabled: token.enabled,
      addedBy: token.addedBy,
      updatedAt: token.updatedAt.toISOString(),
    };
  }

  private requireRegistered(chainId: unknown) {
    const id = Number(chainId);
    const entry = Number.isInteger(id) ? getRegistryEntry(id) : null;
    if (!entry || !isRegisteredChainId(id)) {
      throw new BadRequestException({
        ok: false,
        error:
          `Chain ${chainId} is not in the network registry. A network has to be added to ` +
          `backend/src/networks/network-registry.ts before it can have a token list.`,
      });
    }
    return entry;
  }

  private requireAddress(address: unknown): string {
    const value = typeof address === 'string' ? address : '';
    if (!isAddressLike(value)) {
      throw new BadRequestException({
        ok: false,
        error: `"${String(address)}" is not a token address (expected 0x + 40 hex characters).`,
      });
    }
    return normalizeAddress(value);
  }

  private requireNotSettlementToken(chainId: number, address: string): void {
    const stable = getStableAddress(chainId)?.toLowerCase();
    if (stable && stable === address) {
      throw new BadRequestException({
        ok: false,
        error:
          `${getStableSymbol(chainId)} is this network's settlement stablecoin. Plans spend it on ` +
          `every run, so it cannot also be something they buy.`,
      });
    }
  }

  private parseSources(sources: unknown, supported: TokenSourceName[]): TokenSourceName[] {
    if (sources == null) return supported;
    if (!Array.isArray(sources)) {
      throw new BadRequestException({ ok: false, error: 'sources must be an array of provider ids' });
    }
    const requested = sources.filter(isTokenSourceName);
    const unknown = sources.filter((s) => !isTokenSourceName(s));
    if (unknown.length > 0) {
      throw new BadRequestException({
        ok: false,
        error: `Unknown token source(s): ${unknown.join(', ')}`,
      });
    }
    if (requested.length === 0) return supported;
    return requested;
  }

  private parseLimit(limit: unknown): number {
    if (limit == null) return 100;
    const value = Number(limit);
    if (!Number.isInteger(value) || value < 1 || value > 250) {
      throw new BadRequestException({ ok: false, error: 'limit must be an integer from 1 to 250' });
    }
    return value;
  }
}
