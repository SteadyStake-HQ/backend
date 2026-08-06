import { Module } from '@nestjs/common';
import { CapacityController } from './capacity.controller';
import { CapacityAdminController } from './capacity-admin.controller';
import { CapacityService } from './capacity.service';

/**
 * Auto Execution Plan capacity (blueprint §15, §16). Computes the global NFT bonus draw, reserves
 * slots race-safely, and signs EIP-712 permits the on-chain AutoPlanCapacityVerifier consumes.
 */
@Module({
  controllers: [CapacityController, CapacityAdminController],
  providers: [CapacityService],
  exports: [CapacityService],
})
export class CapacityModule {}
