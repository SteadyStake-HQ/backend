/**
 * The Early Supporter Campaign's tables (campaign spec §8 data model, §10 anti-abuse, §15 audit).
 *
 * The backend is the source of truth for every reward total (spec §15). Nothing here trusts a
 * percentage from a client: a completion row is written only by a verifier that read an authoritative
 * record, and the boost a voucher attests is re-summed from these rows at the moment it is signed.
 *
 * WHAT MAKES THIS IDEMPOTENT. `campaign_mission_completions` is unique on
 * `(campaign_user_id, mission_code)`, which is the spec's "prevent the same mission from being
 * rewarded multiple times" expressed as a constraint rather than as application logic. Every write
 * goes through `ON CONFLICT`, so a verifier that runs twice — and they run on every profile read —
 * cannot double-award. `campaign_referrals` is unique on the *referred* user for the same reason:
 * "a wallet can have only one original referrer" is a constraint, not a check.
 *
 * Addresses are stored lower-cased everywhere, matching every other store in this folder and the
 * game's own tables, so they compare and join without a case-insensitive collation. Callers must
 * normalize before querying; the helpers here do it anyway.
 *
 * DI-free (SUPABASE_DB_URL) on the shared pool, matching the other stores so the presale indexer can
 * write without Nest.
 */
import type { Pool } from 'pg';
import { getSharedPool } from './pg-pool';

function getPool(): Pool | null {
  return getSharedPool();
}

