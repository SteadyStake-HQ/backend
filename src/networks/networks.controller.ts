import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { NetworkAllocationService } from './network-allocation.service';
import { isNetworkType } from './network-registry';

/**
 * Public read of the network allocation. This is what the frontend asks for the list it shows, so
 * the answer is filtered by `type` (`mainnet` | `testnet`) — the frontend's NETWORK_TYPE — and
 * removed networks are already gone from it.
 *
 * Unguarded, like the rest of the read-only config API: it exposes nothing an observer could not
 * read off the chain, and the frontend calls it on behalf of anonymous visitors.
 */
@Controller('api/networks')
export class NetworksController {
  constructor(private readonly networks: NetworkAllocationService) {}

  /**
   * GET /api/networks?type=mainnet&include=visible
   *
   * `include=all` returns removed networks too, for the operator dashboard.
   */
  @Get()
  async list(@Query('type') type?: string, @Query('include') include?: string) {
    const raw = type?.trim().toLowerCase() ?? '';
    if (raw && !isNetworkType(raw)) {
      throw new BadRequestException({
        ok: false,
        error: `type must be "mainnet" or "testnet" (got "${type}")`,
      });
    }
    const requestedType = isNetworkType(raw) ? raw : null;
    const all = await this.networks.listNetworks(
      requestedType ? { type: requestedType } : undefined,
    );
    const networks = include?.trim() === 'all' ? all : all.filter((n) => n.visible);
    return {
      ok: true,
      type: requestedType ?? null,
      chainIds: networks.map((n) => n.chainId),
      networks,
    };
  }
}
