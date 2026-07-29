import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SupabaseService } from '../supabase/supabase.service';
import * as history from '../history';
import type { ExecutorResult } from '../run-executor';

interface LocalHistorySnapshot {
  runs: history.RunRecord[];
  schedulerSettingsHistory: history.SchedulerHistoryRecord[];
  executionTimingHistory: history.SchedulerHistoryRecord[];
}

/**
 * Local-fallback retention, in runs.
 *
 * Two separate caps because the file serves two readers with opposite needs. The gas and portfolio
 * charts read their points off *every* run, including the idle ones, so a recent window has to be
 * kept whole. The treasury ledger reads only runs that executed, and those are rare enough that a
 * flat cap of 200 rows holds about twenty minutes of them. Keeping the union costs a few hundred KB
 * and is the difference between an execution staying on the page and vanishing at the next tick.
 */
const LOCAL_RECENT_RUNS = 200;
const LOCAL_EXECUTED_RUNS = 500;

/** Idle sweeps are dropped once they are this old. Executions and failures are never dropped. */
const IDLE_RUN_RETENTION_DAYS = 7;
/** Scheduler-timing rows kept. The API reads at most 100; the rest is growth with no reader. */
const EXECUTION_TIMING_ROWS_KEPT = 2_000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Long enough after boot that the sweep never competes with the first page load. */
const PRUNE_START_DELAY_MS = 5 * 60 * 1000;

