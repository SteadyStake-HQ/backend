/**
 * The "Game Activity" missions: the 1/3/10 session milestones and the Game Pass purchase
 * (campaign spec §5.1–§5.2).
 *
 * Both read Echo Arena's own tables in the shared Supabase database, the same way the operator's
 * Players page does. Read-only: the game owns `echo_runs` and the payments indexer owns
 * `purchase_intents`, and a second writer to either would be able to violate the invariants they
 * enforce.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT COUNTS AS A VALID SESSION, AND WHY THE TICKET IS THE TEST.
 *
 * §5.1 excludes opening the page, clicking Play without finishing, abandoned sessions, invalid
 * sessions, and duplicate submissions of the same session id. Every one of those exclusions is
 * already structurally enforced by the game's run-ticket flow, so this verifier does not re-derive
 * them — it counts the rows that survived it:
 *
 *   - A run row exists only if `submitRun` filed it, which requires a ticket the server issued.
 *   - The ticket is burned atomically in the same statement that claims it (`usedAt` set where
 *     `usedAt IS NULL`), so one ticket produces at most one run — duplicate submission is impossible,
 *     not merely rejected.
 *   - A ticket expires 15 minutes after issue, so an abandoned session leaves no row at all.
 *   - The run is checked against `describeImplausibleRun` before insertion, so an invalid score is
 *     refused at the door.
 *
 * The filter is therefore `ticket_id IS NOT NULL`. That deliberately excludes two kinds of row: those
 * filed before the ticket column existed, and those from the legacy un-ticketed `POST /api/runs` path.
 * Both are real gameplay, and both are exactly the rows whose validity nothing can now establish — so
 * they do not earn a presale boost. A wallet with only legacy runs sees 0 sessions and can earn the
 * mission by playing once more, which is a far better failure than paying a boost against rows that
 * predate the anti-farming guarantees.
 *
 * Every mode counts (`ranked`, `open_verified`, `normal`). The mission is "complete a valid game
 * session", not "spend a season budget", and normal mode is the only mode playable between seasons.
 */
import type { Pool } from 'pg';
import { getSharedPool } from '../../supabase/pg-pool';
import { PASS_PLANS } from '../../payments/pass-plans';
import { met, notMet, unavailable, type VerifierResult } from './verifier-types';

const SOURCE_SESSIONS = 'echo_arena:ticketed_runs';
const SOURCE_PASS = 'echo_arena:pass_purchase';

export interface GameActivity {
  /** Runs filed against a server-issued ticket. See the module note on why that is the test. */
  validSessions: number;
  /** Rows with no ticket — legacy or pre-column. Reported so the dashboard can explain a low count. */
  unticketedSessions: number;
  lastPlayedAt: Date | null;
}

export async function readGameActivity(wallet: string): Promise<GameActivity | null> {
  const pool: Pool | null = getSharedPool();
  if (!pool) return null;

  try {
    const { rows } = await pool.query(
      `SELECT count(*) FILTER (WHERE ticket_id IS NOT NULL)::int AS valid_sessions,
              count(*) FILTER (WHERE ticket_id IS NULL)::int AS unticketed_sessions,
              max(created_at) AS last_played_at
         FROM echo_runs
        WHERE address = $1`,
      [wallet.trim().toLowerCase()],
    );
    const row = rows[0] ?? {};
    return {
      validSessions: Number(row.valid_sessions ?? 0),
      unticketedSessions: Number(row.unticketed_sessions ?? 0),
      lastPlayedAt: row.last_played_at ? new Date(row.last_played_at as string) : null,
    };
  } catch {
    // Includes the case where `echo_runs` does not exist — a backend deployment whose database has
    // never had the game's migrations run. Unverifiable, not zero.
    return null;
  }
}

/** The 1/3/10 session milestones, all scored from one count of valid sessions. */
export function verifyGameSessions(activity: GameActivity | null, requiredSessions: string): VerifierResult {
  if (!activity) {
    return unavailable(SOURCE_SESSIONS, 'Could not read your Echo Arena sessions right now. Try again in a moment.');
  }

  const target = Number(requiredSessions) || 1;
  const detail = {
    validSessions: activity.validSessions,
    unticketedSessions: activity.unticketedSessions,
    target,
    lastPlayedAt: activity.lastPlayedAt?.toISOString() ?? null,
  };

  if (activity.validSessions >= target) {
    return met(SOURCE_SESSIONS, `sessions:${activity.validSessions}`, detail);
  }
  return notMet(SOURCE_SESSIONS, { current: activity.validSessions, target }, detail);
}

