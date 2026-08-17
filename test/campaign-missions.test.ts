import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMPAIGN_MISSIONS,
  CAMPAIGN_SECTIONS,
  COMPLETION_MISSION_BY_SECTION,
  campaignMaxBps,
  completionInputs,
  computeBoostBps,
  getMission,
  isMissionCode,
  missionsInSection,
  PUBLISHED_CAMPAIGN_MAX_BPS,
  PUBLISHED_SECTION_MAX_BPS,
  sectionMaxBps,
  type CampaignSection,
} from '../src/campaign/campaign-missions.ts';

/**
 * The campaign's economics, locked down.
 *
 * These are the numbers that appear in the campaign copy, on the presale page, and — via
 * `maxCampaignBoostBps` — frozen into the sale contract's config hash. A rate edited without its
 * section maximum being adjusted produces vouchers the contract *reverts* rather than clamps, which
 * costs buyers gas and sells them nothing. The catalog asserts its own consistency at import time;
 * these tests are what makes that assertion visible as a failing test rather than a boot crash.
 */

/** Every mission in a section, as the set `computeBoostBps` takes. */
function allOf(section: CampaignSection): string[] {
  return missionsInSection(section).map((m) => m.code);
}

test('the published section maxima are what the catalog actually sums to', () => {
  for (const section of CAMPAIGN_SECTIONS) {
    assert.equal(
      sectionMaxBps(section),
      PUBLISHED_SECTION_MAX_BPS[section],
      `${section} must sum to the published maximum`,
    );
  }
  // +1.10% + +2.60% + +1.80% = +5.50%, the number the campaign hero prints.
  assert.equal(campaignMaxBps(), PUBLISHED_CAMPAIGN_MAX_BPS);
  assert.equal(campaignMaxBps(), 550);
});

test('the campaign is the twenty-one missions the spec defines', () => {
  assert.equal(CAMPAIGN_MISSIONS.length, 21);
  assert.equal(missionsInSection('community').length, 7);
  assert.equal(missionsInSection('onchain').length, 9);
  assert.equal(missionsInSection('game').length, 5);
});

test('mission codes are unique and resolvable', () => {
  const codes = new Set(CAMPAIGN_MISSIONS.map((m) => m.code));
  assert.equal(codes.size, CAMPAIGN_MISSIONS.length, 'no duplicate codes');
  for (const code of codes) {
    assert.ok(isMissionCode(code));
    assert.equal(getMission(code)?.code, code);
  }
  assert.equal(isMissionCode('not_a_mission'), false);
  assert.equal(getMission('not_a_mission'), undefined);
});

test('every rate is a whole basis point — no fractions reach a signature', () => {
  for (const mission of CAMPAIGN_MISSIONS) {
    assert.ok(Number.isInteger(mission.boostBps), `${mission.code} must be an integer bps`);
    assert.ok(mission.boostBps >= 0, `${mission.code} must not be negative`);
    assert.ok(mission.boostBps <= 550, `${mission.code} must not exceed the campaign maximum alone`);
  }
});

test('the individual rates are the ones the spec publishes', () => {
  // Spot-checked rather than exhaustive: these five are the ones the campaign copy quotes by number,
  // so they are the ones a reader will hold the implementation to.
  assert.equal(getMission('community_follow_steadystake_x')?.boostBps, 15);
  assert.equal(getMission('community_verified_referral')?.boostBps, 20);
  assert.equal(getMission('onchain_six_dca_executions')?.boostBps, 40);
  assert.equal(getMission('game_purchase_pass')?.boostBps, 100);
  assert.equal(getMission('game_completion')?.boostBps, 30);
  // The wallet-connect mission is eligibility only and must never pay.
  assert.equal(getMission('onchain_connect_botchain_wallet')?.boostBps, 0);
});

test('a wallet that has completed nothing earns nothing', () => {
  const { boostBps, missionCodes, perSection } = computeBoostBps([]);
  assert.equal(boostBps, 0);
  assert.deepEqual(missionCodes, []);
  assert.deepEqual(perSection, { community: 0, onchain: 0, game: 0 });
});

test('completing every mission earns exactly the published maximum and no more', () => {
  const { boostBps, perSection } = computeBoostBps(CAMPAIGN_MISSIONS.map((m) => m.code));
  assert.equal(boostBps, 550);
  assert.equal(perSection.community, 110);
  assert.equal(perSection.onchain, 260);
  assert.equal(perSection.game, 180);
});

test('a section is worth its own maximum and contributes nothing to the others', () => {
  for (const section of CAMPAIGN_SECTIONS) {
    const { boostBps, perSection } = computeBoostBps(allOf(section));
    assert.equal(boostBps, PUBLISHED_SECTION_MAX_BPS[section]);
    for (const other of CAMPAIGN_SECTIONS) {
      if (other !== section) assert.equal(perSection[other], 0);
    }
  }
});

test('the zero-bps eligibility mission is not counted as a contributing mission', () => {
  const { boostBps, missionCodes } = computeBoostBps(['onchain_connect_botchain_wallet']);
  assert.equal(boostBps, 0);
  // Excluded from the voucher's mission list too: a voucher recording a mission worth nothing would
  // make the audit trail claim a reward that was never paid.
  assert.deepEqual(missionCodes, []);
});

