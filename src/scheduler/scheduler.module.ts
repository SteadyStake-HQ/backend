import { Module } from '@nestjs/common';
import { HistoryModule } from '../history/history.module';
import { SchedulerService } from './scheduler.service';
import { StatusController } from './status.controller';
import { ConfigApiController } from './config-api.controller';
import { ExecutionController } from './execution.controller';
import { RunNowController } from './run-now.controller';
import { NetworkMetricsController } from './network-metrics.controller';
import { NetworkMetricsService } from './network-metrics.service';
import { RuntimeSessionController } from './runtime-session.controller';
import { PlanTimingController } from './plan-timing.controller';

@Module({
  imports: [HistoryModule],
  providers: [SchedulerService, NetworkMetricsService],
  controllers: [
    StatusController,
    ConfigApiController,
    ExecutionController,
    RunNowController,
    NetworkMetricsController,
    RuntimeSessionController,
    PlanTimingController,
  ],
  exports: [SchedulerService],
})
export class SchedulerModule {}
