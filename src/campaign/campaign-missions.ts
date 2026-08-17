/**
 * The Early Supporter Campaign's mission catalog — the one place the campaign's economics are
 * written down.
 *
 * WHY THIS IS CODE AND NOT A TABLE. The campaign spec fixes twenty-one missions and three section
 * maxima that add to a published +5.50%, and that number is frozen into the sale contract's
 * `configHash` as `maxCampaignBoostBps`. A dashboard-editable rate table would let an operator
 * publish a boost the contract will refuse to honour — `buyWithCampaign` reverts above the ceiling
 * rather than clamping — so the rates live here, beside the assertions that keep them consistent,
 * and the contract's ceiling is read from the chain rather than restated (see campaign-voucher.ts).
 *
 * The `is_active` / `is_repeatable` / `requirements` fields the spec's §8 data model suggests are
 * represented as the `active`, `repeatable` and `threshold` fields below. None of the launch missions
 * are repeatable: every one is "reach this milestone", and the milestones are cumulative, which is
 * what makes a single completion row per (wallet, mission) the correct idempotency key.
 *
 * Everything is in basis points, never percent. 15 bps is 0.15%, and the campaign's smallest step is
 * 5 bps — a float percentage would introduce rounding into a number that ends up in a signature.
 */

/** The three sections of the campaign, in the order the dashboard renders them. */
export const CAMPAIGN_SECTIONS = ['community', 'onchain', 'game'] as const;
export type CampaignSection = (typeof CAMPAIGN_SECTIONS)[number];

/**
 * How a mission's completion is established. This is the field that decides which verifier runs,
 * and — just as importantly — which missions can be verified at all today.
 *
 * - `wallet_session`   the wallet proved control of its address on the sale chain (SIWE).
 * - `onchain_balance`  a BOT Chain RPC read of native or ERC-20 balance.
 * - `dca_record`       SteadyStake's own indexed DCA plan/execution records on BOT Chain.
 * - `game_session`     the Echo Arena run ledger, ticketed runs only.
 * - `game_pass`        a confirmed Game Pass purchase intent.
 * - `referral`         an internal referral record whose referee has a confirmed SS4 purchase.
 * - `telegram`         Telegram Bot API `getChatMember` against a linked Telegram account.
 * - `x`                the X API. NOT WIRED — see `X_VERIFICATION_AVAILABLE` below.
 * - `completion`       derived: every other reward-bearing mission in the section is complete.
 */
export const VERIFICATION_TYPES = [
  'wallet_session',
  'onchain_balance',
  'dca_record',
  'game_session',
  'game_pass',
  'referral',
  'telegram',
  'x',
  'completion',
] as const;
export type VerificationType = (typeof VERIFICATION_TYPES)[number];

/** The status of one wallet's attempt at one mission (spec §6 "Recommended Mission States"). */
export const MISSION_STATUSES = ['locked', 'available', 'verifying', 'completed', 'failed'] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

export interface CampaignMission {
  /** Stable code, used as the database key and in the API. Never renamed — completions key on it. */
  code: string;
  section: CampaignSection;
  name: string;
  /** The requirement, phrased as the campaign page states it. */
  requirement: string;
  /** Basis points of the purchase this mission adds. 0 for the eligibility-only wallet mission. */
  boostBps: number;
  verificationType: VerificationType;
  /**
   * The numeric milestone this mission is measured against, when it has one: 1 BOT in wei,
   * 10 USDT in base units, 3 executions, 10 sessions. Null for the missions that are pass/fail.
   *
   * Held as a string because the balance thresholds are wei-scale and must survive JSON without
   * losing precision — the same reason every amount in this backend is a string.
   */
  threshold: string | null;
  /**
   * Whether this mission has to be complete for its section's completion bonus to be granted.
   *
   * False only for `wallet_session` (it pays nothing, and the spec says the eligibility mission
   * "does not contribute a percentage but may be required before the on-chain campaign can be
   * completed" — it is required as a precondition of the others, not as a completion input) and for
   * the completion bonuses themselves, which cannot require each other.
   */
  countsTowardCompletion: boolean;
  /** Whether the same wallet can earn this mission more than once. None of the launch set can. */
  repeatable: boolean;
  active: boolean;
}

