import { Module } from '@nestjs/common';
import { HistoryService } from './history.service';
import { HistoryController } from './history.controller';
import { RunCostHistoryService } from './run-cost-history.service';

@Module({
  providers: [HistoryService, RunCostHistoryService],
  controllers: [HistoryController],
  exports: [HistoryService, RunCostHistoryService],
})
export class HistoryModule {}
