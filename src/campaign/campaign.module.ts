/**
 * The Early Supporter Campaign module.
 *
 * `CampaignScheduler` is here rather than in scheduler/ deliberately: the DCA scheduler is a relayer
 * that signs and sends transactions on a cadence the operator sets, and folding a read-only log
 * indexer into it would put campaign work behind that dashboard's run controls. This one only reads
 * logs and writes rows.
 */
import { Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { CampaignAdminController } from './campaign-admin.controller';
import { CampaignController } from './campaign.controller';
import { CampaignService } from './campaign.service';
import { CampaignVoucherService } from './campaign-voucher';
import { campaignPresale } from './campaign-config';
import { PresaleIndexerService } from './presale-indexer';

/**
 * How often the sale's events are read.
 *
 * A minute is chosen from what the delay actually costs someone: it is the lag between a referee's
 * purchase confirming and their referrer's +0.20% becoming available. Faster would mean more RPC calls
 * for a reward nobody is watching a clock for, and the referrer's own next page load re-reads it
 * anyway. Nothing in the campaign is time-critical to the second.
 */
const INDEX_INTERVAL_MS = 60_000;

@Injectable()
class CampaignScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CampaignScheduler.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly indexer: PresaleIndexerService) {}

  onModuleInit(): void {
    // Nothing to index without a v3 sale, and starting a timer that logs "not configured" every minute
    // would bury real warnings. The admin endpoint can still trigger a run once one is deployed.
    if (!campaignPresale()) {
      this.logger.log('Campaign event indexer idle: no SS4PresaleV3 is configured for the campaign chain.');
      return;
    }

    // `unref` so a shutdown is not held open by a pending tick, matching the other timers here.
    this.timer = setInterval(() => {
      void this.indexer.sync().catch((err) => this.logger.warn(`indexer tick failed: ${err.message}`));
    }, INDEX_INTERVAL_MS);
    this.timer.unref?.();

    // One immediate pass so a restart does not wait a full interval before catching up.
    void this.indexer.sync().catch(() => undefined);
    this.logger.log(`Campaign event indexer started (every ${INDEX_INTERVAL_MS / 1000}s).`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

@Module({
  imports: [SupabaseModule],
  controllers: [CampaignController, CampaignAdminController],
  providers: [CampaignService, CampaignVoucherService, PresaleIndexerService, CampaignScheduler],
  exports: [CampaignService],
})
export class CampaignModule {}
