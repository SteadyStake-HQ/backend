import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import {
  getRunCostHistory,
  getRunCostHistoryChainIds,
  refreshRunCostHistory,
  runCostHistoryQueryOptions,
  setRunCostHistoryLoader,
} from '../run-cost-history';

/** Rebuild the snapshot on this cadence even when nothing asks for it, so a page load is never
 *  the thing waiting on a full aggregation. */
const REFRESH_INTERVAL_MS = 3 * 60_000;

/**
 * Keeps the per-chain run-cost snapshot fed from `run_history`.
 *
 * The snapshot lives in a plain module (`run-cost-history.ts`) because its readers are plain
 * modules — the executor's per-plan loop and `getGasProfile` — and neither can be made async
 * without rewriting its callers. This service is the half that needs the container: it owns the
 * database handle, binds it as the snapshot's loader at boot, and refreshes on a timer.
 *
 * Everything here is best-effort. Without Supabase configured the loader is never bound and every
 * reader falls back to the relayer's own in-process samples, which is where they were before.
 */
@Injectable()
export class RunCostHistoryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RunCostHistoryService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly supabase: SupabaseService) {}

  onModuleInit(): void {
    if (!this.supabase.isConfigured()) {
      this.logger.log(
        'Supabase is not configured — per-chain run costs fall back to the relayer\'s in-process samples.',
      );
      return;
    }

    setRunCostHistoryLoader(() =>
      this.supabase.getRunCostAggregatesByChain(runCostHistoryQueryOptions()),
    );

    // Not awaited: Nest runs every onModuleInit to completion before binding the port, and this
    // walks the whole execution history. The first request is served from the seeds if it lands
    // before the first refresh does, which is a second or two at most.
    void refreshRunCostHistory(true).then(() => this.logFirstLoad());

    this.timer = setInterval(() => void refreshRunCostHistory(true), REFRESH_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    setRunCostHistoryLoader(null);
  }

  /** Refresh now, and wait for it. For a request that would rather be a moment late than wrong. */
  async ensureLoaded(): Promise<void> {
    await refreshRunCostHistory();
  }

  private logFirstLoad(): void {
    const chainIds = getRunCostHistoryChainIds();
    if (chainIds.length === 0) {
      this.logger.log('Run-cost history: no executions on record yet.');
      return;
    }
    const summary = chainIds
      .map((id) => `${id}:${getRunCostHistory(id)?.costSamples ?? 0}`)
      .join(' ');
    this.logger.log(`Run-cost history loaded from run_history (chain:charged runs) — ${summary}`);
  }
}
