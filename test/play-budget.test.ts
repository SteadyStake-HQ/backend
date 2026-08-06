import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveBudget, planBudgetFor, SEASON_PLAY_BUDGET } from '../src/seasons/play-budget.ts';

test('plan budget grows with tier and institutional is effectively uncapped', () => {
  assert.equal(planBudgetFor('starter').ranked, SEASON_PLAY_BUDGET.starter.ranked);
  assert.ok(planBudgetFor('plus').ranked > planBudgetFor('starter').ranked);
  assert.ok(planBudgetFor('pro').openVerified > planBudgetFor('plus').openVerified);
  assert.ok(planBudgetFor('institutional').ranked >= Number.MAX_SAFE_INTEGER);
});

test('effective budget = min(plan, season limit); null season limit leaves the plan budget', () => {
  // No season cap: the plan budget stands.
  assert.equal(effectiveBudget(30, null), 30);
  assert.equal(effectiveBudget(30, undefined), 30);
  // Season caps below the plan budget win.
  assert.equal(effectiveBudget(30, 10), 10);
  // Season cap above the plan budget does not raise it.
  assert.equal(effectiveBudget(30, 100), 30);
  // A zero season cap means no runs of that mode.
  assert.equal(effectiveBudget(30, 0), 0);
  // Negative season limits are clamped to zero, never negative budget.
  assert.equal(effectiveBudget(30, -5), 0);
});
