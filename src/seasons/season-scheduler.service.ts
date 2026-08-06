import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { isSupabaseConfigured } from '../supabase/dca-plans-store';
import { advanceSeasons, ensureSeasonsSchema } from '../supabase/seasons-store';

/**
 * Flips season states on the clock (§11.5): Scheduled -> Live at start, Live -> Review at end. A
 * light standalone interval, like the pass indexer — a stuck season tick must never delay DCA runs
 * or pass indexing. Finalization stays a deliberate admin action; only the automatic transitions
 * happen here.
 */
@Injectable()
export class SeasonSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SeasonSchedulerService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  private intervalMs(): number {
    const n = parseInt(process.env.SEASON_TICK_MS?.trim() ?? '', 10);
    return Number.isFinite(n) && n >= 10_000 ? n : 60_000;
  }

  async onModuleInit(): Promise<void> {
    if (!isSupabaseConfigured()) {
      this.logger.warn('SUPABASE_DB_URL unset: season scheduling is disabled.');
      return;
    }
    try {
      await ensureSeasonsSchema();
    } catch (e) {
      this.logger.error(`seasons schema init failed: ${(e as Error).message}`);
      return;
    }
    setTimeout(() => void this.tick(), 2000);
    this.timer = setInterval(() => void this.tick(), this.intervalMs());
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { reviewed, activated } = await advanceSeasons();
      if (activated.length) this.logger.log(`season(s) now live: ${activated.join(', ')}`);
      if (reviewed.length) this.logger.log(`season(s) moved to review: ${reviewed.join(', ')}`);
    } catch (e) {
      this.logger.error(`season tick failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
