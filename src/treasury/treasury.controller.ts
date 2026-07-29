import { Controller, Get, Query } from '@nestjs/common';
import { TreasuryService } from './treasury.service';

/**
 * The operator wallet's balances and its execution economics.
 *
 * Read-only and unguarded, like the rest of the dashboard's read API. Everything it returns is
 * already public: the relayer's address is the `from` on every execution transaction, its balances
 * are on-chain, and the executions themselves are the run history the activity page already shows.
 * The private key is never touched here — only the address it derives to.
 */
@Controller('api/treasury')
export class TreasuryController {
  constructor(private readonly treasury: TreasuryService) {}

  /**
   * GET /api/treasury/wallets — what the relayer holds on every deployed network.
   *
   * Cached for half a minute; `?refresh=1` forces a re-read, which is what the page's Refresh
   * button sends after an operator has topped a wallet up and wants to see it land.
   */
  @Get('wallets')
  async wallets(@Query('refresh') refresh?: string) {
    return this.treasury.getWallets(refresh === '1' || refresh === 'true');
  }

  /**
   * GET /api/treasury/flows?runs=50 — every auto-execution in the last N runs, priced on both
   * sides, with the daily / per-network / per-token rollups the page charts.
   */
  @Get('flows')
  async flows(@Query('runs') runs?: string) {
    const parsed = Number.parseInt(runs ?? '50', 10);
    return this.treasury.getFlows(Number.isFinite(parsed) ? parsed : 50);
  }
}
