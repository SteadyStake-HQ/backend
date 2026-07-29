import { Module } from '@nestjs/common';
import { HistoryModule } from '../history/history.module';
import { TreasuryController } from './treasury.controller';
import { TreasuryService } from './treasury.service';

/**
 * NetworkAllocationService is not imported here: NetworksModule is @Global, so the allocation
 * status each wallet card shows comes through without a second wiring of the same provider.
 */
@Module({
  imports: [HistoryModule],
  controllers: [TreasuryController],
  providers: [TreasuryService],
})
export class TreasuryModule {}
