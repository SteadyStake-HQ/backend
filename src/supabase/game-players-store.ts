/**
 * Read access to the Echo Arena game's player, run and Steady Points tables.
 *
 * The game owns and writes these tables; this backend only reads them, for the operator's Players
 * page (§17). Both apps share one Supabase database, so — like the season rating query in
 * seasons-store.ts — this reads `echo_*` directly rather than calling the game over HTTP.
 *
 * Read-only on purpose. SP is credited by the game's submit path under its daily caps and its
 * `(reason, source_id)` idempotency key; a second writer would be able to violate both.
 *
 * DI-free (SUPABASE_DB_URL) and on the shared pool, matching the other stores in this folder.
 */
import type { Pool } from 'pg';
import { getSharedPool } from './pg-pool';

function getPool(): Pool | null {
  return getSharedPool();
}

/** The run modes the game files (blueprint §9). `null` on rows written before the column existed. */
export type PlayMode = 'ranked' | 'open_verified' | 'normal';

export const PLAY_MODES: readonly PlayMode[] = ['ranked', 'open_verified', 'normal'];

export function isPlayMode(value: unknown): value is PlayMode {
  return PLAY_MODES.includes(value as PlayMode);
}

/** Every address the game stores is lower-cased; normalize before comparing or querying. */
function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export interface PlayerSummary {
  address: string;
  bestScore: number;
  bestCycle: number;
  bestEchoes: number;
  bestSurvivedMs: number;
  /** Runs counted onto the all-time board (ranked + normal), as the game maintains it. */
  totalRuns: number;
  /** Rows in `echo_runs` for this wallet, which unlike `totalRuns` includes open-verified play. */
  recordedRuns: number;
  normalRuns: number;
  rankedRuns: number;
  openVerifiedRuns: number;
  spBalance: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastPlayedAt: Date | null;
}

function toSummary(r: Record<string, unknown>): PlayerSummary {
  return {
    address: String(r.address).toLowerCase(),
    bestScore: Number(r.best_score ?? 0),
    bestCycle: Number(r.best_cycle ?? 0),
    bestEchoes: Number(r.best_echoes ?? 0),
    bestSurvivedMs: Number(r.best_survived_ms ?? 0),
    totalRuns: Number(r.total_runs ?? 0),
    recordedRuns: Number(r.recorded_runs ?? 0),
    normalRuns: Number(r.normal_runs ?? 0),
    rankedRuns: Number(r.ranked_runs ?? 0),
    openVerifiedRuns: Number(r.open_verified_runs ?? 0),
    spBalance: Number(r.sp_balance ?? 0),
    firstSeenAt: new Date(r.first_seen_at as string),
    lastSeenAt: new Date(r.last_seen_at as string),
    lastPlayedAt: r.last_played_at ? new Date(r.last_played_at as string) : null,
  };
}

/**
 * The per-wallet run and SP aggregates, as a CTE pair both the list and the single-player read
 * share. Kept in one place so the two can't disagree about what "normal runs" counts.
 *
 * Rows with a null `mode` predate the column and are attributed to no mode — they are still in
 * `recorded_runs`, so the per-mode counts can sum to less than the total on an old wallet.
 */
const AGGREGATE_CTES = `
  run_stats AS (
    SELECT address,
           count(*)::int AS recorded_runs,
           count(*) FILTER (WHERE mode = 'normal')::int AS normal_runs,
           count(*) FILTER (WHERE mode = 'ranked')::int AS ranked_runs,
           count(*) FILTER (WHERE mode = 'open_verified')::int AS open_verified_runs,
           max(created_at) AS last_played_at
      FROM echo_runs
     GROUP BY address
  ),
  sp_stats AS (
    SELECT address, coalesce(sum(amount), 0)::int AS sp_balance
      FROM echo_sp_ledger
     GROUP BY address
  )
`;

export type PlayerSort = 'last_played' | 'sp' | 'best_score' | 'runs';

const SORT_SQL: Record<PlayerSort, string> = {
  last_played: 'coalesce(rs.last_played_at, p.last_seen_at) DESC',
  sp: 'coalesce(ss.sp_balance, 0) DESC',
  best_score: 'p.best_score DESC',
  runs: 'coalesce(rs.recorded_runs, 0) DESC',
};

/**
 * Wallets that have played, newest-active first by default. `search` matches an address by
 * substring, so a partial paste finds the wallet.
 */
