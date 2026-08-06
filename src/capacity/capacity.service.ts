import { randomBytes } from 'crypto';
import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { isAddress } from 'viem';
import {
  BASE_SLOTS_PER_NETWORK,
  ensureCapacitySchema,
  getActivePlanCountsByChain,
  getHighestCardBonus,
  getMembership,
  listReservations,
  reserveSlot,
  setMembership,
  type MembershipTier,
} from '../supabase/capacity-store';
import {
  PERMIT_TTL_SECONDS,
  getVerifier,
  signCapacityPermit,
  type CapacityPermit,
} from './capacity-permit';

function randomBytes32(): `0x${string}` {
  return `0x${randomBytes(32).toString('hex')}`;
}

function normalizeIntentId(raw?: string): `0x${string}` {
  return raw && /^0x[0-9a-fA-F]{64}$/.test(raw) ? (raw as `0x${string}`) : randomBytes32();
}

@Injectable()
export class CapacityService {
  private readonly logger = new Logger(CapacityService.name);

  /** §15.2 capacity read: base per-network limit, NFT bonus, used across networks, and available. */
  async getCapacity(wallet: string) {
    if (!isAddress(wallet)) throw new BadRequestException({ ok: false, error: 'A valid wallet address is required.' });
    await ensureCapacitySchema();

    const tier = await getMembership(wallet);
    const baseLimit = BASE_SLOTS_PER_NETWORK[tier];
    const activeByChain = await getActivePlanCountsByChain(wallet);
    const nftBonus = await getHighestCardBonus(wallet);

    const perNetwork = Object.entries(activeByChain).map(([chainId, active]) => {
      const excess = baseLimit == null ? 0 : Math.max(0, active - baseLimit);
      return { chainId: Number(chainId), active, baseLimit, excess };
    });
    const usedSlots = perNetwork.reduce((sum, n) => sum + n.excess, 0);
    const availableNftSlots = Math.max(0, nftBonus - usedSlots);

    return {
      ok: true,
      wallet: wallet.toLowerCase(),
      tier,
      baseLimitPerNetwork: baseLimit, // null = unlimited (institutional)
      nftBonus,
      usedNftSlots: usedSlots,
      availableNftSlots,
      perNetwork,
    };
  }

  /** §17.5 capacity inspector: the full read plus recent reservations, for support staff. */
  async inspect(wallet: string) {
    const capacity = await this.getCapacity(wallet);
    const reservations = await listReservations(wallet);
    return {
      ...capacity,
      reservations: reservations.map((r) => ({
        reservationId: r.reservationId,
        targetChainId: r.targetChainId,
        reservedSlotNumber: r.reservedSlotNumber,
        status: r.status,
        permitDeadline: r.permitDeadline.toISOString(),
        transactionHash: r.transactionHash,
      })),
    };
  }

  /**
   * §17.5: an audited membership-tier override. This is the "separately authorized" control support
   * staff use until an on-chain subscription source populates tiers; it is logged, not silent.
   */
  async setTier(wallet: string, tier: string, actor?: string) {
    if (!isAddress(wallet)) throw new BadRequestException({ ok: false, error: 'A valid wallet address is required.' });
    if (!(tier in BASE_SLOTS_PER_NETWORK)) {
      throw new BadRequestException({ ok: false, error: 'tier must be starter, plus, pro, or institutional.' });
    }
    await ensureCapacitySchema();
    await setMembership(wallet, tier as MembershipTier);
    this.logger.warn(`membership override: ${wallet.toLowerCase()} -> ${tier}${actor ? ` by ${actor}` : ''}`);
    return { ok: true, wallet: wallet.toLowerCase(), tier };
  }

  /**
   * §15.6 / §16: reserve one bonus slot and return a signed capacity permit. Fails closed — no card,
   * no verifier on the target chain, or no free slot all reject rather than over-issue.
   */
  async reserve(input: { wallet?: string; targetChainId?: number; planIntentId?: string }) {
    if (!input.wallet || !isAddress(input.wallet)) {
      throw new BadRequestException({ ok: false, error: 'A valid wallet address is required.' });
    }
    const targetChainId = Number(input.targetChainId);
    const verifier = getVerifier(targetChainId);
    if (!verifier) {
      throw new BadRequestException({ ok: false, error: `No capacity verifier deployed on chain ${targetChainId}.` });
    }
    await ensureCapacitySchema();

    const wallet = input.wallet.toLowerCase();
    const tier: MembershipTier = await getMembership(wallet);
    const baseLimit = BASE_SLOTS_PER_NETWORK[tier];
    const nftBonus = await getHighestCardBonus(wallet);
    if (nftBonus <= 0) {
      throw new BadRequestException({ ok: false, error: 'This wallet holds no reward card, so it has no bonus slots.' });
    }

    const activeByChain = await getActivePlanCountsByChain(wallet);
    const usedSlots =
      baseLimit == null
        ? 0
        : Object.values(activeByChain).reduce((sum, active) => sum + Math.max(0, active - baseLimit), 0);

    const nonce = BigInt(`0x${randomBytes(32).toString('hex')}`);
    const issuedAt = Math.floor(Date.now() / 1000);
    const deadline = issuedAt + PERMIT_TTL_SECONDS;
    const planIntentId = normalizeIntentId(input.planIntentId);

    const reservation = await reserveSlot({
      wallet,
      targetChainId,
      planIntentId,
      nftBonus,
      permitNonce: nonce.toString(),
      permitDeadline: new Date(deadline * 1000),
      usedSlots,
    });
    if (!reservation) {
      throw new ConflictException({
        ok: false,
        error: 'No bonus slot available: your reward card capacity is fully used or reserved.',
        code: 'no_capacity',
      });
    }

    const permit: CapacityPermit = {
      wallet: wallet as `0x${string}`,
      targetChainId,
      planIntentId,
      nftBonus,
      reservedSlotNumber: reservation.reservedSlotNumber,
      nonce,
      issuedAt,
      deadline,
    };
    const signature = await signCapacityPermit(permit, verifier);
    this.logger.log(`capacity permit signed for ${wallet} on ${targetChainId} slot ${reservation.reservedSlotNumber}`);

    return {
      ok: true,
      reservationId: reservation.reservationId,
      verifier: verifier.address,
      permit: {
        wallet: permit.wallet,
        targetChainId: permit.targetChainId,
        planIntentId: permit.planIntentId,
        nftBonus: permit.nftBonus,
        reservedSlotNumber: permit.reservedSlotNumber,
        nonce: permit.nonce.toString(),
        issuedAt: permit.issuedAt,
        deadline: permit.deadline,
      },
      signature,
    };
  }
}
