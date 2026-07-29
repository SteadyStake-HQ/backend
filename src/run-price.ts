/**
 * What a run charges the user's tank, when an operator sets it by hand.
 *
 * Three numbers decide a run's price and only one of them is a decision. Gas price and native
 * token price are read from the network — they are facts. The third, the amount actually debited
 * from the tank, is a business decision: a flat rate the operator picks so a user can be quoted
 * "$0.05 per run" and have that stay true while gas moves underneath it.
 *
 * That decision used to live in two places that were awkward to change — `gasCostPerExecutionUsdc6`
 * on each chain's GasTank (an owner-only transaction, per network, via scripts/set-gas-cost.js) and
 * a GAS_COST_PER_EXECUTION_USDC env var that needed a redeploy. This module makes it a stored value
 * the operator dashboard can edit per network, which is what the price being a decision implies.
 *
 * It is safe for this to outrank the contract. The contract does not price a run: `recordExecution`
 * debits whatever amount the relayer passes it, and `gasCostPerExecutionUsdc6` is only a number the
 * relayer chooses to read. What matters is that the relayer and the UI read the *same* number, so
 * both go through here (backend/src/run-executor.ts, and the frontend via /api/run-price).
 *
 * Storage mirrors the scheduler config: Supabase when SUPABASE_DB_URL is set, a JSON file
 * otherwise, so a single-box deployment without a database still keeps the operator's price.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { Pool } from 'pg';
import { formatUnits, parseUnits } from 'viem';
import { getStableDecimals, getStableOne } from './config';

/** kv_store key holding the whole per-chain map. One row, rewritten on every edit. */
const RUN_PRICE_KV_KEY = 'steadystake:run-price:overrides';

/**
 * Ceiling on a manually set price ($100), in the chain's stablecoin base units. A run costs cents;
 * anything near this is a units mistake (dollars typed where base units were meant), and the cost
 * of accepting one is a user's tank drained in a single run.
 *
 * Scaled per chain: $100 is 100_000_000 base units on 6-decimal chains but 1e20 on BSC, so a fixed
 * ceiling would have rejected every legitimate BSC price as too large.
 */
function maxPriceFor(chainId: number): bigint {
  return 100n * getStableOne(chainId);
}

/** How long a loaded map is trusted before the next read refreshes it from storage. */
const CACHE_TTL_MS = 30_000;

export interface RunPriceOverride {
  /** Amount debited per run, in USDC 6-decimals, as a string — JSON has no bigint. */
  usdc6: string;
  /** When an operator last set it. */
  updatedAt: string;
  /** Free-form operator identifier, for the audit trail. Null when not supplied. */
  updatedBy: string | null;
  /** Why this price, in the operator's words. Shown on the dashboard, never to users. */
  note: string | null;
}

/** chainId (as a string key, because this is persisted as JSON) -> the operator's price. */
export type RunPriceMap = Record<string, RunPriceOverride>;

let cache: RunPriceMap = {};
let cacheLoadedAt = 0;
let pool: Pool | null = null;

function getPool(): Pool | null {
  const connectionString = process.env.SUPABASE_DB_URL?.trim();
  if (!connectionString) return null;
  if (!pool) {
    pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 2 });
    // Same reasoning as plan-admin-controls: an unhandled 'error' on an idle client that the
    // Supabase pooler has dropped would take the whole process down.
    pool.on('error', () => {});
  }
  return pool;
}

function fileCandidates(): string[] {
  return [join(process.cwd(), 'run-price.json'), join(tmpdir(), 'steadystake-run-price.json')];
}

/** Drop anything that is not a usable price, so a hand-edited file cannot set a nonsense charge. */
function sanitize(raw: unknown): RunPriceMap {
  const out: RunPriceMap = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const chainId = Number(key);
    if (!Number.isFinite(chainId) || chainId <= 0) continue;
    const entry = value as Partial<RunPriceOverride> | null;
    if (!entry || typeof entry !== 'object') continue;
    let usdc6: bigint;
    try {
      usdc6 = BigInt(String(entry.usdc6));
    } catch {
      continue;
    }
    if (usdc6 <= 0n || usdc6 > maxPriceFor(chainId)) continue;
    out[String(chainId)] = {
      usdc6: usdc6.toString(),
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date().toISOString(),
      updatedBy: typeof entry.updatedBy === 'string' && entry.updatedBy.trim() ? entry.updatedBy.trim() : null,
      note: typeof entry.note === 'string' && entry.note.trim() ? entry.note.trim() : null,
    };
  }
  return out;
}

