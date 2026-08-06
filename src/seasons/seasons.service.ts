import { createHash } from 'crypto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  createSeason,
  deleteSeason,
  getFinalists,
  getLiveSeason,
  getLiveSeasonForChain,
  getSeason,
  getSeasonDailyBests,
  listSeasons,
  pauseSeason,
  replaceFinalists,
  resumeSeason,
  setDailyBestDisqualified,
  setSeasonStatus,
  setSnapshotHash,
  updateDraftSeason,
  type CreateSeasonInput,
  type SeasonRow,
} from '../supabase/seasons-store';
import { getMembership } from '../supabase/capacity-store';
import { getSeasonAwards } from '../supabase/nft-awards-store';
import { isRegisteredChainId } from '../networks/network-registry';
import { effectiveBudget, planBudgetFor } from './play-budget';
import { rankSeason, topThree, type RankedPlayer } from './season-rating';

/** §11.1 duration bounds. */
const MIN_DURATION_SECONDS = 7 * 24 * 60 * 60;
const MAX_DURATION_SECONDS = 90 * 24 * 60 * 60;

/** SP multiplier bounds (percent). 100 = 1.0x (no boost); 1000 = 10x ceiling. */
const MIN_MULTIPLIER_PCT = 100;
const MAX_MULTIPLIER_PCT = 1000;

/**
 * The friendly, player-facing status shown on the reward page, derived from the internal lifecycle:
 *   scheduled            -> upcoming
 *   live                 -> ongoing
 *   review | finalized   -> distributing   (season ended; admin computing/distributing rewards)
 *   awarded              -> ended          (all rewards distributed)
 *   cancelled            -> cancelled
 *   draft                -> draft          (admin-only, not yet published)
 */
export type FriendlyStatus = 'draft' | 'upcoming' | 'ongoing' | 'distributing' | 'ended' | 'cancelled';