export async function listPlayers(options: {
  search?: string;
  sort?: PlayerSort;
  limit?: number;
  offset?: number;
}): Promise<{ players: PlayerSummary[]; total: number }> {
  const p = getPool();
  if (!p) return { players: [], total: 0 };

  const limit = Math.min(Math.max(1, options.limit ?? 50), 200);
  const offset = Math.max(0, options.offset ?? 0);
  const search = options.search?.trim().toLowerCase();
  const order = SORT_SQL[options.sort ?? 'last_played'];

  // LIKE with an escaped pattern: an operator pasting an address fragment must not be able to turn
  // `_` or `%` into wildcards, and the value stays a bound parameter either way.
  const filter = search ? `WHERE p.address LIKE $1` : '';
  const params: unknown[] = search
    ? [`%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, limit, offset]
    : [limit, offset];
  const limitParam = search ? '$2' : '$1';
  const offsetParam = search ? '$3' : '$2';

  const { rows } = await p.query(
    `WITH ${AGGREGATE_CTES}
     SELECT p.address, p.best_score, p.best_cycle, p.best_echoes, p.best_survived_ms,
            p.total_runs, p.first_seen_at, p.last_seen_at,
            coalesce(rs.recorded_runs, 0) AS recorded_runs,
            coalesce(rs.normal_runs, 0) AS normal_runs,
            coalesce(rs.ranked_runs, 0) AS ranked_runs,
            coalesce(rs.open_verified_runs, 0) AS open_verified_runs,
            rs.last_played_at,
            coalesce(ss.sp_balance, 0) AS sp_balance,
            count(*) OVER ()::int AS total_count
       FROM echo_players p
       LEFT JOIN run_stats rs ON rs.address = p.address
       LEFT JOIN sp_stats ss ON ss.address = p.address
       ${filter}
      ORDER BY ${order}
      LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params,
  );

  return {
    players: rows.map(toSummary),
    total: rows.length ? Number(rows[0].total_count) : 0,
  };
}

/** One wallet's summary, or null when the game has never seen it. */
export async function getPlayer(address: string): Promise<PlayerSummary | null> {
  const p = getPool();
  if (!p) return null;
  const { rows } = await p.query(
    `WITH ${AGGREGATE_CTES}
     SELECT p.address, p.best_score, p.best_cycle, p.best_echoes, p.best_survived_ms,
            p.total_runs, p.first_seen_at, p.last_seen_at,
            coalesce(rs.recorded_runs, 0) AS recorded_runs,
            coalesce(rs.normal_runs, 0) AS normal_runs,
            coalesce(rs.ranked_runs, 0) AS ranked_runs,
            coalesce(rs.open_verified_runs, 0) AS open_verified_runs,
            rs.last_played_at,
            coalesce(ss.sp_balance, 0) AS sp_balance
       FROM echo_players p
       LEFT JOIN run_stats rs ON rs.address = p.address
       LEFT JOIN sp_stats ss ON ss.address = p.address
      WHERE p.address = $1`,
    [normalizeAddress(address)],
  );
  return rows.length ? toSummary(rows[0]) : null;
}

export interface PlayRecord {
  id: string;
  address: string;
  /** null on rows filed before the mode column existed, or via the legacy un-ticketed path. */
  mode: PlayMode | null;
  score: number;
  cycle: number;
  echoes: number;
  echoesDestroyed: number;
  survivedMs: number;
  chainId: number | null;
  ticketId: string | null;
  /** Steady Points credited for this run, from the ledger row keyed on its ticket. */
  spAwarded: number | null;
  createdAt: Date;
}

/**
 * One wallet's play history, newest first, optionally narrowed to a single mode.
 *
 * The SP credited for each run is joined in on the ticket id, which is the ledger's `source_id` for
 * a `run` credit. A null there means no SP row exists: a normal-mode run, an SP-run slot or daily
 * cap already spent, or a run filed before the ticket id was recorded.
 */
