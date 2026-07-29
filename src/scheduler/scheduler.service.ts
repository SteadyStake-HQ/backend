import { Injectable, OnModuleInit } from '@nestjs/common';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Subject } from 'rxjs';
import { runExecutor, type ExecutorResult } from '../run-executor';
import { SchedulerConfigService } from '../config/scheduler-config.service';
import { HistoryService } from '../history/history.service';
import { SupabaseService } from '../supabase/supabase.service';
import {
  clearPlanExecuting,
  getPlanExecutionMode,
  markPlanExecuting,
} from '../plans/plan-execution-state';
import type { SchedulerHistoryRecord } from '../history';

export interface ExecutionStatusPayload {
  status: 'idle' | 'running';
  log: string[];
  lastResult: ExecutorResult | null;
}

interface SchedulerRuntimeState {
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastResult: ExecutorResult | null;
}

const SCHEDULER_STATE_KV_KEY = 'steadystake:scheduler:state';

/**
 * How long a manual run waits for the in-flight scheduled run to finish before giving up. The
 * poll interval is capped at 5s while a full fleet scan takes longer, so the scheduler is almost
 * always busy — a manual run that refused to wait would never find a free slot.
 */
const MANUAL_RUN_MAX_WAIT_MS = 60_000;
/** A scheduled tick only ever starts when the queue is already clear, so this is slack, not a wait. */
const SCHEDULED_RUN_MAX_WAIT_MS = 1_000;

@Injectable()
export class SchedulerService implements OnModuleInit {
  private lastRunAt: Date | null = null;
  private lastResult: ExecutorResult | null = null;
  private nextRunAt: Date | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private isRunning = false;
  private pendingRuns = 0;
  private runChain: Promise<unknown> = Promise.resolve();
  private executionLog: string[] = [];
  private readonly execution$ = new Subject<ExecutionStatusPayload>();
  private readonly runtimeStatePaths = [
    join(process.cwd(), 'scheduler-state.json'),
    join(tmpdir(), 'steadystake-scheduler-state.json'),
  ];
  private activeRuntimeStatePath: string | null = null;

  constructor(
    private readonly config: SchedulerConfigService,
    private readonly history: HistoryService,
    private readonly supabase: SupabaseService,
  ) {}

  async onModuleInit() {
    await this.config.hydrate();
    await this.restoreRuntimeState();
    try {
      await this.hydrateRuntimeSessionFromSupabase();
      await this.syncRuntimeSession();
    } catch (error) {
      console.warn(`Runtime session sync unavailable: ${(error as Error).message}`);
    }
    this.scheduleNext();
    // No plan indexing on boot. Plans are recorded to dca_plans as they are created, executed and
    // cancelled, so the table needs no scan to stay correct — and a boot-time index is a block-log
    // scan that costs minutes whenever the cursor is missing or stale. To backfill plans created
    // outside that path, call POST /api/plans/reindex explicitly.
  }

  async getStatus(): Promise<{
    lastRunAt: string | null;
    nextRunAt: string | null;
    isRunning: boolean;
    lastResult: ExecutorResult | null;
  }> {
    const nextRunAt = await this.resolveEffectiveNextRunAt();
    return {
      lastRunAt: this.lastRunAt?.toISOString() ?? null,
      nextRunAt: nextRunAt?.toISOString() ?? null,
      isRunning: this.isRunning,
      lastResult: this.lastResult ?? null,
    };
  }

  async getTimingContext(): Promise<{
    serverTime: number;
    lastRunAt: string | null;
    nextRunAt: string | null;
    nextRunTimestamp: number | null;
    intervalMs: number;
    isRunning: boolean;
  }> {
    const nextRunAt = await this.resolveEffectiveNextRunAt();
    const config = this.config.getConfig();
    return {
      serverTime: Math.floor(Date.now() / 1000),
      lastRunAt: this.lastRunAt?.toISOString() ?? null,
      nextRunAt: nextRunAt?.toISOString() ?? null,
      nextRunTimestamp: nextRunAt ? Math.floor(nextRunAt.getTime() / 1000) : null,
      intervalMs: config.intervalMs,
      isRunning: this.isRunning,
    };
  }

