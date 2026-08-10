import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { getTokenPriceQuotes, normalizeTokenAddress } from '../token-price';

/** One request may not price more tokens than the picker ever shows at once. */
const MAX_ADDRESSES = 60;

/**
 * Public read of what a token is worth in USD.
 *
 * This is the single source of the price the app shows: the new-plan picker quotes every token from
 * here, and the price stamped onto an execution comes from the same module (see token-price.ts). A
 * second implementation on the frontend would eventually disagree with the number recorded against
 * a user's buys, so the frontend route only proxies this one.
 *
 * Unguarded like the token list it accompanies — these are public ERC-20 addresses and public market
 * prices, asked for on behalf of anonymous visitors.
 */
@Controller('api/token-price')
export class TokenPriceController {
  /**
   * GET /api/token-price?chainId=56&addresses=0xa,0xb
   * -> { ok, chainId, prices: [{ address, usd, source, at, stale }] }
   *
   * Every requested address comes back, `usd: null` included: "no feed quotes this token" is a real
   * answer the picker has to render, and dropping those rows would make it look like a failed call.
   */
  @Get()
  async prices(@Query('chainId') chainId?: string, @Query('addresses') addresses?: string) {
    const id = Number(chainId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new BadRequestException({ ok: false, error: 'chainId is required' });
    }

    const requested = (addresses ?? '')
      .split(',')
      .map((value) => normalizeTokenAddress(value))
      .filter((value): value is string => value !== null);
    if (requested.length === 0) {
      throw new BadRequestException({ ok: false, error: 'addresses is required' });
    }
    if (requested.length > MAX_ADDRESSES) {
      throw new BadRequestException({
        ok: false,
        error: `At most ${MAX_ADDRESSES} addresses per request`,
      });
    }

    const prices = await getTokenPriceQuotes(id, requested);
    return { ok: true, chainId: id, prices };
  }
}
