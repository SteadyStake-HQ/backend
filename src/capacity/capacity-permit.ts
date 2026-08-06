/**
 * EIP-712 Auto Plan Capacity permit signing (blueprint §16). The backend's capacity-signer key holds
 * SIGNER_ROLE on each network's AutoPlanCapacityVerifier; the signature it produces here is what the
 * vault (Phase 6 integration) will pass to `consumePermit` on the target chain.
 *
 * Verifier addresses and the EIP-712 domain (name/version) come from the deployed contracts file, so
 * the domain always matches what was deployed — a mismatch would make every permit fail on-chain.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { privateKeyToAccount } from 'viem/accounts';

export const PERMIT_TTL_SECONDS = 5 * 60; // §16.2 deadline <= issuedAt + 5 min

export interface VerifierInfo {
  address: `0x${string}`;
  name: string;
  version: string;
}

interface DeployedEntry {
  chainId: number;
  AutoPlanCapacityVerifier?: { address?: string; domain?: string };
}

let verifierCache: Record<number, VerifierInfo> | null = null;

function loadVerifiers(): Record<number, VerifierInfo> {
  if (verifierCache) return verifierCache;
  const candidates = [
    join(process.cwd(), '..', 'contracts', 'deployed-game-contracts.json'),
    join(process.cwd(), 'contracts', 'deployed-game-contracts.json'),
    join(__dirname, '..', '..', '..', 'contracts', 'deployed-game-contracts.json'),
    process.env.GAME_CONTRACTS_FILE?.trim() ?? '',
  ].filter(Boolean);
  const file = candidates.find((c) => existsSync(c));
  const out: Record<number, VerifierInfo> = {};
  if (file) {
    const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, DeployedEntry>;
    for (const entry of Object.values(data)) {
      const v = entry.AutoPlanCapacityVerifier;
      if (!v?.address) continue;
      const [name, version] = (v.domain ?? 'Echo Arena Capacity/1').split('/');
      out[entry.chainId] = { address: v.address as `0x${string}`, name: name ?? 'Echo Arena Capacity', version: version ?? '1' };
    }
  }
  verifierCache = out;
  return out;
}

export function getVerifier(chainId: number): VerifierInfo | null {
  return loadVerifiers()[chainId] ?? null;
}

function signerAccount() {
  let pk = process.env.CAPACITY_SIGNER_PRIVATE_KEY?.trim() || process.env.RELAYER_PRIVATE_KEY?.trim();
  if (!pk) throw new Error('CAPACITY_SIGNER_PRIVATE_KEY / RELAYER_PRIVATE_KEY is not configured.');
  if (!pk.startsWith('0x')) pk = `0x${pk}`;
  return privateKeyToAccount(pk as `0x${string}`);
}

export interface CapacityPermit {
  wallet: `0x${string}`;
  targetChainId: number;
  planIntentId: `0x${string}`;
  nftBonus: number;
  reservedSlotNumber: number;
  nonce: bigint;
  issuedAt: number;
  deadline: number;
}

/** Sign a capacity permit for `verifier` on `targetChainId`. Returns the 65-byte signature. */
export async function signCapacityPermit(permit: CapacityPermit, verifier: VerifierInfo): Promise<`0x${string}`> {
  const account = signerAccount();
  return account.signTypedData({
    domain: {
      name: verifier.name,
      version: verifier.version,
      chainId: permit.targetChainId,
      verifyingContract: verifier.address,
    },
    types: {
      AutoPlanCapacityPermit: [
        { name: 'wallet', type: 'address' },
        { name: 'targetChainId', type: 'uint256' },
        { name: 'planIntentId', type: 'bytes32' },
        { name: 'nftBonus', type: 'uint8' },
        { name: 'reservedSlotNumber', type: 'uint8' },
        { name: 'nonce', type: 'uint256' },
        { name: 'issuedAt', type: 'uint64' },
        { name: 'deadline', type: 'uint64' },
      ],
    },
    primaryType: 'AutoPlanCapacityPermit',
    message: {
      wallet: permit.wallet,
      targetChainId: BigInt(permit.targetChainId),
      planIntentId: permit.planIntentId,
      nftBonus: permit.nftBonus,
      reservedSlotNumber: permit.reservedSlotNumber,
      nonce: permit.nonce,
      issuedAt: BigInt(permit.issuedAt),
      deadline: BigInt(permit.deadline),
    },
  });
}

/** The signer's address, for logging / granting SIGNER_ROLE. */
export function capacitySignerAddress(): `0x${string}` {
  return signerAccount().address;
}
