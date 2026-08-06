/**
 * Standalone Supabase access to the `dca_plans` table and the indexer cursor, for use outside
 * NestJS DI (the plans reader, the executor and the CLI). Mirrors the pattern in
 * automation-users.ts: reads SUPABASE_DB_URL directly and reuses a module-level pool.
 *
 * `dca_plans` is the system of record for DCA plans. Rows are written through at each lifecycle
 * point — created (frontend, from the tx receipt), executed (executor), cancelled — so the table
 * stays correct without scanning block logs. index-plans.ts remains available as a manual backfill
 * for plans created outside that path, but nothing on the automatic read/execute paths scans.
 *
 * It holds the off-chain facts the DCAVault struct can't provide once a plan is cancelled or
 * depleted: created/ended timestamps, the original committed total, the exact swapped amount, and
 * the completed-vs-cancelled distinction. Fields left null mean "never recorded" and are surfaced
 * as "Not recorded" rather than guessed at.
 */
import { Pool } from 'pg';
import { getSharedPool } from './pg-pool';
import { NETWORK_ALLOCATIONS_DDL } from './network-allocations';
import { PLAN_ADMIN_CONTROLS_DDL } from './plan-admin-controls';

export type DcaPlanStatus = 'active' | 'completed' | 'cancelled';

export interface DcaPlanRow {
  chainId: number;
  userAddr: string;
  scheduleId: number;
  targetToken: string | null;
  frequency: number | null;
  amountPerIntervalUsdc6: string | null;
  /** original total committed at creation (swapped + remaining, or swapped + returned once cancelled) */
  committedUsdc6: string | null;
  /** exact sum of ScheduleExecuted.usdcAmount */
  swappedUsdc6: string | null;
  executedCount: number;
  createdAt: Date | null;
  lastExecutionAt: Date | null;
  endedAt: Date | null;
  status: DcaPlanStatus;
  returnedUsdc6: string | null;
}

function getPool(): Pool | null {
  return getSharedPool();
}

export function isSupabaseConfigured(): boolean {
  return typeof process.env.SUPABASE_DB_URL === 'string' && process.env.SUPABASE_DB_URL.trim().length > 0;
}

/** Idempotent DDL so the indexer / CLI can run without the Nest boot path having created the tables. */
export async function ensureDcaPlansSchema(): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  await p.query(DCA_PLANS_DDL);
}

/** Shared DDL, also run from SupabaseService.ensureSchema on Nest boot. */
export const DCA_PLANS_DDL = `
  CREATE TABLE IF NOT EXISTS dca_plans (
    chain_id integer NOT NULL,
    user_addr text NOT NULL,
    schedule_id integer NOT NULL,
    target_token text,
    frequency smallint,
    amount_per_interval_usdc6 text,
    committed_usdc6 text,
    swapped_usdc6 text,
    executed_count integer NOT NULL DEFAULT 0,
    created_at timestamptz,
    last_execution_at timestamptz,
    ended_at timestamptz,
    status text NOT NULL DEFAULT 'active',
    returned_usdc6 text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, user_addr, schedule_id)
  );
  CREATE INDEX IF NOT EXISTS dca_plans_member_idx ON dca_plans (chain_id, user_addr);

  CREATE TABLE IF NOT EXISTS dca_index_cursor (
    chain_id integer PRIMARY KEY,
    last_block bigint NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  -- getDcaPlanMembers unions this in, so the standalone/CLI path must not depend on the Nest
  -- boot path having created it first.
  CREATE TABLE IF NOT EXISTS automation_users (
    member text PRIMARY KEY,
    chain_id integer NOT NULL,
    user_addr text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  -- The executor reads admin holds on every run, so the standalone/CLI path must create this too.
  ${PLAN_ADMIN_CONTROLS_DDL}

  -- The executor reads network allocations on every run to skip paused/removed chains, so the
  -- standalone/CLI path must create this too.
  ${NETWORK_ALLOCATIONS_DDL}
`;

function rowFromDb(r: Record<string, unknown>): DcaPlanRow {
  return {
    chainId: Number(r.chain_id),
    userAddr: r.user_addr as string,
    scheduleId: Number(r.schedule_id),
    targetToken: (r.target_token as string | null) ?? null,
    frequency: r.frequency == null ? null : Number(r.frequency),
    amountPerIntervalUsdc6: (r.amount_per_interval_usdc6 as string | null) ?? null,
    committedUsdc6: (r.committed_usdc6 as string | null) ?? null,
    swappedUsdc6: (r.swapped_usdc6 as string | null) ?? null,
    executedCount: Number(r.executed_count ?? 0),
    createdAt: r.created_at ? new Date(r.created_at as string) : null,
    lastExecutionAt: r.last_execution_at ? new Date(r.last_execution_at as string) : null,
    endedAt: r.ended_at ? new Date(r.ended_at as string) : null,
    status: (r.status as DcaPlanStatus) ?? 'active',
    returnedUsdc6: (r.returned_usdc6 as string | null) ?? null,
  };
}

