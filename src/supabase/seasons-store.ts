/**
 * Season configuration, lifecycle, and finalists (blueprint §11, §12, §20).
 *
 * The season system lives in this backend (the "existing dashboard", §17) while the ranked results
 * it rates are produced by the Echo Arena game. Both apps share one Supabase database, so the rating
 * query reads the game's `echo_ranked_daily_bests` table directly.
 *
 * DI-free (SUPABASE_DB_URL), matching the other stores so a standalone scheduler tick can run
 * without the Nest boot path.
 */
import { Pool } from 'pg';
import { getSharedPool } from './pg-pool';

export type SeasonStatus =
  | 'draft'
  | 'scheduled'
  | 'live'
  | 'review'
  | 'finalized'
  | 'awarded'
  | 'cancelled';

export const SEASON_STATUSES: readonly SeasonStatus[] = [
  'draft',
  'scheduled',
  'live',
  'review',
  'finalized',
  'awarded',
  'cancelled',
];

export interface SeasonRow {
  seasonId: number;
  name: string;
  slug: string;
  status: SeasonStatus;
  startAt: Date;
  endAt: Date;
  durationSeconds: number;
  gameBuildId: string | null;
  rulesetVersion: string | null;
  rankedAttemptsPerDay: number;
  countedDailyResults: number;
  minimumEligibleDays: number;
  reviewWindowHours: number;
  /** Chain IDs the season is visible/joinable on. Empty = every configured network. */
  availableNetworks: number[];
  /** SP multiplier applied to season runs, as a percentage (100 = 1.0x). Stacks with the pass. */
  spMultiplierPct: number;
  /** Per-wallet season cap on ranked runs. null = uncapped by the season. */
  rankedRunLimit: number | null;
  /** Per-wallet season cap on open-verified runs. null = uncapped by the season. */
  openVerifiedRunLimit: number | null;
  /** Free-form reward description shown on the reward page. */
  rewardDetails: unknown | null;
  rulesHash: string | null;
  snapshotHash: string | null;
  awardChainId: number | null;
  nftContractAddress: string | null;
  /** When set, a Live season is temporarily held: it stays 'live' but is not served to players. */
  pausedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SeasonFinalistRow {
  seasonId: number;
  finalRank: number;
  walletAddress: string;
  seasonRating: number;
  eligibilityStatus: string;
  confirmedAt: Date | null;
}

function getPool(): Pool | null {
  return getSharedPool();
}

export const SEASONS_DDL = `
  CREATE TABLE IF NOT EXISTS seasons (
    season_id bigserial PRIMARY KEY,
    name text NOT NULL,
    slug text UNIQUE NOT NULL,
    status text NOT NULL DEFAULT 'draft',
    start_at timestamptz NOT NULL,
    end_at timestamptz NOT NULL,
    duration_seconds integer NOT NULL,
    game_build_id text,
    ruleset_version text,
    ranked_attempts_per_day integer NOT NULL DEFAULT 3,
    counted_daily_results integer NOT NULL DEFAULT 5,
    minimum_eligible_days integer NOT NULL DEFAULT 3,
    review_window_hours integer NOT NULL DEFAULT 48,
    available_networks integer[] NOT NULL DEFAULT '{}',
    sp_multiplier_pct integer NOT NULL DEFAULT 100,
    ranked_run_limit integer,
    open_verified_run_limit integer,
    reward_details jsonb,
    rules_hash text,
    snapshot_hash text,
    award_chain_id integer,
    nft_contract_address text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  -- In-place migration for databases created before these columns existed.
  ALTER TABLE seasons ADD COLUMN IF NOT EXISTS available_networks integer[] NOT NULL DEFAULT '{}';
  ALTER TABLE seasons ADD COLUMN IF NOT EXISTS sp_multiplier_pct integer NOT NULL DEFAULT 100;
  ALTER TABLE seasons ADD COLUMN IF NOT EXISTS ranked_run_limit integer;
  ALTER TABLE seasons ADD COLUMN IF NOT EXISTS open_verified_run_limit integer;
  ALTER TABLE seasons ADD COLUMN IF NOT EXISTS reward_details jsonb;
  ALTER TABLE seasons ADD COLUMN IF NOT EXISTS paused_at timestamptz;
  CREATE TABLE IF NOT EXISTS season_finalists (
    season_id bigint NOT NULL,
    final_rank integer NOT NULL,
    wallet_address text NOT NULL,
    season_rating integer NOT NULL,
    eligibility_status text NOT NULL DEFAULT 'eligible',
    confirmed_at timestamptz,
    PRIMARY KEY (season_id, final_rank)
  );
  -- Only one season may occupy each pre-terminal state at a time; a partial unique index keeps a
  -- second Live or Scheduled season from ever being published by accident.
  CREATE UNIQUE INDEX IF NOT EXISTS seasons_one_live_idx ON seasons ((status)) WHERE status = 'live';
`;

export async function ensureSeasonsSchema(): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  await p.query(SEASONS_DDL);
}

