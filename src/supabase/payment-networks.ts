/**
 * The stablecoin payment networks a Game Pass can be bought on (blueprint §6 / §20 `payment_networks`).
 *
 * One row per chain that has a deployed StablecoinGamePassCheckout. Selection is by exact chain id
 * and exact contract address — never by ticker (§6) — so a lookalike token with the right symbol but
 * the wrong address is simply not in this table and cannot be paid with.
 *
 * DI-free, reading SUPABASE_DB_URL directly, to match dca-plans-store.ts / network-allocations.ts:
 * the standalone pass indexer (`node dist/payments/pass-indexer.js`) reads this without booting Nest.
 */
import { Pool } from 'pg';
import { getSharedPool } from './pg-pool';

export interface PaymentNetworkRow {
  chainId: number;
  stablecoinSymbol: string;
  stablecoinAddress: string;
  stablecoinDecimals: number;
  checkoutContract: string;
  treasuryAddress: string;
  requiredConfirmations: number;
  enabled: boolean;
  configVersion: number;
}

function getPool(): Pool | null {
  return getSharedPool();
}

export const PAYMENT_NETWORKS_DDL = `
  CREATE TABLE IF NOT EXISTS payment_networks (
    chain_id integer PRIMARY KEY,
    stablecoin_symbol text NOT NULL,
    stablecoin_address text NOT NULL,
    stablecoin_decimals integer NOT NULL,
    checkout_contract text NOT NULL,
    treasury_address text NOT NULL,
    required_confirmations integer NOT NULL DEFAULT 3,
    enabled boolean NOT NULL DEFAULT true,
    config_version integer NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
`;

export async function ensurePaymentNetworksSchema(): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  await p.query(PAYMENT_NETWORKS_DDL);
}

function mapRow(r: Record<string, unknown>): PaymentNetworkRow {
  return {
    chainId: Number(r.chain_id),
    stablecoinSymbol: String(r.stablecoin_symbol),
    stablecoinAddress: String(r.stablecoin_address).toLowerCase(),
    stablecoinDecimals: Number(r.stablecoin_decimals),
    checkoutContract: String(r.checkout_contract).toLowerCase(),
    treasuryAddress: String(r.treasury_address).toLowerCase(),
    requiredConfirmations: Number(r.required_confirmations),
    enabled: Boolean(r.enabled),
    configVersion: Number(r.config_version),
  };
}

export async function getPaymentNetworks(onlyEnabled = false): Promise<PaymentNetworkRow[]> {
  const p = getPool();
  if (!p) return [];
  const { rows } = await p.query(
    `SELECT * FROM payment_networks ${onlyEnabled ? 'WHERE enabled = true' : ''} ORDER BY chain_id`,
  );
  return rows.map(mapRow);
}

export async function getPaymentNetwork(chainId: number): Promise<PaymentNetworkRow | null> {
  const p = getPool();
  if (!p) return null;
  const { rows } = await p.query('SELECT * FROM payment_networks WHERE chain_id = $1', [chainId]);
  return rows.length ? mapRow(rows[0]) : null;
}

/** Idempotent upsert. Used by the boot seed and (later) an admin editor. */
export async function upsertPaymentNetwork(row: PaymentNetworkRow): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  await p.query(
    `INSERT INTO payment_networks
       (chain_id, stablecoin_symbol, stablecoin_address, stablecoin_decimals,
        checkout_contract, treasury_address, required_confirmations, enabled, config_version, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (chain_id) DO UPDATE SET
       stablecoin_symbol = EXCLUDED.stablecoin_symbol,
       stablecoin_address = EXCLUDED.stablecoin_address,
       stablecoin_decimals = EXCLUDED.stablecoin_decimals,
       checkout_contract = EXCLUDED.checkout_contract,
       treasury_address = EXCLUDED.treasury_address,
       required_confirmations = EXCLUDED.required_confirmations,
       enabled = EXCLUDED.enabled,
       config_version = EXCLUDED.config_version,
       updated_at = now()`,
    [
      row.chainId,
      row.stablecoinSymbol,
      row.stablecoinAddress.toLowerCase(),
      row.stablecoinDecimals,
      row.checkoutContract.toLowerCase(),
      row.treasuryAddress.toLowerCase(),
      row.requiredConfirmations,
      row.enabled,
      row.configVersion,
    ],
  );
}
