/**
 * Signing the EIP-712 `CampaignVoucher` that `SS4PresaleV3.buyWithCampaign` honours.
 *
 * This is the narrowest and most consequential file in the campaign: it is the only place the hot
 * signer key is used, and its output is the only thing that can move `$SS4` out of the campaign
 * reserve. Everything it does is therefore either a check or a signature.
 *
 * THE CEILING IS READ FROM THE CHAIN, NOT FROM THE CATALOG. `maxCampaignBoostBps` is frozen into the
 * sale's `configHash`, and `buyWithCampaign` reverts above it rather than clamping — so a voucher over
 * the ceiling is not a generous voucher, it is a transaction that costs a buyer gas and fails. The
 * catalog's own maximum (550) is asserted *against* the contract's before anything is signed, and a
 * disagreement refuses to sign at all. That way a campaign edited past what the deployed sale
 * published fails loudly here rather than quietly at the buyer's wallet.
 *
 * THE EPOCH IS READ FROM THE CHAIN TOO. `bumpCampaignEpoch()` is the break-glass response to a leaked
 * key; a backend that cached the epoch would keep signing vouchers under the invalidated generation
 * and every buyer would see `InvalidVoucher`. It is read per signature, from the same call that reads
 * the ceiling.
 */
import { Injectable, Logger } from '@nestjs/common';
import { createPublicClient, http, isAddress, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getRpc } from '../config';
import { getChain } from '../run-executor';
import { campaignPresale, voucherTtlSeconds } from './campaign-config';
import { PUBLISHED_CAMPAIGN_MAX_BPS } from './campaign-missions';

/** The subset of `SS4PresaleV3` this file reads. Views only — the backend never sends a sale tx. */
const PRESALE_V3_CAMPAIGN_ABI = [
  {
    type: 'function',
    name: 'maxCampaignBoostBps',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint16' }],
  },
  { type: 'function', name: 'campaignEpoch', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'bonusRemaining', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'configFrozen', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'domainSeparator', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  {
    type: 'function',
    name: 'voucherUsed',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'uint64' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'campaignVoucherDigest',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'uint16' }, { type: 'uint64' }, { type: 'uint64' }],
    outputs: [{ type: 'bytes32' }],
  },
] as const;

/**
 * The typed-data definition, which must match `CAMPAIGN_VOUCHER_TYPEHASH` in SS4PresaleV3.sol field
 * for field and in order. viem derives the type hash from this, so a reordered field here produces a
 * silently different digest — hence `assertDigestMatchesContract`, which compares against the
 * contract's own `campaignVoucherDigest` before the first signature of a process's life.
 */
const VOUCHER_TYPES = {
  CampaignVoucher: [
    { name: 'buyer', type: 'address' },
    { name: 'boostBps', type: 'uint16' },
    { name: 'deadline', type: 'uint64' },
    { name: 'nonce', type: 'uint64' },
    { name: 'epoch', type: 'uint64' },
  ],
} as const;

export interface SaleCampaignState {
  presaleAddress: `0x${string}`;
  chainId: number;
  maxCampaignBoostBps: number;
  campaignEpoch: number;
  /** `$SS4` base units left in the reserve. A campaign that has run dry still sells, it just stops paying. */
  bonusRemaining: string;
  configFrozen: boolean;
}

export interface SignedVoucher {
  boostBps: number;
  /** Unix seconds, as the contract's `uint64 deadline`. */
  deadline: number;
  nonce: string;
  signature: `0x${string}`;
  /** Echoed so a client can assert it is signing against the sale it thinks it is. */
  presaleAddress: `0x${string}`;
  chainId: number;
  campaignEpoch: number;
}

export class VoucherError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

@Injectable()
export class CampaignVoucherService {
  private readonly logger = new Logger(CampaignVoucherService.name);

  /** Set once the process has proved its typed-data encoding against a live contract. */
  private digestVerifiedFor: string | null = null;

  private client(chainId: number): PublicClient | null {
    const chain = getChain(chainId);
    const rpc = getRpc(chainId);
    if (!chain || !rpc) return null;
    return createPublicClient({ chain, transport: http(rpc) }) as PublicClient;
  }

  /**
   * The signing account, or null when the campaign is not configured to sign.
   *
   * Null rather than throwing so the campaign's read endpoints work on a deployment with no signer —
   * a user can see their progress on a backend that cannot yet issue vouchers, which is a better
   * degradation than a 500 on the profile page.
   */
  signerAccount(): ReturnType<typeof privateKeyToAccount> | null {
    const raw = process.env.SS4_CAMPAIGN_SIGNER_KEY?.trim();
    if (!raw) return null;
    try {
      return privateKeyToAccount((raw.startsWith('0x') ? raw : `0x${raw}`) as `0x${string}`);
    } catch {
      this.logger.error('SS4_CAMPAIGN_SIGNER_KEY is set but is not a valid private key; vouchers are disabled.');
      return null;
    }
  }

