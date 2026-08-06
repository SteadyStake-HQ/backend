import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { SeasonsService } from './seasons.service';

/**
 * Public season reads (§21 Player APIs). Unguarded like the rest of the read-only surface — it
 * exposes only what a player already sees in-game.
 */
@Controller('api/seasons')
export class SeasonsController {
  constructor(private readonly seasons: SeasonsService) {}

  /** GET /api/seasons/current?chainId= — the live season for the caller's chain, or null. */
  @Get('current')
  current(@Query('chainId') chainId?: string) {
    const parsed = chainId != null && chainId !== '' ? Number(chainId) : undefined;
    return this.seasons.currentSeason(Number.isFinite(parsed) ? parsed : undefined);
  }

  /**
   * GET /api/seasons/play-budget?wallet=&chainId= — the wallet's per-mode season play budget
   * (plan budget, season caps, and effective min). The game gates ranked/open-verified modes on this.
   */
  @Get('play-budget')
  playBudget(@Query('wallet') wallet?: string, @Query('chainId') chainId?: string) {
    const parsed = chainId != null && chainId !== '' ? Number(chainId) : undefined;
    return this.seasons.playBudget(wallet ?? '', Number.isFinite(parsed) ? parsed : undefined);
  }

  /** GET /api/seasons/:id/leaderboard?limit=&offset= — the verified season leaderboard. */
  @Get(':id/leaderboard')
  leaderboard(
    @Param('id', ParseIntPipe) id: number,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const lim = Math.min(200, Math.max(1, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    return this.seasons.leaderboard(id, lim, off);
  }
}
