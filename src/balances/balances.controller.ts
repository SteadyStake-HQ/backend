import { Controller, Get, Query } from '@nestjs/common';
import { ContractBalancesService } from './contract-balances.service';

/**
 * What every deployed contract holds, per network.
 *
 * Read-only and unguarded like the rest of the dashboard's read API: contract addresses and their
 * balances are on-chain and public, and the admin wallet's address is the `from` on every
 * transaction this backend has ever sent. Nothing here touches a private key. The *withdraw* half of
 * this feature lives behind ADMIN_API_TOKEN in balances-admin.controller.ts.
 */
@Controller('api/balances')
export class BalancesController {
  constructor(private readonly balances: ContractBalancesService) {}

  /**
   * GET /api/balances — every contract on every deployed network, with custody classification,
   * per-network totals and the current-state analytics rollups.
   *
   * Cached for half a minute; `?refresh=1` forces a re-read, which is what the page's Refresh button
   * sends and what a withdrawal's follow-up read uses.
   */
  @Get()
  async list(@Query('refresh') refresh?: string) {
    return this.balances.getBalances(refresh === '1' || refresh === 'true');
  }

  /** GET /api/balances/analytics — the rollups alone, for a caller that does not want every row. */
  @Get('analytics')
  async analytics(@Query('refresh') refresh?: string) {
    const payload = await this.balances.getBalances(refresh === '1' || refresh === 'true');
    return { analytics: payload.analytics, updatedAt: payload.updatedAt };
  }
}
