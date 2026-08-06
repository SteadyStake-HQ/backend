import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { AdminTokenGuard } from '../admin/admin-token.guard';
import { SeasonsService } from './seasons.service';
import { SeasonAwardService } from './season-award.service';

/**
 * Admin season management (§17, §21 Admin APIs). Guarded by the same ADMIN_API_TOKEN as the other
 * privileged plan-control endpoints. NFT result-registration and minting are Phase 5 and are not
 * exposed here yet; finalize locks the immutable top three and snapshot hash in the database, which
 * is what those on-chain steps will consume.
 */
@Controller('api/admin/seasons')
@UseGuards(AdminTokenGuard)
export class SeasonsAdminController {
  constructor(
    private readonly seasons: SeasonsService,
    private readonly awards: SeasonAwardService,
  ) {}

  @Get()
  list() {
    return this.seasons.listAll();
  }

  /** POST /api/admin/seasons — create a Draft season. */
  @Post()
  create(@Body() body: Record<string, unknown>) {
    return this.seasons.createDraft(body);
  }

  /** PATCH /api/admin/seasons/:id — edit a Draft season. */
  @Patch(':id')
  edit(@Param('id', ParseIntPipe) id: number, @Body() body: Record<string, unknown>) {
    return this.seasons.editDraft(id, body);
  }

  /** DELETE /api/admin/seasons/:id — permanently remove a season and its derived records. */
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.seasons.remove(id);
  }

  /** POST /api/admin/seasons/:id/publish — Draft -> Scheduled. */
  @Post(':id/publish')
  publish(@Param('id', ParseIntPipe) id: number) {
    return this.seasons.publish(id);
  }

  /** POST /api/admin/seasons/:id/pause — temporarily hold a Live season. */
  @Post(':id/pause')
  pause(@Param('id', ParseIntPipe) id: number) {
    return this.seasons.pause(id);
  }

  /** POST /api/admin/seasons/:id/resume — lift the hold on a paused Live season. */
  @Post(':id/resume')
  resume(@Param('id', ParseIntPipe) id: number) {
    return this.seasons.resume(id);
  }

  /** POST /api/admin/seasons/:id/cancel — cancel a Draft/Scheduled/Live season. */
  @Post(':id/cancel')
  cancel(@Param('id', ParseIntPipe) id: number) {
    return this.seasons.cancel(id);
  }

  /** GET /api/admin/seasons/:id/review — frozen ranking + flags for the Review window. */
  @Get(':id/review')
  review(@Param('id', ParseIntPipe) id: number) {
    return this.seasons.review(id);
  }

  /** POST /api/admin/seasons/:id/disqualifications — flag a player's day (or whole entry). */
  @Post(':id/disqualifications')
  disqualify(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { address?: string; utcDate?: string | null; reason?: string },
  ) {
    return this.seasons.disqualify(id, body);
  }

  /** POST /api/admin/seasons/:id/finalize — lock the immutable top three and snapshot hash. */
  @Post(':id/finalize')
  finalize(@Param('id', ParseIntPipe) id: number) {
    return this.seasons.finalize(id);
  }

  /** GET /api/admin/seasons/:id/rewards — reward-page read model: sorted records + finalists + awards. */
  @Get(':id/rewards')
  rewards(@Param('id', ParseIntPipe) id: number) {
    return this.seasons.rewardDetail(id);
  }

  /** POST /api/admin/seasons/:id/winners — override the top-three winner wallets before distribution. */
  @Post(':id/winners')
  setWinners(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { winners?: Array<{ rank?: number; wallet?: string; seasonRating?: number }> },
  ) {
    return this.seasons.setFinalists(id, body.winners ?? []);
  }

  /** POST /api/admin/seasons/:id/distribute — pick contract (+ optional winners) and register+mint. */
  @Post(':id/distribute')
  distribute(
    @Param('id', ParseIntPipe) id: number,
    @Body()
    body: {
      contractId?: number;
      chainId?: number;
      contract?: string;
      winners?: Array<{ rank?: number; wallet?: string; seasonRating?: number }>;
    },
  ) {
    return this.awards.distribute(id, body);
  }

  /** GET /api/admin/seasons/:id/awards — on-chain award state per rank. */
  @Get(':id/awards')
  awardStatus(@Param('id', ParseIntPipe) id: number) {
    return this.awards.status(id);
  }

  /** POST /api/admin/seasons/:id/awards/register — registerSeasonResult on the SeasonRewardNFT. */
  @Post(':id/awards/register')
  register(@Param('id', ParseIntPipe) id: number) {
    return this.awards.register(id);
  }

  /** POST /api/admin/seasons/:id/awards/mint — mint every registered rank; season -> Awarded. */
  @Post(':id/awards/mint')
  mint(@Param('id', ParseIntPipe) id: number) {
    return this.awards.mintAll(id);
  }
}
