/**
 * Auto Execution Plan capacity: membership tier, NFT bonus draw, and the reservation ledger that
 * makes the global bonus race-safe (blueprint §15, §16, §20).
 *
 * The NFT card grants +1/+2/+3 slots ONCE across all networks (§15.2). To hand those out safely to
 * a wallet creating plans on several chains at once, every bonus plan first takes a short-lived
 * reservation here, under a serializable transaction, before a permit is signed (§16.3).
 *
 * DI-free (SUPABASE_DB_URL) like the other stores.
 */
import { Pool, type PoolClient } from 'pg';
import { getSharedPool } from './pg-pool';

export type MembershipTier = 'starter' | 'plus' | 'pro' | 'institutional';

/** §15.1 base active Auto Execution slots per supported network. Institutional is unlimited. */
export const BASE_SLOTS_PER_NETWORK: Record<MembershipTier, number | null> = {
  starter: 1,
  plus: 5,
  pro: 25,
  institutional: null,
};

function getPool(): Pool | null {
  return getSharedPool();
}

export const CAPACITY_DDL = `
  CREATE TABLE IF NOT EXISTS account_memberships (
    wallet_address text PRIMARY KEY,
    tier text NOT NULL DEFAULT 'starter',
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS auto_plan_capacity_reservations (
    reservation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address text NOT NULL,
    target_chain_id integer NOT NULL,
    plan_intent_id text NOT NULL,
    reserved_slot_number integer NOT NULL,
    permit_nonce text NOT NULL,
    permit_deadline timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'reserved',
    transaction_hash text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS capacity_reservations_nonce_uq
    ON auto_plan_capacity_reservations (target_chain_id, permit_nonce);
  CREATE INDEX IF NOT EXISTS capacity_reservations_wallet_idx
    ON auto_plan_capacity_reservations (wallet_address, status);
`;

export async function ensureCapacitySchema(): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  await p.query(CAPACITY_DDL);
}

export async function getMembership(wallet: string): Promise<MembershipTier> {
  const p = getPool();
  if (!p) return 'starter';
  const { rows } = await p.query('SELECT tier FROM account_memberships WHERE wallet_address = $1', [
    wallet.toLowerCase(),
  ]);
  const tier = rows[0]?.tier as MembershipTier | undefined;
  return tier && tier in BASE_SLOTS_PER_NETWORK ? tier : 'starter';
}

export async function setMembership(wallet: string, tier: MembershipTier): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  await p.query(
    `INSERT INTO account_memberships (wallet_address, tier, updated_at) VALUES ($1,$2, now())
     ON CONFLICT (wallet_address) DO UPDATE SET tier = EXCLUDED.tier, updated_at = now()`,
    [wallet.toLowerCase(), tier],
  );
}

/** Active DCA plans per chain for a wallet — the slot-consuming plans (§15.4). */
export async function getActivePlanCountsByChain(wallet: string): Promise<Record<number, number>> {
  const p = getPool();
  if (!p) return {};
  const { rows } = await p.query(
    `SELECT chain_id, count(*)::int AS n FROM dca_plans
      WHERE user_addr = $1 AND status = 'active' GROUP BY chain_id`,
    [wallet.toLowerCase()],
  );
  const out: Record<number, number> = {};
  for (const r of rows) out[Number(r.chain_id)] = Number(r.n);
  return out;
}

/** Highest valid card bonus a wallet holds, capped at +3 (§15.8). Cards are soulbound, so a minted
 * award in nft_awards is permanent ownership. */
export async function getHighestCardBonus(wallet: string): Promise<number> {
  const p = getPool();
  if (!p) return 0;
  const { rows } = await p.query(
    `SELECT coalesce(max(bonus_slots), 0)::int AS b FROM nft_awards
      WHERE wallet_address = $1 AND status = 'minted'`,
    [wallet.toLowerCase()],
  );
  return Math.min(3, Number(rows[0]?.b ?? 0));
}

export interface ReservationRow {
  reservationId: string;
  walletAddress: string;
  targetChainId: number;
  planIntentId: string;
  reservedSlotNumber: number;
  permitNonce: string;
  permitDeadline: Date;
  status: string;
  transactionHash: string | null;
}

/** Count of a wallet's reservations that still hold a slot (reserved and unexpired). */
export async function countPendingReservations(client: Pool | PoolClient, wallet: string): Promise<number> {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM auto_plan_capacity_reservations
      WHERE wallet_address = $1 AND status = 'reserved' AND permit_deadline > now()`,
    [wallet.toLowerCase()],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Reserve one bonus slot atomically (§16.3). Runs a serializable transaction: it re-counts confirmed
 * active plans' excess and pending reservations inside the lock, and only inserts a reservation when
 * a slot is genuinely free. `computeUsedSlots` is passed in so the capacity math lives in one place.
 *
 * Returns the created reservation, or null when no slot is available.
 */
export async function reserveSlot(input: {
  wallet: string;
  targetChainId: number;
  planIntentId: string;
  nftBonus: number;
  permitNonce: string;
  permitDeadline: Date;
  usedSlots: number; // excess across networks, computed by the caller from confirmed plans
}): Promise<ReservationRow | null> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  const client = await p.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const pending = await countPendingReservations(client, input.wallet);
    const available = input.nftBonus - input.usedSlots - pending;
    if (available <= 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const reservedSlotNumber = input.usedSlots + pending + 1;
    const { rows } = await client.query(
      `INSERT INTO auto_plan_capacity_reservations
         (wallet_address, target_chain_id, plan_intent_id, reserved_slot_number, permit_nonce, permit_deadline)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        input.wallet.toLowerCase(),
        input.targetChainId,
        input.planIntentId,
        reservedSlotNumber,
        input.permitNonce,
        input.permitDeadline,
      ],
    );
    await client.query('COMMIT');
    const r = rows[0];
    return {
      reservationId: String(r.reservation_id),
      walletAddress: String(r.wallet_address),
      targetChainId: Number(r.target_chain_id),
      planIntentId: String(r.plan_intent_id),
      reservedSlotNumber: Number(r.reserved_slot_number),
      permitNonce: String(r.permit_nonce),
      permitDeadline: new Date(r.permit_deadline),
      status: String(r.status),
      transactionHash: r.transaction_hash ? String(r.transaction_hash) : null,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** A wallet's recent capacity reservations, newest first — for the capacity inspector (§17.5). */
export async function listReservations(wallet: string, limit = 20): Promise<ReservationRow[]> {
  const p = getPool();
  if (!p) return [];
  const { rows } = await p.query(
    `SELECT * FROM auto_plan_capacity_reservations
      WHERE wallet_address = $1 ORDER BY created_at DESC LIMIT $2`,
    [wallet.toLowerCase(), limit],
  );
  return rows.map((r) => ({
    reservationId: String(r.reservation_id),
    walletAddress: String(r.wallet_address),
    targetChainId: Number(r.target_chain_id),
    planIntentId: String(r.plan_intent_id),
    reservedSlotNumber: Number(r.reserved_slot_number),
    permitNonce: String(r.permit_nonce),
    permitDeadline: new Date(r.permit_deadline),
    status: String(r.status),
    transactionHash: r.transaction_hash ? String(r.transaction_hash) : null,
  }));
}

/** Opportunistic sweep of reservations whose permit deadline has passed unused. */
export async function expireStaleReservations(): Promise<void> {
  const p = getPool();
  if (!p) return;
  await p.query(
    `UPDATE auto_plan_capacity_reservations SET status = 'expired'
      WHERE status = 'reserved' AND permit_deadline <= now()`,
  );
}
