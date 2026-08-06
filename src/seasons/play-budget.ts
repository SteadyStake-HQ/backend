/**
 * Per-plan game play budget.
 *
 * A wallet's SteadyStake membership plan grants a per-season budget of verified runs, split between
 * ranked and open-verified modes (these two are counted separately). The live season may set a lower
 * cap; the effective budget a player actually gets is `min(planBudget, seasonLimit)` (a null season
 * limit means "no season cap", so the plan budget stands). Once a mode's budget is spent for the
 * season the player can only play the un-counted "normal" record-score mode.
 *
 * Kept as a pure table so the game (which enforces the caps at ticket-issue time) and the dashboard
 * read the same numbers.
 */
import type { MembershipTier } from '../supabase/capacity-store';

export interface ModeBudget {
  /** Ranked verified runs allowed this season. */
  ranked: number;
  /** Open-verified runs allowed this season. */
  openVerified: number;
}

/**
 * Season budget per membership tier. Higher tiers unlock more verified play. `institutional` is
 * effectively uncapped by the plan (the season limit, if any, is the only ceiling).
 */
export const SEASON_PLAY_BUDGET: Record<MembershipTier, ModeBudget> = {
  starter: { ranked: 15, openVerified: 30 },
  plus: { ranked: 45, openVerified: 90 },
  pro: { ranked: 150, openVerified: 300 },
  institutional: { ranked: Number.MAX_SAFE_INTEGER, openVerified: Number.MAX_SAFE_INTEGER },
};

export function planBudgetFor(tier: MembershipTier): ModeBudget {
  return SEASON_PLAY_BUDGET[tier];
}

/**
 * The budget a wallet effectively gets for one mode: the plan budget, capped by the season limit when
 * the season sets one. A null/undefined season limit leaves the plan budget untouched.
 */
export function effectiveBudget(planBudget: number, seasonLimit: number | null | undefined): number {
  if (seasonLimit == null) return planBudget;
  return Math.min(planBudget, Math.max(0, seasonLimit));
}
