import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AdminTokenGuard } from '../admin/admin-token.guard';
import { PlayersService } from './players.service';

/**
 * Operator read APIs for Echo Arena play records (§17, §21 Admin APIs).
 *
 * Guarded by the same ADMIN_API_TOKEN as the other privileged endpoints: these expose one wallet's
 * full play history and points ledger to whoever asks, which is not something to leave open.
 */
@Controller('api/admin/players')
@UseGuards(AdminTokenGuard)
export class PlayersAdminController {
  constructor(private readonly players: PlayersService) {}

  /** GET /api/admin/players/totals — dashboard-wide play and SP totals. */
  @Get('totals')
  totals() {
    return this.players.totals();
  }

  /** GET /api/admin/players?search=&sort=&limit=&offset= — wallets that have played. */
  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.players.list(query);
  }

  /** GET /api/admin/players/:address — summary + runs + SP ledger + daily counters. */
  @Get(':address')
  detail(@Param('address') address: string, @Query() query: Record<string, unknown>) {
    return this.players.detail(address, query);
  }

  /** GET /api/admin/players/:address/runs?mode=&limit=&offset= — run history alone, for paging. */
  @Get(':address/runs')
  runs(@Param('address') address: string, @Query() query: Record<string, unknown>) {
    return this.players.runs(address, query);
  }

  /** GET /api/admin/players/:address/sp?limit=&offset= — the Steady Points ledger alone. */
  @Get(':address/sp')
  ledger(@Param('address') address: string, @Query() query: Record<string, unknown>) {
    return this.players.ledger(address, query);
  }
}