function readFromFile(): RunPriceMap | null {
  for (const path of fileCandidates()) {
    try {
      if (!existsSync(path)) continue;
      return sanitize(JSON.parse(readFileSync(path, 'utf-8')));
    } catch {
      // Try the next candidate; a corrupt file must not stop the relayer pricing runs.
    }
  }
  return null;
}

function writeToFile(map: RunPriceMap): boolean {
  const serialized = JSON.stringify(map, null, 2);
  for (const path of fileCandidates()) {
    try {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(path, serialized, 'utf-8');
      return true;
    } catch {
      // Try the next candidate.
    }
  }
  return false;
}

/**
 * Pull the current map from storage. Call once per executor sweep and before serving the API;
 * every read after that is synchronous, which is what the executor's per-plan loop needs.
 *
 * A storage failure leaves the last known map in place rather than clearing it: forgetting the
 * operator's price silently reverts every chain to the contract's, which is the one outcome worse
 * than serving a slightly stale one.
 */
export async function refreshRunPrices(force = false): Promise<RunPriceMap> {
  if (!force && Date.now() - cacheLoadedAt < CACHE_TTL_MS) return cache;

  const db = getPool();
  if (db) {
    try {
      const { rows } = await db.query('SELECT value FROM kv_store WHERE key = $1', [RUN_PRICE_KV_KEY]);
      cache = rows.length === 0 ? {} : sanitize(rows[0].value);
      cacheLoadedAt = Date.now();
      return cache;
    } catch {
      // Fall through to the file, then to whatever is already cached.
    }
  }

  const fromFile = readFromFile();
  if (fromFile) {
    cache = fromFile;
    cacheLoadedAt = Date.now();
  }
  return cache;
}

/**
 * The operator's price for a chain, or null when none is set. Synchronous, reading the map last
 * loaded by refreshRunPrices — callers on a hot path must have refreshed first.
 */
export function getRunPriceUsdc6(chainId: number): bigint | null {
  const entry = cache[String(chainId)];
  if (!entry) return null;
  try {
    const usdc6 = BigInt(entry.usdc6);
    return usdc6 > 0n && usdc6 <= maxPriceFor(chainId) ? usdc6 : null;
  } catch {
    return null;
  }
}

/** The full map as last loaded, for the dashboard. */
export function getAllRunPrices(): RunPriceMap {
  return { ...cache };
}

export class RunPriceError extends Error {}

/**
 * Set or clear the price for one chain. Pass null to clear, which hands that chain back to the
 * on-chain `gasCostPerExecutionUsdc6`.
 */
export async function setRunPrice(
  chainId: number,
  usdc6: bigint | null,
  meta: { updatedBy?: string | null; note?: string | null } = {},
): Promise<RunPriceMap> {
  if (!Number.isFinite(chainId) || chainId <= 0) {
    throw new RunPriceError(`Invalid chainId: ${chainId}`);
  }
  const maxPrice = maxPriceFor(chainId);
  if (usdc6 != null && (usdc6 <= 0n || usdc6 > maxPrice)) {
    throw new RunPriceError(
      `Price must be between 0 and ${formatUnits(maxPrice, getStableDecimals(chainId))} per run (got ${usdc6}).`,
    );
  }

  const next = await refreshRunPrices(true);
  const key = String(chainId);
  if (usdc6 == null) {
    delete next[key];
  } else {
    next[key] = {
      usdc6: usdc6.toString(),
      updatedAt: new Date().toISOString(),
      updatedBy: meta.updatedBy?.trim() ? meta.updatedBy.trim() : null,
      note: meta.note?.trim() ? meta.note.trim() : null,
    };
  }

  const db = getPool();
  if (db) {
    try {
      await db.query(
        `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [RUN_PRICE_KV_KEY, JSON.stringify(next)],
      );
      cache = next;
      cacheLoadedAt = Date.now();
      return getAllRunPrices();
    } catch (error) {
      throw new RunPriceError(
        `Could not save the run price: ${(error as Error).message}. Nothing was changed.`,
      );
    }
  }

  if (!writeToFile(next)) {
    // In-memory only would look like it worked and evaporate on the next deploy. An operator
    // setting a price needs to know it did not stick.
    throw new RunPriceError(
      'Could not save the run price: no writable storage (set SUPABASE_DB_URL, or give the backend a writable working directory).',
    );
  }
  cache = next;
  cacheLoadedAt = Date.now();
  return getAllRunPrices();
}

/**
 * Parse a dollars-and-cents string ("0.05") into the chain's stablecoin base units.
 * Null for blank input.
 */
export function parseUsdToUsdc6(
  chainId: number,
  value: string | number | null | undefined,
): bigint | null {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const usd = Number(raw);
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new RunPriceError(`"${raw}" is not a positive amount.`);
  }
  return parseUnits(usd.toString(), getStableDecimals(chainId));
}