  getExecutionStatus(): ExecutionStatusPayload {
    return {
      status: this.isRunning ? 'running' : 'idle',
      log: [...this.executionLog],
      lastResult: this.lastResult ?? null,
    };
  }

  getExecutionStream(): Subject<ExecutionStatusPayload> {
    return this.execution$;
  }

  async getConfig() {
    const currentConfig = this.config.getConfig();
    if (!this.supabase.isConfigured()) {
      return currentConfig;
    }

    try {
      const session = await this.supabase.getLatestRuntimeSession();
      if (!session) {
        return currentConfig;
      }
      const nextRun = new Date(session.next_run);
      return {
        intervalMs:
          typeof session.intervalMs === 'number' && session.intervalMs > 0
            ? session.intervalMs
            : currentConfig.intervalMs,
        ...(session.isTimeAt === true ? { staticTimeEnabled: true } : {}),
        ...(session.isTimeAt === true && !Number.isNaN(nextRun.getTime())
          ? { staticStartAt: nextRun.toISOString() }
          : currentConfig.staticStartAt
            ? { staticStartAt: currentConfig.staticStartAt }
            : {}),
      };
    } catch {
      return currentConfig;
    }
  }

  async setConfig(config: {
    intervalMs?: number;
    staticTimeEnabled?: boolean;
    staticStartAt?: string;
  }) {
    if (config.staticTimeEnabled === true && config.staticStartAt) {
      const requestedNextRun = new Date(config.staticStartAt);
      if (Number.isNaN(requestedNextRun.getTime())) {
        throw new Error('Invalid next run date.');
      }
      if (requestedNextRun.getTime() <= Date.now()) {
        throw new Error('Next run time must be in the future.');
      }
    }

    const updated = await this.config.setConfig(config);
    this.nextRunAt =
      updated.staticTimeEnabled && updated.staticStartAt
        ? new Date(updated.staticStartAt)
        : new Date(Date.now() + updated.intervalMs);
    await this.recordSchedulerSettingsHistory(updated, config);
    await this.syncRuntimeSession(updated);
    await this.persistRuntimeState();
    this.scheduleNext();
    return updated;
  }

  private computeNextRunAt(from: Date = new Date()): Date {
    const { intervalMs, staticTimeEnabled, staticStartAt } = this.config.getConfig();
    if (!staticTimeEnabled || !staticStartAt) {
      return new Date(from.getTime() + intervalMs);
    }

    const anchor = new Date(staticStartAt);
    if (Number.isNaN(anchor.getTime())) {
      return new Date(from.getTime() + intervalMs);
    }

    return anchor;
  }

  scheduleNext(): void {
    if (this.timeoutId) clearTimeout(this.timeoutId);
    if (!this.nextRunAt) {
      this.nextRunAt = this.computeNextRunAt(new Date());
    }
    void this.persistRuntimeState();
    const delayMs = Math.max(0, this.nextRunAt.getTime() - Date.now());
    this.timeoutId = setTimeout(() => {
      // Also defers for a queued manual run, so an operator's execution is never made to wait
      // behind a tick that was scheduled after they clicked.
      if (this.isRunning || this.pendingRuns > 0) {
        void this.persistRuntimeState();
        this.timeoutId = setTimeout(() => this.scheduleNext(), 1000);
        return;
      }
      this.runOnce().catch((e) => console.error('Scheduled run failed:', e));
    }, delayMs);
  }

  async runOnce(): Promise<ExecutorResult> {
    if (this.isRunning || this.pendingRuns > 0) {
      throw new Error('Executor is already running');
    }
    return this.enqueueRun(() => this.executeScheduledRun(), SCHEDULED_RUN_MAX_WAIT_MS);
  }

