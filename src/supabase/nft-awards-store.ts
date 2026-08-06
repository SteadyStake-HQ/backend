/**
 * On-chain season NFT award records (blueprint §14 / §20 `nft_awards`).
 *
 * One row per (season, rank) once a season result is registered on the SeasonRewardNFT contract,
 * filled in with the token id and mint tx when the card is minted. Mirrors the on-chain truth so the
 * dashboard and (Phase 6) the capacity service can read award state without re-scanning the chain.
 *
 * DI-free (SUPABASE_DB_URL) like the other stores.
 */
import { Pool } from 'pg';
import { getSharedPool } from './pg-pool';

export type AwardStatus = 'registered' | 'minted' | 'failed';

export interface NftAwardRow {
  seasonId: number;
  rank: number;
  walletAddress: string;
  chainId: number;
  contractAddress: string;
  tokenId: string | null;
  bonusSlots: number;
  registerTransactionHash: string | null;
  mintTransactionHash: string | null;
  status: AwardStatus;
}

function getPool(): Pool | null {
  return getSharedPool();
}

export const NFT_AWARDS_DDL = `
  CREATE TABLE IF NOT EXISTS nft_awards (
    season_id bigint NOT NULL,
    rank integer NOT NULL,
    wallet_address text NOT NULL,
    chain_id integer NOT NULL,
    contract_address text NOT NULL,
    token_id text,
    bonus_slots integer NOT NULL,
    register_transaction_hash text,
    mint_transaction_hash text,
    status text NOT NULL DEFAULT 'registered',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (season_id, rank)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS nft_awards_token_uq
    ON nft_awards (chain_id, contract_address, token_id) WHERE token_id IS NOT NULL;
`;

export async function ensureNftAwardsSchema(): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  await p.query(NFT_AWARDS_DDL);
}

function mapRow(r: Record<string, unknown>): NftAwardRow {
  return {
    seasonId: Number(r.season_id),
    rank: Number(r.rank),
    walletAddress: String(r.wallet_address).toLowerCase(),
    chainId: Number(r.chain_id),
    contractAddress: String(r.contract_address).toLowerCase(),
    tokenId: r.token_id != null ? String(r.token_id) : null,
    bonusSlots: Number(r.bonus_slots),
    registerTransactionHash: r.register_transaction_hash ? String(r.register_transaction_hash) : null,
    mintTransactionHash: r.mint_transaction_hash ? String(r.mint_transaction_hash) : null,
    status: String(r.status) as AwardStatus,
  };
}

/** Record a registered rank (created at registerSeasonResult time; token minted later). */
export async function upsertRegisteredAward(row: Omit<NftAwardRow, 'tokenId' | 'mintTransactionHash' | 'status'>): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  await p.query(
    `INSERT INTO nft_awards
       (season_id, rank, wallet_address, chain_id, contract_address, bonus_slots, register_transaction_hash, status, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'registered', now())
     ON CONFLICT (season_id, rank) DO UPDATE SET
       wallet_address = EXCLUDED.wallet_address,
       chain_id = EXCLUDED.chain_id,
       contract_address = EXCLUDED.contract_address,
       bonus_slots = EXCLUDED.bonus_slots,
       register_transaction_hash = EXCLUDED.register_transaction_hash,
       updated_at = now()`,
    [
      row.seasonId,
      row.rank,
      row.walletAddress.toLowerCase(),
      row.chainId,
      row.contractAddress.toLowerCase(),
      row.bonusSlots,
      row.registerTransactionHash,
    ],
  );
}

export async function markAwardMinted(seasonId: number, rank: number, tokenId: string, mintTxHash: string): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  await p.query(
    `UPDATE nft_awards SET token_id = $3, mint_transaction_hash = $4, status = 'minted', updated_at = now()
     WHERE season_id = $1 AND rank = $2`,
    [seasonId, rank, tokenId, mintTxHash.toLowerCase()],
  );
}

export async function getSeasonAwards(seasonId: number): Promise<NftAwardRow[]> {
  const p = getPool();
  if (!p) return [];
  const { rows } = await p.query('SELECT * FROM nft_awards WHERE season_id = $1 ORDER BY rank', [seasonId]);
  return rows.map(mapRow);
}
