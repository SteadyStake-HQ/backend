import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AdminTokenGuard } from '../admin/admin-token.guard';
import { ContractBalancesService } from './contract-balances.service';

/**
 * Moving protocol revenue out of a contract and into the deployer wallet.
 *
 * Like the fee setters, these write to a *chain*: they sign with the owner key, and the only way to
 * undo one is to send the money back. They sit behind the same ADMIN_API_TOKEN, and each one is
 * simulated before it is sent and confirmed before it is believed.
 *
 * There is deliberately no endpoint for sweeping a Gas Tank. That balance is users' prepaid gas and
 * the deployed GasTank has no owner sweep at all — an endpoint for it could only ever return an
 * error, and an error-only endpoint reads as "not wired up yet" rather than "this is not the
 * protocol's money". The service says so in one place instead; see its `withdraw`.
 */
@Controller('api/admin/balances')
@UseGuards(AdminTokenGuard)
export class BalancesAdminController {
  constructor(private readonly balances: ContractBalancesService) {}

  /**
   * POST /api/admin/balances/withdraw — take one contract's collected fees to the admin wallet.
   *
   * The destination is not a parameter: `DCAVault.withdrawFees()` transfers to `msg.sender`, so the
   * money lands in whichever key this backend signs with. Accepting a `to` we could not honour would
   * be worse than not offering one.
   */
  @Post('withdraw')
  async withdraw(@Body() body: { chainId?: number | string; contract?: string }) {
    const chainId = parseChainId(body?.chainId);
    const contract = (body?.contract ?? 'dcaVault').trim();
    return this.balances.withdraw(chainId, contract);
  }

  /**
   * POST /api/admin/balances/withdraw-all — sweep collected fees on every chain that has any.
   *
   * Partial success is the normal outcome, not an exception: one chain's RPC being down should not
   * stop the other seven. Each chain reports its own result and the caller gets the whole list.
   */
  @Post('withdraw-all')
  async withdrawAll() {
    return this.balances.withdrawAll();
  }
}

function parseChainId(raw: unknown): number {
  const chainId = Number(raw);
  if (!Number.isFinite(chainId) || chainId <= 0) {
    throw new BadRequestException({ ok: false, error: 'A valid chainId is required.' });
  }
  return chainId;
}
