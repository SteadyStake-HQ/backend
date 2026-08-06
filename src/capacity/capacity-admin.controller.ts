import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { AdminTokenGuard } from '../admin/admin-token.guard';
import { CapacityService } from './capacity.service';

/**
 * Capacity inspector for support staff (blueprint §17.5, §21 `GET /admin/capacity/:wallet`). Guarded
 * by the same ADMIN_API_TOKEN as the other privileged endpoints. The membership override is the
 * "separately authorized, fully audited" control the blueprint requires — it is logged server-side.
 */
@Controller('api/admin/capacity')
@UseGuards(AdminTokenGuard)
export class CapacityAdminController {
  constructor(private readonly capacity: CapacityService) {}

  /** GET /api/admin/capacity/:wallet — full capacity read + recent reservations. */
  @Get(':wallet')
  inspect(@Param('wallet') wallet: string) {
    return this.capacity.inspect(wallet);
  }

  /** POST /api/admin/capacity/:wallet/membership { tier } — audited tier override. */
  @Post(':wallet/membership')
  setMembership(
    @Param('wallet') wallet: string,
    @Body() body: { tier?: string },
    @Headers('x-admin-actor') actor?: string,
  ) {
    return this.capacity.setTier(wallet, body?.tier ?? '', actor);
  }
}
