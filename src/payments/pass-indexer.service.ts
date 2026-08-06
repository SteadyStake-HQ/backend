import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { isSupabaseConfigured } from '../supabase/dca-plans-store';
import { ensurePaymentNetworksSchema } from '../supabase/payment-networks';
import { ensurePurchaseIntentsSchema, expireStaleIntents } from '../supabase/purchase-intents';
import { ensurePassEntitlementsSchema } from '../supabase/pass-entitlements';
import { seedPaymentNetworks } from './seed-payment-networks';
import { indexPassPayments } from './pass-indexer';

/**
 * Runs the Game Pass payment indexer on a light interval. Kept as its own loop rather than folded
 * into the DCA scheduler tick: the two have different cadences and failure domains, and a stuck pass
 * scan must never delay a DCA execution. Overlap-guarded so a slow scan can't stack.
 */
@Injectable()
export class PassIndexerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PassIndexerService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  private intervalMs(): number {
    const n = parseInt(process.env.PASS_INDEX_INTERVAL_MS?.trim() ?? '', 10);
    return Number.isFinite(n) && n >= 5000 ? n : 45_000;
  }

  async onModuleInit(): Promise<void> {
    if (!isSupabaseConfigured()) {
      this.logger.warn('SUPABASE_DB_URL unset: Game Pass payments are disabled.');
      return;
    }
    try {
      await ensurePaymentNetworksSchema();
      await ensurePurchaseIntentsSchema();
      await ensurePassEntitlementsSchema();
      await seedPaymentNetworks(this.logger);
    } catch (e) {
      this.logger.error(`payments init failed: ${(e as Error).message}`);
      return;
    }

    // First pass shortly after boot, then on the interval.
    setTimeout(() => void this.tick(), 3000);
    this.timer = setInterval(() => void this.tick(), this.intervalMs());
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await expireStaleIntents();
      const result = await indexPassPayments();
      const confirmed = result.chains.reduce((a, c) => a + c.confirmed, 0);
      if (confirmed > 0) this.logger.log(`indexed ${confirmed} pass payment(s)`);
      if (result.errors?.length) this.logger.warn(`indexer errors: ${result.errors.join('; ')}`);
    } catch (e) {
      this.logger.error(`pass indexer tick failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