function mapSeason(r: Record<string, unknown>): SeasonRow {
  return {
    seasonId: Number(r.season_id),
    name: String(r.name),
    slug: String(r.slug),
    status: String(r.status) as SeasonStatus,
    startAt: new Date(r.start_at as string),
    endAt: new Date(r.end_at as string),
    durationSeconds: Number(r.duration_seconds),
    gameBuildId: r.game_build_id ? String(r.game_build_id) : null,
    rulesetVersion: r.ruleset_version ? String(r.ruleset_version) : null,
    rankedAttemptsPerDay: Number(r.ranked_attempts_per_day),
    countedDailyResults: Number(r.counted_daily_results),
    minimumEligibleDays: Number(r.minimum_eligible_days),
    reviewWindowHours: Number(r.review_window_hours),
    availableNetworks: Array.isArray(r.available_networks)
      ? (r.available_networks as unknown[]).map((n) => Number(n))
      : [],
    spMultiplierPct: r.sp_multiplier_pct != null ? Number(r.sp_multiplier_pct) : 100,
    rankedRunLimit: r.ranked_run_limit != null ? Number(r.ranked_run_limit) : null,
    openVerifiedRunLimit: r.open_verified_run_limit != null ? Number(r.open_verified_run_limit) : null,
    rewardDetails: r.reward_details ?? null,
    rulesHash: r.rules_hash ? String(r.rules_hash) : null,
    snapshotHash: r.snapshot_hash ? String(r.snapshot_hash) : null,
    awardChainId: r.award_chain_id != null ? Number(r.award_chain_id) : null,
    nftContractAddress: r.nft_contract_address ? String(r.nft_contract_address) : null,
    pausedAt: r.paused_at ? new Date(r.paused_at as string) : null,
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}

export interface CreateSeasonInput {
  name: string;
  slug: string;
  startAt: Date;
  durationSeconds: number;
  gameBuildId?: string | null;
  rulesetVersion?: string | null;
  countedDailyResults?: number;
  minimumEligibleDays?: number;
  reviewWindowHours?: number;
  availableNetworks?: number[];
  spMultiplierPct?: number;
  rankedRunLimit?: number | null;
  openVerifiedRunLimit?: number | null;
  rewardDetails?: unknown | null;
  awardChainId?: number | null;
  nftContractAddress?: string | null;
}

export async function createSeason(input: CreateSeasonInput): Promise<SeasonRow> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  const endAt = new Date(input.startAt.getTime() + input.durationSeconds * 1000);
  const { rows } = await p.query(
    `INSERT INTO seasons
       (name, slug, status, start_at, end_at, duration_seconds, game_build_id, ruleset_version,
        counted_daily_results, minimum_eligible_days, review_window_hours,
        available_networks, sp_multiplier_pct, ranked_run_limit, open_verified_run_limit, reward_details,
        award_chain_id, nft_contract_address)
     VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING *`,
    [
      input.name,
      input.slug,
      input.startAt,
      endAt,
      input.durationSeconds,
      input.gameBuildId ?? null,
      input.rulesetVersion ?? null,
      input.countedDailyResults ?? 5,
      input.minimumEligibleDays ?? 3,
      input.reviewWindowHours ?? 48,
      input.availableNetworks ?? [],
      input.spMultiplierPct ?? 100,
      input.rankedRunLimit ?? null,
      input.openVerifiedRunLimit ?? null,
      input.rewardDetails != null ? JSON.stringify(input.rewardDetails) : null,
      input.awardChainId ?? null,
      input.nftContractAddress ?? null,
    ],
  );
  return mapSeason(rows[0]);
}