function norm(address: string): string {
  return address.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CompletionStatus = 'verifying' | 'completed' | 'failed';

/** Spec §8 "Referral Record" statuses, in the order a referral moves through them. */
export type ReferralStatus =
  | 'pending'
  | 'registered'
  | 'purchase_pending'
  | 'qualified'
  | 'rewarded'
  | 'rejected';

export interface CampaignUserRow {
  id: string;
  walletAddress: string;
  /** The chain the wallet signed in on. Recorded so an off-chain session can be audited. */
  chainId: number;
  xHandle: string | null;
  xUserId: string | null;
  telegramUserId: string | null;
  telegramUsername: string | null;
  /** This user's own code, which they share. Unique, generated on first sign-in. */
  referralCode: string;
  /** The campaign_users.id that referred this wallet, or null. */
  referredBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MissionCompletionRow {
  id: string;
  campaignUserId: string;
  missionCode: string;
  status: CompletionStatus;
  /** What was actually awarded, snapshotted at verification. See the note on the DDL. */
  boostBpsAwarded: number;
  /** Which verifier established this — 'onchain_balance', 'dca_record', 'admin:<token-holder>'. */
  verificationSource: string | null;
  /** The specific evidence: a tx hash, a purchase id, a run count, a Telegram user id. */
  verificationReference: string | null;
  verifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReferralRow {
  id: string;
  referrerUserId: string;
  referredUserId: string;
  referrerWallet: string;
  referredWallet: string;
  status: ReferralStatus;
  ss4PurchaseReference: string | null;
  qualifiedAt: Date | null;
  rewardedAt: Date | null;
  createdAt: Date;
}

export interface VoucherRow {
  /** Per-wallet, single-use. The contract refuses a second purchase against the same pair. */
  nonce: string;
  campaignUserId: string;
  walletAddress: string;
  chainId: number;
  presaleAddress: string;
  boostBps: number;
  /** The mission codes the boost was composed of, so a disputed voucher can be explained. */
  missionCodes: string[];
  campaignEpoch: number;
  deadline: Date;
  issuedAt: Date;
  /** Set when the indexer sees the purchase that spent it. Null while outstanding. */
  consumedAt: Date | null;
  transactionHash: string | null;
}

export interface SS4PurchaseRow {
  transactionHash: string;
  logIndex: number;
  chainId: number;
  presaleAddress: string;
  buyerWallet: string;
  paymentToken: string;
  paymentAmount: string;
  ss4Amount: string;
  blockNumber: string;
  purchasedAt: Date;
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

/**
 * Shared DDL, also run from SupabaseService.ensureSchema on Nest boot.
 *
 * `boost_bps_awarded` is stored per completion rather than looked up from the catalog at read time,
 * even though the catalog is the authority on rates. It is the answer to the spec's audit question
 * "what percentage was awarded?" for a reward that has already been paid: if a rate is ever changed
 * between campaigns, the historic row must keep saying what that wallet was actually attested for.
 * Live totals are recomputed from the catalog (see campaign.service.ts), so a stale row can never
 * inflate a *current* boost — it only records history.
 */
export const CAMPAIGN_DDL = `
  CREATE TABLE IF NOT EXISTS campaign_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address text NOT NULL UNIQUE,
    chain_id integer NOT NULL,
    x_handle text,
    x_user_id text,
    telegram_user_id text,
    telegram_username text,
    referral_code text NOT NULL UNIQUE,
    referred_by uuid REFERENCES campaign_users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  -- One campaign identity per linked social account, so two wallets cannot both claim one X or
  -- Telegram account's follow. Partial, because most rows have neither linked.
  CREATE UNIQUE INDEX IF NOT EXISTS campaign_users_telegram_uq
    ON campaign_users (telegram_user_id) WHERE telegram_user_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS campaign_users_x_uq
    ON campaign_users (x_user_id) WHERE x_user_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS campaign_mission_completions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_user_id uuid NOT NULL REFERENCES campaign_users (id) ON DELETE CASCADE,
    mission_code text NOT NULL,
    status text NOT NULL DEFAULT 'verifying',
    boost_bps_awarded integer NOT NULL DEFAULT 0,
    verification_source text,
    verification_reference text,
    verified_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    -- The idempotency key. One row per wallet per mission; every write is an upsert onto it.
    UNIQUE (campaign_user_id, mission_code)
  );
  CREATE INDEX IF NOT EXISTS campaign_completions_user_idx
    ON campaign_mission_completions (campaign_user_id, status);

  CREATE TABLE IF NOT EXISTS campaign_referrals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_user_id uuid NOT NULL REFERENCES campaign_users (id) ON DELETE CASCADE,
    -- UNIQUE, not just NOT NULL: "a wallet can have only one original referrer" (spec §3.1).
    referred_user_id uuid NOT NULL UNIQUE REFERENCES campaign_users (id) ON DELETE CASCADE,
    referrer_wallet text NOT NULL,
    referred_wallet text NOT NULL,
    status text NOT NULL DEFAULT 'registered',
    ss4_purchase_reference text,
    qualified_at timestamptz,
    rewarded_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    -- Self-referral, refused by the database as well as by the service (spec §10).
    CONSTRAINT campaign_referrals_not_self CHECK (referrer_user_id <> referred_user_id)
  );
  CREATE INDEX IF NOT EXISTS campaign_referrals_referrer_idx
    ON campaign_referrals (referrer_user_id, status);

  -- Sign-in challenges. Burned on redemption so a captured signature cannot open a second session.
  CREATE TABLE IF NOT EXISTS campaign_auth_nonces (
    nonce text PRIMARY KEY,
    wallet_address text NOT NULL,
    chain_id integer NOT NULL,
    message text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS campaign_auth_nonces_expires_idx ON campaign_auth_nonces (expires_at);

  -- Every voucher this backend has ever signed. This table IS the answer to the spec's §15 audit
  -- questions: who received it, what percentage, which missions produced it, when, and whether the
  -- chain has spent it yet.
  CREATE TABLE IF NOT EXISTS campaign_vouchers (
    nonce bigint NOT NULL,
    campaign_user_id uuid NOT NULL REFERENCES campaign_users (id) ON DELETE CASCADE,
    wallet_address text NOT NULL,
    chain_id integer NOT NULL,
    presale_address text NOT NULL,
    boost_bps integer NOT NULL,
    mission_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
    campaign_epoch integer NOT NULL DEFAULT 0,
    deadline timestamptz NOT NULL,
    issued_at timestamptz NOT NULL DEFAULT now(),
    consumed_at timestamptz,
    transaction_hash text,
    -- Matches the contract's own key: voucherUsed[buyer][nonce]. A nonce is only unique per wallet,
    -- and making it globally unique here would invent a constraint the chain does not have.
    PRIMARY KEY (wallet_address, nonce)
  );
  CREATE INDEX IF NOT EXISTS campaign_vouchers_user_idx ON campaign_vouchers (campaign_user_id, issued_at DESC);

  -- Confirmed SS4 purchases, indexed from the sale's own Purchase events. Referral qualification
  -- reads this rather than trusting a client's word that its referee bought (spec §3.1).
  CREATE TABLE IF NOT EXISTS campaign_ss4_purchases (
    transaction_hash text NOT NULL,
    log_index integer NOT NULL,
    chain_id integer NOT NULL,
    presale_address text NOT NULL,
    buyer_wallet text NOT NULL,
    payment_token text NOT NULL,
    payment_amount numeric NOT NULL,
    ss4_amount numeric NOT NULL,
    block_number bigint NOT NULL,
    purchased_at timestamptz NOT NULL,
    PRIMARY KEY (transaction_hash, log_index)
  );
  CREATE INDEX IF NOT EXISTS campaign_ss4_purchases_buyer_idx
    ON campaign_ss4_purchases (buyer_wallet, purchased_at DESC);

  -- How far the presale indexer has read, per (chain, sale). Keyed on the address as well as the
  -- chain because a redeployed sale is a different contract with its own log history, and reusing
  -- one cursor across them would skip every event before the previous sale's last block.
  CREATE TABLE IF NOT EXISTS campaign_index_cursor (
    chain_id integer NOT NULL,
    presale_address text NOT NULL,
    last_block bigint NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, presale_address)
  );

  -- Append-only audit trail (spec §14 item 12). Every verification decision, every voucher, every
  -- operator override. Never updated, never deleted.
  CREATE TABLE IF NOT EXISTS campaign_audit_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address text,
    mission_code text,
    event text NOT NULL,
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS campaign_audit_wallet_idx ON campaign_audit_log (wallet_address, created_at DESC);
  CREATE INDEX IF NOT EXISTS campaign_audit_event_idx ON campaign_audit_log (event, created_at DESC);
`;

/** Idempotent DDL so the indexer / CLI can run without the Nest boot path having created the tables. */
export async function ensureCampaignSchema(): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  await p.query(CAMPAIGN_DDL);
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function toUser(r: Record<string, unknown>): CampaignUserRow {
  return {
    id: String(r.id),
    walletAddress: String(r.wallet_address).toLowerCase(),
    chainId: Number(r.chain_id),
    xHandle: r.x_handle ? String(r.x_handle) : null,
    xUserId: r.x_user_id ? String(r.x_user_id) : null,
    telegramUserId: r.telegram_user_id ? String(r.telegram_user_id) : null,
    telegramUsername: r.telegram_username ? String(r.telegram_username) : null,
    referralCode: String(r.referral_code),
    referredBy: r.referred_by ? String(r.referred_by) : null,
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}

function toCompletion(r: Record<string, unknown>): MissionCompletionRow {
  return {
    id: String(r.id),
    campaignUserId: String(r.campaign_user_id),
    missionCode: String(r.mission_code),
    status: String(r.status) as CompletionStatus,
    boostBpsAwarded: Number(r.boost_bps_awarded ?? 0),
    verificationSource: r.verification_source ? String(r.verification_source) : null,
    verificationReference: r.verification_reference ? String(r.verification_reference) : null,
    verifiedAt: r.verified_at ? new Date(r.verified_at as string) : null,
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}

function toReferral(r: Record<string, unknown>): ReferralRow {
  return {
    id: String(r.id),
    referrerUserId: String(r.referrer_user_id),
    referredUserId: String(r.referred_user_id),
    referrerWallet: String(r.referrer_wallet).toLowerCase(),
    referredWallet: String(r.referred_wallet).toLowerCase(),
    status: String(r.status) as ReferralStatus,
    ss4PurchaseReference: r.ss4_purchase_reference ? String(r.ss4_purchase_reference) : null,
    qualifiedAt: r.qualified_at ? new Date(r.qualified_at as string) : null,
    rewardedAt: r.rewarded_at ? new Date(r.rewarded_at as string) : null,
    createdAt: new Date(r.created_at as string),
  };
}

// ---------------------------------------------------------------------------
// Campaign users
// ---------------------------------------------------------------------------

/**
 * Find or create the campaign identity for a wallet.
 *
 * `referralCode` is supplied by the caller (which generates it) rather than defaulted in SQL, so the
 * code format stays one decision in one place. The insert is `ON CONFLICT DO NOTHING` followed by a
 * read rather than `DO UPDATE`, because a returning upsert on conflict would burn a fresh referral
 * code on every sign-in — Postgres evaluates the insert's values before detecting the conflict, and
 * the code column is unique, so two wallets racing on one generated code would collide.
 */
export async function upsertCampaignUser(
  wallet: string,
  chainId: number,
  referralCode: string,
): Promise<CampaignUserRow> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  const address = norm(wallet);

  await p.query(
    `INSERT INTO campaign_users (wallet_address, chain_id, referral_code)
     VALUES ($1, $2, $3)
     ON CONFLICT (wallet_address) DO UPDATE SET chain_id = $2, updated_at = now()`,
    [address, chainId, referralCode],
  );

  const { rows } = await p.query('SELECT * FROM campaign_users WHERE wallet_address = $1', [address]);
  if (!rows.length) throw new Error(`campaign_users row for ${address} vanished after upsert`);
  return toUser(rows[0]);
}

export async function getCampaignUser(wallet: string): Promise<CampaignUserRow | null> {
  const p = getPool();
  if (!p) return null;
  const { rows } = await p.query('SELECT * FROM campaign_users WHERE wallet_address = $1', [norm(wallet)]);
  return rows.length ? toUser(rows[0]) : null;
}

export async function getCampaignUserById(id: string): Promise<CampaignUserRow | null> {
  const p = getPool();
  if (!p) return null;
  const { rows } = await p.query('SELECT * FROM campaign_users WHERE id = $1', [id]);
  return rows.length ? toUser(rows[0]) : null;
}

export async function getCampaignUserByReferralCode(code: string): Promise<CampaignUserRow | null> {
  const p = getPool();
  if (!p) return null;
  // Codes are generated upper-case but compared case-insensitively: a referral link is something a
  // person retypes, and rejecting it for case would lose the referrer their reward.
  const { rows } = await p.query('SELECT * FROM campaign_users WHERE upper(referral_code) = upper($1)', [
    code.trim(),
  ]);
  return rows.length ? toUser(rows[0]) : null;
}

/**
 * Attach a Telegram account to a campaign identity.
 *
 * Returns false when that Telegram account is already linked to a different wallet, which the unique
 * index enforces — one social account cannot earn the follow boost for two wallets (spec §10).
 */
export async function linkTelegramAccount(
  campaignUserId: string,
  telegramUserId: string,
  telegramUsername: string | null,
): Promise<boolean> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  try {
    const { rowCount } = await p.query(
      `UPDATE campaign_users
          SET telegram_user_id = $2, telegram_username = $3, updated_at = now()
        WHERE id = $1`,
      [campaignUserId, telegramUserId, telegramUsername],
    );
    return (rowCount ?? 0) > 0;
  } catch (err) {
    // 23505 = unique_violation: the account belongs to another wallet.
    if ((err as { code?: string }).code === '23505') return false;
    throw err;
  }
}

/** Attach an X handle. Same one-account-one-wallet rule as Telegram. */
export async function linkXAccount(
  campaignUserId: string,
  xUserId: string,
  xHandle: string | null,
): Promise<boolean> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  try {
    const { rowCount } = await p.query(
      `UPDATE campaign_users SET x_user_id = $2, x_handle = $3, updated_at = now() WHERE id = $1`,
      [campaignUserId, xUserId, xHandle],
    );
    return (rowCount ?? 0) > 0;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return false;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Mission completions
// ---------------------------------------------------------------------------

export async function listCompletions(campaignUserId: string): Promise<MissionCompletionRow[]> {
  const p = getPool();
  if (!p) return [];
  const { rows } = await p.query(
    'SELECT * FROM campaign_mission_completions WHERE campaign_user_id = $1 ORDER BY created_at',
    [campaignUserId],
  );
  return rows.map(toCompletion);
}

export interface RecordCompletionInput {
  campaignUserId: string;
  missionCode: string;
  status: CompletionStatus;
  boostBpsAwarded: number;
  verificationSource: string;
  verificationReference: string | null;
}

/**
 * Record a mission's outcome, idempotently.
 *
 * The one-way rule is in the WHERE of the DO UPDATE: a row that is already `completed` is never
 * rewritten. That is what makes a mission "verified once, earned forever" — the spec's own model for
 * the balance checks ("when the requirement is first verified, the user becomes eligible"), and the
 * reason a wallet that spends its BOT after qualifying does not lose the boost it earned.
 *
 * It also means a verifier flapping between pass and fail cannot revoke a paid reward, which matters
 * because an RPC timeout is indistinguishable from a drained wallet at the call site.
 *
 * Returns true when this call is the one that newly completed the mission, so the caller writes
 * exactly one audit row.
 */
export async function recordCompletion(input: RecordCompletionInput): Promise<boolean> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  const verifiedAt = input.status === 'completed' ? new Date() : null;

  const { rows } = await p.query(
    `INSERT INTO campaign_mission_completions
       (campaign_user_id, mission_code, status, boost_bps_awarded,
        verification_source, verification_reference, verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (campaign_user_id, mission_code) DO UPDATE SET
       status = EXCLUDED.status,
       boost_bps_awarded = EXCLUDED.boost_bps_awarded,
       verification_source = EXCLUDED.verification_source,
       verification_reference = EXCLUDED.verification_reference,
       verified_at = COALESCE(campaign_mission_completions.verified_at, EXCLUDED.verified_at),
       updated_at = now()
     WHERE campaign_mission_completions.status <> 'completed'
     RETURNING status`,
    [
      input.campaignUserId,
      input.missionCode,
      input.status,
      input.boostBpsAwarded,
      input.verificationSource,
      input.verificationReference,
      verifiedAt,
    ],
  );

  return rows.length > 0 && String(rows[0].status) === 'completed';
}

/**
 * Withdraw a completion an operator judges was awarded in error.
 *
 * Deliberately the only way a `completed` row can move, and deliberately not reachable from any
 * automatic verifier — see `recordCompletion`. A revoked mission stops contributing to the boost on
 * the *next* voucher; vouchers already signed keep their rate until they expire, because the chain
 * has already been handed a signature and no backend write can recall it. Bump the campaign epoch to
 * invalidate outstanding vouchers if that matters.
 */
export async function revokeCompletion(
  campaignUserId: string,
  missionCode: string,
  source: string,
): Promise<boolean> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  const { rowCount } = await p.query(
    `UPDATE campaign_mission_completions
        SET status = 'failed', boost_bps_awarded = 0, verification_source = $3, updated_at = now()
      WHERE campaign_user_id = $1 AND mission_code = $2`,
    [campaignUserId, missionCode, source],
  );
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Referrals
// ---------------------------------------------------------------------------

/**
 * Record that `referredUserId` arrived through `referrerUserId`'s link.
 *
 * Refuses self-referral, a second referrer for an already-referred wallet, and a cycle. The cycle
 * check walks up the referrer chain rather than only comparing the two ids, because A→B plus B→A is
 * the two-step case the spec calls out ("prevent circular referral relationships") and a pairwise
 * check would miss A→B→C→A entirely.
 *
 * Returns the reason it was refused, or null on success.
 */
export async function recordReferral(
  referrerUserId: string,
  referredUserId: string,
  referrerWallet: string,
  referredWallet: string,
): Promise<string | null> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  if (referrerUserId === referredUserId) return 'A wallet cannot refer itself.';

  // Would this edge close a loop? True when the referrer is already downstream of the referee.
  const { rows: cycle } = await p.query(
    `WITH RECURSIVE upstream AS (
        SELECT id, referred_by FROM campaign_users WHERE id = $1
        UNION ALL
        SELECT u.id, u.referred_by
          FROM campaign_users u
          JOIN upstream ON u.id = upstream.referred_by
     )
     SELECT 1 FROM upstream WHERE id = $2 LIMIT 1`,
    [referrerUserId, referredUserId],
  );
  if (cycle.length) return 'That referral would create a circular referral relationship.';

  const client = await p.connect();
  try {
    await client.query('BEGIN');
    // The referral edge and the denormalized pointer on the user row move together: the pointer is
    // what the recursive cycle check above walks, so a referral row without it would let the next
    // referral close a loop this one just created.
    const { rowCount } = await client.query(
      `INSERT INTO campaign_referrals
         (referrer_user_id, referred_user_id, referrer_wallet, referred_wallet, status)
       VALUES ($1, $2, $3, $4, 'registered')
       ON CONFLICT (referred_user_id) DO NOTHING`,
      [referrerUserId, referredUserId, norm(referrerWallet), norm(referredWallet)],
    );
    if (!rowCount) {
      await client.query('ROLLBACK');
      return 'That wallet already has a referrer.';
    }
    await client.query('UPDATE campaign_users SET referred_by = $2, updated_at = now() WHERE id = $1', [
      referredUserId,
      referrerUserId,
    ]);
    await client.query('COMMIT');
    return null;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if ((err as { code?: string }).code === '23505') return 'That wallet already has a referrer.';
    throw err;
  } finally {
    client.release();
  }
}

export async function getReferralOfReferee(referredUserId: string): Promise<ReferralRow | null> {
  const p = getPool();
  if (!p) return null;
  const { rows } = await p.query('SELECT * FROM campaign_referrals WHERE referred_user_id = $1', [
    referredUserId,
  ]);
  return rows.length ? toReferral(rows[0]) : null;
}

export async function listReferralsByReferrer(referrerUserId: string): Promise<ReferralRow[]> {
  const p = getPool();
  if (!p) return [];
  const { rows } = await p.query(
    'SELECT * FROM campaign_referrals WHERE referrer_user_id = $1 ORDER BY created_at DESC',
    [referrerUserId],
  );
  return rows.map(toReferral);
}

/**
 * Move a referral to `qualified` because its referee's SS4 purchase confirmed.
 *
 * Only advances a referral that has not qualified yet, and returns whether this call was the one that
 * advanced it — so the referrer's mission is credited exactly once however many times the indexer
 * re-reads the same purchase (spec §10: "the same referred user cannot generate the same referral
 * reward multiple times").
 */
export async function qualifyReferral(referredWallet: string, purchaseReference: string): Promise<boolean> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  const { rowCount } = await p.query(
    `UPDATE campaign_referrals
        SET status = 'qualified', ss4_purchase_reference = $2, qualified_at = now()
      WHERE referred_wallet = $1 AND status NOT IN ('qualified', 'rewarded', 'rejected')`,
    [norm(referredWallet), purchaseReference],
  );
  return (rowCount ?? 0) > 0;
}

/** Mark a qualified referral as having paid its referrer, for the operator's view. */
export async function markReferralRewarded(referralId: string): Promise<void> {
  const p = getPool();
  if (!p) return;
  await p.query(
    `UPDATE campaign_referrals SET status = 'rewarded', rewarded_at = now()
      WHERE id = $1 AND status = 'qualified'`,
    [referralId],
  );
}

/**
 * This referrer's qualified referrals: how many, and the purchase that proved the first one.
 *
 * Both together rather than a bare count, because the count alone cannot answer the campaign spec's
 * §15 audit question "what source proved completion?". The mission's completion row stores
 * `firstPurchaseReference` as its evidence, so a disputed referral reward can be traced to the exact
 * `Purchase` log that qualified it without joining back through the referral table.
 *
 * The *first* qualifying purchase is the reference, not the latest: the mission is earned once, at the
 * moment it first qualified, and a later referee buying must not rewrite the evidence for a reward
 * that was already attested.
 */
export async function readQualifiedReferrals(
  referrerUserId: string,
): Promise<{ count: number; firstPurchaseReference: string | null }> {
  const p = getPool();
  if (!p) return { count: 0, firstPurchaseReference: null };
  const { rows } = await p.query(
    `SELECT count(*)::int AS n,
            (ARRAY_REMOVE(ARRAY_AGG(ss4_purchase_reference ORDER BY qualified_at), NULL))[1] AS first_reference
       FROM campaign_referrals
      WHERE referrer_user_id = $1 AND status IN ('qualified', 'rewarded')`,
    [referrerUserId],
  );
  return {
    count: Number(rows[0]?.n ?? 0),
    firstPurchaseReference: rows[0]?.first_reference ? String(rows[0].first_reference) : null,
  };
}

// ---------------------------------------------------------------------------
// Vouchers
// ---------------------------------------------------------------------------

/**
 * Allocate the next nonce for a wallet and record the voucher about to be signed.
 *
 * The nonce is `max(existing) + 1` inside one statement rather than a counter column, so two
 * concurrent issue requests cannot be handed the same value: the primary key on
 * `(wallet_address, nonce)` makes the loser's insert fail rather than silently overwrite, and the
 * caller retries. Starting at 1 leaves 0 permanently unused, which is deliberate — a zero nonce is
 * indistinguishable from an unset field in a client that forgot to send one.
 */
export async function issueVoucherRecord(input: {
  campaignUserId: string;
  walletAddress: string;
  chainId: number;
  presaleAddress: string;
  boostBps: number;
  missionCodes: string[];
  campaignEpoch: number;
  deadline: Date;
}): Promise<bigint> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  const wallet = norm(input.walletAddress);

  const { rows } = await p.query(
    `INSERT INTO campaign_vouchers
       (wallet_address, nonce, campaign_user_id, chain_id, presale_address,
        boost_bps, mission_codes, campaign_epoch, deadline)
     SELECT $1,
            COALESCE((SELECT max(nonce) FROM campaign_vouchers WHERE wallet_address = $1), 0) + 1,
            $2, $3, $4, $5, $6::jsonb, $7, $8
     RETURNING nonce`,
    [
      wallet,
      input.campaignUserId,
      input.chainId,
      norm(input.presaleAddress),
      input.boostBps,
      JSON.stringify(input.missionCodes),
      input.campaignEpoch,
      input.deadline,
    ],
  );
  return BigInt(String(rows[0].nonce));
}

export async function listVouchers(campaignUserId: string, limit = 20): Promise<VoucherRow[]> {
  const p = getPool();
  if (!p) return [];
  const { rows } = await p.query(
    `SELECT * FROM campaign_vouchers WHERE campaign_user_id = $1 ORDER BY issued_at DESC LIMIT $2`,
    [campaignUserId, Math.min(Math.max(1, limit), 100)],
  );
  return rows.map((r) => ({
    nonce: String(r.nonce),
    campaignUserId: String(r.campaign_user_id),
    walletAddress: String(r.wallet_address).toLowerCase(),
    chainId: Number(r.chain_id),
    presaleAddress: String(r.presale_address).toLowerCase(),
    boostBps: Number(r.boost_bps),
    missionCodes: Array.isArray(r.mission_codes) ? (r.mission_codes as string[]) : [],
    campaignEpoch: Number(r.campaign_epoch),
    deadline: new Date(r.deadline as string),
    issuedAt: new Date(r.issued_at as string),
    consumedAt: r.consumed_at ? new Date(r.consumed_at as string) : null,
    transactionHash: r.transaction_hash ? String(r.transaction_hash).toLowerCase() : null,
  }));
}

/** Mark a voucher spent, from the `CampaignBoostAccrued` event that spent it. */
export async function markVoucherConsumed(
  wallet: string,
  nonce: bigint,
  txHash: string,
  at: Date,
): Promise<void> {
  const p = getPool();
  if (!p) return;
  await p.query(
    `UPDATE campaign_vouchers SET consumed_at = $4, transaction_hash = $3
      WHERE wallet_address = $1 AND nonce = $2 AND consumed_at IS NULL`,
    [norm(wallet), nonce.toString(), txHash.toLowerCase(), at],
  );
}

// ---------------------------------------------------------------------------
// Indexed SS4 purchases
// ---------------------------------------------------------------------------

/** Record a `Purchase` event. Idempotent on `(tx, logIndex)`, so a re-read costs nothing. */
export async function recordSS4Purchase(row: SS4PurchaseRow): Promise<boolean> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  const { rowCount } = await p.query(
    `INSERT INTO campaign_ss4_purchases
       (transaction_hash, log_index, chain_id, presale_address, buyer_wallet,
        payment_token, payment_amount, ss4_amount, block_number, purchased_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (transaction_hash, log_index) DO NOTHING`,
    [
      row.transactionHash.toLowerCase(),
      row.logIndex,
      row.chainId,
      norm(row.presaleAddress),
      norm(row.buyerWallet),
      norm(row.paymentToken),
      row.paymentAmount,
      row.ss4Amount,
      row.blockNumber,
      row.purchasedAt,
    ],
  );
  return (rowCount ?? 0) > 0;
}

