/**
 * The tokens a user may buy on each network, stored in `token_list`.
 *
 * Until this table existed the answer lived in the frontend bundle: `config/trending-tokens.json`,
 * written by a Moralis script someone had to run and commit, plus hand-maintained arrays in
 * contracts.ts. Changing what a network offers therefore meant a redeploy, and the third-party call
 * was made from the build rather than from the operator. Here it is data: an operator imports a list
 * per chain, adds or removes single tokens, and the frontend reads the result.
 *
 * Two rules the shape encodes, both because a re-import must never undo an operator's decision:
 *   - `enabled` survives an import. A token the operator removed stays removed when the same
 *     provider hands it back an hour later.
 *   - a row whose `source` is `manual` keeps that source and its rank through an import. The
 *     operator put it there deliberately; a provider agreeing is not a reason to renumber it.
 *
 * DI-free with a file fallback, exactly like network-allocations.ts: a deployment with no
 * SUPABASE_DB_URL still gets a working token list rather than an empty dashboard.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Pool } from 'pg';
import { getSharedPool } from './pg-pool';

/** Where a row came from. Free-form apart from `manual`, which has the meaning described above. */
export type TokenSource = 'manual' | 'coingecko' | 'coinmarketcap' | 'geckoterminal' | 'dex' | string;