  /** The signer's address, for the operator dashboard to compare against CAMPAIGN_SIGNER_ROLE. */
  signerAddress(): string | null {
    return this.signerAccount()?.address ?? null;
  }

  /**
   * The sale's live campaign parameters.
   *
   * Returns null when there is no v3 sale or no reachable RPC. Callers treat that as "cannot issue a
   * voucher right now" rather than as a zero ceiling, because a zero ceiling would look like a
   * campaign that pays nothing when in fact it is a campaign nobody could read.
   */
  async readSaleState(): Promise<SaleCampaignState | null> {
    const presale = campaignPresale();
    if (!presale) return null;

    const client = this.client(presale.chainId);
    if (!client) return null;

    const contract = { address: presale.address as `0x${string}`, abi: PRESALE_V3_CAMPAIGN_ABI } as const;
    try {
      const [maxBps, epoch, remaining, frozen] = await Promise.all([
        client.readContract({ ...contract, functionName: 'maxCampaignBoostBps' }),
        client.readContract({ ...contract, functionName: 'campaignEpoch' }),
        client.readContract({ ...contract, functionName: 'bonusRemaining' }),
        client.readContract({ ...contract, functionName: 'configFrozen' }),
      ]);
      return {
        presaleAddress: presale.address as `0x${string}`,
        chainId: presale.chainId,
        maxCampaignBoostBps: Number(maxBps),
        campaignEpoch: Number(epoch),
        bonusRemaining: String(remaining),
        configFrozen: Boolean(frozen),
      };
    } catch (err) {
      this.logger.warn(`Could not read campaign state from ${presale.address}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Prove this process's typed-data encoding reproduces the contract's digest, once per sale address.
   *
   * A mismatch is not recoverable by retrying and must not be signed through: every voucher would fail
   * verification at the buyer's wallet, and the cause (a field order, a domain version, a type name)
   * is invisible from the revert. Checking it against the chain once is cheap and turns a class of
   * silent, total failure into a startup-time error.
   */
  private async assertDigestMatchesContract(
    state: SaleCampaignState,
    sample: { buyer: `0x${string}`; boostBps: number; deadline: number; nonce: bigint },
  ): Promise<void> {
    const key = `${state.chainId}:${state.presaleAddress}`;
    if (this.digestVerifiedFor === key) return;

    const client = this.client(state.chainId);
    const account = this.signerAccount();
    if (!client || !account) return;

    const onChain = (await client.readContract({
      address: state.presaleAddress,
      abi: PRESALE_V3_CAMPAIGN_ABI,
      functionName: 'campaignVoucherDigest',
      args: [sample.buyer, sample.boostBps, BigInt(sample.deadline), sample.nonce],
    })) as `0x${string}`;

    // viem exposes the digest via hashTypedData, which is what signTypedData signs.
    const { hashTypedData } = await import('viem');
    const local = hashTypedData({
      domain: {
        name: 'SS4Presale',
        version: '3',
        chainId: state.chainId,
        verifyingContract: state.presaleAddress,
      },
      types: VOUCHER_TYPES,
      primaryType: 'CampaignVoucher',
      message: {
        buyer: sample.buyer,
        boostBps: sample.boostBps,
        deadline: BigInt(sample.deadline),
        nonce: sample.nonce,
        epoch: BigInt(state.campaignEpoch),
      },
    });

    if (local.toLowerCase() !== onChain.toLowerCase()) {
      throw new VoucherError(
        'The campaign voucher encoding does not match the sale contract. Vouchers are disabled until this is fixed.',
        'digest_mismatch',
        503,
      );
    }
    this.digestVerifiedFor = key;
    this.logger.log(`Campaign voucher encoding verified against ${state.presaleAddress} on chain ${state.chainId}.`);
  }

  /**
   * Sign a voucher for `wallet` at `boostBps` against `nonce`.
   *
   * Refuses, rather than adjusting, in every case where the attestation would not be honoured:
   *
   *  - no signer key, no v3 sale, or an unreachable chain → the campaign cannot attest right now
   *  - the catalog's published maximum disagrees with the sale's frozen ceiling → a configuration
   *    error that would otherwise reach buyers as a revert
   *  - `boostBps` above the sale's ceiling → refused here so it fails in an API response a client can
   *    show, not in a wallet after gas is spent
   *  - the nonce has already been spent on chain → refused, because the contract would revert
   *
   * A boost of 0 is signed happily: a wallet that has earned nothing yet still gets a valid voucher,
   * which keeps the purchase path identical for everyone and means the buy button never has to branch
   * on whether the campaign applies.
   */
  /**
   * The expiry a voucher issued right now would carry.
   *
   * Exposed so the caller can record the exact deadline it is about to sign *before* allocating a
   * nonce, rather than storing an approximation and hoping the two never have to be reconciled. The
   * `campaign_vouchers` table exists to answer "what did we attest, and did the chain honour it" — a
   * stored deadline that disagrees with the signed one makes that answer wrong.
   */
  nextDeadline(): number {
    return Math.floor(Date.now() / 1000) + voucherTtlSeconds();
  }

  async signVoucher(input: {
    wallet: string;
    boostBps: number;
    nonce: bigint;
    /** The exact expiry to sign. Defaults to `nextDeadline()` when a caller does not pin one. */
    deadline?: number;
  }): Promise<{ voucher: SignedVoucher; state: SaleCampaignState }> {
    if (!isAddress(input.wallet)) {
      throw new VoucherError('That is not a valid wallet address.', 'bad_wallet', 400);
    }

    const account = this.signerAccount();
    if (!account) {
      throw new VoucherError(
        'The campaign cannot issue vouchers: no signing key is configured on this backend.',
        'signer_unavailable',
        503,
      );
    }

    const state = await this.readSaleState();
    if (!state) {
      throw new VoucherError(
        'The campaign cannot reach the presale contract right now. Try again in a moment.',
        'sale_unavailable',
        503,
      );
    }
    if (!state.configFrozen) {
      throw new VoucherError(
        'The presale configuration is not frozen yet, so the campaign is not open.',
        'sale_not_frozen',
        409,
      );
    }

    // The catalog and the chain must agree on what the campaign publishes. This is the check that
    // catches a rate edited in campaign-missions.ts after the sale was deployed and frozen.
    if (state.maxCampaignBoostBps !== PUBLISHED_CAMPAIGN_MAX_BPS) {
      this.logger.error(
        `Campaign maximum mismatch: the catalog publishes ${PUBLISHED_CAMPAIGN_MAX_BPS} bps but ` +
          `${state.presaleAddress} froze ${state.maxCampaignBoostBps} bps. Vouchers refused.`,
      );
      throw new VoucherError(
        'The campaign’s published maximum does not match the deployed sale. Vouchers are disabled until this is fixed.',
        'campaign_max_mismatch',
        503,
      );
    }

    const boostBps = Math.floor(input.boostBps);
    if (!Number.isFinite(boostBps) || boostBps < 0) {
      throw new VoucherError('The computed boost is not a valid rate.', 'bad_boost', 500);
    }
    if (boostBps > state.maxCampaignBoostBps) {
      // Should be unreachable — the service clamps per section and overall before calling — so this is
      // an assertion about our own arithmetic rather than input validation.
      throw new VoucherError(
        `The computed boost (${boostBps} bps) is above the campaign maximum (${state.maxCampaignBoostBps} bps).`,
        'boost_above_max',
        500,
      );
    }

    const wallet = input.wallet.toLowerCase() as `0x${string}`;
    const deadline = input.deadline ?? this.nextDeadline();

    await this.assertDigestMatchesContract(state, { buyer: wallet, boostBps, deadline, nonce: input.nonce });

    // The nonce allocator hands out max+1 per wallet from our own table, so a collision means the
    // chain has seen a purchase we have not indexed. Refusing is right: signing it would produce a
    // voucher the contract rejects with VoucherAlreadyUsed.
    const client = this.client(state.chainId);
    if (client) {
      const used = (await client.readContract({
        address: state.presaleAddress,
        abi: PRESALE_V3_CAMPAIGN_ABI,
        functionName: 'voucherUsed',
        args: [wallet, input.nonce],
      })) as boolean;
      if (used) {
        throw new VoucherError(
          'That campaign voucher has already been used. Request a new one.',
          'nonce_used',
          409,
        );
      }
    }

    const signature = await account.signTypedData({
      domain: {
        name: 'SS4Presale',
        version: '3',
        chainId: state.chainId,
        verifyingContract: state.presaleAddress,
      },
      types: VOUCHER_TYPES,
      primaryType: 'CampaignVoucher',
      message: {
        buyer: wallet,
        boostBps,
        deadline: BigInt(deadline),
        nonce: input.nonce,
        epoch: BigInt(state.campaignEpoch),
      },
    });

    return {
      voucher: {
        boostBps,
        deadline,
        nonce: input.nonce.toString(),
        signature,
        presaleAddress: state.presaleAddress,
        chainId: state.chainId,
        campaignEpoch: state.campaignEpoch,
      },
      state,
    };
  }
}
