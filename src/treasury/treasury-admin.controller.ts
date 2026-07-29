import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AdminTokenGuard } from '../admin/admin-token.guard';
import { TreasuryService } from './treasury.service';

/**
 * Operator control over the vault's fee settings.
 *
 * Unlike every other admin endpoint in this backend, these write to a *chain*. The network and plan
 * controls are off-chain bookkeeping that a later request can undo; this signs a transaction with
 * the owner key, changes what every user of that network is charged from the next block onward, and
 * cannot be rolled back except by sending another one. It is behind the same ADMIN_API_TOKEN, and
 * each write is simulated before it is sent and confirmed before it is believed.
 *
 * Only the two fees the contract actually exposes a setter for are here. The early-cancellation fee
 * is a `constant` in DCAVault.sol — it lives in the deployed bytecode, so no key can change it and
 * no endpoint can pretend otherwise.
 */
@Controller('api/admin/treasury')
@UseGuards(AdminTokenGuard)
export class TreasuryAdminController {
  constructor(private readonly treasury: TreasuryService) {}

  /**
   * POST /api/admin/treasury/swap-fee — set DCAVault.feePercentage on one network.
   *
   * Takes a percentage the way an operator says it ("0.25" for 0.25%), not basis points: the
   * contract's own unit is hundredths of a percent, and asking a human to enter 25 for 0.25% is how
   * a fee ends up a hundred times too large.
   */
  @Post('swap-fee')
  async setSwapFee(@Body() body: { chainId?: number | string; percent?: number | string }) {
    const chainId = parseChainId(body?.chainId);
    const percent = parseNumber(body?.percent, 'percent');
    return this.treasury.setSwapFeePercent(chainId, percent);
  }

  /**
   * POST /api/admin/treasury/auto-plan-fee — set the flat charge for a user's second and later
   * auto-executing plans, in whole stablecoin ("10" for $10). Zero disables the charge, which also
   * makes enrolling an extra plan revert — the contract requires the fee to be set.
   */
  @Post('auto-plan-fee')
  async setAutoPlanFee(@Body() body: { chainId?: number | string; usd?: number | string }) {
    const chainId = parseChainId(body?.chainId);
    const usd = parseNumber(body?.usd, 'usd');
    return this.treasury.setAutoPlanFeeUsd(chainId, usd);
  }
}

function parseChainId(raw: unknown): number {
  const chainId = Number(raw);
  if (!Number.isFinite(chainId) || chainId <= 0) {
    throw new BadRequestException({ ok: false, error: 'A valid chainId is required.' });
  }
  return chainId;
}

function parseNumber(raw: unknown, field: string): number {
  if (raw == null || String(raw).trim() === '') {
    throw new BadRequestException({ ok: false, error: `${field} is required.` });
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new BadRequestException({ ok: false, error: `${field} must be a number of zero or more.` });
  }
  return value;
}
