/**
 * Runtime allocation of the networks in the registry, stored in `network_allocations`.
 *
 * The registry (networks/network-registry.ts) says which chains the code can talk to; this says what
 * an operator has currently decided about each one:
 *
 *   enabled  — live. Shown to users, relayer executes on it.
 *   paused   — reversible hold. Still shown, but no new plans and the relayer stops executing.
 *              Existing plans stay visible so users can cancel, withdraw, and reclaim gas tank
 *              funds; a chain holding user money must never simply vanish from the UI.
 *   disabled — "removed". Hidden from users and skipped by the relayer.
 *
 * A row exists only where an operator has overridden the default, so **no row means enabled with
 * the registry's own mainnet/testnet classification**. That direction matters: it keeps a database
 * that has never been written to identical to today's behaviour, and it means a newly deployed chain
 * is live rather than invisible until someone remembers to allocate it.
 *
 * DI-free on purpose — the standalone relayer (`npm run run`) reads this on every run and never
 * boots Nest, so it cannot go through SupabaseService. Mirrors plan-admin-controls.ts.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Pool } from 'pg';
import { isNetworkType, type NetworkType } from '../networks/network-registry';

export type NetworkStatus = 'enabled' | 'paused' | 'disabled';

export const NETWORK_STATUSES: readonly NetworkStatus[] = ['enabled', 'paused', 'disabled'];

export interface NetworkAllocation {
  chainId: number;
  status: NetworkStatus;
  /** Operator override of the registry's classification; null = use the registry's own type. */
  typeOverride: NetworkType | null;
  /** Free-form operator note, e.g. why a chain is paused. Surfaced in the admin dashboard. */
  note: string | null;
  updatedBy: string | null;
  updatedAt: Date;
}

export interface SetNetworkAllocationInput {
  chainId: number;
  status?: NetworkStatus;
  /** `null` clears the override and falls back to the registry type; `undefined` leaves it as is. */
  typeOverride?: NetworkType | null;
  note?: string | null;
  updatedBy?: string | null;
}

export function isNetworkStatus(value: unknown): value is NetworkStatus {
  return typeof value === 'string' && (NETWORK_STATUSES as readonly string[]).includes(value);
}

