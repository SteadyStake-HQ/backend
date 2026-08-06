import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { CapacityService } from './capacity.service';

/**
 * Auto Execution Plan capacity API (§21). The read is public (it exposes only what the chain and the
 * award records already show); the reserve endpoint issues a signed permit, which is safe to expose
 * because the permit is chain-, wallet-, nonce-, and deadline-bound and the on-chain verifier is the
 * real gate (§16.2).
 */
@Controller('api/steadystake/auto-plan-capacity')
export class CapacityController {
  constructor(private readonly capacity: CapacityService) {}

  /** GET /api/steadystake/auto-plan-capacity?wallet= — base, NFT, used, and available slots. */
  @Get()
  read(@Query('wallet') wallet: string) {
    return this.capacity.getCapacity(wallet ?? '');
  }

  /** POST /api/steadystake/auto-plan-capacity/reserve { wallet, targetChainId, planIntentId? } */
  @Post('reserve')
  reserve(@Body() body: { wallet?: string; targetChainId?: number; planIntentId?: string }) {
    return this.capacity.reserve(body);
  }
}
