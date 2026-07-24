import { Global, Module } from '@nestjs/common';
import { SchedulerConfigService } from './scheduler-config.service';

@Global()
@Module({
  providers: [SchedulerConfigService],
  exports: [SchedulerConfigService],
})
export class ConfigModule {}