function friendlyStatus(status: SeasonRow['status']): FriendlyStatus {
  switch (status) {
    case 'scheduled':
      return 'upcoming';
    case 'live':
      return 'ongoing';
    case 'review':
    case 'finalized':
      return 'distributing';
    case 'awarded':
      return 'ended';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'draft';
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

@Injectable()
export class SeasonsService {
  private readonly logger = new Logger(SeasonsService.name);

  /**
   * Public: the current live season for the caller's chain, or null when none applies (§21). When a
   * chainId is given only a season whose `available_networks` includes it (or is empty) is returned,
   * so a player on an excluded network sees no season.
   */
  async currentSeason(chainId?: number) {
    const live =
      chainId != null && Number.isFinite(chainId)
        ? await getLiveSeasonForChain(Number(chainId))
        : await getLiveSeason();
    return { ok: true, season: live ? this.publicView(live) : null };
  }

  async listAll() {
    return { ok: true, seasons: (await listSeasons()).map((s) => this.adminView(s)) };
  }

  /**
   * The play budget a wallet gets for the live season on its chain: the plan (membership) budget, the
   * season's caps, and the effective per-mode budget = min(plan, seasonLimit). The game reads this to
   * gate ranked / open-verified modes and to fall back to normal mode once a mode's budget is spent.
   */
  async playBudget(wallet: string, chainId?: number) {
    const tier = await getMembership(wallet);
    const plan = planBudgetFor(tier);
    const season =
      chainId != null && Number.isFinite(chainId)
        ? await getLiveSeasonForChain(Number(chainId))
        : await getLiveSeason();

    const seasonLimit = {
      ranked: season?.rankedRunLimit ?? null,
      openVerified: season?.openVerifiedRunLimit ?? null,
    };
    const effective = {
      ranked: effectiveBudget(plan.ranked, seasonLimit.ranked),
      openVerified: effectiveBudget(plan.openVerified, seasonLimit.openVerified),
    };
    return {
      ok: true,
      wallet: wallet.toLowerCase(),
      tier,
      seasonId: season?.seasonId ?? null,
      // The season's duration, so the game can hold ranked / open-verified play inside it (§9).
      seasonStartAt: season?.startAt.toISOString() ?? null,
      seasonEndAt: season?.endAt.toISOString() ?? null,
      spMultiplierPct: season?.spMultiplierPct ?? 100,
      planBudget: plan,
      seasonLimit,
      effective,
    };
  }

  async getOne(seasonId: number): Promise<SeasonRow> {
    const season = await getSeason(seasonId);
    if (!season) throw new NotFoundException({ ok: false, error: 'Unknown season.' });
    return season;
  }

  /** Admin: create a Draft season (§11.3). end_at is derived from start_at + duration. */
  async createDraft(input: {
    name?: string;
    slug?: string;
    startAt?: string;
    durationDays?: number;
    durationSeconds?: number;
    gameBuildId?: string;
    rulesetVersion?: string;
    countedDailyResults?: number;
    minimumEligibleDays?: number;
    reviewWindowHours?: number;
    availableNetworks?: number[];
    spMultiplierPct?: number;
    rankedRunLimit?: number | null;
    openVerifiedRunLimit?: number | null;
    rewardDetails?: unknown | null;
    awardChainId?: number;
    nftContractAddress?: string;
  }) {
    if (!input.name?.trim()) throw new BadRequestException({ ok: false, error: 'name is required.' });
    const startAt = input.startAt ? new Date(input.startAt) : null;
    if (!startAt || Number.isNaN(startAt.getTime())) {
      throw new BadRequestException({ ok: false, error: 'A valid start_at is required.' });
    }
    const durationSeconds = input.durationSeconds ?? (input.durationDays ? input.durationDays * 86400 : 30 * 86400);
    this.assertDuration(durationSeconds);
    const availableNetworks = this.normalizeNetworks(input.availableNetworks);
    const spMultiplierPct = this.normalizeMultiplier(input.spMultiplierPct);
    const rankedRunLimit = this.normalizeLimit(input.rankedRunLimit, 'rankedRunLimit');
    const openVerifiedRunLimit = this.normalizeLimit(input.openVerifiedRunLimit, 'openVerifiedRunLimit');

    const created: CreateSeasonInput = {
      name: input.name.trim(),
      slug: input.slug?.trim() || slugify(input.name),
      startAt,
      durationSeconds,
      gameBuildId: input.gameBuildId ?? null,
      rulesetVersion: input.rulesetVersion ?? null,
      countedDailyResults: input.countedDailyResults ?? 5,
      minimumEligibleDays: input.minimumEligibleDays ?? 3,
      reviewWindowHours: input.reviewWindowHours ?? 48,
      availableNetworks,
      spMultiplierPct,
      rankedRunLimit,
      openVerifiedRunLimit,
      rewardDetails: input.rewardDetails ?? null,
      awardChainId: input.awardChainId ?? null,
      nftContractAddress: input.nftContractAddress ?? null,
    };
    const season = await createSeason(created);
    return { ok: true, season: this.adminView(season) };
  }

  /** Admin: edit a Draft season. Only Draft is freely editable (§11.4). */
  async editDraft(seasonId: number, patch: Record<string, unknown>) {
    const season = await this.getOne(seasonId);
    if (season.status !== 'draft') {
      throw new BadRequestException({ ok: false, error: 'Only Draft seasons can be edited.' });
    }
    const durationSeconds =
      (patch.durationSeconds as number | undefined) ??
      (patch.durationDays ? Number(patch.durationDays) * 86400 : undefined);
    if (durationSeconds !== undefined) this.assertDuration(durationSeconds);

    const updated = await updateDraftSeason(seasonId, {
      name: patch.name as string | undefined,
      startAt: patch.startAt ? new Date(patch.startAt as string) : undefined,
      durationSeconds,
      gameBuildId: patch.gameBuildId as string | undefined,
      rulesetVersion: patch.rulesetVersion as string | undefined,
      countedDailyResults: patch.countedDailyResults as number | undefined,
      minimumEligibleDays: patch.minimumEligibleDays as number | undefined,
      reviewWindowHours: patch.reviewWindowHours as number | undefined,
      availableNetworks:
        patch.availableNetworks !== undefined
          ? this.normalizeNetworks(patch.availableNetworks as number[])
          : undefined,
      spMultiplierPct:
        patch.spMultiplierPct !== undefined
          ? this.normalizeMultiplier(patch.spMultiplierPct as number)
          : undefined,
      rankedRunLimit:
        patch.rankedRunLimit !== undefined
          ? this.normalizeLimit(patch.rankedRunLimit as number | null, 'rankedRunLimit')
          : undefined,
      openVerifiedRunLimit:
        patch.openVerifiedRunLimit !== undefined
          ? this.normalizeLimit(patch.openVerifiedRunLimit as number | null, 'openVerifiedRunLimit')
          : undefined,
      rewardDetails: patch.rewardDetails !== undefined ? patch.rewardDetails : undefined,
      awardChainId: patch.awardChainId as number | undefined,
      nftContractAddress: patch.nftContractAddress as string | undefined,
    });
    return { ok: true, season: this.adminView(updated!) };
  }

  /** Admin: publish a reviewed Draft to Scheduled (§11.3 step 12). */
  async publish(seasonId: number) {
    const season = await setSeasonStatus(seasonId, ['draft'], 'scheduled');
    if (!season) throw new BadRequestException({ ok: false, error: 'Only a Draft season can be published.' });
    return { ok: true, season: this.adminView(season) };
  }

  /**
   * Admin: temporarily hold a Live season (§manual controls). It stays Live — so no Scheduled season is
   * auto-promoted in its place — but is no longer served to players until resumed. Reversible.
   */
  async pause(seasonId: number) {
    const current = await this.getOne(seasonId);
    if (current.status !== 'live') {
      throw new BadRequestException({ ok: false, error: 'Only a Live season can be paused.' });
    }
    if (current.pausedAt) {
      throw new BadRequestException({ ok: false, error: 'This season is already paused.' });
    }
    const season = await pauseSeason(seasonId);
    if (!season) throw new BadRequestException({ ok: false, error: 'Could not pause the season.' });
    this.logger.warn(`season ${seasonId} (${season.name}) paused`);
    return { ok: true, season: this.adminView(season) };
  }

  /** Admin: lift a hold, making a paused Live season available to players again. */
  async resume(seasonId: number) {
    const current = await this.getOne(seasonId);
    if (current.status !== 'live') {
      throw new BadRequestException({ ok: false, error: 'Only a Live season can be resumed.' });
    }
    if (!current.pausedAt) {
      throw new BadRequestException({ ok: false, error: 'This season is not paused.' });
    }
    const season = await resumeSeason(seasonId);
    if (!season) throw new BadRequestException({ ok: false, error: 'Could not resume the season.' });
    this.logger.warn(`season ${seasonId} (${season.name}) resumed`);
    return { ok: true, season: this.adminView(season) };
  }

  /**
   * Admin: stop a season for good. Allowed from Draft or Scheduled (never started) and from Live
   * (an operator manually ending a running season). Terminal — a cancelled season cannot come back.
   */
  async cancel(seasonId: number) {
    const season = await setSeasonStatus(seasonId, ['draft', 'scheduled', 'live'], 'cancelled');
    if (!season) {
      throw new BadRequestException({ ok: false, error: 'Only a Draft, Scheduled, or Live season can be cancelled.' });
    }
    this.logger.warn(`season ${seasonId} (${season.name}) cancelled`);
    return { ok: true, season: this.adminView(season) };
  }

  /**
   * Admin: permanently delete a season and its derived records (finalists + on-chain award rows).
   * Irreversible. A Live season is refused — cancel it (or let it run to Review) first, so an in-flight
   * season is never yanked out from under players mid-run.
   */
  async remove(seasonId: number) {
    const season = await this.getOne(seasonId);
    if (season.status === 'live') {
      throw new BadRequestException({
        ok: false,
        error: 'A Live season cannot be deleted. Cancel it or wait for it to end first.',
      });
    }
    const deleted = await deleteSeason(seasonId);
    if (!deleted) throw new NotFoundException({ ok: false, error: 'Unknown season.' });
    this.logger.warn(`season ${seasonId} (${season.name}, was ${season.status}) permanently deleted`);
    return { ok: true, deleted: true, seasonId };
  }

  /** Public + admin: the computed leaderboard for a season (§12). */
  async leaderboard(seasonId: number, limit = 50, offset = 0) {
    const season = await this.getOne(seasonId);
    const ranked = await this.computeRanked(season);
    const page = ranked.slice(offset, offset + limit).map((p, i) => ({
      rank: offset + i + 1,
      address: p.address,
      seasonRating: p.seasonRating,
      eligibleDays: p.eligibleDays,
      prizeEligible: p.prizeEligible,
      highestDaily: p.highestDaily,
    }));
    return { ok: true, seasonId, status: season.status, total: ranked.length, entries: page };
  }

  /** Admin: disqualify a player's day (or whole season entry) during Review (§12.4). */
  async disqualify(seasonId: number, body: { address?: string; utcDate?: string | null; reason?: string }) {
    const season = await this.getOne(seasonId);
    if (season.status !== 'review') {
      throw new BadRequestException({ ok: false, error: 'Disqualification is only allowed during Review.' });
    }
    if (!body.address) throw new BadRequestException({ ok: false, error: 'address is required.' });
    await setDailyBestDisqualified(seasonId, body.address, body.utcDate ?? null, true);
    this.logger.warn(`season ${seasonId}: disqualified ${body.address} ${body.utcDate ?? '(all)'} — ${body.reason ?? 'no reason'}`);
    return { ok: true };
  }

  /**
   * Admin: lock the immutable top three and the snapshot hash (§14.2). Only from Review, and only
   * once — after this the finalists are fixed and the season moves to Finalized.
   */
  async finalize(seasonId: number) {
    const season = await this.getOne(seasonId);
    if (season.status !== 'review') {
      throw new BadRequestException({ ok: false, error: 'A season can only be finalized from Review.' });
    }
    const ranked = await this.computeRanked(season);
    const winners = topThree(ranked);

    const finalists = winners.map((p, i) => ({
      seasonId,
      finalRank: i + 1,
      walletAddress: p.address,
      seasonRating: p.seasonRating,
      eligibilityStatus: 'eligible',
      confirmedAt: null,
    }));
    await replaceFinalists(seasonId, finalists);

    const snapshotHash = this.snapshotHash(season, finalists);
    await setSnapshotHash(seasonId, snapshotHash);
    const finalized = await setSeasonStatus(seasonId, ['review'], 'finalized');

    return {
      ok: true,
      season: this.adminView(finalized!),
      snapshotHash,
      finalists: finalists.map((f) => ({ rank: f.finalRank, wallet: f.walletAddress, rating: f.seasonRating })),
    };
  }

  /**
   * Admin: override the frozen top-three winners before distribution (§reward page). Ranks must be a
   * contiguous 1..N (N ≤ 3) with distinct wallets. Replaces the finalists and re-derives the snapshot
   * hash so it stays honest about who is being rewarded. Allowed once a season is Finalized.
   */
  async setFinalists(seasonId: number, winners: Array<{ rank?: number; wallet?: string; seasonRating?: number }>) {
    const season = await this.getOne(seasonId);
    if (season.status !== 'finalized' && season.status !== 'review') {
      throw new BadRequestException({ ok: false, error: 'Winners can only be set during Review or after Finalize.' });
    }
    const cleaned = winners
      .map((w) => ({
        finalRank: Number(w.rank),
        walletAddress: String(w.wallet ?? '').toLowerCase(),
        seasonRating: Number(w.seasonRating ?? 0),
      }))
      .filter((w) => w.walletAddress);
    const ranks = cleaned.map((w) => w.finalRank).sort((a, b) => a - b);
    if (cleaned.length === 0 || cleaned.length > 3) {
      throw new BadRequestException({ ok: false, error: 'Provide 1 to 3 winners.' });
    }
    if (ranks.some((r, i) => r !== i + 1)) {
      throw new BadRequestException({ ok: false, error: 'Ranks must be a contiguous 1..N (max 3).' });
    }
    if (new Set(cleaned.map((w) => w.walletAddress)).size !== cleaned.length) {
      throw new BadRequestException({ ok: false, error: 'Winner wallets must be distinct.' });
    }
    const finalists = cleaned.map((w) => ({
      seasonId,
      finalRank: w.finalRank,
      walletAddress: w.walletAddress,
      seasonRating: w.seasonRating,
      eligibilityStatus: 'eligible',
      confirmedAt: null,
    }));
    await replaceFinalists(seasonId, finalists);
    const snapshotHash = this.snapshotHash(season, finalists);
    await setSnapshotHash(seasonId, snapshotHash);
    return { ok: true, seasonId, snapshotHash, finalists: await getFinalists(seasonId) };
  }

  /**
   * Reward-page read model: the season, the full ranking sorted by rating with the top three flagged,
   * the frozen finalists, and the on-chain award state per rank.
   */
  async rewardDetail(seasonId: number) {
    const season = await this.getOne(seasonId);
    const ranked = await this.computeRanked(season);
    const records = ranked.map((p, i) => ({
      rank: i + 1,
      isTopThree: i < 3,
      address: p.address,
      seasonRating: p.seasonRating,
      eligibleDays: p.eligibleDays,
      prizeEligible: p.prizeEligible,
      highestDaily: p.highestDaily,
    }));
    return {
      ok: true,
      season: this.adminView(season),
      records,
      finalists: await getFinalists(seasonId),
      awards: await getSeasonAwards(seasonId),
    };
  }

  /** Admin: the Review view — full ranking plus which entries are flagged/disqualified. */
  async review(seasonId: number) {
    const season = await this.getOne(seasonId);
    const ranked = await this.computeRanked(season);
    return {
      ok: true,
      season: this.adminView(season),
      finalists: await getFinalists(seasonId),
      ranking: ranked.map((p, i) => ({
        provisionalRank: i + 1,
        address: p.address,
        seasonRating: p.seasonRating,
        eligibleDays: p.eligibleDays,
        prizeEligible: p.prizeEligible,
        highestDaily: p.highestDaily,
        countedCycles: p.countedCycles,
        countedEchoes: p.countedEchoes,
      })),
    };
  }

  private async computeRanked(season: SeasonRow): Promise<RankedPlayer[]> {
    const bests = await getSeasonDailyBests(season.seasonId);
    return rankSeason(bests, {
      countedDailyResults: season.countedDailyResults,
      minimumEligibleDays: season.minimumEligibleDays,
    });
  }

  /** Deterministic SHA-256 over the season identity, ruleset, and final wallet ranking (§14.2). */
  private snapshotHash(season: SeasonRow, finalists: { finalRank: number; walletAddress: string; seasonRating: number }[]): string {
    const payload = JSON.stringify({
      seasonId: season.seasonId,
      rulesHash: season.rulesHash,
      rulesetVersion: season.rulesetVersion,
      gameBuildId: season.gameBuildId,
      countedDailyResults: season.countedDailyResults,
      minimumEligibleDays: season.minimumEligibleDays,
      winners: finalists.map((f) => ({ rank: f.finalRank, wallet: f.walletAddress.toLowerCase(), rating: f.seasonRating })),
    });
    return `0x${createHash('sha256').update(payload).digest('hex')}`;
  }

  private assertDuration(durationSeconds: number) {
    if (durationSeconds < MIN_DURATION_SECONDS || durationSeconds > MAX_DURATION_SECONDS) {
      throw new BadRequestException({
        ok: false,
        error: `Duration must be between 7 and 90 days (got ${(durationSeconds / 86400).toFixed(1)} days).`,
      });
    }
  }

  /** Validate + de-dupe the season's available network list. Every id must be a registered chain. */
  private normalizeNetworks(networks?: number[]): number[] {
    if (!networks || networks.length === 0) return [];
    const cleaned = Array.from(new Set(networks.map((n) => Number(n))));
    for (const id of cleaned) {
      if (!Number.isInteger(id) || !isRegisteredChainId(id)) {
        throw new BadRequestException({ ok: false, error: `Unknown network chain id: ${id}.` });
      }
    }
    return cleaned;
  }

  private normalizeMultiplier(value?: number): number {
    if (value == null) return 100;
    const pct = Math.floor(Number(value));
    if (!Number.isFinite(pct) || pct < MIN_MULTIPLIER_PCT || pct > MAX_MULTIPLIER_PCT) {
      throw new BadRequestException({
        ok: false,
        error: `spMultiplierPct must be between ${MIN_MULTIPLIER_PCT} and ${MAX_MULTIPLIER_PCT}.`,
      });
    }
    return pct;
  }

  /** null/undefined = uncapped; otherwise a non-negative integer run budget. */
  private normalizeLimit(value: number | null | undefined, field: string): number | null {
    if (value == null) return null;
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 0) {
      throw new BadRequestException({ ok: false, error: `${field} must be a non-negative integer or null.` });
    }
    return n;
  }

  private publicView(s: SeasonRow) {
    return {
      seasonId: s.seasonId,
      name: s.name,
      slug: s.slug,
      status: s.status,
      friendlyStatus: friendlyStatus(s.status),
      startAt: s.startAt.toISOString(),
      endAt: s.endAt.toISOString(),
      rankedAttemptsPerDay: s.rankedAttemptsPerDay,
      countedDailyResults: s.countedDailyResults,
      minimumEligibleDays: s.minimumEligibleDays,
      availableNetworks: s.availableNetworks,
      spMultiplierPct: s.spMultiplierPct,
      rankedRunLimit: s.rankedRunLimit,
      openVerifiedRunLimit: s.openVerifiedRunLimit,
      rewardDetails: s.rewardDetails,
    };
  }

  private adminView(s: SeasonRow) {
    return {
      ...this.publicView(s),
      durationSeconds: s.durationSeconds,
      gameBuildId: s.gameBuildId,
      rulesetVersion: s.rulesetVersion,
      reviewWindowHours: s.reviewWindowHours,
      rulesHash: s.rulesHash,
      snapshotHash: s.snapshotHash,
      awardChainId: s.awardChainId,
      nftContractAddress: s.nftContractAddress,
      paused: !!s.pausedAt,
      pausedAt: s.pausedAt ? s.pausedAt.toISOString() : null,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    };
  }
}