  private async executeScheduledRun(): Promise<ExecutorResult> {
    this.isRunning = true;
    this.executionLog = [];
    await this.persistRuntimeState();
    this.broadcast();
    const at = new Date();
    const runId = at.toISOString().replace(/[:.]/g, '-');
    const onProgress = (msg: string) => {
      this.executionLog.push(`[${new Date().toISOString()}] ${msg}`);
      this.broadcast();
    };
    const cfg = this.config.getConfig();
    const nextScheduledAt = new Date(at.getTime() + cfg.intervalMs);
    try {
      const result = await runExecutor(onProgress);
      this.lastRunAt = at;
      this.lastResult = result;
      this.nextRunAt = nextScheduledAt;
      if (cfg.staticTimeEnabled) {
        await this.config.setConfig({
          staticTimeEnabled: true,
          staticStartAt: this.nextRunAt.toISOString(),
        });
      }
      await this.recordExecutionTimingHistory(cfg, at, nextScheduledAt, 'Run completed and next execution scheduled.');
      await this.syncRuntimeSession({
        ...cfg,
        ...(cfg.staticTimeEnabled ? { staticStartAt: this.nextRunAt.toISOString() } : {}),
      }, nextScheduledAt);
      await this.persistRuntimeState();
      try {
        await this.history.saveRun(runId, at, result);
      } catch (e) {
        console.error('History save failed:', e);
      }
      // No plan re-index here: the executor records each swap to dca_plans as it makes it, so
      // committed/swapped/progress are already current. This used to scan block logs every tick.
      return result;
    } finally {
      // Released before any bookkeeping: these awaits can throw (history writes are not guarded),
      // and a throw here used to skip the reset and wedge the executor as permanently "running".
      this.isRunning = false;
      try {
        if (!this.nextRunAt || this.nextRunAt.getTime() <= at.getTime()) {
          this.nextRunAt = nextScheduledAt;
          if (cfg.staticTimeEnabled) {
            await this.config.setConfig({
              staticTimeEnabled: true,
              staticStartAt: this.nextRunAt.toISOString(),
            });
          }
          await this.recordExecutionTimingHistory(cfg, at, nextScheduledAt, 'Run started; next execution advanced from the execution start time.');
        }
        await this.syncRuntimeSession({
          ...cfg,
          ...(cfg.staticTimeEnabled && this.nextRunAt ? { staticStartAt: this.nextRunAt.toISOString() } : {}),
        }, nextScheduledAt);
        await this.persistRuntimeState();
      } catch (error) {
        console.error('Scheduler bookkeeping after run failed:', error);
      }
      this.scheduleNext();
      this.broadcast();
    }
  }

  async runSelectedPlan(input: {
    chainId: number;
    userAddress: string;
    scheduleId: string;
  }): Promise<ExecutorResult> {
    // The dashboards disable the button off this same state, but that is advisory only — two
    // operators, or one double-click landing before the next poll, must not both reach the relayer.
    if (getPlanExecutionMode(input.chainId, input.userAddress, input.scheduleId) !== null) {
      throw new Error('This plan is already executing.');
    }
    // Marked here rather than at swap time: a queued run can wait up to a minute for the scheduler,
    // and an unmarked plan shows an idle button on both dashboards for that whole wait.
    markPlanExecuting(input.chainId, input.userAddress, input.scheduleId, 'manual', {
      source: 'relayer',
    });
    try {
      // Operator-initiated, so it queues behind an in-flight scheduled run instead of failing: the
      // scheduled fleet scan outlasts its own poll interval, leaving no idle moment to race for.
      return await this.enqueueRun(() => this.executeSelectedPlan(input), MANUAL_RUN_MAX_WAIT_MS);
    } finally {
      clearPlanExecuting(input.chainId, input.userAddress, input.scheduleId, { source: 'relayer' });
    }
  }

  private async executeSelectedPlan(input: {
    chainId: number;
    userAddress: string;
    scheduleId: string;
  }): Promise<ExecutorResult> {
    this.isRunning = true;
    this.executionLog = [];
    await this.persistRuntimeState();
    this.broadcast();

    const at = new Date();
    const runId = `manual-${at.toISOString().replace(/[:.]/g, '-')}`;
    const onProgress = (message: string) => {
      this.executionLog.push(`[${new Date().toISOString()}] ${message}`);
      this.broadcast();
    };

    try {
      const result = await runExecutor(onProgress, {
        targets: [input],
      });
      this.lastResult = result;
      try {
        await this.history.saveRun(runId, at, result);
      } catch (error) {
        console.error('Manual plan execution history save failed:', error);
      }
      await this.persistRuntimeState();
      return result;
    } finally {
      this.isRunning = false;
      await this.persistRuntimeState();
      this.broadcast();
    }
  }

  private broadcast(): void {
    this.execution$.next(this.getExecutionStatus());
  }