/**
 * Part 1 — Join the Community. Maximum +1.10%.
 *
 * NOTE ON `community_verified_referral` AND THE COMPLETION BONUS. The spec says the community
 * completion bonus lands "after all required community missions are completed" without saying which
 * are required, where the other two sections are explicit (on-chain: "all reward-bearing"; game: "all
 * ... including the Game Pass purchase mission"). It is read here as all reward-bearing missions,
 * referral included, so the three sections follow one rule. That makes the full +1.10% reachable only
 * by a wallet that actually converted a referral — deliberately parallel to the game section, where
 * the full +1.80% requires paying for a Game Pass. Flip `countsTowardCompletion` on this one mission
 * to make the completion bonus reachable without a referral.
 */
const COMMUNITY_MISSIONS: readonly CampaignMission[] = [
  {
    code: 'community_follow_steadystake_x',
    section: 'community',
    name: 'Follow SteadyStake on X',
    requirement: 'User follows the official SteadyStake X account',
    boostBps: 15,
    verificationType: 'x',
    threshold: null,
    countsTowardCompletion: true,
    repeatable: false,
    active: true,
  },
  {
    code: 'community_join_steadystake_telegram',
    section: 'community',
    name: 'Join SteadyStake Telegram',
    requirement: 'User joins the official SteadyStake Telegram community',
    boostBps: 15,
    verificationType: 'telegram',
    threshold: null,
    countsTowardCompletion: true,
    repeatable: false,
    active: true,
  },
  {
    code: 'community_follow_botchain_x',
    section: 'community',
    name: 'Follow BOT Chain on X',
    requirement: 'User follows the official BOT Chain X account',
    boostBps: 15,
    verificationType: 'x',
    threshold: null,
    countsTowardCompletion: true,
    repeatable: false,
    active: true,
  },
  {
    code: 'community_join_botchain_telegram',
    section: 'community',
    name: 'Join BOT Chain Telegram',
    requirement: 'User joins the official BOT Chain Telegram community',
    boostBps: 15,
    verificationType: 'telegram',
    threshold: null,
    countsTowardCompletion: true,
    repeatable: false,
    active: true,
  },
  {
    code: 'community_campaign_engagement',
    section: 'community',
    name: 'Like + Repost Campaign Post',
    requirement: 'User completes required engagement on the campaign post',
    boostBps: 10,
    verificationType: 'x',
    threshold: null,
    countsTowardCompletion: true,
    repeatable: false,
    active: true,
  },
  {
    code: 'community_verified_referral',
    section: 'community',
    name: 'Refer a Verified User',
    requirement: 'An invited user purchases SS4 in the presale',
    boostBps: 20,
    verificationType: 'referral',
    threshold: '1',
    countsTowardCompletion: true,
    repeatable: false,
    active: true,
  },
  {
    code: 'community_completion',
    section: 'community',
    name: 'Community Completion Bonus',
    requirement: 'User completes all required community missions',
    boostBps: 20,
    verificationType: 'completion',
    threshold: null,
    countsTowardCompletion: false,
    repeatable: false,
    active: true,
  },
];

/**
 * Part 2 — Record On-Chain. Maximum +2.60%.
 *
 * Thresholds are in base units, not display units: 1 BOT is 1e18 wei, 10 USDT is 10e6 at the six
 * decimals BOT Chain's stablecoin carries. The USDT contract itself is not named here — it is per
 * chain and comes from configuration (see campaign-config.ts), because the testnet rehearsal settles
 * in a 6-decimal USDC while mainnet BOT Chain carries USDT, and a hard-coded address would verify a
 * holding against a token the sale cannot accept.
 */