export async function getSeason(seasonId: number): Promise<SeasonRow | null> {
  const p = getPool();
  if (!p) return null;
  const { rows } = await p.query('SELECT * FROM seasons WHERE season_id = $1', [seasonId]);
  return rows.length ? mapSeason(rows[0]) : null;
}

export async function listSeasons(): Promise<SeasonRow[]> {
  const p = getPool();
  if (!p) return [];
  const { rows } = await p.query('SELECT * FROM seasons ORDER BY start_at DESC');
  return rows.map(mapSeason);
}

/**
 * The one live season currently being served to players. A paused Live season is excluded — it keeps
 * status='live' (so the one-live index still holds and the scheduler won't promote another) but is not
 * returned here, so players see no active season until it is resumed.
 *
 * The clock is checked as well as the status: the scheduler flips Live -> Review on a poll interval,
 * so a finished season reads 'live' for up to a tick afterwards. Since the game gates ranked and
 * open-verified play on this read (§9), a season stops being live the moment its duration ends, not
 * the moment the scheduler notices.
 */
export async function getLiveSeason(): Promise<SeasonRow | null> {
  const p = getPool();
  if (!p) return null;
  const { rows } = await p.query(
    `SELECT * FROM seasons
      WHERE status = 'live' AND paused_at IS NULL AND now() >= start_at AND now() < end_at
      ORDER BY start_at DESC LIMIT 1`,
  );
  return rows.length ? mapSeason(rows[0]) : null;
}

/** Temporarily hold a Live season (players stop seeing it). No-op if it isn't Live or is already held. */
export async function pauseSeason(seasonId: number): Promise<SeasonRow | null> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  const { rows } = await p.query(
    `UPDATE seasons SET paused_at = now(), updated_at = now()
      WHERE season_id = $1 AND status = 'live' AND paused_at IS NULL RETURNING *`,
    [seasonId],
  );
  return rows.length ? mapSeason(rows[0]) : null;
}

/** Lift a hold on a Live season, making it available to players again. No-op if it isn't held. */
export async function resumeSeason(seasonId: number): Promise<SeasonRow | null> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  const { rows } = await p.query(
    `UPDATE seasons SET paused_at = NULL, updated_at = now()
      WHERE season_id = $1 AND status = 'live' AND paused_at IS NOT NULL RETURNING *`,
    [seasonId],
  );
  return rows.length ? mapSeason(rows[0]) : null;
}

/**
 * The live season visible on a given chain: the single live season when its `available_networks` is
 * empty (visible everywhere) or contains `chainId`. Returns null when the live season is scoped to
 * other networks, so a player on an excluded chain sees no season (decision: one live, network filter).
 */
export async function getLiveSeasonForChain(chainId: number): Promise<SeasonRow | null> {
  const live = await getLiveSeason();
  if (!live) return null;
  if (live.availableNetworks.length === 0) return live;
  return live.availableNetworks.includes(Number(chainId)) ? live : null;
}

