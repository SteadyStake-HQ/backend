import { Module } from '@nestjs/common';
import { PlanAdminController } from './plan-admin.controller';
import { PlanExecutionController } from './plan-execution.controller';
import { PlansController } from './plans.controller';
import { PlansService } from './plans.service';

@Module({
  controllers: [PlansController, PlanExecutionController, PlanAdminController],
  providers: [PlansService],
  exports: [PlansService],
})
export class PlansModule {}