const ONCHAIN_MISSIONS: readonly CampaignMission[] = [
  {
    code: 'onchain_connect_botchain_wallet',
    section: 'onchain',
    name: 'Connect BOT Chain Wallet',
    requirement: 'User connects an eligible wallet on BOT Chain',
    boostBps: 0,
    verificationType: 'wallet_session',
    threshold: null,
    countsTowardCompletion: false,
    repeatable: false,
    active: true,
  },
  {
    code: 'onchain_hold_bot',
    section: 'onchain',
    name: 'Hold BOT',
    requirement: 'Wallet holds at least 1 BOT',
    boostBps: 20,
    verificationType: 'onchain_balance',
    threshold: '1000000000000000000',
    countsTowardCompletion: true,
    repeatable: false,
    active: true,
  },
  {
    code: 'onchain_hold_usdt',
    section: 'onchain',
    name: 'Hold USDT',
    requirement: 'Wallet holds at least 10 USDT on BOT Chain',
    boostBps: 20,
    verificationType: 'onchain_balance',
    threshold: '10000000',
    countsTowardCompletion: true,
    repeatable: false,
    active: true,
  },
  {
    code: 'onchain_bot_usdt_ready',
    section: 'onchain',
    name: 'BOT + USDT Ready',
    requirement: 'Wallet simultaneously meets both the BOT and USDT minimums',
    boostBps: 20,
    verificationType: 'onchain_balance',
    threshold: null,
    countsTowardCompletion: true,
    repeatable: false,
    active: true,
  },
  {
    code: 'onchain_create_dca_plan',
    section: 'onchain',
    name: 'Create First DCA Plan',
    requirement: 'User creates a valid SteadyStake DCA plan on BOT Chain',
    boostBps: 40,
    verificationType: 'dca_record',
    threshold: '1',
    countsTowardCompletion: true,
    repeatable: false,
    active: true,
  },
  {
    code: 'onchain_first_dca_execution',
    section: 'onchain',
    name: 'Complete First DCA Execution',
    requirement: 'One valid DCA execution is successfully settled',
    boostBps: 40,
    verificationType: 'dca_record',
    threshold: '1',
    countsTowardCompletion: true,
    repeatable: false,
    active: true,
  },
  {
    code: 'onchain_three_dca_executions',
    section: 'onchain',
    name: 'Complete 3 DCA Executions',
    requirement: 'User reaches 3 successfully settled executions',
    boostBps: 40,
    verificationType: 'dca_record',
    threshold: '3',
    countsTowardCompletion: true,
    repeatable: false,
    active: true,
  },
  {
    code: 'onchain_six_dca_executions',
    section: 'onchain',
    name: 'Complete 6 DCA Executions',
    requirement: 'User reaches 6 successfully settled executions',
    boostBps: 40,
    verificationType: 'dca_record',
    threshold: '6',
    countsTowardCompletion: true,
    repeatable: false,
    active: true,
  },
  {
    code: 'onchain_completion',
    section: 'onchain',
    name: 'On-Chain Completion Bonus',
    requirement: 'User completes all reward-bearing on-chain missions',
    boostBps: 40,
    verificationType: 'completion',
    threshold: null,
    countsTowardCompletion: false,
    repeatable: false,
    active: true,
  },
];

