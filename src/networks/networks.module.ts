import { Global, Module } from '@nestjs/common';
import { NetworkAllocationService } from './network-allocation.service';
import { NetworkAdminController } from './network-admin.controller';
import { NetworksController } from './networks.controller';

/**
 * Global so the scheduler can subtract paused and removed networks from the chain set it hands the
 * executor without importing this module explicitly, matching how ConfigModule is wired.
 */
@Global()
@Module({
  controllers: [NetworksController, NetworkAdminController],
  providers: [NetworkAllocationService],
  exports: [NetworkAllocationService],
})
export class NetworksModule {}
