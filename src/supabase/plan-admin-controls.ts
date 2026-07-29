/**
 * Admin holds on individual DCA plans, stored in `dca_plan_admin_controls`.
 *
 * An operator can stop the relayer from auto-executing one plan without touching the chain: the
 * plan, its enrollment and the user's deposit are all left exactly as they are, and only the
 * backend's willingness to execute it changes. Two states are recorded:
 *
 *   paused    — reversible. The admin intends to resume it.
 *   cancelled — the admin has stopped automation for good. Still off-chain: the user keeps their
 *               funds and can cancel the plan themselves to get the remainder refunded.
 *
 * A row exists only while a hold is in force; resuming deletes it. That keeps "no row" the single
 * meaning of "nothing is holding this plan", so a missing row can never be read as a stale hold.
 *
 * Kept out of `dca_plans` deliberately. That table is written through by the create/execute/cancel
 * paths, which overwrite whole rows; an admin hold has a different lifecycle and must survive them.
 */
import { Pool } from 'pg';

export type PlanAdminStatus = 'paused' | 'cancelled';

export const PLAN_ADMIN_STATUSES: readonly PlanAdminStatus[] = ['paused', 'cancelled'];

export interface PlanAdminControl {
  chainId: number;
  userAddr: string;
  scheduleId: number;
  status: PlanAdminStatus;
  /** Operator-supplied explanation, surfaced to the user on the plan card. */
  reason: string | null;
  /** Free-form operator identifier, for the audit trail. */
  updatedBy: string | null;
  /**
   * Seconds of contract cooldown the plan still owed when the hold was placed — the countdown,
   * frozen. It is what the dashboards display instead of a ticking clock while the plan is held,
   * and what the resume path turns into a gate so lifting a hold does not fire the plan at once.
   * null when the chain could not be read at the time, or the plan was already due.
   */
  cooldownRemainingSeconds: number | null;
  createdAt: Date;
  updatedAt: Date;
}

let pool: Pool | null = null;

function getPool(): Pool | null {
  const connectionString = process.env.SUPABASE_DB_URL?.trim();
  if (!connectionString) return null;
  if (!pool) {
    pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 3 });
    // Same reasoning as dca-plans-store: the Supabase pooler drops idle connections, and an
    // unhandled 'error' event on an idle client would take the process down.
    pool.on('error', () => {});
  }
  return pool;
}

function requirePool(): Pool {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  return p;
}

/** Shared DDL, run from SupabaseService.ensureSchema on boot and by the standalone/CLI path. */
export const PLAN_ADMIN_CONTROLS_DDL = `
  CREATE TABLE IF NOT EXISTS dca_plan_admin_controls (
    chain_id integer NOT NULL,
    user_addr text NOT NULL,
    schedule_id integer NOT NULL,
    status text NOT NULL,
    reason text,
    updated_by text,
    cooldown_remaining_seconds integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, user_addr, schedule_id)
  );
  CREATE INDEX IF NOT EXISTS dca_plan_admin_controls_member_idx
    ON dca_plan_admin_controls (chain_id, user_addr);
  -- Added after the table shipped; deployments that already have it need the column too.
  ALTER TABLE dca_plan_admin_controls
    ADD COLUMN IF NOT EXISTS cooldown_remaining_seconds integer;
`;

/** `${chainId}:${user}:${scheduleId}` — the key every lookup map in this codebase uses. */
export function planAdminControlKey(
  chainId: number,
  userAddress: string,
  scheduleId: string | number | bigint,
): string {
  return `${chainId}:${userAddress.toLowerCase()}:${scheduleId.toString()}`;
}

