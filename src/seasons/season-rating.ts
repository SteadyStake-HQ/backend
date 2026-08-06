/**
 * Season rating and ranking (blueprint §12). Pure and dependency-free so it can be unit-tested
 * against the worked example, and reused by both the live leaderboard and finalization.
 */

export interface DailyBest {
  address: string;
  utcDate: string;
  score: number;
  cycles: number;
  echoes: number;
  /** When this daily-best was set; the last tie-break uses it (§12.2). */
  achievedAt: Date;
}

export interface RankedPlayer {
  address: string;
  /** Sum of the best five daily-best scores (§12.1). */
  seasonRating: number;
  /** Distinct UTC dates with a daily-best. */
  eligibleDays: number;
  /** True once the player has at least the minimum eligible days (§12.1). */
  prizeEligible: boolean;
  highestDaily: number;
  countedCycles: number;
  countedEchoes: number;
  /** The moment the rating was completed — the latest achievedAt among the counted runs. */
  ratingAchievedAt: Date;
}

export interface RatingConfig {
  countedDailyResults: number; // §11.1 default 5
  minimumEligibleDays: number; // §11.1 default 3
}

function byScoreThenEarliest(a: DailyBest, b: DailyBest): number {
  if (b.score !== a.score) return b.score - a.score;
  return a.achievedAt.getTime() - b.achievedAt.getTime();
}

/**
 * Rank every player in a season. Input is one row per (player, UTC date) — the player's highest
 * ranked score for that date. Output is sorted best-first with the §12.2 tie-breaks fully applied.
 */
export function rankSeason(bests: DailyBest[], config: RatingConfig): RankedPlayer[] {
  const byPlayer = new Map<string, DailyBest[]>();
  for (const best of bests) {
    const key = best.address.toLowerCase();
    const list = byPlayer.get(key);
    if (list) list.push(best);
    else byPlayer.set(key, [best]);
  }

  const players: RankedPlayer[] = [];
  for (const [address, rows] of byPlayer) {
    const sorted = [...rows].sort(byScoreThenEarliest);
    const counted = sorted.slice(0, config.countedDailyResults);
    const seasonRating = counted.reduce((sum, r) => sum + r.score, 0);
    const ratingAchievedAt = counted.reduce(
      (latest, r) => (r.achievedAt > latest ? r.achievedAt : latest),
      counted[0]?.achievedAt ?? new Date(0),
    );
    players.push({
      address,
      seasonRating,
      eligibleDays: rows.length,
      prizeEligible: rows.length >= config.minimumEligibleDays,
      highestDaily: counted[0]?.score ?? 0,
      countedCycles: counted.reduce((s, r) => s + r.cycles, 0),
      countedEchoes: counted.reduce((s, r) => s + r.echoes, 0),
      ratingAchievedAt,
    });
  }

  return players.sort(compareRankedPlayers);
}

/** §12.2 tie-break order: rating, single daily-best, cycles, echoes, then earliest achievement. */
export function compareRankedPlayers(a: RankedPlayer, b: RankedPlayer): number {
  if (b.seasonRating !== a.seasonRating) return b.seasonRating - a.seasonRating;
  if (b.highestDaily !== a.highestDaily) return b.highestDaily - a.highestDaily;
  if (b.countedCycles !== a.countedCycles) return b.countedCycles - a.countedCycles;
  if (b.countedEchoes !== a.countedEchoes) return b.countedEchoes - a.countedEchoes;
  return a.ratingAchievedAt.getTime() - b.ratingAchievedAt.getTime();
}

/** The prize-eligible top three, for finalization (§14.2). Ineligible players are skipped (§14.3). */
export function topThree(ranked: RankedPlayer[]): RankedPlayer[] {
  return ranked.filter((p) => p.prizeEligible && p.seasonRating > 0).slice(0, 3);
}
