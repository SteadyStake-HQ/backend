/**
 * Game Pass purchase intents (blueprint §7 / §20 `purchase_intents`).
 *
 * An intent is the backend's trusted record of *what* a checkout should be: the plan, the exact
 * amount in the token's own base units, the chain, and a one-time `purchase_id`. The client never
 * supplies price, token, or duration — it receives them (§7.1). Creating an intent grants nothing;
 * only a confirmed on-chain `PassPaid` carrying the same `purchase_id` activates a pass, which is
 * why the create endpoint can be public.
 *
 * DI-free (SUPABASE_DB_URL), matching the other stores so the indexer can write without Nest.
 */
import { Pool } from 'pg';
import { getSharedPool } from './pg-pool';

export type PurchaseStatus = 'created' | 'submitted' | 'confirmed' | 'expired' | 'cancelled';

export interface PurchaseIntentRow {
  purchaseId: string; // bytes32 hex
  walletAddress: string;
  chainId: number;
  passPlanId: number;
  durationSeconds: number;
  paymentToken: string;
  expectedAmountAtomic: string; // numeric as string
  checkoutContract: string;
  status: PurchaseStatus;
  transactionHash: string | null;
  createdAt: Date;
  expiresAt: Date;
  confirmedAt: Date | null;
}

function getPool(): Pool | null {
  return getSharedPool();
}

export const PURCHASE_INTENTS_DDL = `
  CREATE TABLE IF NOT EXISTS purchase_intents (
    purchase_id text PRIMARY KEY,
    wallet_address text NOT NULL,
    chain_id integer NOT NULL,
    pass_plan_id integer NOT NULL,
    duration_seconds integer NOT NULL,
    payment_token text NOT NULL,
    expected_amount_atomic numeric NOT NULL,
    checkout_contract text NOT NULL,
    status text NOT NULL DEFAULT 'created',
    transaction_hash text,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    confirmed_at timestamptz
  );
  CREATE UNIQUE INDEX IF NOT EXISTS purchase_intents_txhash_uq
    ON purchase_intents (transaction_hash) WHERE transaction_hash IS NOT NULL;
  CREATE INDEX IF NOT EXISTS purchase_intents_wallet_idx ON purchase_intents (wallet_address);
`;

export async function ensurePurchaseIntentsSchema(): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  await p.query(PURCHASE_INTENTS_DDL);
}

function mapRow(r: Record<string, unknown>): PurchaseIntentRow {
  return {
    purchaseId: String(r.purchase_id),
    walletAddress: String(r.wallet_address).toLowerCase(),
    chainId: Number(r.chain_id),
    passPlanId: Number(r.pass_plan_id),
    durationSeconds: Number(r.duration_seconds),
    paymentToken: String(r.payment_token).toLowerCase(),
    expectedAmountAtomic: String(r.expected_amount_atomic),
    checkoutContract: String(r.checkout_contract).toLowerCase(),
    status: String(r.status) as PurchaseStatus,
    transactionHash: r.transaction_hash ? String(r.transaction_hash).toLowerCase() : null,
    createdAt: new Date(r.created_at as string),
    expiresAt: new Date(r.expires_at as string),
    confirmedAt: r.confirmed_at ? new Date(r.confirmed_at as string) : null,
  };
}

export async function createPurchaseIntent(row: Omit<PurchaseIntentRow, 'createdAt' | 'confirmedAt' | 'status' | 'transactionHash'>): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  await p.query(
    `INSERT INTO purchase_intents
       (purchase_id, wallet_address, chain_id, pass_plan_id, duration_seconds,
        payment_token, expected_amount_atomic, checkout_contract, status, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'created',$9)`,
    [
      row.purchaseId,
      row.walletAddress.toLowerCase(),
      row.chainId,
      row.passPlanId,
      row.durationSeconds,
      row.paymentToken.toLowerCase(),
      row.expectedAmountAtomic,
      row.checkoutContract.toLowerCase(),
      row.expiresAt,
    ],
  );
}

export async function getPurchaseIntent(purchaseId: string): Promise<PurchaseIntentRow | null> {
  const p = getPool();
  if (!p) return null;
  const { rows } = await p.query('SELECT * FROM purchase_intents WHERE purchase_id = $1', [purchaseId]);
  return rows.length ? mapRow(rows[0]) : null;
}

/**
 * Attach a submitted tx hash. Only moves an unconfirmed intent to `submitted` and only when it does
 * not already carry a different hash — so a repeated browser callback is idempotent (§7.4).
 */
export async function attachTransactionHash(purchaseId: string, txHash: string): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  await p.query(
    `UPDATE purchase_intents
       SET transaction_hash = $2,
           status = CASE WHEN status = 'created' THEN 'submitted' ELSE status END
     WHERE purchase_id = $1
       AND status IN ('created', 'submitted')
       AND (transaction_hash IS NULL OR transaction_hash = $2)`,
    [purchaseId, txHash.toLowerCase()],
  );
}

/**
 * Mark an intent confirmed. Idempotent: only flips a not-yet-confirmed row, and returns whether this
 * call was the one that did it, so the caller extends pass time exactly once (§7.3).
 */
export async function markPurchaseConfirmed(
  purchaseId: string,
  txHash: string,
  confirmedAt: Date,
): Promise<boolean> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  const { rowCount } = await p.query(
    `UPDATE purchase_intents
       SET status = 'confirmed', transaction_hash = $2, confirmed_at = $3
     WHERE purchase_id = $1 AND status <> 'confirmed'`,
    [purchaseId, txHash.toLowerCase(), confirmedAt],
  );
  return (rowCount ?? 0) > 0;
}

/** Opportunistic sweep of intents that were never paid, matching the nonce-sweep style elsewhere. */
export async function expireStaleIntents(): Promise<void> {
  const p = getPool();
  if (!p) return;
  await p.query(
    `UPDATE purchase_intents SET status = 'expired'
     WHERE status IN ('created', 'submitted') AND expires_at < now()`,
  );
}