export async function listPlayerRuns(
  address: string,
  options: { mode?: PlayMode; limit?: number; offset?: number } = {},
): Promise<{ runs: PlayRecord[]; total: number }> {
  const p = getPool();
  if (!p) return { runs: [], total: 0 };

  const limit = Math.min(Math.max(1, options.limit ?? 50), 200);
  const offset = Math.max(0, options.offset ?? 0);
  const wallet = normalizeAddress(address);

  const params: unknown[] = options.mode ? [wallet, options.mode, limit, offset] : [wallet, limit, offset];
  const modeFilter = options.mode ? 'AND r.mode = $2' : '';
  const limitParam = options.mode ? '$3' : '$2';
  const offsetParam = options.mode ? '$4' : '$3';

  const { rows } = await p.query(
    `SELECT r.id, r.address, r.mode, r.score, r.cycle, r.echoes, r.echoes_destroyed,
            r.survived_ms, r.chain_id, r.ticket_id, r.created_at,
            l.amount AS sp_awarded,
            count(*) OVER ()::int AS total_count
       FROM echo_runs r
       LEFT JOIN echo_sp_ledger l
              ON l.reason = 'run' AND l.source_id = r.ticket_id::text
      WHERE r.address = $1 ${modeFilter}
      ORDER BY r.created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params,
  );

  return {
    runs: rows.map((r) => ({
      id: String(r.id),
      address: String(r.address).toLowerCase(),
      mode: isPlayMode(r.mode) ? r.mode : null,
      score: Number(r.score),
      cycle: Number(r.cycle),
      echoes: Number(r.echoes),
      echoesDestroyed: Number(r.echoes_destroyed ?? 0),
      survivedMs: Number(r.survived_ms),
      chainId: r.chain_id == null ? null : Number(r.chain_id),
      ticketId: r.ticket_id ? String(r.ticket_id) : null,
      spAwarded: r.sp_awarded == null ? null : Number(r.sp_awarded),
      createdAt: new Date(r.created_at as string),
    })),
    total: rows.length ? Number(rows[0].total_count) : 0,
  };
}

export interface SpLedgerEntry {
  id: string;
  amount: number;
  /** `run` or `quest` today. The source id is the ticket id, or `YYYY-MM-DD:quest_key`. */
  reason: string;
  sourceId: string;
  createdAt: Date;
  /** Running balance after this entry, oldest-to-newest. */
  balanceAfter: number;
}

/**
 * One wallet's Steady Points ledger, newest first, with the running balance carried on each entry
 * so an operator can see where a balance came from without re-adding it by hand.
 */
export async function listSpLedger(
  address: string,
  options: { limit?: number; offset?: number } = {},
): Promise<{ entries: SpLedgerEntry[]; total: number; balance: number }> {
  const p = getPool();
  if (!p) return { entries: [], total: 0, balance: 0 };

  const limit = Math.min(Math.max(1, options.limit ?? 100), 500);
  const offset = Math.max(0, options.offset ?? 0);

  const { rows } = await p.query(
    `WITH ledger AS (
       SELECT id, amount, reason, source_id, created_at,
              sum(amount) OVER (ORDER BY created_at, id)::int AS balance_after,
              count(*) OVER ()::int AS total_count,
              sum(amount) OVER ()::int AS balance
         FROM echo_sp_ledger
        WHERE address = $1
     )
     SELECT * FROM ledger ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
    [normalizeAddress(address), limit, offset],
  );

  return {
    entries: rows.map((r) => ({
      id: String(r.id),
      amount: Number(r.amount),
      reason: String(r.reason),
      sourceId: String(r.source_id),
      createdAt: new Date(r.created_at as string),
      balanceAfter: Number(r.balance_after),
    })),
    total: rows.length ? Number(rows[0].total_count) : 0,
    balance: rows.length ? Number(rows[0].balance) : 0,
  };
}

export interface DailyCounterRow {
  utcDate: string;
  spRunsUsed: number;
  spEarned: number;
  rankedUsed: number;
}

/** The wallet's recent per-UTC-day SP counters — what the daily cap was actually measured against. */
export async function listDailyCounters(address: string, days = 14): Promise<DailyCounterRow[]> {
  const p = getPool();
  if (!p) return [];
  const { rows } = await p.query(
    `SELECT utc_date, sp_runs_used, sp_earned, ranked_used
       FROM echo_daily_counters
      WHERE address = $1
      ORDER BY utc_date DESC
      LIMIT $2`,
    [normalizeAddress(address), Math.min(Math.max(1, days), 90)],
  );
  return rows.map((r) => ({
    utcDate: String(r.utc_date),
    spRunsUsed: Number(r.sp_runs_used ?? 0),
    spEarned: Number(r.sp_earned ?? 0),
    rankedUsed: Number(r.ranked_used ?? 0),
  }));
}

/** Dashboard-wide totals for the page header. */
export async function getPlayTotals(): Promise<{
  players: number;
  runs: number;
  normalRuns: number;
  rankedRuns: number;
  openVerifiedRuns: number;
  spIssued: number;
}> {
  const p = getPool();
  if (!p) {
    return { players: 0, runs: 0, normalRuns: 0, rankedRuns: 0, openVerifiedRuns: 0, spIssued: 0 };
  }
  const { rows } = await p.query(
    `SELECT (SELECT count(*)::int FROM echo_players) AS players,
            (SELECT count(*)::int FROM echo_runs) AS runs,
            (SELECT count(*)::int FROM echo_runs WHERE mode = 'normal') AS normal_runs,
            (SELECT count(*)::int FROM echo_runs WHERE mode = 'ranked') AS ranked_runs,
            (SELECT count(*)::int FROM echo_runs WHERE mode = 'open_verified') AS open_verified_runs,
            (SELECT coalesce(sum(amount), 0)::int FROM echo_sp_ledger) AS sp_issued`,
  );
  const r = rows[0] ?? {};
  return {
    players: Number(r.players ?? 0),
    runs: Number(r.runs ?? 0),
    normalRuns: Number(r.normal_runs ?? 0),
    rankedRuns: Number(r.ranked_runs ?? 0),
    openVerifiedRuns: Number(r.open_verified_runs ?? 0),
    spIssued: Number(r.sp_issued ?? 0),
  };
}
