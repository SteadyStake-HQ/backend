/**
 * Per-plan game play budget.
 *
 * A wallet's SteadyStake membership plan grants a per-season budget of verified runs, split between
 * ranked and open-verified modes (these two are counted separately). This plan budget is the only
 * ceiling: a season used to be able to set a lower per-wallet cap of its own, but that was removed
 * along with the dashboard field for it, so `effectiveBudget`'s season limit is now always null.
 *
 * Once a mode's budget is spent for the season the player can still play the un-counted "normal"
 * record-score mode, which earns Steady Points like any other — the budget limits *verified* play, not
 * earning.
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
 * one is passed. A null/undefined season limit leaves the plan budget untouched, which is now every
 * call — the parameter is kept so a season-scoped cap can be reintroduced without replumbing this.
 */
export function effectiveBudget(planBudget: number, seasonLimit: number | null | undefined): number {
  if (seasonLimit == null) return planBudget;
  return Math.min(planBudget, Math.max(0, seasonLimit));
}
