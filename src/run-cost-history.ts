/**
 * What runs have really cost on each network, read from the durable execution record.
 *
 * `gas-profile.ts` keeps the relayer's own samples in a JSON file beside the process. That is fine
 * for what it was written for — teaching the next run what the last one burned, within one process
 * — but it is not a record: the file lives in the working directory or /tmp, so a container that
 * redeploys comes back with nothing, and in production it has been empty every time anyone asked.
 * Users saw the consequence directly. The gas tank's "average run" and "most expensive run" render
 * only when there are samples, so they never appeared at all, and the live estimate beside them
 * multiplied a seeded gas figure rather than a measured one — on BNB Chain that seed is roughly a
 * third under what a run there actually burns, which is exactly the size of the gap between the
 * estimate the modal showed and the charges on the ledger.
 *
 * Every one of those executions was saved the whole time. `run_history` holds one row per sweep
 * with an `executedTasks` array on it, nothing ever prunes a row that executed something, and each
 * task carries the gas both legs burned and the amount the tank was charged. So the figures the app
 * quotes are drawn from there instead: **every recorded execution on that network, for every user,
 * with no window** — which is what an average is supposed to mean, and what makes the modal's
 * average equal the average of the treasury ledger's own charged column rather than an unrelated
 * number from whatever the current process happens to have seen.
 *
 * The aggregation itself is one SQL statement (SupabaseService.getRunCostAggregatesByChain). This
 * module is the part around it: a snapshot the synchronous readers in `gas-profile.ts` and
 * `run-executor.ts` can consult without becoming async, refreshed on a timer and on demand.
 *
 * When Supabase is not configured, or the query fails, every accessor here returns null and the
 * callers fall back to the process-local samples exactly as before. Nothing regresses; a
 * deployment without a database simply keeps the accuracy it already had.
 */

import { getNonStandardStableDecimals } from './config';
import type { RunCostAggregateRow } from './supabase/supabase.service';

/** A charge above this is a units mistake, not a run — see gas-profile.ts's own guard. */
const MAX_PLAUSIBLE_COST_USD = 10;
/** A sane band for one transaction's gas, and so for a two-leg run's total. */
const MIN_PLAUSIBLE_GAS = 21_000;
const MAX_PLAUSIBLE_GAS = 5_000_000;

/**
 * How long a snapshot is served before a refresh is triggered.
 *
 * A completed run is the only thing that changes these figures, and runs are minutes apart at
 * best. The query walks every executed row, so this is also the knob that keeps it from being
 * asked to on every page load.
 */
const SNAPSHOT_TTL_MS = 3 * 60_000;

/** After a failure, hold off rather than re-running a query the database just refused. */
const FAILURE_COOLDOWN_MS = 60_000;

export type RunCostAggregate = RunCostAggregateRow;

type Loader = () => Promise<RunCostAggregateRow[]>;

let loader: Loader | null = null;
let snapshot: Map<number, RunCostAggregateRow> = new Map();
let loadedAt = 0;
let lastFailureAt = 0;
let inFlight: Promise<void> | null = null;

/**
 * Hand this module the query it should refresh from. Called once at boot by
 * RunCostHistoryService, which owns the database handle; kept as an injection rather than an
 * import so `gas-profile.ts` and `run-executor.ts` — plain modules the executor calls from
 * scripts as well as from Nest — do not acquire a dependency on the DI container.
 */
export function setRunCostHistoryLoader(fn: Loader | null): void {
  loader = fn;
}

export function isRunCostHistoryAvailable(): boolean {
  return loader !== null;
}

/** The parameters the SQL needs, kept here so the plausibility bands have one definition. */
export function runCostHistoryQueryOptions() {
  return {
    stableDecimalsByChain: getNonStandardStableDecimals(),
    maxPlausibleCostUsd: MAX_PLAUSIBLE_COST_USD,
    minPlausibleGas: MIN_PLAUSIBLE_GAS,
    maxPlausibleGas: MAX_PLAUSIBLE_GAS,
  };
}

/**
 * Re-read the aggregates. Concurrent callers share one query rather than each starting their own,
 * which matters because the natural trigger is a page load and page loads arrive in bursts.
 */
export async function refreshRunCostHistory(force = false): Promise<void> {
  if (!loader) return;
  if (inFlight) return inFlight;
  const now = Date.now();
  if (!force && now - loadedAt < SNAPSHOT_TTL_MS && loadedAt > 0) return;
  if (!force && now - lastFailureAt < FAILURE_COOLDOWN_MS) return;

  inFlight = (async () => {
    try {
      const rows = await loader!();
      const next = new Map<number, RunCostAggregateRow>();
      for (const row of rows) {
        if (Number.isFinite(row.chainId)) next.set(row.chainId, row);
      }
      snapshot = next;
      loadedAt = Date.now();
      lastFailureAt = 0;
    } catch {
      // Keep serving the last good snapshot. A database that is briefly unreachable should not
      // blank out figures that were true a minute ago and are still very nearly true now.
      lastFailureAt = Date.now();
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * This chain's aggregates, or null when the history has nothing to say about it.
 *
 * Synchronous by design: `getGasProfile` is called from inside the executor's per-plan loop and
 * from a controller, and both want the same answer without either becoming async. A stale
 * snapshot triggers a background refresh and returns what it has — the figure is a running average
 * over thousands of runs, so being three minutes behind changes it in the fourth decimal place.
 */
export function getRunCostHistory(chainId: number): RunCostAggregateRow | null {
  if (loader && Date.now() - loadedAt >= SNAPSHOT_TTL_MS) void refreshRunCostHistory();
  return snapshot.get(chainId) ?? null;
}

/** Every chain the execution record knows about. */
export function getRunCostHistoryChainIds(): number[] {
  return [...snapshot.keys()];
}

/** When the snapshot was last rebuilt, for callers that report freshness. Null before the first. */
export function runCostHistoryLoadedAt(): string | null {
  return loadedAt > 0 ? new Date(loadedAt).toISOString() : null;
}