/** Whether this wallet has any confirmed SS4 purchase on the campaign's sale. */
export async function hasConfirmedSS4Purchase(
  wallet: string,
  chainId: number,
  presaleAddress: string,
): Promise<{ bought: boolean; reference: string | null }> {
  const p = getPool();
  if (!p) return { bought: false, reference: null };
  const { rows } = await p.query(
    `SELECT transaction_hash, log_index FROM campaign_ss4_purchases
      WHERE buyer_wallet = $1 AND chain_id = $2 AND presale_address = $3
      ORDER BY purchased_at LIMIT 1`,
    [norm(wallet), chainId, norm(presaleAddress)],
  );
  if (!rows.length) return { bought: false, reference: null };
  return { bought: true, reference: `${String(rows[0].transaction_hash)}:${Number(rows[0].log_index)}` };
}

export async function getIndexCursor(chainId: number, presaleAddress: string): Promise<bigint | null> {
  const p = getPool();
  if (!p) return null;
  const { rows } = await p.query(
    'SELECT last_block FROM campaign_index_cursor WHERE chain_id = $1 AND presale_address = $2',
    [chainId, norm(presaleAddress)],
  );
  return rows.length ? BigInt(String(rows[0].last_block)) : null;
}

export async function setIndexCursor(
  chainId: number,
  presaleAddress: string,
  lastBlock: bigint,
): Promise<void> {
  const p = getPool();
  if (!p) return;
  await p.query(
    `INSERT INTO campaign_index_cursor (chain_id, presale_address, last_block)
     VALUES ($1, $2, $3)
     ON CONFLICT (chain_id, presale_address) DO UPDATE
       SET last_block = GREATEST(campaign_index_cursor.last_block, EXCLUDED.last_block),
           updated_at = now()`,
    [chainId, norm(presaleAddress), lastBlock.toString()],
  );
}