  /**
   * Serializes every executor run. The relayer signs with a single key, so two runs in flight
   * would race on the same nonce. Callers queue rather than fail: the deadline is checked when the
   * slot is granted, so a run that waited too long is dropped before it can touch a plan — never
   * after the caller has been told it failed.
   */
  private enqueueRun<T>(task: () => Promise<T>, maxWaitMs: number): Promise<T> {
    const deadline = Date.now() + maxWaitMs;
    this.pendingRuns += 1;
    const start = () => {
      if (Date.now() > deadline) {
        throw new Error(
          'Executor is busy with a scheduled run and the plan was not executed. Try again in a moment.',
        );
      }
      return task();
    };
    const run = this.runChain.then(start, start).finally(() => {
      this.pendingRuns -= 1;
    });
    this.runChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async restoreRuntimeState(): Promise<void> {
    if (this.supabase.isConfigured()) {
      try {
        const parsed = await this.supabase.kvGetJson<Partial<SchedulerRuntimeState>>(
          SCHEDULER_STATE_KV_KEY,
        );
        if (parsed) {
          this.lastRunAt =
            typeof parsed.lastRunAt === 'string' && parsed.lastRunAt
              ? new Date(parsed.lastRunAt)
              : null;
          this.nextRunAt =
            typeof parsed.nextRunAt === 'string' && parsed.nextRunAt
              ? new Date(parsed.nextRunAt)
              : null;
          this.lastResult = parsed.lastResult ?? null;
          return;
        }
      } catch {
        // fall through to file restoration
      }
    }
    for (const path of this.runtimeStatePaths) {
      if (!existsSync(path)) continue;
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SchedulerRuntimeState>;
        this.lastRunAt =
          typeof parsed.lastRunAt === 'string' && parsed.lastRunAt
            ? new Date(parsed.lastRunAt)
            : null;
        this.nextRunAt =
          typeof parsed.nextRunAt === 'string' && parsed.nextRunAt
            ? new Date(parsed.nextRunAt)
            : null;
        this.lastResult = parsed.lastResult ?? null;
        this.activeRuntimeStatePath = path;
        return;
      } catch {
        continue;
      }
    }
  }

  private async persistRuntimeState(): Promise<void> {
    const state: SchedulerRuntimeState = {
      lastRunAt: this.lastRunAt?.toISOString() ?? null,
      nextRunAt: this.nextRunAt?.toISOString() ?? null,
      lastResult: this.lastResult ?? null,
    };
    const serialized = JSON.stringify(state, null, 2);
    if (this.supabase.isConfigured()) {
      try {
        await this.supabase.kvSetJson(SCHEDULER_STATE_KV_KEY, state);
        return;
      } catch (error) {
        console.warn(`Scheduler state Supabase persist failed: ${(error as Error).message}`);
      }
    }
    const candidatePaths = [
      ...(this.activeRuntimeStatePath ? [this.activeRuntimeStatePath] : []),
      ...this.runtimeStatePaths,
    ].filter((path, index, list) => list.indexOf(path) === index);
    for (const path of candidatePaths) {
      try {
        writeFileSync(path, serialized, 'utf-8');
        this.activeRuntimeStatePath = path;
        return;
      } catch {
        continue;
      }
    }
  }

