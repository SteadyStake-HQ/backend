/**
 * Resume gates on individual DCA plans, stored in `dca_plan_execution_gates`.
 *
 * An admin hold freezes a plan's countdown: while the plan is paused the wait it still owes stops
 * being spent. The chain does not know that — `lastExecutionTime` is fixed, so its cooldown carries
 * on elapsing — which is why lifting a hold used to fire the plan on the very next tick no matter
 * how long it had left when it was paused.
 *
 * A gate is what carries that frozen remainder across the resume: when a hold is lifted with N
 * seconds still owed, a row is written with `not_before = now() + N`, and the relayer treats the
 * plan as not-yet-due until then. It is off-chain and advisory only, exactly like the hold it
 * comes from: the schedule, its enrolment and the deposit are untouched, and the owner can still
 * execute their own plan from their wallet whenever the contract permits it.
 *
 * A row is only meaningful while `not_before` is in the future; every read filters expired rows out
 * and `pruneExpiredPlanExecutionGates` clears them, so "no row" and "an expired row" mean the same
 * thing and neither can be read as an open-ended stop.
 */
import { Pool } from 'pg';
import { getSharedPool } from './pg-pool';

export interface PlanExecutionGate {
  chainId: number;
  userAddr: string;
  scheduleId: number;
  /** Wall-clock instant before which the relayer must not auto-execute this plan. */
  notBefore: Date;
  /** The cooldown remainder this gate is repaying, as captured when the hold was placed. */
  heldRemainingSeconds: number;
  createdAt: Date;
}

function getPool(): Pool | null {
  return getSharedPool();
}

function requirePool(): Pool {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  return p;
}

/** Shared DDL, run from SupabaseService.ensureSchema on boot and by the standalone/CLI path. */
export const PLAN_EXECUTION_GATES_DDL = `
  CREATE TABLE IF NOT EXISTS dca_plan_execution_gates (
    chain_id integer NOT NULL,
    user_addr text NOT NULL,
    schedule_id integer NOT NULL,
    not_before timestamptz NOT NULL,
    held_remaining_seconds integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, user_addr, schedule_id)
  );
  CREATE INDEX IF NOT EXISTS dca_plan_execution_gates_member_idx
    ON dca_plan_execution_gates (chain_id, user_addr);
`;

/** Same key shape as plan admin holds, so both maps are looked up with one call. */
export function planExecutionGateKey(
  chainId: number,
  userAddress: string,
  scheduleId: string | number | bigint,
): string {
  return `${chainId}:${userAddress.toLowerCase()}:${scheduleId.toString()}`;
}

function rowFrom(r: Record<string, unknown>): PlanExecutionGate {
  return {
    chainId: Number(r.chain_id),
    userAddr: r.user_addr as string,
    scheduleId: Number(r.schedule_id),
    notBefore: new Date(r.not_before as string),
    heldRemainingSeconds: Number(r.held_remaining_seconds ?? 0),
    createdAt: new Date(r.created_at as string),
  };
}

/** Gates still in force. Pass chainIds to restrict; empty/undefined returns all. */
export async function getPlanExecutionGates(chainIds?: number[]): Promise<PlanExecutionGate[]> {
  const p = requirePool();
  const hasFilter = Array.isArray(chainIds) && chainIds.length > 0;
  const { rows } = hasFilter
    ? await p.query(
        `SELECT * FROM dca_plan_execution_gates
         WHERE not_before > now() AND chain_id = ANY($1)
         ORDER BY chain_id, user_addr, schedule_id`,
        [chainIds],
      )
    : await p.query(
        `SELECT * FROM dca_plan_execution_gates
         WHERE not_before > now()
         ORDER BY chain_id, user_addr, schedule_id`,
      );
  return rows.map(rowFrom);
}

/** Gates in force keyed by `planExecutionGateKey`, for callers that check many plans in one pass. */
export async function getPlanExecutionGateMap(
  chainIds?: number[],
): Promise<Map<string, PlanExecutionGate>> {
  const gates = await getPlanExecutionGates(chainIds);
  return new Map(gates.map((g) => [planExecutionGateKey(g.chainId, g.userAddr, g.scheduleId), g]));
}

/**
 * Gates for one wallet on one chain. The user-facing timing endpoint is polled by every open
 * dashboard, so it uses this rather than the whole-chain map.
 */
export async function getMemberPlanExecutionGateMap(
  chainId: number,
  userAddress: string,
): Promise<Map<string, PlanExecutionGate>> {
  const p = requirePool();
  const { rows } = await p.query(
    `SELECT * FROM dca_plan_execution_gates
     WHERE chain_id = $1 AND user_addr = $2 AND not_before > now()`,
    [chainId, userAddress.toLowerCase()],
  );
  return new Map(
    rows.map(rowFrom).map((g) => [planExecutionGateKey(g.chainId, g.userAddr, g.scheduleId), g]),
  );
}

/** The gate on one plan, or null when nothing is deferring it. */
export async function getPlanExecutionGate(
  chainId: number,
  userAddress: string,
  scheduleId: string | number,
): Promise<PlanExecutionGate | null> {
  const p = requirePool();
  const { rows } = await p.query(
    `SELECT * FROM dca_plan_execution_gates
     WHERE chain_id = $1 AND user_addr = $2 AND schedule_id = $3 AND not_before > now()`,
    [chainId, userAddress.toLowerCase(), Number(scheduleId)],
  );
  return rows.length === 0 ? null : rowFrom(rows[0]);
}

export interface SetPlanExecutionGateInput {
  chainId: number;
  userAddress: string;
  scheduleId: string | number;
  /** Seconds of cooldown still owed. The gate expires that many seconds from now. */
  remainingSeconds: number;
}

/** Defer a plan by `remainingSeconds` from now. Replaces any existing gate on the same plan. */
export async function setPlanExecutionGate(
  input: SetPlanExecutionGateInput,
): Promise<PlanExecutionGate> {
  const p = requirePool();
  const remaining = Math.max(0, Math.floor(input.remainingSeconds));
  const { rows } = await p.query(
    `INSERT INTO dca_plan_execution_gates
       (chain_id, user_addr, schedule_id, not_before, held_remaining_seconds, created_at)
     VALUES ($1, $2, $3, now() + ($4::int * interval '1 second'), $4::int, now())
     ON CONFLICT (chain_id, user_addr, schedule_id) DO UPDATE SET
       not_before = EXCLUDED.not_before,
       held_remaining_seconds = EXCLUDED.held_remaining_seconds,
       created_at = now()
     RETURNING *`,
    [input.chainId, input.userAddress.toLowerCase(), Number(input.scheduleId), remaining],
  );
  return rowFrom(rows[0]);
}

/** Drop a gate. Returns false when the plan was not gated. */
export async function clearPlanExecutionGate(
  chainId: number,
  userAddress: string,
  scheduleId: string | number,
): Promise<boolean> {
  const p = requirePool();
  const result = await p.query(
    `DELETE FROM dca_plan_execution_gates
     WHERE chain_id = $1 AND user_addr = $2 AND schedule_id = $3`,
    [chainId, userAddress.toLowerCase(), Number(scheduleId)],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Housekeeping: drop gates that have run out. Called from the executor's own read path. */
export async function pruneExpiredPlanExecutionGates(): Promise<number> {
  const p = requirePool();
  const result = await p.query('DELETE FROM dca_plan_execution_gates WHERE not_before <= now()');
  return result.rowCount ?? 0;
}