/** Shared DDL, run from SupabaseService.ensureSchema on boot and by the standalone/CLI path. */
export const NETWORK_ALLOCATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS network_allocations (
    chain_id integer PRIMARY KEY,
    status text NOT NULL,
    type_override text,
    note text,
    updated_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
`;

let pool: Pool | null = null;

function getPool(): Pool | null {
  const connectionString = process.env.SUPABASE_DB_URL?.trim();
  if (!connectionString) return null;
  if (!pool) {
    pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 3 });
    // Same reasoning as plan-admin-controls: the Supabase pooler drops idle connections, and an
    // unhandled 'error' event on an idle client would take the process down.
    pool.on('error', () => {});
  }
  return pool;
}

export function isAllocationStoreConfigured(): boolean {
  return getPool() !== null;
}

interface AllocationRow {
  chain_id: number;
  status: string;
  type_override: string | null;
  note: string | null;
  updated_by: string | null;
  updated_at: Date | string;
}

function fromRow(row: AllocationRow): NetworkAllocation {
  return {
    chainId: Number(row.chain_id),
    status: isNetworkStatus(row.status) ? row.status : 'enabled',
    typeOverride: isNetworkType(row.type_override) ? row.type_override : null,
    note: row.note,
    updatedBy: row.updated_by,
    updatedAt: new Date(row.updated_at),
  };
}

// -------- File fallback (deployments without SUPABASE_DB_URL) --------

/** Same two-candidate scheme as the scheduler config: cwd first, tmpdir when the image is read-only. */
function fileCandidates(): string[] {
  return [
    join(process.cwd(), 'network-allocations.json'),
    join(tmpdir(), 'steadystake-network-allocations.json'),
  ];
}

function readFileAllocations(): NetworkAllocation[] {
  for (const path of fileCandidates()) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
      if (!Array.isArray(parsed)) continue;
      return parsed
        .map((entry) => {
          const record = entry as Partial<NetworkAllocation>;
          const chainId = Number(record?.chainId);
          if (!Number.isInteger(chainId) || chainId <= 0) return null;
          return {
            chainId,
            status: isNetworkStatus(record.status) ? record.status : 'enabled',
            typeOverride: isNetworkType(record.typeOverride) ? record.typeOverride : null,
            note: typeof record.note === 'string' ? record.note : null,
            updatedBy: typeof record.updatedBy === 'string' ? record.updatedBy : null,
            updatedAt: record.updatedAt ? new Date(record.updatedAt) : new Date(0),
          } satisfies NetworkAllocation;
        })
        .filter((entry): entry is NetworkAllocation => entry !== null);
    } catch {
      // try the next candidate
    }
  }
  return [];
}

function writeFileAllocations(allocations: NetworkAllocation[]): void {
  const serialized = JSON.stringify(
    allocations.map((a) => ({ ...a, updatedAt: a.updatedAt.toISOString() })),
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
    `Network allocations could not be persisted: ${lastError?.message ?? 'no writable location'}`,
  );
}

// -------- Public API --------

/**
 * Every allocation an operator has set, keyed by chain ID. Chains absent from the result are at
 * their registry default (enabled, registry type).
 */
export async function getNetworkAllocations(): Promise<Map<number, NetworkAllocation>> {
  const p = getPool();
  if (!p) return new Map(readFileAllocations().map((a) => [a.chainId, a]));
  const { rows } = await p.query<AllocationRow>(
    'SELECT chain_id, status, type_override, note, updated_by, updated_at FROM network_allocations',
  );
  return new Map(rows.map(fromRow).map((a) => [a.chainId, a]));
}

/**
 * Create or update one chain's allocation. Fields left `undefined` keep their current value, so a
 * pause does not wipe an operator's earlier mainnet/testnet override.
 */
export async function setNetworkAllocation(
  input: SetNetworkAllocationInput,
): Promise<NetworkAllocation> {
  const p = getPool();
  if (!p) {
    const all = readFileAllocations();
    const existing = all.find((a) => a.chainId === input.chainId);
    const next: NetworkAllocation = {
      chainId: input.chainId,
      status: input.status ?? existing?.status ?? 'enabled',
      typeOverride:
        input.typeOverride === undefined ? (existing?.typeOverride ?? null) : input.typeOverride,
      note: input.note === undefined ? (existing?.note ?? null) : input.note,
      updatedBy: input.updatedBy === undefined ? (existing?.updatedBy ?? null) : input.updatedBy,
      updatedAt: new Date(),
    };
    writeFileAllocations([...all.filter((a) => a.chainId !== input.chainId), next]);
    return next;
  }

  // $2 is deliberately nullable and defaulted with COALESCE rather than in JS: a "set this chain to
  // testnet" call passes no status, and it must not quietly resume a chain an operator had paused.
  // $6/$7 carry "was this field supplied at all", which COALESCE cannot express — clearing the
  // override means writing NULL, and NULL is also how "not supplied" arrives.
  const { rows } = await p.query<AllocationRow>(
    `INSERT INTO network_allocations (chain_id, status, type_override, note, updated_by)
     VALUES ($1::integer, COALESCE($2::text, 'enabled'), $3::text, $4::text, $5::text)
     ON CONFLICT (chain_id) DO UPDATE SET
       status = COALESCE($2::text, network_allocations.status),
       type_override = CASE WHEN $6::boolean THEN $3::text ELSE network_allocations.type_override END,
       note = CASE WHEN $7::boolean THEN $4::text ELSE network_allocations.note END,
       updated_by = COALESCE($5::text, network_allocations.updated_by),
       updated_at = now()
     RETURNING chain_id, status, type_override, note, updated_by, updated_at`,
    [
      input.chainId,
      input.status ?? null,
      input.typeOverride ?? null,
      input.note ?? null,
      input.updatedBy ?? null,
      input.typeOverride !== undefined,
      input.note !== undefined,
    ],
  );
  return fromRow(rows[0]);
}

/**
 * Chain IDs an operator has taken out of service — the paused and the removed ones.
 *
 * Exposed as its own function so the standalone relayer can apply it without Nest: it is the one
 * piece of this store the executor needs on every run.
 */
export async function getNonExecutableChainIds(): Promise<Set<number>> {
  const allocations = await getNetworkAllocations();
  return new Set(
    [...allocations.values()]
      .filter((allocation) => allocation.status !== 'enabled')
      .map((allocation) => allocation.chainId),
  );
}

/** Drop a chain's allocation so it reverts to the registry default. Returns whether a row existed. */
export async function clearNetworkAllocation(chainId: number): Promise<boolean> {
  const p = getPool();
  if (!p) {
    const all = readFileAllocations();
    const remaining = all.filter((a) => a.chainId !== chainId);
    if (remaining.length === all.length) return false;
    writeFileAllocations(remaining);
    return true;
  }
  const result = await p.query('DELETE FROM network_allocations WHERE chain_id = $1', [chainId]);
  return (result.rowCount ?? 0) > 0;
}