  private async recordSchedulerSettingsHistory(
    config: {
      intervalMs: number;
      staticTimeEnabled?: boolean;
      staticStartAt?: string;
    },
    request: {
      intervalMs?: number;
      staticTimeEnabled?: boolean;
      staticStartAt?: string;
    },
  ): Promise<void> {
    const eventType: SchedulerHistoryRecord['eventType'] =
      request.staticTimeEnabled !== undefined || request.staticStartAt !== undefined
        ? 'static_time_change'
        : 'period_change';
    const note =
      eventType === 'static_time_change'
        ? config.staticTimeEnabled && config.staticStartAt
          ? `Static schedule saved for ${config.staticStartAt}.`
          : 'Static schedule disabled.'
        : `Run period changed to ${config.intervalMs} ms.`;
    await this.history.saveSchedulerSettingsHistory({
      id: `settings-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      eventType,
      intervalMs: config.intervalMs,
      nextRunAt: this.nextRunAt?.toISOString() ?? null,
      staticTimeEnabled: config.staticTimeEnabled === true,
      staticStartAt: config.staticStartAt ?? null,
      source: 'dashboard',
      note,
    });
  }

  private async recordExecutionTimingHistory(
    config: {
      intervalMs: number;
      staticTimeEnabled?: boolean;
      staticStartAt?: string;
    },
    executionStartedAt: Date,
    nextRunAt: Date,
    note: string,
  ): Promise<void> {
    await this.history.saveExecutionTimingHistory({
      id: `execution-${executionStartedAt.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
      at: executionStartedAt.toISOString(),
      eventType: 'execution_schedule',
      intervalMs: config.intervalMs,
      nextRunAt: nextRunAt.toISOString(),
      staticTimeEnabled: config.staticTimeEnabled === true,
      staticStartAt: config.staticStartAt ?? null,
      source: 'scheduler',
      note,
    });
  }

  private async hydrateRuntimeSessionFromSupabase(): Promise<void> {
    const session = await this.supabase.getLatestRuntimeSession();
    if (!session) {
      return;
    }

    const nextRunFromSession = new Date(session.next_run);
    const currentConfig = this.config.getConfig();

    await this.config.setConfig({
      intervalMs:
        typeof session.intervalMs === 'number' && session.intervalMs > 0
          ? session.intervalMs
          : currentConfig.intervalMs,
      staticTimeEnabled: session.isTimeAt === true,
      staticStartAt:
        session.isTimeAt === true && !Number.isNaN(nextRunFromSession.getTime())
          ? nextRunFromSession.toISOString()
          : undefined,
    });

    if (!Number.isNaN(nextRunFromSession.getTime())) {
      this.nextRunAt = nextRunFromSession;
    } else {
      this.nextRunAt = this.computeNextRunAt(new Date());
    }

  }

  private async syncRuntimeSession(
    config: {
      intervalMs: number;
      staticTimeEnabled?: boolean;
      staticStartAt?: string;
    } = this.config.getConfig(),
    resolvedNextRunAt?: Date,
  ): Promise<void> {
    const runPeriod =
      resolvedNextRunAt && !Number.isNaN(resolvedNextRunAt.getTime())
        ? resolvedNextRunAt
        : this.nextRunAt ?? this.computeNextRunAt(new Date());
    const configuredNextRun =
      config.staticTimeEnabled && config.staticStartAt ? new Date(config.staticStartAt) : runPeriod;
    const nextRun =
      Number.isNaN(configuredNextRun.getTime()) ? runPeriod : configuredNextRun;

    if (!this.supabase.isConfigured()) {
      return;
    }

    try {
      await this.supabase.upsertLatestRuntimeSession({
        run_period: runPeriod,
        next_run: nextRun,
        isTimeAt: config.staticTimeEnabled === true,
        intervalMs: config.intervalMs,
        updatedAt: new Date(),
      });
    } catch (error) {
      console.warn(`Runtime session Supabase persist failed: ${(error as Error).message}`);
    }
  }

  private async resolveEffectiveNextRunAt(): Promise<Date | null> {
    if (this.supabase.isConfigured()) {
      try {
        const session = await this.supabase.getLatestRuntimeSession();
        if (session) {
          const persistedNextRunAt = new Date(session.next_run);
          if (!Number.isNaN(persistedNextRunAt.getTime())) {
            this.nextRunAt = persistedNextRunAt;
            return persistedNextRunAt;
          }
        }
      } catch {
        // fall through to config-derived snapshot
      }
    }

    if (this.nextRunAt && !Number.isNaN(this.nextRunAt.getTime())) {
      return this.nextRunAt;
    }

    const config = this.config.getConfig();
    if (config.staticTimeEnabled && config.staticStartAt) {
      const configuredNextRunAt = new Date(config.staticStartAt);
      if (!Number.isNaN(configuredNextRunAt.getTime())) {
        this.nextRunAt = configuredNextRunAt;
        return configuredNextRunAt;
      }
    }

    if (typeof config.intervalMs === 'number' && config.intervalMs > 0) {
      const computedNextRunAt = new Date(Date.now() + config.intervalMs);
      this.nextRunAt = computedNextRunAt;
      return computedNextRunAt;
    }

    return null;
  }
}
