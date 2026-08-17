/**
 * The DCA missions: `onchain_create_dca_plan` and the 1/3/6 execution milestones (campaign spec §4.4).
 *
 * Read from `dca_plans`, which the plan indexer maintains from the vault's own `ScheduleCreated` and
 * `ScheduleExecuted` events. That table is the right source rather than a fresh RPC scan: it is
 * already the authority the DCA product itself reports from, it is indexed per chain, and its
 * `executed_count` comes from the schedule struct read immediately after each swap rather than from an
 * accumulated tally — so it counts swaps that actually happened and nothing else.
 *
 * WHAT "SETTLED" MEANS HERE, AND WHY THIS SATISFIES THE SPEC. §4.4 requires that "failed, reverted,
 * skipped, or cancelled executions must not count". `executed_count` advances only when the on-chain
 * struct says a swap completed, so a reverted run never reaches it. Cancellation is subtler: a
 * cancelled plan's *earlier* successful executions are real and are counted, because the spec excludes
 * cancelled *executions*, not the history of a plan that was later stopped. A plan cancelled before
 * ever executing contributes 1 to the plan count and 0 to the execution count, which is exactly right.
 *
 * SCOPED TO THE CAMPAIGN CHAIN. The mission says "a valid SteadyStake DCA plan on BOT Chain", and
 * SteadyStake runs on six networks. A plan on Base is real product usage but it is not this mission,
 * so the query filters on the campaign chain id rather than summing every network — counting them all
 * would pay the on-chain section to wallets that never touched the chain the sale settles on.
 */
import type { Pool } from 'pg';
import { getSharedPool } from '../../supabase/pg-pool';
import { campaignChainId } from '../campaign-config';
import { met, notMet, unavailable, type VerifierResult } from './verifier-types';

const SOURCE_PLANS = 'steadystake_dca:plans';
const SOURCE_EXECUTIONS = 'steadystake_dca:executions';

export interface DcaActivity {
  chainId: number;
  /** Plans this wallet has ever created on the campaign chain, cancelled ones included. */
  plans: number;
  /** Successfully settled executions across all of them. */
  executions: number;
  /** The most recent settled execution, for the dashboard. */
  lastExecutionAt: Date | null;
}

/**
 * One wallet's DCA record on the campaign chain, or null when the database is unreachable.
 *
 * Null is distinct from a zeroed record on purpose: a wallet with no plans and a database that cannot
 * be read are the same query result but very different facts, and only the first one should ever be
 * shown to a user as "not done yet".
 */
export async function readDcaActivity(wallet: string): Promise<DcaActivity | null> {
  const pool: Pool | null = getSharedPool();
  if (!pool) return null;
  const chainId = campaignChainId();

  try {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS plans,
              COALESCE(sum(executed_count), 0)::int AS executions,
              max(last_execution_at) AS last_execution_at
         FROM dca_plans
        WHERE chain_id = $1 AND user_addr = $2`,
      [chainId, wallet.trim().toLowerCase()],
    );
    const row = rows[0] ?? {};
    return {
      chainId,
      plans: Number(row.plans ?? 0),
      executions: Number(row.executions ?? 0),
      lastExecutionAt: row.last_execution_at ? new Date(row.last_execution_at as string) : null,
    };
  } catch {
    return null;
  }
}

/** `onchain_create_dca_plan` — at least one plan created on the campaign chain. */
export function verifyDcaPlanCount(activity: DcaActivity | null, requiredPlans: string): VerifierResult {
  if (!activity) {
    return unavailable(SOURCE_PLANS, 'Could not read your DCA plans right now. Try again in a moment.');
  }

  const target = Number(requiredPlans) || 1;
  const detail = { plans: activity.plans, target, chainId: activity.chainId };

  if (activity.plans >= target) {
    return met(SOURCE_PLANS, `plans:${activity.plans}`, detail);
  }
  return notMet(SOURCE_PLANS, { current: activity.plans, target }, detail);
}

/**
 * The 1/3/6 execution missions, all three scored from the same count.
 *
 * They are cumulative milestones on one number, not four separate achievements, which is why a wallet
 * arriving at 6 executions completes all four at once. That is the spec's intent — each milestone
 * "contributes its configured boost only once" — and it is why the missions are not repeatable.
 */
export function verifyDcaExecutions(activity: DcaActivity | null, requiredExecutions: string): VerifierResult {
  if (!activity) {
    return unavailable(SOURCE_EXECUTIONS, 'Could not read your DCA executions right now. Try again in a moment.');
  }

  const target = Number(requiredExecutions) || 1;
  const detail = {
    executions: activity.executions,
    target,
    chainId: activity.chainId,
    lastExecutionAt: activity.lastExecutionAt?.toISOString() ?? null,
  };

  if (activity.executions >= target) {
    return met(SOURCE_EXECUTIONS, `executions:${activity.executions}`, detail);
  }
  return notMet(SOURCE_EXECUTIONS, { current: activity.executions, target }, detail);
}