/** Part 3 — Game Activity. Maximum +1.80%, of which the Game Pass alone is +1.00%. */
const GAME_MISSIONS: readonly CampaignMission[] = [
  {
    code: 'game_first_play',
    section: 'game',
    name: 'Play First Game',
    requirement: 'Complete one valid Echo Arena game session',
    boostBps: 10,
    verificationType: 'game_session',
    threshold: '1',
    countsTowardCompletion: true,
    repeatable: false,
    active: true,
  },
  {
    code: 'game_three_sessions',
    section: 'game',
    name: 'Complete 3 Games',
    requirement: 'Complete at least 3 valid game sessions',
    boostBps: 15,
    verificationType: 'game_session',
    threshold: '3',
    countsTowardCompletion: true,
    repeatable: false,
    active: true,
  },
  {
    code: 'game_ten_sessions',
    section: 'game',
    name: 'Complete 10 Games',
    requirement: 'Complete at least 10 valid game sessions',
    boostBps: 25,
    verificationType: 'game_session',
    threshold: '10',
    countsTowardCompletion: true,
    repeatable: false,
    active: true,
  },
  {
    code: 'game_purchase_pass',
    section: 'game',
    name: 'Purchase Game Pass',
    requirement: 'Successfully purchase an eligible Echo Arena Game Pass',
    boostBps: 100,
    verificationType: 'game_pass',
    threshold: null,
    countsTowardCompletion: true,
    repeatable: false,
    active: true,
  },
  {
    code: 'game_completion',
    section: 'game',
    name: 'Game Completion Bonus',
    requirement: 'Complete all campaign game missions, Game Pass included',
    boostBps: 30,
    verificationType: 'completion',
    threshold: null,
    countsTowardCompletion: false,
    repeatable: false,
    active: true,
  },
];

export const CAMPAIGN_MISSIONS: readonly CampaignMission[] = [
  ...COMMUNITY_MISSIONS,
  ...ONCHAIN_MISSIONS,
  ...GAME_MISSIONS,
];

/** The completion-bonus mission of each section, by section. */
export const COMPLETION_MISSION_BY_SECTION: Record<CampaignSection, string> = {
  community: 'community_completion',
  onchain: 'onchain_completion',
  game: 'game_completion',
};

const MISSION_BY_CODE = new Map(CAMPAIGN_MISSIONS.map((m) => [m.code, m]));

export function getMission(code: string): CampaignMission | undefined {
  return MISSION_BY_CODE.get(code);
}

export function isMissionCode(value: unknown): value is string {
  return typeof value === 'string' && MISSION_BY_CODE.has(value);
}

export function missionsInSection(section: CampaignSection): CampaignMission[] {
  return CAMPAIGN_MISSIONS.filter((m) => m.section === section);
}

/** The missions whose completion the section's completion bonus depends on. */
export function completionInputs(section: CampaignSection): CampaignMission[] {
  return CAMPAIGN_MISSIONS.filter((m) => m.section === section && m.countsTowardCompletion && m.active);
}

/** The published maximum for one section, in bps. */
export function sectionMaxBps(section: CampaignSection): number {
  return CAMPAIGN_MISSIONS.filter((m) => m.section === section && m.active).reduce(
    (total, m) => total + m.boostBps,
    0,
  );
}

/** The published campaign maximum across all three sections, in bps. 550 = +5.50%. */
export function campaignMaxBps(): number {
  return CAMPAIGN_SECTIONS.reduce((total, section) => total + sectionMaxBps(section), 0);
}

/**
 * The Presale Boost a set of completed missions is worth, in bps, with both clamps applied.
 *
 * Lives here rather than in the service because it is arithmetic over the rates in this file, and it
 * has to stay next to `assertCatalogIsConsistent` — the clamps and the assertion are two halves of one
 * guarantee, and separating them is how a section quietly starts paying more than it publishes.
 *
 * SUMMED FROM THE CATALOG, NOT FROM STORED AWARDS. Completion rows record what a wallet was attested
 * for historically; a live voucher must reflect what the campaign publishes *now*. The caller passes
 * only the set of mission codes it has completed.
 *
 * TWO CLAMPS, AND WHY BOTH. Per section first, then overall. The catalog's boot-time assertion should
 * make both unreachable, but the consequence of being wrong is not symmetric: `buyWithCampaign`
 * *reverts* above the sale's frozen ceiling rather than clamping, so a boost that overflowed by one
 * basis point would not overpay a buyer — it would cost them their gas and sell them nothing.
 */