/** Read stored plan rows. Pass chainIds to restrict; empty/undefined returns all. */
export async function getDcaPlans(chainIds?: number[]): Promise<DcaPlanRow[]> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  const hasFilter = Array.isArray(chainIds) && chainIds.length > 0;
  const { rows } = hasFilter
    ? await p.query('SELECT * FROM dca_plans WHERE chain_id = ANY($1) ORDER BY chain_id, user_addr, schedule_id', [
        chainIds,
      ])
    : await p.query('SELECT * FROM dca_plans ORDER BY chain_id, user_addr, schedule_id');
  return rows.map(rowFromDb);
}

/**
 * Members (`${chainId}:${user}`) known to the DB: everyone who has a recorded plan, unioned with
 * the registration list. This replaces on-chain ScheduleCreated discovery — a plan is recorded when
 * it is created, so the plans table itself is the member list and no log scan is needed.
 */
export async function getDcaPlanMembers(chainIds?: number[]): Promise<string[]> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  const hasFilter = Array.isArray(chainIds) && chainIds.length > 0;
  const sql = `
    SELECT DISTINCT chain_id, user_addr FROM (
      SELECT chain_id, user_addr FROM dca_plans
      UNION
      SELECT chain_id, user_addr FROM automation_users
    ) m
    ${hasFilter ? 'WHERE chain_id = ANY($1)' : ''}
    ORDER BY chain_id, user_addr`;
  const { rows } = hasFilter ? await p.query(sql, [chainIds]) : await p.query(sql);
  return rows.map((r) => `${Number(r.chain_id)}:${(r.user_addr as string).toLowerCase()}`);
}

/**
 * Every wallet address the DB has ever seen, on any chain.
 *
 * Membership is stored per `chainId:user`, which makes a wallet invisible on a chain it was never
 * recorded against — the exact hole an unrecorded plan falls through. Discovery (see
 * plans/discover-members.ts) needs the addresses alone so it can ask each chain about each wallet.
 */
export async function getKnownWalletAddresses(): Promise<string[]> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  const { rows } = await p.query(`
    SELECT DISTINCT lower(user_addr) AS user_addr FROM (
      SELECT user_addr FROM dca_plans
      UNION
      SELECT user_addr FROM automation_users
    ) m
    ORDER BY 1`);
  return rows.map((r) => r.user_addr as string);
}

/**
 * Register `chainId:user` pairs in the member list, idempotently.
 *
 * Used by discovery to remember a wallet found holding schedules on a chain it was not registered
 * against, so the finding survives the process and the executor sees the member too. It only ever
 * adds a *member*; whether any of that member's plans auto-execute is still decided on-chain by
 * `getEnrolledScheduleIds`.
 */
export async function registerAutomationUsers(
  members: Array<{ chainId: number; userAddr: string }>,
): Promise<void> {
  if (members.length === 0) return;
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  for (const { chainId, userAddr } of members) {
    const user = userAddr.toLowerCase();
    await p.query(
      `INSERT INTO automation_users (member, chain_id, user_addr) VALUES ($1, $2, $3)
       ON CONFLICT (member) DO NOTHING`,
      [`${chainId}:${user}`, chainId, user],
    );
  }
}