// ---------------------------------------------------------------------------
// Sign-in nonces
// ---------------------------------------------------------------------------

export async function createAuthNonce(input: {
  nonce: string;
  wallet: string;
  chainId: number;
  message: string;
  expiresAt: Date;
}): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  await p.query(
    `INSERT INTO campaign_auth_nonces (nonce, wallet_address, chain_id, message, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.nonce, norm(input.wallet), input.chainId, input.message, input.expiresAt],
  );
}

/**
 * Redeem a challenge, deleting it in the same statement.
 *
 * Delete-on-read is what makes a captured signature useless: the row is gone before the signature is
 * even checked, so a replay finds no challenge to verify against.
 */
export async function consumeAuthNonce(
  nonce: string,
  wallet: string,
): Promise<{ message: string; chainId: number } | null> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  const { rows } = await p.query(
    `DELETE FROM campaign_auth_nonces
      WHERE nonce = $1 AND wallet_address = $2 AND expires_at > now()
      RETURNING message, chain_id`,
    [nonce, norm(wallet)],
  );
  if (!rows.length) return null;
  return { message: String(rows[0].message), chainId: Number(rows[0].chain_id) };
}

/** Opportunistic sweep of challenges nobody signed, matching the nonce-sweep style elsewhere. */
export async function expireStaleAuthNonces(): Promise<void> {
  const p = getPool();
  if (!p) return;
  await p.query('DELETE FROM campaign_auth_nonces WHERE expires_at < now()');
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export async function writeAudit(input: {
  wallet: string | null;
  missionCode: string | null;
  event: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const p = getPool();
  if (!p) return;
  // Audit writes must never be the reason a verification fails: the reward is the thing that matters
  // to the user, and a lost log line is recoverable from the completion row it accompanies.
  try {
    await p.query(
      `INSERT INTO campaign_audit_log (wallet_address, mission_code, event, detail)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        input.wallet ? norm(input.wallet) : null,
        input.missionCode,
        input.event,
        JSON.stringify(input.detail ?? {}),
      ],
    );
  } catch {
    // Swallowed on purpose — see above.
  }
}

