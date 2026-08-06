/**
 * Registry of deployed reward-NFT contracts the admin can distribute season rewards from.
 *
 * The reward page's distribute modal lists the enabled rows here (or the admin may paste an address).
 * A row is just an address + chain + label; the mint itself is done by the season award service using
 * the contract's ABI. Keyed by (chain_id, address) so the same contract on two chains are distinct.
 *
 * DI-free (SUPABASE_DB_URL) like the other stores.
 */
import { Pool } from 'pg';
import { getSharedPool } from './pg-pool';

export interface RewardNftContractRow {
  id: number;
  chainId: number;
  address: string;
  name: string;
  /** Contract shape, so the award service knows how to mint. Only 'season_reward_nft' today. */
  kind: string;
  enabled: boolean;
  createdAt: Date;
}

function getPool(): Pool | null {
  return getSharedPool();
}

export const REWARD_NFT_CONTRACTS_DDL = `
  CREATE TABLE IF NOT EXISTS reward_nft_contracts (
    id bigserial PRIMARY KEY,
    chain_id integer NOT NULL,
    address text NOT NULL,
    name text NOT NULL,
    kind text NOT NULL DEFAULT 'season_reward_nft',
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS reward_nft_contracts_chain_addr_uq
    ON reward_nft_contracts (chain_id, address);
`;

export async function ensureRewardNftContractsSchema(): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  await p.query(REWARD_NFT_CONTRACTS_DDL);
}

function mapRow(r: Record<string, unknown>): RewardNftContractRow {
  return {
    id: Number(r.id),
    chainId: Number(r.chain_id),
    address: String(r.address).toLowerCase(),
    name: String(r.name),
    kind: String(r.kind),
    enabled: Boolean(r.enabled),
    createdAt: new Date(r.created_at as string),
  };
}

/** All contracts, newest first. `enabledOnly` filters to the ones the distribute modal should show. */
export async function listRewardNftContracts(enabledOnly = false): Promise<RewardNftContractRow[]> {
  const p = getPool();
  if (!p) return [];
  const { rows } = await p.query(
    `SELECT * FROM reward_nft_contracts ${enabledOnly ? 'WHERE enabled = true' : ''} ORDER BY created_at DESC`,
  );
  return rows.map(mapRow);
}

export async function getRewardNftContract(id: number): Promise<RewardNftContractRow | null> {
  const p = getPool();
  if (!p) return null;
  const { rows } = await p.query('SELECT * FROM reward_nft_contracts WHERE id = $1', [id]);
  return rows.length ? mapRow(rows[0]) : null;
}

export async function upsertRewardNftContract(input: {
  chainId: number;
  address: string;
  name: string;
  kind?: string;
  enabled?: boolean;
}): Promise<RewardNftContractRow> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  const { rows } = await p.query(
    `INSERT INTO reward_nft_contracts (chain_id, address, name, kind, enabled)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (chain_id, address) DO UPDATE SET
       name = EXCLUDED.name, kind = EXCLUDED.kind, enabled = EXCLUDED.enabled
     RETURNING *`,
    [input.chainId, input.address.toLowerCase(), input.name, input.kind ?? 'season_reward_nft', input.enabled ?? true],
  );
  return mapRow(rows[0]);
}

export async function setRewardNftContractEnabled(id: number, enabled: boolean): Promise<RewardNftContractRow | null> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  const { rows } = await p.query(
    'UPDATE reward_nft_contracts SET enabled = $2 WHERE id = $1 RETURNING *',
    [id, enabled],
  );
  return rows.length ? mapRow(rows[0]) : null;
}