/** Upsert absolute plan state (callers compute full values, so this overwrites). */
export async function upsertDcaPlans(rows: DcaPlanRow[]): Promise<void> {
  if (rows.length === 0) return;
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  for (const row of rows) {
    await p.query(
      `INSERT INTO dca_plans (
         chain_id, user_addr, schedule_id, target_token, frequency,
         amount_per_interval_usdc6, committed_usdc6, swapped_usdc6, executed_count,
         created_at, last_execution_at, ended_at, status, returned_usdc6, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
       ON CONFLICT (chain_id, user_addr, schedule_id) DO UPDATE SET
         target_token = EXCLUDED.target_token,
         frequency = EXCLUDED.frequency,
         amount_per_interval_usdc6 = EXCLUDED.amount_per_interval_usdc6,
         committed_usdc6 = EXCLUDED.committed_usdc6,
         swapped_usdc6 = EXCLUDED.swapped_usdc6,
         executed_count = EXCLUDED.executed_count,
         created_at = COALESCE(EXCLUDED.created_at, dca_plans.created_at),
         last_execution_at = EXCLUDED.last_execution_at,
         ended_at = EXCLUDED.ended_at,
         status = EXCLUDED.status,
         returned_usdc6 = EXCLUDED.returned_usdc6,
         updated_at = now()`,
      [
        row.chainId,
        row.userAddr.toLowerCase(),
        row.scheduleId,
        row.targetToken,
        row.frequency,
        row.amountPerIntervalUsdc6,
        row.committedUsdc6,
        row.swappedUsdc6,
        row.executedCount,
        row.createdAt,
        row.lastExecutionAt,
        row.endedAt,
        row.status,
        row.returnedUsdc6,
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Write-through recording. Each DCA lifecycle event records straight to the DB from the code
// path that caused it, so `dca_plans` stays correct without any log scan.
// ---------------------------------------------------------------------------

export interface RecordPlanCreatedInput {
  chainId: number;
  userAddr: string;
  scheduleId: number;
  targetToken: string;
  frequency: number;
  amountPerIntervalUsdc6: string;
  /** total deposited at creation — the plan's committed total */
  committedUsdc6: string;
  createdAt: Date;
}

/**
 * Record a newly created plan, and register the user for automation in the same transaction.
 * Creation is the only moment the committed total is unambiguous, so it is stored verbatim here.
 * Re-recording the same plan is a no-op on the immutable creation facts.
 */
export async function recordPlanCreated(input: RecordPlanCreatedInput): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  const user = input.userAddr.toLowerCase();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO dca_plans (
         chain_id, user_addr, schedule_id, target_token, frequency,
         amount_per_interval_usdc6, committed_usdc6, swapped_usdc6, executed_count,
         created_at, status, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'0',0,$8,'active', now())
       ON CONFLICT (chain_id, user_addr, schedule_id) DO UPDATE SET
         target_token = COALESCE(dca_plans.target_token, EXCLUDED.target_token),
         frequency = COALESCE(dca_plans.frequency, EXCLUDED.frequency),
         amount_per_interval_usdc6 = COALESCE(dca_plans.amount_per_interval_usdc6, EXCLUDED.amount_per_interval_usdc6),
         committed_usdc6 = COALESCE(dca_plans.committed_usdc6, EXCLUDED.committed_usdc6),
         created_at = COALESCE(dca_plans.created_at, EXCLUDED.created_at),
         updated_at = now()`,
      [
        input.chainId,
        user,
        input.scheduleId,
        input.targetToken.toLowerCase(),
        input.frequency,
        input.amountPerIntervalUsdc6,
        input.committedUsdc6,
        input.createdAt,
      ],
    );
    await client.query(
      `INSERT INTO automation_users (member, chain_id, user_addr) VALUES ($1, $2, $3)
       ON CONFLICT (member) DO NOTHING`,
      [`${input.chainId}:${user}`, input.chainId, user],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export interface RecordPlanExecutedInput {
  chainId: number;
  userAddr: string;
  scheduleId: number;
  /** authoritative post-swap values read from the schedule struct */
  executedCount: number;
  /** gross USDC drawn from the deposit so far (perInterval * executedCount) */
  swappedUsdc6: string;
  /** in-plan balance left after the swap; 0 means the plan just depleted */
  remainingUsdc6: string;
  /** false once the vault has retired the schedule (depleted) */
  active: boolean;
  at: Date;
}

/**
 * Record a swap the executor just performed. Values come from the schedule struct read right after
 * the swap, so they are exact rather than accumulated. A plan that is no longer active and was not
 * cancelled has run to completion.
 */
export async function recordPlanExecuted(input: RecordPlanExecutedInput): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  const committed = (BigInt(input.swappedUsdc6) + BigInt(input.remainingUsdc6)).toString();
  await p.query(
    `UPDATE dca_plans SET
       executed_count = $4,
       swapped_usdc6 = $5,
       -- Trust the recorded creation-time total; only fall back to the derived one when the plan
       -- predates write-through recording and never had a committed total stored.
       committed_usdc6 = COALESCE(committed_usdc6, $6),
       last_execution_at = $7,
       status = CASE WHEN $8::boolean THEN 'active' ELSE 'completed' END,
       ended_at = CASE WHEN $8::boolean THEN ended_at ELSE COALESCE(ended_at, $7) END,
       updated_at = now()
     WHERE chain_id = $1 AND user_addr = $2 AND schedule_id = $3
       -- never resurrect a cancelled plan
       AND status <> 'cancelled'`,
    [
      input.chainId,
      input.userAddr.toLowerCase(),
      input.scheduleId,
      input.executedCount,
      input.swappedUsdc6,
      committed,
      input.at,
      input.active,
    ],
  );
}

export interface RecordPlanCancelledInput {
  chainId: number;
  userAddr: string;
  scheduleId: number;
  /** USDC refunded to the user by cancelSchedule */
  returnedUsdc6: string;
  at: Date;
}

/** Record a cancellation. The vault zeroes the deposit on cancel, so remaining becomes 0. */
export async function recordPlanCancelled(input: RecordPlanCancelledInput): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  await p.query(
    `UPDATE dca_plans SET
       status = 'cancelled',
       returned_usdc6 = $4,
       ended_at = COALESCE(ended_at, $5),
       updated_at = now()
     WHERE chain_id = $1 AND user_addr = $2 AND schedule_id = $3`,
    [input.chainId, input.userAddr.toLowerCase(), input.scheduleId, input.returnedUsdc6, input.at],
  );
}

export async function getIndexCursor(chainId: number): Promise<bigint | null> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  const { rows } = await p.query('SELECT last_block FROM dca_index_cursor WHERE chain_id = $1', [chainId]);
  if (rows.length === 0) return null;
  return BigInt(rows[0].last_block);
}

export async function setIndexCursor(chainId: number, lastBlock: bigint): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  await p.query(
    `INSERT INTO dca_index_cursor (chain_id, last_block, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (chain_id) DO UPDATE SET last_block = EXCLUDED.last_block, updated_at = now()`,
    [chainId, lastBlock.toString()],
  );
}
