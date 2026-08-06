/**
 * Account-level Game Pass entitlement (blueprint §5.4 / §20 `pass_entitlements`).
 *
 * The canonical, cross-network source of when a wallet's pass expires. A pass bought on any payment
 * network extends the same account expiry — the pass "works across the game regardless of which
 * supported network was used for payment" (§5.9). Keyed by lowercased wallet.
 *
 * DI-free (SUPABASE_DB_URL) so the indexer can extend expiry directly on confirmation.
 */
import { Pool } from 'pg';
import { getSharedPool } from './pg-pool';

export interface PassEntitlementRow {
  walletAddress: string;
  startsAt: Date | null;
  expiresAt: Date | null;
  latestPurchaseId: string | null;
  updatedAt: Date;
}

function getPool(): Pool | null {
  return getSharedPool();
}

export const PASS_ENTITLEMENTS_DDL = `
  CREATE TABLE IF NOT EXISTS pass_entitlements (
    wallet_address text PRIMARY KEY,
    starts_at timestamptz,
    expires_at timestamptz,
    latest_purchase_id text,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
`;

export async function ensurePassEntitlementsSchema(): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  await p.query(PASS_ENTITLEMENTS_DDL);
}

export async function getPassEntitlement(wallet: string): Promise<PassEntitlementRow | null> {
  const p = getPool();
  if (!p) return null;
  const { rows } = await p.query('SELECT * FROM pass_entitlements WHERE wallet_address = $1', [
    wallet.toLowerCase(),
  ]);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    walletAddress: String(r.wallet_address).toLowerCase(),
    startsAt: r.starts_at ? new Date(r.starts_at) : null,
    expiresAt: r.expires_at ? new Date(r.expires_at) : null,
    latestPurchaseId: r.latest_purchase_id ? String(r.latest_purchase_id) : null,
    updatedAt: new Date(r.updated_at),
  };
}

/**
 * Extend a wallet's pass by `durationSeconds` using the blueprint formula (§5.4):
 *
 *   new_expiry = max(current_expiry, payment_confirmed_at) + duration
 *
 * Done in a single atomic SQL statement so two confirmations racing on the same wallet each add
 * their own time rather than one clobbering the other. `starts_at` is set only on first activation.
 */
export async function extendPassEntitlement(
  wallet: string,
  confirmedAt: Date,
  durationSeconds: number,
  latestPurchaseId: string,
): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  const interval = `${Math.floor(durationSeconds)} seconds`;
  await p.query(
    `INSERT INTO pass_entitlements (wallet_address, starts_at, expires_at, latest_purchase_id, updated_at)
     VALUES ($1, $2, $2::timestamptz + $3::interval, $4, now())
     ON CONFLICT (wallet_address) DO UPDATE SET
       expires_at = GREATEST(COALESCE(pass_entitlements.expires_at, $2::timestamptz), $2::timestamptz)
                    + $3::interval,
       starts_at = COALESCE(pass_entitlements.starts_at, $2::timestamptz),
       latest_purchase_id = $4,
       updated_at = now()`,
    [wallet.toLowerCase(), confirmedAt, interval, latestPurchaseId],
  );
}