export interface PassPurchase {
  purchaseId: string;
  planId: number;
  chainId: number;
  amountAtomic: string;
  transactionHash: string | null;
  confirmedAt: Date;
}

/**
 * The wallet's earliest *eligible* confirmed Game Pass purchase, or null if it has none.
 *
 * ELIGIBILITY IS NOT THE SAME AS CONFIRMED, and this is the load-bearing part of the whole game
 * section. The pass mission is worth +1.00% — the largest single reward in the campaign, more than the
 * entire community section — so what counts as "an eligible Game Pass" has to be exactly the real
 * product, not anything that ever wrote a confirmed row.
 *
 * Two filters therefore apply on top of `status = 'confirmed'`:
 *
 *   1. `plan_id` must be in `PASS_PLANS`. That table holds the three shipping tiers (Day $0.99,
 *      Week $3.99, Month $9.99). It notably does *not* hold plan id 4, a retired $0.01 one-hour test
 *      tier which bought the full pass entitlement and was withdrawn for precisely this class of
 *      reason. A confirmed plan-4 row must never buy a 1% presale boost for a cent, and because ids
 *      are matched against the live table rather than excluded by number, any future retirement is
 *      covered automatically.
 *
 *   2. `expected_amount_atomic` must be non-zero. A zero-amount intent is either a misconfiguration
 *      or a free grant, and neither is a purchase.
 *
 * The *earliest* eligible purchase is returned rather than the latest, so the mission's evidence is
 * stable: a renewal must not rewrite the reference of a boost that was already attested.
 */
export async function readPassPurchase(wallet: string): Promise<PassPurchase | null | undefined> {
  const pool: Pool | null = getSharedPool();
  if (!pool) return undefined;

  const eligiblePlanIds = PASS_PLANS.map((p) => p.id);

  try {
    const { rows } = await pool.query(
      `SELECT purchase_id, pass_plan_id, chain_id, expected_amount_atomic, transaction_hash, confirmed_at
         FROM purchase_intents
        WHERE wallet_address = $1
          AND status = 'confirmed'
          AND pass_plan_id = ANY($2::int[])
          AND expected_amount_atomic > 0
        ORDER BY confirmed_at
        LIMIT 1`,
      [wallet.trim().toLowerCase(), eligiblePlanIds],
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      purchaseId: String(r.purchase_id),
      planId: Number(r.pass_plan_id),
      chainId: Number(r.chain_id),
      amountAtomic: String(r.expected_amount_atomic),
      transactionHash: r.transaction_hash ? String(r.transaction_hash).toLowerCase() : null,
      // A confirmed intent always has this set — `markPurchaseConfirmed` writes both together.
      confirmedAt: new Date(r.confirmed_at as string),
    };
  } catch {
    return undefined;
  }
}

/**
 * `game_purchase_pass` — +1.00% for a confirmed, eligible Game Pass purchase.
 *
 * `undefined` means the database could not be read; `null` means it was read and there is no such
 * purchase. The three-way distinction is why this takes the raw result rather than a boolean.
 *
 * The spec's remaining conditions are satisfied upstream rather than here: the purchase is linked to
 * the wallet because `purchase_intents.wallet_address` is the wallet the intent was created for and
 * the indexer only confirms an intent against a `PassPaid` carrying its own `purchase_id`; the same
 * purchase cannot be used twice because the completion row is unique per (wallet, mission); and a
 * refunded or reverted purchase never reaches `confirmed` in the first place.
 */
export function verifyPassPurchase(purchase: PassPurchase | null | undefined): VerifierResult {
  if (purchase === undefined) {
    return unavailable(SOURCE_PASS, 'Could not check your Game Pass purchase right now. Try again in a moment.');
  }
  if (purchase === null) {
    return notMet(SOURCE_PASS, { current: 0, target: 1 }, { eligiblePlans: PASS_PLANS.map((p) => p.key) });
  }

  const plan = PASS_PLANS.find((p) => p.id === purchase.planId);
  return met(SOURCE_PASS, purchase.purchaseId, {
    planId: purchase.planId,
    planKey: plan?.key ?? null,
    planLabel: plan?.label ?? null,
    chainId: purchase.chainId,
    transactionHash: purchase.transactionHash,
    confirmedAt: purchase.confirmedAt.toISOString(),
  });
}