@Injectable()
export class HistoryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HistoryService.name);
  private readonly localHistoryPathCandidates = [
    join(process.cwd(), 'history-store.json'),
    join(tmpdir(), 'steadystake-history-store.json'),
  ];
  private localHistoryPath: string | null = null;
  private inMemorySnapshot: LocalHistorySnapshot = {
    runs: [],
    schedulerSettingsHistory: [],
    executionTimingHistory: [],
  };
  private pruneTimers: NodeJS.Timeout[] = [];

  constructor(private readonly supabase: SupabaseService) {}

  onModuleInit(): void {
    if (!this.useSupabase()) return;
    const start = setTimeout(() => {
      void this.prune();
      const repeat = setInterval(() => void this.prune(), PRUNE_INTERVAL_MS);
      repeat.unref();
      this.pruneTimers.push(repeat);
    }, PRUNE_START_DELAY_MS);
    start.unref();
    this.pruneTimers.push(start);
  }

  onModuleDestroy(): void {
    for (const timer of this.pruneTimers) clearTimeout(timer as unknown as NodeJS.Timeout);
    this.pruneTimers = [];
  }

  /**
   * Housekeeping so the tables the execution history lives in stay writable.
   *
   * The scheduler writes a run row and a timing row every few seconds, ~17k of each per day, and
   * almost none of them record anything. Unbounded, that is what eventually fills the database —
   * and the first thing to fail is the INSERT of the next real execution. Best-effort: a failed
   * sweep is logged and retried tomorrow, never allowed to take the process down.
   */
  private async prune(): Promise<void> {
    try {
      const idle = await this.supabase.pruneIdleRunHistory(IDLE_RUN_RETENTION_DAYS);
      const timing = await this.supabase.pruneExecutionTimingHistory(EXECUTION_TIMING_ROWS_KEPT);
      if (idle > 0 || timing > 0) {
        this.logger.log(
          `History prune: removed ${idle} idle run rows older than ${IDLE_RUN_RETENTION_DAYS}d ` +
            `and ${timing} scheduler-timing rows. No execution record is ever removed.`,
        );
      }
    } catch (error) {
      this.logger.warn(`History prune failed: ${(error as Error).message}`);
    }
  }

  private useSupabase(): boolean {
    return this.supabase.isConfigured();
  }

  async saveRun(runId: string, at: Date, result: ExecutorResult): Promise<void> {
    const record: history.RunRecord = {
      runId,
      at: at.toISOString(),
      executed: result.executed,
      executedTasks: result.executedTasksDetail ?? [],
      errors: result.errors ?? [],
      gasBalances: result.gasBalances ?? [],
      planSnapshots: result.planSnapshots ?? [],
      portfolioSnapshots: result.portfolioSnapshots ?? [],
    };
    if (this.useSupabase()) {
      await this.supabase.saveRunRecord(runId, at, record);
      await this.supabase.appendGasHistory(
        (result.gasBalances ?? []).map((g) => ({
          chainId: g.chainId,
          user: g.user,
          at,
          balanceUsdc6: g.balanceUsdc6,
        })),
      );
      await this.supabase.appendPortfolioHistory(
        (result.portfolioSnapshots ?? []).map((p) => ({
          chainId: p.chainId,
          user: p.user,
          at,
          valueUsdc6: p.valueUsdc6,
        })),
      );
      return;
    }
    const snapshot = await this.readLocalHistory();
    const merged = [record, ...snapshot.runs.filter((run) => run.runId !== runId)];
    await this.writeLocalHistory({ ...snapshot, runs: retainLocalRuns(merged) });
  }

  async getRuns(limit: number = 50): Promise<history.RunRecord[]> {
    if (this.useSupabase()) return (await this.supabase.getRunRecords(limit)) as history.RunRecord[];
    const snapshot = await this.readLocalHistory();
    return snapshot.runs.slice(0, limit);
  }

  /**
   * The newest `limit` runs that executed at least one plan.
   *
   * Distinct from `getRuns` because most runs execute nothing: the scheduler sweeps every few
   * seconds and records the sweep either way, so the last N *rows* are almost always the last few
   * minutes of idle ticks with no execution among them. Anything that reports on executions —
   * the treasury ledger, the per-chain cost-per-run average — has to ask for this instead, or a
   * run that really was saved disappears from the page minutes after it happened.
   */
  async getRunsWithExecutions(limit: number = 50): Promise<history.RunRecord[]> {
    if (this.useSupabase()) {
      return (await this.supabase.getRunRecordsWithExecutions(limit)) as history.RunRecord[];
    }
    const snapshot = await this.readLocalHistory();
    return snapshot.runs.filter((run) => (run.executedTasks ?? []).length > 0).slice(0, limit);
  }

  /** Total runs on record that executed something — what the history window can reach at most. */
  async countRunsWithExecutions(): Promise<number> {
    if (this.useSupabase()) return this.supabase.countRunRecordsWithExecutions();
    const snapshot = await this.readLocalHistory();
    return snapshot.runs.filter((run) => (run.executedTasks ?? []).length > 0).length;
  }

  async getRun(runId: string): Promise<history.RunRecord | null> {
    if (this.useSupabase()) return (await this.supabase.getRunRecord(runId)) as history.RunRecord | null;
    const snapshot = await this.readLocalHistory();
    return snapshot.runs.find((run) => run.runId === runId) ?? null;
  }

  async getGasHistory(
    user?: string,
    chainId?: number,
  ): Promise<Array<{ at: string; chainId: number; user: string; balanceUsdc6: string }>> {
    if (this.useSupabase()) return this.supabase.getGasHistory(user, chainId);
    const snapshot = await this.readLocalHistory();
    return history.getGasHistoryFromRuns(snapshot.runs, user, chainId);
  }

  async getPortfolioHistory(
    user: string,
    chainId: number,
    limit: number = 200,
  ): Promise<Array<{ at: string; valueUsdc6: string }>> {
    if (this.useSupabase()) return this.supabase.getPortfolioHistory(user, chainId, limit);
    const snapshot = await this.readLocalHistory();
    return history.getPortfolioHistoryFromRuns(snapshot.runs, user, chainId, limit);
  }

  async saveSchedulerSettingsHistory(
    record: history.SchedulerHistoryRecord,
  ): Promise<void> {
    if (this.useSupabase()) {
      await this.supabase.saveSchedulerEvent(
        'scheduler_settings_history',
        record.id,
        new Date(record.at),
        record,
      );
      return;
    }
    const snapshot = await this.readLocalHistory();
    const nextEntries = [
      record,
      ...snapshot.schedulerSettingsHistory.filter((entry) => entry.id !== record.id),
    ].slice(0, 200);
    await this.writeLocalHistory({ ...snapshot, schedulerSettingsHistory: nextEntries });
  }

  async getSchedulerSettingsHistory(
    limit: number = 50,
  ): Promise<history.SchedulerHistoryRecord[]> {
    if (this.useSupabase()) {
      return (await this.supabase.getSchedulerEvents(
        'scheduler_settings_history',
        limit,
      )) as history.SchedulerHistoryRecord[];
    }
    const snapshot = await this.readLocalHistory();
    return snapshot.schedulerSettingsHistory.slice(0, limit);
  }

  async saveExecutionTimingHistory(
    record: history.SchedulerHistoryRecord,
  ): Promise<void> {
    if (this.useSupabase()) {
      await this.supabase.saveSchedulerEvent(
        'execution_timing_history',
        record.id,
        new Date(record.at),
        record,
      );
      return;
    }
    const snapshot = await this.readLocalHistory();
    const nextEntries = [
      record,
      ...snapshot.executionTimingHistory.filter((entry) => entry.id !== record.id),
    ].slice(0, 200);
    await this.writeLocalHistory({ ...snapshot, executionTimingHistory: nextEntries });
  }

  async getExecutionTimingHistory(
    limit: number = 50,
  ): Promise<history.SchedulerHistoryRecord[]> {
    if (this.useSupabase()) {
      return (await this.supabase.getSchedulerEvents(
        'execution_timing_history',
        limit,
      )) as history.SchedulerHistoryRecord[];
    }
    const snapshot = await this.readLocalHistory();
    return snapshot.executionTimingHistory.slice(0, limit);
  }

  private async readLocalHistory(): Promise<LocalHistorySnapshot> {
    for (const filePath of this.localHistoryPathCandidates) {
      try {
        const raw = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<LocalHistorySnapshot>;
        const runs = Array.isArray(parsed.runs) ? parsed.runs : [];
        const schedulerSettingsHistory = Array.isArray(parsed.schedulerSettingsHistory)
          ? parsed.schedulerSettingsHistory
          : [];
        const executionTimingHistory = Array.isArray(parsed.executionTimingHistory)
          ? parsed.executionTimingHistory
          : [];
        this.localHistoryPath = filePath;
        this.inMemorySnapshot = { runs, schedulerSettingsHistory, executionTimingHistory };
        return this.inMemorySnapshot;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          continue;
        }
      }
    }
    return this.inMemorySnapshot;
  }

  private async writeLocalHistory(snapshot: LocalHistorySnapshot): Promise<void> {
    this.inMemorySnapshot = snapshot;
    for (const filePath of this.localHistoryPathCandidates) {
      try {
        await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
        this.localHistoryPath = filePath;
        return;
      } catch {
        continue;
      }
    }
  }
}

/**
 * What the local file keeps: a whole recent window, plus every recent run that executed something.
 *
 * A flat cap on the newest N runs is the file-mode form of the same bug the Supabase path had — at
 * one sweep every few seconds, 200 rows is twenty minutes, and an execution is evicted by the idle
 * ticks that follow it long before anyone looks. Executions are kept on their own count so they
 * survive; idle runs are kept only for the recent window the gas and portfolio charts read.
 *
 * `runs` is newest-first on the way in and stays newest-first on the way out.
 */
function retainLocalRuns(runs: history.RunRecord[]): history.RunRecord[] {
  const keep = new Set<string>();
  for (const run of runs.slice(0, LOCAL_RECENT_RUNS)) keep.add(run.runId);

  let executed = 0;
  for (const run of runs) {
    if ((run.executedTasks ?? []).length === 0) continue;
    if (executed++ >= LOCAL_EXECUTED_RUNS) break;
    keep.add(run.runId);
  }

  return runs.filter((run) => keep.has(run.runId));
}
