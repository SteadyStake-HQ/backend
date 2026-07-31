import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { TokenListService } from './token-list.service';

/**
 * Public read of a network's token list — this is what the app's "new plan" modal offers.
 *
 * Unguarded like the rest of the read-only config API: it is a list of public ERC-20 addresses, and
 * the frontend asks for it on behalf of anonymous visitors.
 *
 * Only live tokens are returned. A token an operator has removed is gone from here immediately,
 * which is the whole point of moving this list out of the frontend bundle.
 */
@Controller('api/tokens')
export class TokensController {
  constructor(private readonly tokens: TokenListService) {}

  /** GET /api/tokens?chainId=56 -> { ok, chainId, count, tokens[] } */
  @Get()
  async list(@Query('chainId') chainId?: string) {
    const id = Number(chainId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new BadRequestException({ ok: false, error: 'chainId is required' });
    }
    const tokens = await this.tokens.listForChain(id);
    return { ok: true, chainId: id, count: tokens.length, tokens };
  }
}
