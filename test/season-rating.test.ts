import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankSeason, topThree, type DailyBest } from '../src/seasons/season-rating.ts';

const CONFIG = { countedDailyResults: 5, minimumEligibleDays: 3 };

function best(address: string, day: number, score: number, cycles = 0, echoes = 0): DailyBest {
  return {
    address,
    utcDate: `2026-08-${String(day).padStart(2, '0')}`,
    score,
    cycles,
    echoes,
    achievedAt: new Date(Date.UTC(2026, 7, day, 12, 0, 0)),
  };
}

test('§12.1 worked example: best five sum to 29,300', () => {
  const bests = [
    best('0xA', 1, 4200),
    best('0xA', 2, 6100),
    best('0xA', 3, 5700),
    best('0xA', 4, 3900),
    best('0xA', 5, 7000),
    best('0xA', 6, 6300),
  ];
  const ranked = rankSeason(bests, CONFIG);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].seasonRating, 29300, '7000+6300+6100+5700+4200');
  assert.equal(ranked[0].highestDaily, 7000);
  assert.equal(ranked[0].prizeEligible, true);
});

test('fewer than minimum eligible days is not prize-eligible (§12.1)', () => {
  const bests = [best('0xB', 1, 5000), best('0xB', 2, 6000)]; // only 2 days
  const [player] = rankSeason(bests, CONFIG);
  assert.equal(player.prizeEligible, false);
  assert.equal(topThree(rankSeason(bests, CONFIG)).length, 0);
});

test('tie on rating breaks on highest single daily-best (§12.2)', () => {
  // Both total 18,000 over 3 days, but A has a higher single day.
  const bests = [
    best('0xA', 1, 9000), best('0xA', 2, 5000), best('0xA', 3, 4000),
    best('0xB', 1, 6000), best('0xB', 2, 6000), best('0xB', 3, 6000),
  ];
  const ranked = rankSeason(bests, CONFIG);
  assert.equal(ranked[0].seasonRating, 18000);
  assert.equal(ranked[1].seasonRating, 18000);
  assert.equal(ranked[0].address, '0xa', 'higher single daily-best wins the tie');
});

test('disqualifying a day drops it from the rating and reorders', () => {
  // A leads with a huge day; removing it (caller filters the input) puts B ahead.
  const all = [
    best('0xA', 1, 9000), best('0xA', 2, 5000), best('0xA', 3, 4000),
    best('0xB', 1, 6000), best('0xB', 2, 6000), best('0xB', 3, 6000),
  ];
  const withoutAbigDay = all.filter((b) => !(b.address === '0xA' && b.score === 9000));
  const ranked = rankSeason(withoutAbigDay, CONFIG);
  // A now has only 2 days -> not prize-eligible; B is the top prize-eligible.
  assert.equal(topThree(ranked)[0].address, '0xb');
});

test('top three picks prize-eligible players in order', () => {
  const bests = [
    best('0xA', 1, 7000), best('0xA', 2, 7000), best('0xA', 3, 7000),
    best('0xB', 1, 6000), best('0xB', 2, 6000), best('0xB', 3, 6000),
    best('0xC', 1, 5000), best('0xC', 2, 5000), best('0xC', 3, 5000),
    best('0xD', 1, 4000), best('0xD', 2, 4000), // only 2 days -> excluded
  ];
  const winners = topThree(rankSeason(bests, CONFIG)).map((p) => p.address);
  assert.deepEqual(winners, ['0xa', '0xb', '0xc']);
});