function rowFrom(r: Record<string, unknown>): PlanAdminControl {
  return {
    chainId: Number(r.chain_id),
    userAddr: r.user_addr as string,
    scheduleId: Number(r.schedule_id),
    status: r.status as PlanAdminStatus,
    reason: (r.reason as string | null) ?? null,
    updatedBy: (r.updated_by as string | null) ?? null,
    cooldownRemainingSeconds:
      r.cooldown_remaining_seconds == null ? null : Number(r.cooldown_remaining_seconds),
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}

/** Every hold in force. Pass chainIds to restrict; empty/undefined returns all. */
export async function getPlanAdminControls(chainIds?: number[]): Promise<PlanAdminControl[]> {
  const p = requirePool();
  const hasFilter = Array.isArray(chainIds) && chainIds.length > 0;
  const { rows } = hasFilter
    ? await p.query(
        `SELECT * FROM dca_plan_admin_controls WHERE chain_id = ANY($1)
         ORDER BY chain_id, user_addr, schedule_id`,
        [chainIds],
      )
    : await p.query(
        'SELECT * FROM dca_plan_admin_controls ORDER BY chain_id, user_addr, schedule_id',
      );
  return rows.map(rowFrom);
}

/**
 * All holds keyed by `planAdminControlKey`, for callers that check many plans in one pass (the
 * executor, the plan reader) and must not issue a query per plan.
 */
export async function getPlanAdminControlMap(
  chainIds?: number[],
): Promise<Map<string, PlanAdminControl>> {
  const controls = await getPlanAdminControls(chainIds);
  return new Map(
    controls.map((c) => [planAdminControlKey(c.chainId, c.userAddr, c.scheduleId), c]),
  );
}

/**
 * Holds for one wallet on one chain, keyed by `planAdminControlKey`.
 *
 * The user-facing timing endpoint is polled every few seconds by every open dashboard, so it uses
 * this rather than the whole-chain map: it hits the (chain_id, user_addr) index and never pulls
 * other people's holds into the response path.
 */
export async function getMemberPlanAdminControlMap(
  chainId: number,
  userAddress: string,
): Promise<Map<string, PlanAdminControl>> {
  const p = requirePool();
  const { rows } = await p.query(
    `SELECT * FROM dca_plan_admin_controls WHERE chain_id = $1 AND user_addr = $2`,
    [chainId, userAddress.toLowerCase()],
  );
  return new Map(
    rows
      .map(rowFrom)
      .map((c) => [planAdminControlKey(c.chainId, c.userAddr, c.scheduleId), c]),
  );
}

/** The hold on one plan, or null when it is not held. */
export async function getPlanAdminControl(
  chainId: number,
  userAddress: string,
  scheduleId: string | number,
): Promise<PlanAdminControl | null> {
  const p = requirePool();
  const { rows } = await p.query(
    `SELECT * FROM dca_plan_admin_controls
     WHERE chain_id = $1 AND user_addr = $2 AND schedule_id = $3`,
    [chainId, userAddress.toLowerCase(), Number(scheduleId)],
  );
  return rows.length === 0 ? null : rowFrom(rows[0]);
}

export interface SetPlanAdminControlInput {
  chainId: number;
  userAddress: string;
  scheduleId: string | number;
  status: PlanAdminStatus;
  reason?: string | null;
  updatedBy?: string | null;
  /** Cooldown remainder to freeze with the hold; see PlanAdminControl.cooldownRemainingSeconds. */
  cooldownRemainingSeconds?: number | null;
}

/**
 * Place or update a hold. `created_at` is preserved across updates so the audit trail keeps the
 * moment automation first stopped, even if the reason is edited or pause is escalated to cancel.
 *
 * The frozen cooldown is preserved the same way, and for the same reason: it was measured when the
 * countdown stopped, and the chain's own cooldown has been running down ever since, so re-capturing
 * it while the plan is already held would quietly shorten the wait the user is owed on resume.
 */
export async function setPlanAdminControl(
  input: SetPlanAdminControlInput,
): Promise<PlanAdminControl> {
  const p = requirePool();
  const { rows } = await p.query(
    `INSERT INTO dca_plan_admin_controls
       (chain_id, user_addr, schedule_id, status, reason, updated_by,
        cooldown_remaining_seconds, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
     ON CONFLICT (chain_id, user_addr, schedule_id) DO UPDATE SET
       status = EXCLUDED.status,
       reason = EXCLUDED.reason,
       updated_by = EXCLUDED.updated_by,
       cooldown_remaining_seconds = COALESCE(
         dca_plan_admin_controls.cooldown_remaining_seconds,
         EXCLUDED.cooldown_remaining_seconds
       ),
       updated_at = now()
     RETURNING *`,
    [
      input.chainId,
      input.userAddress.toLowerCase(),
      Number(input.scheduleId),
      input.status,
      input.reason?.trim() ? input.reason.trim() : null,
      input.updatedBy?.trim() ? input.updatedBy.trim() : null,
      input.cooldownRemainingSeconds == null
        ? null
        : Math.max(0, Math.floor(input.cooldownRemainingSeconds)),
    ],
  );
  return rowFrom(rows[0]);
}

/** Lift a hold. Returns false when the plan was not held, so the caller can say so. */
export async function clearPlanAdminControl(
  chainId: number,
  userAddress: string,
  scheduleId: string | number,
): Promise<boolean> {
  const p = requirePool();
  const result = await p.query(
    `DELETE FROM dca_plan_admin_controls
     WHERE chain_id = $1 AND user_addr = $2 AND schedule_id = $3`,
    [chainId, userAddress.toLowerCase(), Number(scheduleId)],
  );
  return (result.rowCount ?? 0) > 0;
}