export function computeBoostBps(completedCodes: Iterable<string>): {
  boostBps: number;
  perSection: Record<CampaignSection, number>;
  /** The missions the boost was actually composed of, for the voucher's audit record. */
  missionCodes: string[];
} {
  const completed = completedCodes instanceof Set ? completedCodes : new Set(completedCodes);
  const perSection: Record<CampaignSection, number> = { community: 0, onchain: 0, game: 0 };
  const missionCodes: string[] = [];

  for (const mission of CAMPAIGN_MISSIONS) {
    if (!mission.active || mission.boostBps === 0 || !completed.has(mission.code)) continue;
    perSection[mission.section] += mission.boostBps;
    missionCodes.push(mission.code);
  }

  let total = 0;
  for (const section of CAMPAIGN_SECTIONS) {
    perSection[section] = Math.min(perSection[section], sectionMaxBps(section));
    total += perSection[section];
  }

  return { boostBps: Math.min(total, campaignMaxBps()), perSection, missionCodes };
}

/**
 * The section maxima the campaign publishes, asserted against what the catalog actually sums to.
 *
 * This runs at import time and throws, which is the point: these four numbers appear in the campaign
 * copy, on the dashboard, in the sale contract's frozen ceiling and in every voucher the backend
 * signs. A mission edited without adjusting its section — or a rate fat-fingered by a factor of ten —
 * has to fail at boot, not quietly start attesting boosts the contract will reject and buyers will
 * have read a different number for.
 */
export const PUBLISHED_SECTION_MAX_BPS: Record<CampaignSection, number> = {
  community: 110,
  onchain: 260,
  game: 180,
};
export const PUBLISHED_CAMPAIGN_MAX_BPS = 550;

function assertCatalogIsConsistent(): void {
  const seen = new Set<string>();
  for (const mission of CAMPAIGN_MISSIONS) {
    if (seen.has(mission.code)) {
      throw new Error(`campaign catalog: duplicate mission code ${mission.code}`);
    }
    seen.add(mission.code);
    if (!Number.isInteger(mission.boostBps) || mission.boostBps < 0) {
      throw new Error(`campaign catalog: ${mission.code} has a non-integer or negative boostBps`);
    }
  }

  for (const section of CAMPAIGN_SECTIONS) {
    const actual = sectionMaxBps(section);
    const published = PUBLISHED_SECTION_MAX_BPS[section];
    if (actual !== published) {
      throw new Error(
        `campaign catalog: ${section} sums to ${actual} bps but the campaign publishes ${published} bps`,
      );
    }
    const completionCode = COMPLETION_MISSION_BY_SECTION[section];
    if (!MISSION_BY_CODE.has(completionCode)) {
      throw new Error(`campaign catalog: ${section} names a missing completion mission ${completionCode}`);
    }
    if (completionInputs(section).length === 0) {
      throw new Error(`campaign catalog: ${section}'s completion bonus has no inputs, so it would self-grant`);
    }
  }

  const total = campaignMaxBps();
  if (total !== PUBLISHED_CAMPAIGN_MAX_BPS) {
    throw new Error(
      `campaign catalog: sums to ${total} bps but the campaign publishes ${PUBLISHED_CAMPAIGN_MAX_BPS} bps`,
    );
  }
}

assertCatalogIsConsistent();

/**
 * Whether X (Twitter) verification can run at all in this deployment.
 *
 * It cannot today, and this constant exists so that fact is visible in the API rather than
 * presenting itself as a mission that silently never completes. SteadyStake's X integration
 * (`x_bot`) is offline — revoked tokens, a dead proxy, no API credits — so there is no way to read
 * whether a wallet's linked X account follows an account or engaged with a post.
 *
 * The three X missions are therefore left `available` with `verificationAvailable: false`, and the
 * only path to completing them is `POST /api/admin/campaign/verify`, where an operator records the
 * evidence by hand and the audit log keeps their token as the verification source. Set
 * `X_API_BEARER_TOKEN` and implement `verifyXMission` in verifiers/social.ts to switch this on.
 */
export function xVerificationAvailable(): boolean {
  return Boolean(process.env.X_API_BEARER_TOKEN?.trim());
}