export interface AuditEntry {
  id: string;
  walletAddress: string | null;
  missionCode: string | null;
  event: string;
  detail: Record<string, unknown>;
  createdAt: Date;
}

export async function listAudit(options: {
  wallet?: string;
  event?: string;
  limit?: number;
}): Promise<AuditEntry[]> {
  const p = getPool();
  if (!p) return [];
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.wallet) {
    params.push(norm(options.wallet));
    clauses.push(`wallet_address = $${params.length}`);
  }
  if (options.event) {
    params.push(options.event);
    clauses.push(`event = $${params.length}`);
  }
  params.push(Math.min(Math.max(1, options.limit ?? 100), 500));

  const { rows } = await p.query(
    `SELECT * FROM campaign_audit_log
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    id: String(r.id),
    walletAddress: r.wallet_address ? String(r.wallet_address).toLowerCase() : null,
    missionCode: r.mission_code ? String(r.mission_code) : null,
    event: String(r.event),
    detail: (r.detail ?? {}) as Record<string, unknown>,
    createdAt: new Date(r.created_at as string),
  }));
}

// ---------------------------------------------------------------------------
// Operator aggregates
// ---------------------------------------------------------------------------

export interface CampaignTotals {
  participants: number;
  /** Wallets with at least one completed mission. */
  earning: number;
  completionsByMission: Array<{ missionCode: string; completed: number }>;
  referrals: { registered: number; qualified: number; rewarded: number; rejected: number };
  vouchers: { issued: number; consumed: number; boostBpsIssued: number };
}

export async function getCampaignTotals(): Promise<CampaignTotals> {
  const p = getPool();
  if (!p) {
    return {
      participants: 0,
      earning: 0,
      completionsByMission: [],
      referrals: { registered: 0, qualified: 0, rewarded: 0, rejected: 0 },
      vouchers: { issued: 0, consumed: 0, boostBpsIssued: 0 },
    };
  }

  const [users, earning, byMission, referrals, vouchers] = await Promise.all([
    p.query('SELECT count(*)::int AS n FROM campaign_users'),
    p.query(
      `SELECT count(DISTINCT campaign_user_id)::int AS n
         FROM campaign_mission_completions WHERE status = 'completed'`,
    ),
    p.query(
      `SELECT mission_code, count(*)::int AS n
         FROM campaign_mission_completions WHERE status = 'completed'
        GROUP BY mission_code ORDER BY n DESC`,
    ),
    p.query(`SELECT status, count(*)::int AS n FROM campaign_referrals GROUP BY status`),
    p.query(
      `SELECT count(*)::int AS issued,
              count(consumed_at)::int AS consumed,
              COALESCE(sum(boost_bps) FILTER (WHERE consumed_at IS NOT NULL), 0)::int AS boost_bps
         FROM campaign_vouchers`,
    ),
  ]);

  const referralCounts = { registered: 0, qualified: 0, rewarded: 0, rejected: 0 };
  for (const row of referrals.rows) {
    const key = String(row.status);
    if (key in referralCounts) referralCounts[key as keyof typeof referralCounts] = Number(row.n);
  }

  return {
    participants: Number(users.rows[0]?.n ?? 0),
    earning: Number(earning.rows[0]?.n ?? 0),
    completionsByMission: byMission.rows.map((r) => ({
      missionCode: String(r.mission_code),
      completed: Number(r.n),
    })),
    referrals: referralCounts,
    vouchers: {
      issued: Number(vouchers.rows[0]?.issued ?? 0),
      consumed: Number(vouchers.rows[0]?.consumed ?? 0),
      boostBpsIssued: Number(vouchers.rows[0]?.boost_bps ?? 0),
    },
  };
}

/** Participants for the operator's list, newest first, with their completion count. */
export async function listParticipants(options: {
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<{ participants: Array<CampaignUserRow & { completed: number; boostBps: number }>; total: number }> {
  const p = getPool();
  if (!p) return { participants: [], total: 0 };

  const limit = Math.min(Math.max(1, options.limit ?? 50), 200);
  const offset = Math.max(0, options.offset ?? 0);
  const search = options.search?.trim().toLowerCase();

  const where = search ? 'WHERE u.wallet_address LIKE $3' : '';
  const params: unknown[] = [limit, offset];
  if (search) params.push(`%${search}%`);

  const [rows, total] = await Promise.all([
    p.query(
      `SELECT u.*,
              COALESCE(c.completed, 0)::int AS completed,
              COALESCE(c.boost_bps, 0)::int AS boost_bps
         FROM campaign_users u
         LEFT JOIN (
           SELECT campaign_user_id,
                  count(*)::int AS completed,
                  sum(boost_bps_awarded)::int AS boost_bps
             FROM campaign_mission_completions
            WHERE status = 'completed'
            GROUP BY campaign_user_id
         ) c ON c.campaign_user_id = u.id
         ${where}
        ORDER BY u.created_at DESC
        LIMIT $1 OFFSET $2`,
      params,
    ),
    search
      ? p.query('SELECT count(*)::int AS n FROM campaign_users u WHERE u.wallet_address LIKE $1', [
          `%${search}%`,
        ])
      : p.query('SELECT count(*)::int AS n FROM campaign_users'),
  ]);

  return {
    participants: rows.rows.map((r) => ({
      ...toUser(r),
      completed: Number(r.completed ?? 0),
      boostBps: Number(r.boost_bps ?? 0),
    })),
    total: Number(total.rows[0]?.n ?? 0),
  };
}
