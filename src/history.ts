/**
 * Run history types and pure helpers used by the local-file fallback in HistoryService.
 * Primary persistence now lives in Supabase Postgres (see SupabaseService).
 */
import type {
  ExecutedTask,
  GasBalanceEntry,
  PlanSnapshotEntry,
  PortfolioSnapshotEntry,
} from "./run-executor";

export interface RunRecord {
  runId: string;
  at: string;
  executed: number;
  executedTasks: ExecutedTask[];
  errors: string[];
  gasBalances: GasBalanceEntry[];
  planSnapshots: PlanSnapshotEntry[];
  portfolioSnapshots: PortfolioSnapshotEntry[];
}

export interface SchedulerHistoryRecord {
  id: string;
  at: string;
  eventType: "period_change" | "static_time_change" | "execution_schedule";
  intervalMs: number;
  nextRunAt: string | null;
  staticTimeEnabled: boolean;
  staticStartAt: string | null;
  source: "dashboard" | "scheduler";
  note?: string;
}

export function getPortfolioHistoryFromRuns(
  runs: RunRecord[],
  user: string,
  chainId: number,
  limit: number = 200
): Array<{ at: string; valueUsdc6: string }> {
  const normalizedUser = user.toLowerCase();
  const points = runs
    .flatMap((run) =>
      (run.portfolioSnapshots ?? [])
        .filter(
          (snapshot) =>
            snapshot.chainId === chainId &&
            snapshot.user.toLowerCase() === normalizedUser
        )
        .map((snapshot) => ({
          at: run.at,
          valueUsdc6: snapshot.valueUsdc6,
        }))
    )
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return points.slice(0, limit);
}

export function getGasHistoryFromRuns(
  runs: RunRecord[],
  user?: string,
  chainId?: number
): Array<{ at: string; chainId: number; user: string; balanceUsdc6: string }> {
  const normalizedUser = user?.toLowerCase();
  const byUser = new Map<string, Array<{ at: string; chainId: number; user: string; balanceUsdc6: string }>>();
  for (const run of runs) {
    for (const gasEntry of run.gasBalances ?? []) {
      if (chainId != null && gasEntry.chainId !== chainId) continue;
      if (normalizedUser && gasEntry.user.toLowerCase() !== normalizedUser) continue;
      const key = `${gasEntry.chainId}:${gasEntry.user.toLowerCase()}`;
      if (!byUser.has(key)) byUser.set(key, []);
      byUser.get(key)!.push({
        at: run.at,
        chainId: gasEntry.chainId,
        user: gasEntry.user,
        balanceUsdc6: gasEntry.balanceUsdc6,
      });
    }
  }
  const entries = Array.from(byUser.values()).flat();
  entries.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return entries.slice(0, 500);
}
