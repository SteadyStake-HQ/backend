import { Injectable } from '@nestjs/common';
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

@Injectable()
export class HistoryService {
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

  constructor(private readonly supabase: SupabaseService) {}

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
    const nextRuns = [record, ...snapshot.runs.filter((run) => run.runId !== runId)].slice(0, 200);
    await this.writeLocalHistory({ ...snapshot, runs: nextRuns });
  }

  async getRuns(limit: number = 50): Promise<history.RunRecord[]> {
    if (this.useSupabase()) return (await this.supabase.getRunRecords(limit)) as history.RunRecord[];
    const snapshot = await this.readLocalHistory();
    return snapshot.runs.slice(0, limit);
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
