import { Module } from '@nestjs/common';
import { SeasonsController } from './seasons.controller';
import { SeasonsAdminController } from './seasons-admin.controller';
import { RewardNftController } from './reward-nft.controller';
import { SeasonsService } from './seasons.service';
import { SeasonAwardService } from './season-award.service';
import { SeasonSchedulerService } from './season-scheduler.service';

/**
 * Season system (blueprint §11–§14, §17). Config + lifecycle + rating + finalization live here (the
 * "existing dashboard"); the ranked results it rates come from the Echo Arena game via the shared
 * database.
 */
@Module({
  controllers: [SeasonsController, SeasonsAdminController, RewardNftController],
  providers: [SeasonsService, SeasonAwardService, SeasonSchedulerService],
  exports: [SeasonsService, SeasonAwardService],
})
export class SeasonsModule {}
