import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PassIndexerService } from './pass-indexer.service';

/**
 * Game Pass payments (blueprint §7 / §18.1 / §19). Owns the public checkout API, the boot seed of
 * `payment_networks`, and the `PassPaid` indexer that extends account pass entitlement on confirmed
 * on-chain payment.
 */
@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService, PassIndexerService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