/** Draft-only edit of the mutable fields. Recomputes end_at from start_at + duration. */
export async function updateDraftSeason(
  seasonId: number,
  patch: Partial<CreateSeasonInput>,
): Promise<SeasonRow | null> {
  const current = await getSeason(seasonId);
  if (!current) return null;
  const p = getPool()!;
  const startAt = patch.startAt ?? current.startAt;
  const durationSeconds = patch.durationSeconds ?? current.durationSeconds;
  const endAt = new Date(startAt.getTime() + durationSeconds * 1000);
  const { rows } = await p.query(
    `UPDATE seasons SET
       name = $2, start_at = $3, duration_seconds = $4, end_at = $5,
       game_build_id = $6, ruleset_version = $7, counted_daily_results = $8,
       minimum_eligible_days = $9, review_window_hours = $10, award_chain_id = $11,
       nft_contract_address = $12, available_networks = $13, sp_multiplier_pct = $14,
       ranked_run_limit = $15, open_verified_run_limit = $16, reward_details = $17,
       updated_at = now()
     WHERE season_id = $1 RETURNING *`,
    [
      seasonId,
      patch.name ?? current.name,
      startAt,
      durationSeconds,
      endAt,
      patch.gameBuildId ?? current.gameBuildId,
      patch.rulesetVersion ?? current.rulesetVersion,
      patch.countedDailyResults ?? current.countedDailyResults,
      patch.minimumEligibleDays ?? current.minimumEligibleDays,
      patch.reviewWindowHours ?? current.reviewWindowHours,
      patch.awardChainId ?? current.awardChainId,
      patch.nftContractAddress ?? current.nftContractAddress,
      patch.availableNetworks ?? current.availableNetworks,
      patch.spMultiplierPct ?? current.spMultiplierPct,
      patch.rankedRunLimit !== undefined ? patch.rankedRunLimit : current.rankedRunLimit,
      patch.openVerifiedRunLimit !== undefined ? patch.openVerifiedRunLimit : current.openVerifiedRunLimit,
      patch.rewardDetails !== undefined
        ? patch.rewardDetails != null
          ? JSON.stringify(patch.rewardDetails)
          : null
        : current.rewardDetails != null
          ? JSON.stringify(current.rewardDetails)
          : null,
    ],
  );
  return rows.length ? mapSeason(rows[0]) : null;
}

/**
 * Permanently remove a season and everything derived from it — its frozen finalists and its on-chain
 * award records — in one transaction. Irreversible. The game's own `echo_ranked_daily_bests` rows keep
 * their season_id and are intentionally left untouched: they are the game's verified result history,
 * not season configuration. Returns true when a season row was actually deleted.
 */
export async function deleteSeason(seasonId: number): Promise<boolean> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM season_finalists WHERE season_id = $1', [seasonId]);
    await client.query('DELETE FROM nft_awards WHERE season_id = $1', [seasonId]);
    const res = await client.query('DELETE FROM seasons WHERE season_id = $1', [seasonId]);
    await client.query('COMMIT');
    return (res.rowCount ?? 0) > 0;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Move a season to a new status, only from an allowed prior status. Returns the row or null. */
export async function setSeasonStatus(
  seasonId: number,
  from: SeasonStatus[],
  to: SeasonStatus,
): Promise<SeasonRow | null> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  const { rows } = await p.query(
    `UPDATE seasons SET status = $3, updated_at = now()
     WHERE season_id = $1 AND status = ANY($2) RETURNING *`,
    [seasonId, from, to],
  );
  return rows.length ? mapSeason(rows[0]) : null;
}

/**
 * Advance season states by the clock (§11.5): Live seasons past their end move to Review, then a
 * single due Scheduled season is promoted to Live (the partial unique index guarantees at most one).
 * Returns the season ids that changed, for logging.
 */
export async function advanceSeasons(now: Date = new Date()): Promise<{ reviewed: number[]; activated: number[] }> {
  const p = getPool();
  if (!p) return { reviewed: [], activated: [] };

  const ended = await p.query(
    `UPDATE seasons SET status = 'review', updated_at = now()
      WHERE status = 'live' AND end_at <= $1 RETURNING season_id`,
    [now],
  );
  const reviewed = ended.rows.map((r) => Number(r.season_id));

  const activated: number[] = [];
  const hasLive = await p.query(`SELECT 1 FROM seasons WHERE status = 'live' LIMIT 1`);
  if (hasLive.rows.length === 0) {
    const promoted = await p.query(
      `UPDATE seasons SET status = 'live', updated_at = now()
        WHERE season_id = (
          SELECT season_id FROM seasons
           WHERE status = 'scheduled' AND start_at <= $1 AND end_at > $1
           ORDER BY start_at ASC LIMIT 1
        ) RETURNING season_id`,
      [now],
    );
    for (const r of promoted.rows) activated.push(Number(r.season_id));
  }
  return { reviewed, activated };
}

