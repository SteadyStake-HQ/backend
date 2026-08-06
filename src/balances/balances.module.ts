import { Module } from '@nestjs/common';
import { BalancesController } from './balances.controller';
import { BalancesAdminController } from './balances-admin.controller';
import { ContractBalancesService } from './contract-balances.service';

/**
 * NetworkAllocationService is not imported here: NetworksModule is @Global, so the enabled/paused
 * status each network card shows comes through without a second wiring of the same provider — the
 * same arrangement TreasuryModule uses.
 */
@Module({
  controllers: [BalancesController, BalancesAdminController],
  providers: [ContractBalancesService],
  exports: [ContractBalancesService],
})
export class BalancesModule {}
