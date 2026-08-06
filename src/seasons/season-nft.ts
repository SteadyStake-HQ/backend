/**
 * The slice of SeasonRewardNFT the backend calls (register + mint) and reads (registered, tokenIdFor,
 * events), plus the per-card metadata builder (blueprint §13.2). Kept in sync with
 * contracts/src/SeasonRewardNFT.sol.
 */

export const SEASON_NFT_ABI = [
  {
    type: 'function',
    name: 'registerSeasonResult',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'seasonId', type: 'uint64' },
      { name: 'rulesHash', type: 'bytes32' },
      { name: 'snapshotHash', type: 'bytes32' },
      { name: 'winners', type: 'address[3]' },
      { name: 'tokenURIs', type: 'string[3]' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'mintSeasonAward',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'seasonId', type: 'uint64' },
      { name: 'rank', type: 'uint8' },
    ],
    outputs: [],
  },
  { type: 'function', name: 'tokenIdFor', stateMutability: 'pure', inputs: [{ name: 'seasonId', type: 'uint64' }, { name: 'rank', type: 'uint8' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'seasonRegistered', stateMutability: 'view', inputs: [{ name: 'seasonId', type: 'uint64' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'bonusSlots', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }] },
] as const;

/** Recommended card names per rank (§13). Slot value is fixed by the contract (4 - rank). */
const CARD_NAMES: Record<number, string> = { 1: 'Chronarch Card', 2: 'Navigator Card', 3: 'Signal Card' };

/**
 * The token metadata JSON for a rank (§13.2), as a self-contained data: URI. Testnet-friendly: no
 * IPFS pin needed to exercise the flow. Production should pin real artwork and pass an ipfs:// URI.
 */
export function buildTokenMetadataUri(seasonId: number, rank: number, externalBase?: string): string {
  const bonus = 4 - rank;
  const metadata = {
    name: `${CARD_NAMES[rank]} — Season ${seasonId}`,
    description: `Awarded to the Rank ${rank} verified Echo Arena player for Season ${seasonId}.`,
    image: '',
    external_url: externalBase ? `${externalBase.replace(/\/$/, '')}/seasons/${seasonId}` : '',
    attributes: [
      { trait_type: 'Season', value: String(seasonId) },
      { trait_type: 'Final Rank', value: String(rank) },
      { trait_type: 'Auto Execution Bonus', value: bonus },
      { trait_type: 'Transferability', value: 'Locked' },
    ],
  };
  const json = JSON.stringify(metadata);
  return `data:application/json;base64,${Buffer.from(json, 'utf8').toString('base64')}`;
}