/**
 * Persist the reward target (chain + NFT contract) chosen at distribution time. Unlike the draft-only
 * editor, this is allowed on a finalized season because the contract is picked when the admin actually
 * distributes, not at create time.
 */
export async function setSeasonAwardTarget(
  seasonId: number,
  awardChainId: number,
  nftContractAddress: string,
): Promise<SeasonRow | null> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  const { rows } = await p.query(
    `UPDATE seasons SET award_chain_id = $2, nft_contract_address = $3, updated_at = now()
     WHERE season_id = $1 RETURNING *`,
    [seasonId, awardChainId, nftContractAddress.toLowerCase()],
  );
  return rows.length ? mapSeason(rows[0]) : null;
}

export async function setSnapshotHash(seasonId: number, snapshotHash: string): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  await p.query('UPDATE seasons SET snapshot_hash = $2, updated_at = now() WHERE season_id = $1', [
    seasonId,
    snapshotHash,
  ]);
}

export async function replaceFinalists(seasonId: number, finalists: SeasonFinalistRow[]): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM season_finalists WHERE season_id = $1', [seasonId]);
    for (const f of finalists) {
      await client.query(
        `INSERT INTO season_finalists
           (season_id, final_rank, wallet_address, season_rating, eligibility_status, confirmed_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [seasonId, f.finalRank, f.walletAddress.toLowerCase(), f.seasonRating, f.eligibilityStatus, f.confirmedAt],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function getFinalists(seasonId: number): Promise<SeasonFinalistRow[]> {
  const p = getPool();
  if (!p) return [];
  const { rows } = await p.query(
    'SELECT * FROM season_finalists WHERE season_id = $1 ORDER BY final_rank',
    [seasonId],
  );
  return rows.map((r) => ({
    seasonId: Number(r.season_id),
    finalRank: Number(r.final_rank),
    walletAddress: String(r.wallet_address),
    seasonRating: Number(r.season_rating),
    eligibilityStatus: String(r.eligibility_status),
    confirmedAt: r.confirmed_at ? new Date(r.confirmed_at) : null,
  }));
}

export interface DailyBestRow {
  address: string;
  utcDate: string;
  score: number;
  cycles: number;
  echoes: number;
  achievedAt: Date;
}

/**
 * Every verified ranked daily-best for a season, from the game's table. `disqualified` rows are
 * excluded so a removed entry drops out of the rating (§12.4). Ordered so ties resolve to the
 * earliest achievement (§12.2 last tie-break).
 */
export async function getSeasonDailyBests(seasonId: number): Promise<DailyBestRow[]> {
  const p = getPool();
  if (!p) return [];
  const { rows } = await p.query(
    `SELECT address, utc_date, score, cycles, echoes, achieved_at
       FROM echo_ranked_daily_bests
      WHERE season_id = $1 AND disqualified = false
      ORDER BY achieved_at ASC`,
    [seasonId],
  );
  return rows.map((r) => ({
    address: String(r.address).toLowerCase(),
    utcDate: String(r.utc_date),
    score: Number(r.score),
    cycles: Number(r.cycles),
    echoes: Number(r.echoes),
    achievedAt: new Date(r.achieved_at),
  }));
}

/** Flag or unflag one player's daily-best for a season (disqualification, §12.4). */
export async function setDailyBestDisqualified(
  seasonId: number,
  address: string,
  utcDate: string | null,
  disqualified: boolean,
): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  if (utcDate) {
    await p.query(
      `UPDATE echo_ranked_daily_bests SET disqualified = $4
        WHERE season_id = $1 AND address = $2 AND utc_date = $3`,
      [seasonId, address.toLowerCase(), utcDate, disqualified],
    );
  } else {
    await p.query(
      `UPDATE echo_ranked_daily_bests SET disqualified = $3
        WHERE season_id = $1 AND address = $2`,
      [seasonId, address.toLowerCase(), disqualified],
    );
  }
}
