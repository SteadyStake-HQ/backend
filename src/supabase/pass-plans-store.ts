/**
 * Operator-editable Game Pass plan table.
 *
 * `src/payments/pass-plans.ts` holds the plans the backend shipped with; this table overrides them,
 * so an operator can retitle a plan, change what it costs, change how long it lasts, or take one off
 * sale from the dashboard instead of a deploy.
 *
 * **The chain is the authority on price and duration, not this table.** A checkout contract stores
 * its own `plans(planId)` and `buyPass` asserts the treasury received exactly *its* price, so a row
 * here that disagrees with the contract does not re-price anything — it just makes the buyer's
 * transaction revert after they have already paid gas to approve. The admin API reads the on-chain
 * values back and reports the drift for exactly this reason; changing a price means `setPlan()` on
 * every deployed checkout first, and this row second.
 *
 * Plan id 4 is retired and refused on create: it was a $0.01 test tier that bought the full pass
 * entitlement, and SP balances gate wallet permissions, so a cent-priced pass inflates entitlements
 * everywhere. It was never seeded on a deployed checkout — but a *new* plan given id 4 would
 * silently inherit any checkout that ever had the test tier seeded.
 *
 * DI-free (SUPABASE_DB_URL) and on the shared pool, matching the other stores in this folder.
 */
import type { Pool } from 'pg';
import { getSharedPool } from './pg-pool';
import { PASS_PLANS, type PassPlan } from '../payments/pass-plans';

/** Ids that must never be issued again, whatever the dashboard is asked for. */
export const RETIRED_PLAN_IDS: readonly number[] = [4];

export interface PassPlanRow extends PassPlan {
  /** Off takes the plan off sale everywhere without touching any contract. */
  enabled: boolean;
  sortOrder: number;
  updatedAt: Date | null;
}

function getPool(): Pool | null {
  return getSharedPool();
}

function requirePool(): Pool {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  return p;
}

export const PASS_PLANS_DDL = `
  CREATE TABLE IF NOT EXISTS pass_plans (
    id integer PRIMARY KEY,
    key text NOT NULL,
    label text NOT NULL,
    duration_seconds integer NOT NULL,
    price_cents integer NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    sort_order integer NOT NULL DEFAULT 100,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
`;

export async function ensurePassPlansSchema(): Promise<void> {
  await requirePool().query(PASS_PLANS_DDL);
}

/** Create the table and, the first time only, copy in the shipped plans. */
export async function ensurePassPlansSeeded(): Promise<void> {
  const p = requirePool();
  await p.query(PASS_PLANS_DDL);
  for (let index = 0; index < PASS_PLANS.length; index += 1) {
    const plan = PASS_PLANS[index];
    await p.query(
      `INSERT INTO pass_plans (id, key, label, duration_seconds, price_cents, enabled, sort_order)
       VALUES ($1,$2,$3,$4,$5,true,$6)
       ON CONFLICT (id) DO NOTHING`,
      [plan.id, plan.key, plan.label, plan.durationSeconds, plan.priceCents, (index + 1) * 10],
    );
  }
}

function mapRow(r: Record<string, unknown>): PassPlanRow {
  return {
    id: Number(r.id),
    key: String(r.key) as PassPlan['key'],
    label: String(r.label),
    durationSeconds: Number(r.duration_seconds),
    priceCents: Number(r.price_cents),
    enabled: Boolean(r.enabled),
    sortOrder: Number(r.sort_order ?? 100),
    updatedAt: r.updated_at ? new Date(r.updated_at as string) : null,
  };
}

/**
 * The plan table, shortest-to-longest by sort order.
 *
 * Falls back to the compiled `PASS_PLANS` when the database is unconfigured or the table has not
 * been seeded yet, because checkout must keep working on a deployment that never opened the
 * dashboard. That fallback is the reason the compiled table is still in the repo.
 */
export async function listPassPlans(enabledOnly = false): Promise<PassPlanRow[]> {
  const p = getPool();
  let all: PassPlanRow[];
  if (!p) {
    all = fallbackRows();
  } else {
    try {
      const { rows } = await p.query('SELECT * FROM pass_plans ORDER BY sort_order, id');
      // Only a *table* with no rows at all is "not configured yet". Filtering for enabled first
      // would make "every plan taken off sale" — a legitimate thing to do — read as unconfigured
      // and put the whole shipped table back on sale.
      all = rows.length ? rows.map(mapRow) : fallbackRows();
    } catch {
      // An unmigrated database (no such table) must not close checkout.
      all = fallbackRows();
    }
  }
  return enabledOnly ? all.filter((plan) => plan.enabled) : all;
}

function fallbackRows(): PassPlanRow[] {
  return PASS_PLANS.map((plan, index) => ({
    ...plan,
    enabled: true,
    sortOrder: (index + 1) * 10,
    updatedAt: null,
  }));
}

export async function getPassPlanRow(id: number): Promise<PassPlanRow | null> {
  const plans = await listPassPlans();
  return plans.find((plan) => plan.id === id) ?? null;
}

export async function upsertPassPlan(plan: {
  id: number;
  key: string;
  label: string;
  durationSeconds: number;
  priceCents: number;
  enabled: boolean;
  sortOrder: number;
}): Promise<PassPlanRow> {
  const p = requirePool();
  await ensurePassPlansSchema();
  const { rows } = await p.query(
    `INSERT INTO pass_plans (id, key, label, duration_seconds, price_cents, enabled, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO UPDATE SET
       key = EXCLUDED.key, label = EXCLUDED.label,
       duration_seconds = EXCLUDED.duration_seconds, price_cents = EXCLUDED.price_cents,
       enabled = EXCLUDED.enabled, sort_order = EXCLUDED.sort_order, updated_at = now()
     RETURNING *`,
    [plan.id, plan.key, plan.label, plan.durationSeconds, plan.priceCents, plan.enabled, plan.sortOrder],
  );
  return mapRow(rows[0]);
}

/**
 * Remove a plan row.
 *
 * Deleting a plan that a compiled `PASS_PLANS` entry also defines only un-overrides it — the
 * fallback puts it straight back. Take a shipped plan off sale with `enabled = false` instead; the
 * admin service says so rather than letting the row quietly reappear.
 */
export async function deletePassPlan(id: number): Promise<boolean> {
  const p = requirePool();
  const { rowCount } = await p.query('DELETE FROM pass_plans WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}
