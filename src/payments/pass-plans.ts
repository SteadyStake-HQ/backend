/**
 * The trusted Game Pass plan table (blueprint §5.1). Price/duration come from here, never from the
 * client (§7.1). Ids match the on-chain plan ids seeded into every StablecoinGamePassCheckout.
 *
 * Price is held in whole US cents so the atomic amount is computed per network from the stablecoin's
 * own decimals — 990000 at 6dp, 0.99e18 at 18dp — keeping "the displayed dollar amount numerically
 * the same on each supported network" (§5.1).
 */
export interface PassPlan {
  id: number;
  key: 'hour' | 'day' | 'week' | 'month';
  label: string;
  durationSeconds: number;
  priceCents: number;
}

export const PASS_PLANS: readonly PassPlan[] = [
  /**
   * TEST PLAN — not a product tier. One cent buys the full pass entitlement (10 SP-eligible runs a
   * day, the 1.5x SP multiplier, open-verified mode), which is why it exists only to exercise the
   * purchase flow end to end. Remove it, or reprice it, before this reaches players: SP balances are
   * meant to gate wallet permissions, so a pass anyone can buy for a cent inflates entitlements
   * across every wallet that notices.
   *
   * It is listed first so it reads shortest-to-longest on the Game Pass screen. That does not make it
   * the default — the screen preselects the Week Pass by key.
   */
  { id: 4, key: 'hour', label: '1-Hour Pass', durationSeconds: 60 * 60, priceCents: 1 },
  { id: 1, key: 'day', label: 'Day Pass', durationSeconds: 24 * 60 * 60, priceCents: 99 },
  { id: 2, key: 'week', label: 'Week Pass', durationSeconds: 7 * 24 * 60 * 60, priceCents: 399 },
  { id: 3, key: 'month', label: 'Month Pass', durationSeconds: 30 * 24 * 60 * 60, priceCents: 999 },
];

export function getPassPlan(id: number): PassPlan | undefined {
  return PASS_PLANS.find((p) => p.id === id);
}

/** Atomic amount for a plan on a token with `decimals` places. Requires decimals >= 2. */
export function planAmountAtomic(plan: PassPlan, decimals: number): bigint {
  if (decimals < 2) throw new Error(`stablecoin decimals ${decimals} < 2`);
  const unit = 10n ** BigInt(decimals - 2); // one cent
  return BigInt(plan.priceCents) * unit;
}