test('an unknown mission code contributes nothing rather than throwing', () => {
  // The set comes from stored rows, which outlive a mission being renamed or withdrawn. Silently
  // ignoring an unrecognised code is what keeps a retired mission from either paying or crashing.
  const { boostBps } = computeBoostBps(['game_first_play', 'a_mission_that_was_removed']);
  assert.equal(boostBps, 10);
});

test('duplicate completions cannot be counted twice', () => {
  // The database's unique index makes this unreachable, but the arithmetic must not depend on that:
  // it takes an iterable, and a caller passing an array is one bug away from a doubled boost.
  const { boostBps } = computeBoostBps(['game_purchase_pass', 'game_purchase_pass', 'game_purchase_pass']);
  assert.equal(boostBps, 100);
});

test('a partly-complete wallet earns the sum of exactly what it completed', () => {
  const { boostBps, perSection } = computeBoostBps([
    'onchain_hold_bot', // 20
    'onchain_hold_usdt', // 20
    'onchain_bot_usdt_ready', // 20
    'onchain_create_dca_plan', // 40
    'onchain_first_dca_execution', // 40
    'game_first_play', // 10
    'game_three_sessions', // 15
  ]);
  assert.equal(perSection.onchain, 140);
  assert.equal(perSection.game, 25);
  assert.equal(boostBps, 165);
});

test('the spec §7 worked example reproduces exactly', () => {
  // "Reward Calculation" in the campaign spec adds nine missions to +2.55%. It uses v2's referral
  // wording but the same nine rates, so it is a direct check on this catalog's numbers.
  const { boostBps } = computeBoostBps([
    'community_follow_steadystake_x', // 15
    'community_join_steadystake_telegram', // 15
    'community_follow_botchain_x', // 15
    'onchain_hold_bot', // 20
    'onchain_hold_usdt', // 20
    'onchain_bot_usdt_ready', // 20
    'onchain_create_dca_plan', // 40
    'game_first_play', // 10
    'game_purchase_pass', // 100
  ]);
  assert.equal(boostBps, 255, '+2.55%');
});

test('each section names a real completion mission, and no bonus depends on another bonus', () => {
  for (const section of CAMPAIGN_SECTIONS) {
    const code = COMPLETION_MISSION_BY_SECTION[section];
    const mission = getMission(code);
    assert.ok(mission, `${section} names a real completion mission`);
    assert.equal(mission?.section, section);
    assert.equal(mission?.verificationType, 'completion');
    // A completion bonus that counted toward its own inputs would grant itself.
    assert.equal(mission?.countsTowardCompletion, false);

    const inputs = completionInputs(section);
    assert.ok(inputs.length > 0, `${section}'s completion bonus must have inputs`);
    for (const input of inputs) {
      assert.notEqual(input.verificationType, 'completion', 'no bonus may depend on another bonus');
      assert.equal(input.section, section, 'inputs must be from the same section');
    }
  }
});

test('the completion inputs are exactly the reward-bearing missions of their section', () => {
  // The interpretation this implementation commits to, made explicit so a change to it is a failing
  // test rather than a silent shift in how reachable each section's bonus is. Notably the community
  // bonus requires the referral, which makes the full +1.10% reachable only by a wallet that actually
  // converted one — deliberately parallel to the game section requiring a paid Game Pass.
  assert.deepEqual(completionInputs('community').map((m) => m.code), [
    'community_follow_steadystake_x',
    'community_join_steadystake_telegram',
    'community_follow_botchain_x',
    'community_join_botchain_telegram',
    'community_campaign_engagement',
    'community_verified_referral',
  ]);
  assert.deepEqual(completionInputs('game').map((m) => m.code), [
    'game_first_play',
    'game_three_sessions',
    'game_ten_sessions',
    'game_purchase_pass',
  ]);
  // The eligibility mission is a precondition, not a completion input — it pays nothing.
  assert.ok(!completionInputs('onchain').some((m) => m.code === 'onchain_connect_botchain_wallet'));
  assert.equal(completionInputs('onchain').length, 7);
});

test('no launch mission is repeatable', () => {
  // Every one is a cumulative milestone, which is what makes one completion row per (wallet, mission)
  // the correct idempotency key. A repeatable mission would need a different store shape entirely.
  for (const mission of CAMPAIGN_MISSIONS) {
    assert.equal(mission.repeatable, false, `${mission.code} must not be repeatable`);
  }
});

test('every mission with a milestone carries a parseable threshold', () => {
  for (const mission of CAMPAIGN_MISSIONS) {
    if (mission.threshold === null) continue;
    // Thresholds are strings because the balance ones are wei-scale; they still have to be numbers.
    assert.doesNotThrow(() => BigInt(mission.threshold as string), `${mission.code} threshold`);
    assert.ok(BigInt(mission.threshold as string) > 0n, `${mission.code} threshold must be positive`);
  }
  // The two the spec states in prose, in base units.
  assert.equal(getMission('onchain_hold_bot')?.threshold, '1000000000000000000'); // 1 BOT
  assert.equal(getMission('onchain_hold_usdt')?.threshold, '10000000'); // 10 USDT at 6dp
  assert.equal(getMission('game_ten_sessions')?.threshold, '10');
  assert.equal(getMission('onchain_six_dca_executions')?.threshold, '6');
});