export interface TokenListEntry {
  chainId: number;
  /** Lowercase 0x address — the primary key, so it is normalized on the way in, never on the way out. */
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUrl: string | null;
  source: TokenSource;
  /** False = removed by an operator. Kept rather than deleted so a re-import cannot resurrect it. */
  enabled: boolean;
  /** Display order, ascending. Imports number by provider rank; a manual add pins itself at 0. */
  sortRank: number;
  addedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TokenUpsert {
  chainId: number;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUrl?: string | null;
  source?: TokenSource;
  sortRank?: number;
  addedBy?: string | null;
  /** Only an explicit true/false is written; undefined leaves an existing row's state alone. */
  enabled?: boolean;
}

export const TOKEN_LIST_DDL = `
  CREATE TABLE IF NOT EXISTS token_list (
    chain_id integer NOT NULL,
    address text NOT NULL,
    symbol text NOT NULL,
    name text NOT NULL,
    decimals smallint NOT NULL,
    logo_url text,
    source text NOT NULL DEFAULT 'manual',
    enabled boolean NOT NULL DEFAULT true,
    sort_rank integer NOT NULL DEFAULT 0,
    added_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, address)
  );
  CREATE INDEX IF NOT EXISTS token_list_chain_idx ON token_list (chain_id, enabled, sort_rank);
`;

function getPool(): Pool | null {
  return getSharedPool();
}

export function isTokenStoreConfigured(): boolean {
  return getPool() !== null;
}

/** Normalized form of an address, which is also its identity in this table. */
export function normalizeAddress(address: string): string {
  const trimmed = String(address ?? '').trim();
  return (trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`).toLowerCase();
}

export function isAddressLike(address: string): boolean {
  return /^0x[0-9a-f]{40}$/.test(normalizeAddress(address));
}

interface TokenRow {
  chain_id: number;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logo_url: string | null;
  source: string;
  enabled: boolean;
  sort_rank: number;
  added_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function fromRow(row: TokenRow): TokenListEntry {
  return {
    chainId: Number(row.chain_id),
    address: row.address,
    symbol: row.symbol,
    name: row.name,
    decimals: Number(row.decimals),
    logoUrl: row.logo_url,
    source: row.source,
    enabled: row.enabled === true,
    sortRank: Number(row.sort_rank),
    addedBy: row.added_by,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/** Display order: rank first, then symbol, so two tokens at the same rank are still deterministic. */
function byRank(a: TokenListEntry, b: TokenListEntry): number {
  if (a.sortRank !== b.sortRank) return a.sortRank - b.sortRank;
  return a.symbol.localeCompare(b.symbol);
}

// -------- File fallback (deployments without SUPABASE_DB_URL) --------

function fileCandidates(): string[] {
  return [join(process.cwd(), 'token-list.json'), join(tmpdir(), 'steadystake-token-list.json')];
}

function readFileTokens(): TokenListEntry[] {
  for (const path of fileCandidates()) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
      if (!Array.isArray(parsed)) continue;
      return parsed
        .map((entry) => {
          const record = entry as Partial<TokenListEntry>;
          const chainId = Number(record?.chainId);
          const address = normalizeAddress(String(record?.address ?? ''));
          if (!Number.isInteger(chainId) || chainId <= 0 || !isAddressLike(address)) return null;
          return {
            chainId,
            address,
            symbol: typeof record.symbol === 'string' ? record.symbol : '???',
            name: typeof record.name === 'string' ? record.name : 'Unknown',
            decimals: Number.isFinite(Number(record.decimals)) ? Number(record.decimals) : 18,
            logoUrl: typeof record.logoUrl === 'string' ? record.logoUrl : null,
            source: typeof record.source === 'string' ? record.source : 'manual',
            enabled: record.enabled !== false,
            sortRank: Number.isFinite(Number(record.sortRank)) ? Number(record.sortRank) : 0,
            addedBy: typeof record.addedBy === 'string' ? record.addedBy : null,
            createdAt: record.createdAt ? new Date(record.createdAt) : new Date(0),
            updatedAt: record.updatedAt ? new Date(record.updatedAt) : new Date(0),
          } satisfies TokenListEntry;
        })
        .filter((entry): entry is TokenListEntry => entry !== null);
    } catch {
      // try the next candidate
    }
  }
  return [];
}

function writeFileTokens(tokens: TokenListEntry[]): void {
  const serialized = JSON.stringify(
    tokens.map((t) => ({
      ...t,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    })),
    null,
    2,
  );
  let lastError: Error | null = null;
  for (const path of fileCandidates()) {
    try {
      writeFileSync(path, serialized, 'utf-8');
      return;
    } catch (error) {
      lastError = error as Error;
    }
  }
  throw new Error(
    `Token list could not be persisted: ${lastError?.message ?? 'no writable location'}`,
  );
}

function mergeFileRow(existing: TokenListEntry | undefined, input: TokenUpsert): TokenListEntry {
  const address = normalizeAddress(input.address);
  const manual = existing?.source === 'manual';
  return {
    chainId: input.chainId,
    address,
    symbol: input.symbol,
    name: input.name,
    decimals: input.decimals,
    logoUrl: input.logoUrl ?? existing?.logoUrl ?? null,
    // Same two preservation rules the SQL upsert applies — see the file header.
    source: manual && input.source !== 'manual' ? 'manual' : (input.source ?? 'manual'),
    enabled: input.enabled ?? existing?.enabled ?? true,
    sortRank: manual ? (existing?.sortRank ?? 0) : (input.sortRank ?? existing?.sortRank ?? 0),
    addedBy: input.addedBy ?? existing?.addedBy ?? null,
    createdAt: existing?.createdAt ?? new Date(),
    updatedAt: new Date(),
  };
}

// -------- Public API --------

/**
 * One chain's tokens in display order.
 *
 * `includeDisabled` is the operator's view; the frontend never sees a removed token.
 */
export async function listTokens(
  chainId: number,
  options?: { includeDisabled?: boolean },
): Promise<TokenListEntry[]> {
  const includeDisabled = options?.includeDisabled === true;
  const p = getPool();
  if (!p) {
    return readFileTokens()
      .filter((t) => t.chainId === chainId && (includeDisabled || t.enabled))
      .sort(byRank);
  }
  const { rows } = await p.query<TokenRow>(
    `SELECT chain_id, address, symbol, name, decimals, logo_url, source, enabled, sort_rank,
            added_by, created_at, updated_at
       FROM token_list
      WHERE chain_id = $1 AND ($2::boolean OR enabled)
      ORDER BY sort_rank ASC, symbol ASC`,
    [chainId, includeDisabled],
  );
  return rows.map(fromRow);
}

/** How many tokens each chain holds, split into live and removed. Drives the dashboard summary. */
export async function countTokensByChain(): Promise<Map<number, { enabled: number; total: number }>> {
  const p = getPool();
  if (!p) {
    const counts = new Map<number, { enabled: number; total: number }>();
    for (const token of readFileTokens()) {
      const current = counts.get(token.chainId) ?? { enabled: 0, total: 0 };
      current.total += 1;
      if (token.enabled) current.enabled += 1;
      counts.set(token.chainId, current);
    }
    return counts;
  }
  const { rows } = await p.query<{ chain_id: number; enabled: string; total: string }>(
    `SELECT chain_id, count(*) FILTER (WHERE enabled) AS enabled, count(*) AS total
       FROM token_list GROUP BY chain_id`,
  );
  return new Map(
    rows.map((r) => [Number(r.chain_id), { enabled: Number(r.enabled), total: Number(r.total) }]),
  );
}

export async function getToken(chainId: number, address: string): Promise<TokenListEntry | null> {
  const addr = normalizeAddress(address);
  const p = getPool();
  if (!p) {
    return readFileTokens().find((t) => t.chainId === chainId && t.address === addr) ?? null;
  }
  const { rows } = await p.query<TokenRow>(
    `SELECT chain_id, address, symbol, name, decimals, logo_url, source, enabled, sort_rank,
            added_by, created_at, updated_at
       FROM token_list WHERE chain_id = $1 AND address = $2`,
    [chainId, addr],
  );
  return rows.length === 0 ? null : fromRow(rows[0]);
}

/** Create or update one token. Returns the stored row. */
export async function upsertToken(input: TokenUpsert): Promise<TokenListEntry> {
  const [stored] = await upsertTokens([input]);
  return stored;
}

/**
 * Bulk create-or-update, which is what an import is.
 *
 * The two CASE expressions are the preservation rules from the file header, and they are the reason
 * this is one statement rather than a read-modify-write per token: an import of 100 tokens racing
 * with an operator clicking "remove" must not be able to read a stale `enabled` and write it back.
 */
export async function upsertTokens(inputs: TokenUpsert[]): Promise<TokenListEntry[]> {
  if (inputs.length === 0) return [];
  const p = getPool();
  if (!p) {
    const all = readFileTokens();
    const byKey = new Map(all.map((t) => [`${t.chainId}:${t.address}`, t]));
    const stored: TokenListEntry[] = [];
    for (const input of inputs) {
      const key = `${input.chainId}:${normalizeAddress(input.address)}`;
      const next = mergeFileRow(byKey.get(key), input);
      byKey.set(key, next);
      stored.push(next);
    }
    writeFileTokens([...byKey.values()]);
    return stored;
  }

  const stored: TokenListEntry[] = [];
  for (const input of inputs) {
    const { rows } = await p.query<TokenRow>(
      `INSERT INTO token_list
         (chain_id, address, symbol, name, decimals, logo_url, source, enabled, sort_rank, added_by)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'manual'), COALESCE($8, true), COALESCE($9, 0), $10)
       ON CONFLICT (chain_id, address) DO UPDATE SET
         symbol = EXCLUDED.symbol,
         name = EXCLUDED.name,
         decimals = EXCLUDED.decimals,
         logo_url = COALESCE(EXCLUDED.logo_url, token_list.logo_url),
         -- A manual row stays manual and keeps its place: an import agreeing with the operator is
         -- not a reason to relabel or renumber what the operator curated.
         source = CASE WHEN token_list.source = 'manual' THEN 'manual' ELSE EXCLUDED.source END,
         sort_rank = CASE WHEN token_list.source = 'manual' THEN token_list.sort_rank
                          ELSE EXCLUDED.sort_rank END,
         -- Only an explicit enabled is honoured; an import passes NULL and cannot un-remove a token.
         enabled = COALESCE($8::boolean, token_list.enabled),
         added_by = COALESCE(EXCLUDED.added_by, token_list.added_by),
         updated_at = now()
       RETURNING chain_id, address, symbol, name, decimals, logo_url, source, enabled, sort_rank,
                 added_by, created_at, updated_at`,
      [
        input.chainId,
        normalizeAddress(input.address),
        input.symbol,
        input.name,
        input.decimals,
        input.logoUrl ?? null,
        input.source ?? null,
        input.enabled ?? null,
        input.sortRank ?? null,
        input.addedBy ?? null,
      ],
    );
    stored.push(fromRow(rows[0]));
  }
  return stored;
}

/** Show or hide one token. Returns null when the chain has no such token. */
export async function setTokenEnabled(
  chainId: number,
  address: string,
  enabled: boolean,
  updatedBy?: string | null,
): Promise<TokenListEntry | null> {
  const addr = normalizeAddress(address);
  const p = getPool();
  if (!p) {
    const all = readFileTokens();
    const index = all.findIndex((t) => t.chainId === chainId && t.address === addr);
    if (index === -1) return null;
    const next: TokenListEntry = {
      ...all[index],
      enabled,
      addedBy: updatedBy ?? all[index].addedBy,
      updatedAt: new Date(),
    };
    all[index] = next;
    writeFileTokens(all);
    return next;
  }
  const { rows } = await p.query<TokenRow>(
    `UPDATE token_list SET enabled = $3, added_by = COALESCE($4, added_by), updated_at = now()
      WHERE chain_id = $1 AND address = $2
      RETURNING chain_id, address, symbol, name, decimals, logo_url, source, enabled, sort_rank,
                added_by, created_at, updated_at`,
    [chainId, addr, enabled, updatedBy ?? null],
  );
  return rows.length === 0 ? null : fromRow(rows[0]);
}

/** Drop the row entirely. Unlike `remove`, a later import may bring the token back. */
export async function deleteToken(chainId: number, address: string): Promise<boolean> {
  const addr = normalizeAddress(address);
  const p = getPool();
  if (!p) {
    const all = readFileTokens();
    const remaining = all.filter((t) => !(t.chainId === chainId && t.address === addr));
    if (remaining.length === all.length) return false;
    writeFileTokens(remaining);
    return true;
  }
  const result = await p.query('DELETE FROM token_list WHERE chain_id = $1 AND address = $2', [
    chainId,
    addr,
  ]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Empty one chain's list. Used by an import asked to replace rather than merge, and it takes the
 * operator's removals with it — that is what "replace" means, and why the API asks for it explicitly.
 */
export async function clearChainTokens(chainId: number): Promise<number> {
  const p = getPool();
  if (!p) {
    const all = readFileTokens();
    const remaining = all.filter((t) => t.chainId !== chainId);
    writeFileTokens(remaining);
    return all.length - remaining.length;
  }
  const result = await p.query('DELETE FROM token_list WHERE chain_id = $1', [chainId]);
  return result.rowCount ?? 0;
}
