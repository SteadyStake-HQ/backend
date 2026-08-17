/**
 * The Early Supporter Campaign's brain: evaluate every mission from authoritative records, sum the
 * verified ones into a Presale Boost, and hand that boost to the voucher signer.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE (campaign spec §15): the boost is computed here, from
 * completion rows this backend wrote after reading a record it trusts. Nothing a client sends
 * contributes to it. The frontend's job is to display a number this service produced, and its only
 * inputs to the campaign are "which wallet" (proved by signature) and "which referral code".
 *
 * ---------------------------------------------------------------------------------------------
 * HOW A BOOST IS BUILT, IN ORDER:
 *
 *   1. Every automatic verifier runs against the wallet and writes/updates completion rows. A row
 *      only ever moves *to* `completed`, never back (see `recordCompletion`) — a mission verified
 *      once is earned, which is the spec's own model for the balance checks.
 *   2. Each section's completion bonus is granted iff every `countsTowardCompletion` mission in that
 *      section is complete. Derived, never verified — and re-derived on every pass, so a completion
 *      bonus can never exist without its inputs.
 *   3. The boost is summed *from the catalog's current rates*, per section, clamped to the section
 *      maximum, then clamped to the campaign maximum.
 *
 * Step 3 sums from the catalog rather than from the stored `boost_bps_awarded`, and the difference
 * matters: the stored value is a historical record of what a wallet was attested for, while a live
 * voucher must reflect what the campaign publishes *now*. The two clamps are belt and braces over the
 * catalog's own boot-time assertion — the sale contract reverts above its frozen ceiling rather than
 * clamping, so a buyer whose boost overflowed would lose gas rather than gain tokens.
 */
import { Injectable, Logger } from '@nestjs/common';
import { isAddress } from 'viem';
import { isSupabaseConfigured } from '../supabase/dca-plans-store';
import {
  readQualifiedReferrals,
  getCampaignUser,
  getCampaignUserByReferralCode,
  getReferralOfReferee,
  issueVoucherRecord,
  linkTelegramAccount,
  listCompletions,
  listReferralsByReferrer,
  recordCompletion,
  recordReferral,
  upsertCampaignUser,
  writeAudit,
  type CampaignUserRow,
  type MissionCompletionRow,
} from '../supabase/campaign-store';
import {
  CAMPAIGN_SECTIONS,
  CAMPAIGN_MISSIONS,
  COMPLETION_MISSION_BY_SECTION,
  campaignMaxBps,
  completionInputs,
  computeBoostBps,
  getMission,
  missionsInSection,
  sectionMaxBps,
  xVerificationAvailable,
  type CampaignMission,
  type CampaignSection,
  type MissionStatus,
} from './campaign-missions';
import {
  campaignChainId,
  campaignReadiness,
  campaignStableToken,
  isCampaignChain,
  telegramTargets,
  xTargets,
} from './campaign-config';
import { CampaignVoucherService, VoucherError, type SignedVoucher } from './campaign-voucher';
import { readBalances, verifyBotAndStableReady, verifyHoldBot, verifyHoldStable } from './verifiers/onchain-balances';
import { readDcaActivity, verifyDcaExecutions, verifyDcaPlanCount } from './verifiers/dca-activity';
import { readGameActivity, readPassPurchase, verifyGameSessions, verifyPassPurchase } from './verifiers/game-activity';
import { verifyTelegramLogin, verifyTelegramMembership, verifyXMission, type TelegramLoginPayload } from './verifiers/social';
import { met, notMet, isUnavailable, type VerifierResult } from './verifiers/verifier-types';
import { newReferralCode } from './campaign-auth';

/**
 * How long an evaluation is reused for a wallet.
 *
 * The profile endpoint is polled by an open campaign page, and a full evaluation is a handful of RPC
 * calls plus four queries. Thirty seconds keeps a page responsive to a user who just played a game or
 * bought a pass while stopping an idle tab from generating load. `POST /verify` bypasses it, so the
 * "check again" button is always immediate.
 */
const EVALUATION_TTL_MS = 30_000;

/** One mission as the campaign page renders it. */
export interface MissionView {
  code: string;
  section: CampaignSection;
  name: string;
  requirement: string;
  boostBps: number;
  status: MissionStatus;
  /** True when this mission's boost is currently counted in the wallet's total. */
  earned: boolean;
  verificationType: string;
  /** False when this deployment cannot check the mission automatically at all. */
  verificationAvailable: boolean;
  /** Why it cannot be checked, or why the last check could not conclude. */
  note: string | null;
  progress: { current: number; target: number } | null
  verifiedAt: string | null;
  verificationSource: string | null;
}

export interface SectionView {
  section: CampaignSection;
  earnedBps: number;
  maxBps: number;
  missions: MissionView[];
  /** Which missions still stand between this wallet and the section's completion bonus. */
  completionOutstanding: string[];
}

export interface CampaignProfile {
  wallet: string;
  chainId: number;
  referralCode: string;
  referredByWallet: string | null;
  telegramLinked: boolean;
  telegramUsername: string | null;
  xLinked: boolean;
  xHandle: string | null;
  /** The boost this wallet would be attested for right now, in bps. */
  boostBps: number;
  maxBoostBps: number;
  sections: SectionView[];
  referrals: {
    total: number;
    qualified: number;
    /** Truncated wallets of the invitees, so a referrer can see their own funnel. */
    invited: Array<{ wallet: string; status: string; qualifiedAt: string | null }>;
  };
  /** Null when the sale cannot be read; the page then says the campaign is not open. */
  sale: {
    presaleAddress: string;
    maxCampaignBoostBps: number;
    bonusRemaining: string;
    campaignEpoch: number;
  } | null;
  evaluatedAt: string;
}

export class CampaignError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Everything one evaluation pass needs, read once and shared by every verifier. */
interface EvaluationContext {
  wallet: string;
  user: CampaignUserRow;
  balances: Awaited<ReturnType<typeof readBalances>>;
  dca: Awaited<ReturnType<typeof readDcaActivity>>;
  game: Awaited<ReturnType<typeof readGameActivity>>;
  pass: Awaited<ReturnType<typeof readPassPurchase>>;
  qualifiedReferrals: { count: number; firstPurchaseReference: string | null };
}

@Injectable()
export class CampaignService {
  private readonly logger = new Logger(CampaignService.name);

  /** wallet => when it was last fully evaluated, for the poll throttle. */
  private readonly lastEvaluated = new Map<string, number>();

  constructor(private readonly vouchers: CampaignVoucherService) {}

  private ensureDb(): void {
    if (!isSupabaseConfigured()) {
      throw new CampaignError('The campaign is unavailable: the database is not configured.', 'no_db', 503);
    }
  }

  private normalizeWallet(wallet: string): string {
    if (!isAddress(wallet)) {
      throw new CampaignError('That is not a valid wallet address.', 'bad_wallet', 400);
    }
    return wallet.toLowerCase();
  }

  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  /**
   * Find or create the campaign identity for a wallet that has just signed in.
   *
   * Creating it completes `onchain_connect_botchain_wallet` — the eligibility mission, worth 0 bps and
   * required before the rest of the on-chain section. The signature has already been checked and the
   * chain already confirmed to be the campaign's, so the mission's requirement ("connects an eligible
   * wallet on BOT Chain") is satisfied by the fact of being here.
   */
  async ensureUser(wallet: string, chainId: number): Promise<CampaignUserRow> {
    this.ensureDb();
    const address = this.normalizeWallet(wallet);
    if (!isCampaignChain(chainId)) {
      throw new CampaignError(
        `The campaign runs on chain ${campaignChainId()}. Switch networks and sign in again.`,
        'wrong_chain',
        400,
      );
    }

    const user = await upsertCampaignUser(address, chainId, newReferralCode());

    const newlyCompleted = await recordCompletion({
      campaignUserId: user.id,
      missionCode: 'onchain_connect_botchain_wallet',
      status: 'completed',
      boostBpsAwarded: 0,
      verificationSource: 'campaign_session:siwe',
      verificationReference: `chain:${chainId}`,
    });
    if (newlyCompleted) {
      await writeAudit({
        wallet: address,
        missionCode: 'onchain_connect_botchain_wallet',
        event: 'mission_completed',
        detail: { chainId, source: 'campaign_session:siwe' },
      });
    }

    return user;
  }

  /**
   * Attach a referrer to a wallet, from a referral code.
   *
   * Ordering is the point: the spec requires the referrer to be recorded *before* the invitee's
   * qualifying purchase, so this is called when the invitee signs in through a referral link, and the
   * referral sits at `registered` until the indexer sees them buy. It cannot be called afterwards to
   * back-date attribution, because `recordReferral` refuses a second referrer for a wallet that has one
   * and the qualification step only ever fires on a purchase indexed after the referral row exists.
   *
   * Every refusal is returned as a message rather than thrown: a bad or self-referred code is a
   * completely normal thing for a link to contain, and it must not stop the invitee signing in.
   */
  async claimReferral(wallet: string, referralCode: string): Promise<{ ok: boolean; message: string }> {
    this.ensureDb();
    const address = this.normalizeWallet(wallet);

    const invitee = await getCampaignUser(address);
    if (!invitee) {
      throw new CampaignError('Sign in before claiming a referral.', 'no_user', 401);
    }

    const existing = await getReferralOfReferee(invitee.id);
    if (existing) {
      return { ok: false, message: 'This wallet already has a referrer.' };
    }

    const referrer = await getCampaignUserByReferralCode(referralCode);
    if (!referrer) {
      return { ok: false, message: 'That referral code does not match any campaign participant.' };
    }
    if (referrer.walletAddress === address) {
      await writeAudit({
        wallet: address,
        missionCode: 'community_verified_referral',
        event: 'referral_rejected',
        detail: { reason: 'self_referral', code: referralCode },
      });
      return { ok: false, message: 'A wallet cannot refer itself.' };
    }

    const refusal = await recordReferral(referrer.id, invitee.id, referrer.walletAddress, address);
    if (refusal) {
      await writeAudit({
        wallet: address,
        missionCode: 'community_verified_referral',
        event: 'referral_rejected',
        detail: { reason: refusal, referrerWallet: referrer.walletAddress },
      });
      return { ok: false, message: refusal };
    }

    await writeAudit({
      wallet: address,
      missionCode: 'community_verified_referral',
      event: 'referral_registered',
      detail: { referrerWallet: referrer.walletAddress, code: referralCode },
    });
    return {
      ok: true,
      message: 'Referral recorded. Your referrer earns their boost once you buy SS4 in the presale.',
    };
  }

  /**
   * Link a Telegram account from a Login Widget payload, then check membership immediately.
   *
   * The payload's signature is verified against the bot token before anything is stored, so a client
   * cannot claim an account it does not control. A payload for an account already linked to another
   * wallet is refused by the unique index — one Telegram account earns the Telegram missions once.
   */
  async linkTelegram(wallet: string, payload: TelegramLoginPayload): Promise<{ ok: boolean; message: string }> {
    this.ensureDb();
    const address = this.normalizeWallet(wallet);
    const user = await getCampaignUser(address);
    if (!user) throw new CampaignError('Sign in before linking Telegram.', 'no_user', 401);

    const verified = verifyTelegramLogin(payload);
    if (!verified) {
      return { ok: false, message: 'That Telegram sign-in could not be verified. Try again from the widget.' };
    }

    const linked = await linkTelegramAccount(user.id, verified.telegramUserId, verified.username);
    if (!linked) {
      return { ok: false, message: 'That Telegram account is already linked to another wallet.' };
    }

    await writeAudit({
      wallet: address,
      missionCode: null,
      event: 'telegram_linked',
      detail: { telegramUserId: verified.telegramUserId, username: verified.username },
    });

    // Verify straight away: the user just came from Telegram, so this is the moment they expect the
    // mission to move rather than after a poll.
    await this.evaluate(address, { force: true });
    return { ok: true, message: 'Telegram linked.' };
  }

  // -------------------------------------------------------------------------
  // Evaluation
  // -------------------------------------------------------------------------

  /**
   * Run every automatic verifier for a wallet and persist the outcomes.
   *
   * Returns the per-mission results so the profile can show a live reason for anything that could not
   * be checked, which a completion row cannot carry (it stores what happened, not what failed).
   */
  async evaluate(
    wallet: string,
    options: { force?: boolean } = {},
  ): Promise<Map<string, VerifierResult>> {
    this.ensureDb();
    const address = this.normalizeWallet(wallet);
    const results = new Map<string, VerifierResult>();

    const user = await getCampaignUser(address);
    if (!user) throw new CampaignError('This wallet has not joined the campaign yet.', 'no_user', 404);

    const last = this.lastEvaluated.get(address) ?? 0;
    if (!options.force && Date.now() - last < EVALUATION_TTL_MS) {
      return results; // Caller falls back to the stored completion rows, which are still authoritative.
    }
    this.lastEvaluated.set(address, Date.now());

    // Every source read once, in parallel. The balance pair in particular must be one observation —
    // see onchain-balances.ts on why `onchain_bot_usdt_ready` depends on that.
    const [balances, dca, game, pass, qualifiedReferrals] = await Promise.all([
      readBalances(address),
      readDcaActivity(address),
      readGameActivity(address),
      readPassPurchase(address),
      readQualifiedReferrals(user.id),
    ]);
    const context: EvaluationContext = { wallet: address, user, balances, dca, game, pass, qualifiedReferrals };

    // The completion bonuses are derived from the others, so they are evaluated in a second pass below.
    for (const mission of CAMPAIGN_MISSIONS) {
      if (!mission.active || mission.verificationType === 'completion') continue;
      if (mission.verificationType === 'wallet_session') continue; // Granted at sign-in.

      const result = await this.runVerifier(mission, context);
      results.set(mission.code, result);
      await this.persist(user, mission, result);
    }

    await this.evaluateCompletionBonuses(user, results);
    return results;
  }

  /** Dispatch one mission to its verifier. */
  private async runVerifier(mission: CampaignMission, ctx: EvaluationContext): Promise<VerifierResult> {
    switch (mission.verificationType) {
      case 'onchain_balance':
        return this.runBalanceVerifier(mission, ctx);

      case 'dca_record':
        return mission.code === 'onchain_create_dca_plan'
          ? verifyDcaPlanCount(ctx.dca, mission.threshold ?? '1')
          : verifyDcaExecutions(ctx.dca, mission.threshold ?? '1');

      case 'game_session':
        return verifyGameSessions(ctx.game, mission.threshold ?? '1');

      case 'game_pass':
        return verifyPassPurchase(ctx.pass);

      case 'referral': {
        const target = Number(mission.threshold ?? '1') || 1;
        const { count, firstPurchaseReference } = ctx.qualifiedReferrals;
        if (count >= target) {
          // The reference is the qualifying purchase, not the count: it is what the completion row
          // has to be able to point at to answer for the reward on its own.
          return met('campaign_referrals:qualified', firstPurchaseReference ?? `qualified:${count}`, {
            qualified: count,
            target,
            firstPurchaseReference,
          });
        }
        return notMet('campaign_referrals:qualified', { current: count, target });
      }

      case 'telegram':
        return verifyTelegramMembership(mission.code, ctx.user.telegramUserId);

      case 'x':
        return verifyXMission(mission.code, ctx.user.xUserId);

      default:
        return notMet(`unhandled:${mission.verificationType}`);
    }
  }

  private runBalanceVerifier(mission: CampaignMission, ctx: EvaluationContext): VerifierResult {
    const botThreshold = getMission('onchain_hold_bot')?.threshold ?? '1000000000000000000';
    const stableThreshold = getMission('onchain_hold_usdt')?.threshold ?? '10000000';

    if (mission.code === 'onchain_hold_bot') return verifyHoldBot(ctx.balances, mission.threshold ?? botThreshold);
    if (mission.code === 'onchain_hold_usdt') {
      return verifyHoldStable(ctx.balances, mission.threshold ?? stableThreshold);
    }
    return verifyBotAndStableReady(ctx.balances, botThreshold, stableThreshold);
  }

  /**
   * Write a verifier's outcome to the completion row.
   *
   * Only `met` writes `completed`. An `unavailable` result writes `verifying` — which is exactly what
   * the spec's mission-state list means by that word — and a plain `met: false` writes nothing at all.
   *
   * Writing nothing on a clean "not yet" is deliberate: a row per unearned mission per wallet would be
   * twenty rows of noise for a wallet that has done one thing, and `listCompletions` already treats a
   * missing row as `available`. It also keeps `recordCompletion`'s "never move a completed row" rule
   * from having to reason about rows that were never earned.
   */
  private async persist(
    user: CampaignUserRow,
    mission: CampaignMission,
    result: VerifierResult,
  ): Promise<void> {
    if (result.met) {
      const newlyCompleted = await recordCompletion({
        campaignUserId: user.id,
        missionCode: mission.code,
        status: 'completed',
        boostBpsAwarded: mission.boostBps,
        verificationSource: result.source,
        verificationReference: result.reference,
      });
      if (newlyCompleted) {
        await writeAudit({
          wallet: user.walletAddress,
          missionCode: mission.code,
          event: 'mission_completed',
          detail: {
            boostBps: mission.boostBps,
            source: result.source,
            reference: result.reference,
            ...(result.detail ?? {}),
          },
        });
      }
      return;
    }

    if (isUnavailable(result)) {
      await recordCompletion({
        campaignUserId: user.id,
        missionCode: mission.code,
        status: 'verifying',
        boostBpsAwarded: 0,
        verificationSource: result.source,
        verificationReference: null,
      });
    }
  }

  /**
   * Grant or withhold each section's completion bonus.
   *
   * Re-derived on every pass rather than granted once, which is what the spec means by "completion
   * bonuses must be automatically revoked/not granted if the underlying required mission was never
   * successfully verified". Because completions are one-way, in practice this only ever moves forward —
   * but it is derived from the inputs rather than from its own history, so it cannot outlive them.
   */
  private async evaluateCompletionBonuses(
    user: CampaignUserRow,
    results: Map<string, VerifierResult>,
  ): Promise<void> {
    const stored = await listCompletions(user.id);
    const completed = new Set(stored.filter((c) => c.status === 'completed').map((c) => c.missionCode));

    for (const section of CAMPAIGN_SECTIONS) {
      const inputs = completionInputs(section);
      const outstanding = inputs.filter((m) => !completed.has(m.code));
      const code = COMPLETION_MISSION_BY_SECTION[section];
      const mission = getMission(code);
      if (!mission) continue;

      if (outstanding.length === 0) {
        const newlyCompleted = await recordCompletion({
          campaignUserId: user.id,
          missionCode: code,
          status: 'completed',
          boostBpsAwarded: mission.boostBps,
          verificationSource: 'campaign:section_complete',
          verificationReference: inputs.map((m) => m.code).join(','),
        });
        results.set(code, met('campaign:section_complete', inputs.map((m) => m.code).join(',')));
        if (newlyCompleted) {
          await writeAudit({
            wallet: user.walletAddress,
            missionCode: code,
            event: 'mission_completed',
            detail: { boostBps: mission.boostBps, section, inputs: inputs.map((m) => m.code) },
          });
        }
      } else {
        results.set(
          code,
          notMet('campaign:section_complete', {
            current: inputs.length - outstanding.length,
            target: inputs.length,
          }),
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Boost arithmetic
  // -------------------------------------------------------------------------

  /**
   * The boost a wallet is currently entitled to, in bps, and the missions it came from.
   *
   * The arithmetic itself is `computeBoostBps` in campaign-missions.ts, beside the rates it sums and
   * the assertion that keeps them consistent. This method's only job is deciding what "completed"
   * means: a stored row with status `completed`, and nothing else.
   */
  private computeBoost(completions: MissionCompletionRow[]): {
    boostBps: number;
    perSection: Record<CampaignSection, number>;
    missionCodes: string[];
  } {
    return computeBoostBps(
      completions.filter((c) => c.status === 'completed').map((c) => c.missionCode),
    );
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** The full campaign dashboard for one wallet. */
  async getProfile(wallet: string, options: { force?: boolean } = {}): Promise<CampaignProfile> {
    this.ensureDb();
    const address = this.normalizeWallet(wallet);

    const user = await getCampaignUser(address);
    if (!user) throw new CampaignError('This wallet has not joined the campaign yet.', 'no_user', 404);

    // Live results carry the reason an unverifiable mission could not be checked; an empty map means
    // the throttle skipped the pass and the stored rows are the whole picture.
    let live = new Map<string, VerifierResult>();
    try {
      live = await this.evaluate(address, options);
    } catch (err) {
      // A verifier storm must not take the dashboard down: the stored completions are still the
      // authoritative record of what this wallet has earned.
      this.logger.warn(`Evaluation failed for ${address}: ${(err as Error).message}`);
    }

    const [completions, referrals, saleState] = await Promise.all([
      listCompletions(user.id),
      listReferralsByReferrer(user.id),
      this.vouchers.readSaleState(),
    ]);

    const byCode = new Map(completions.map((c) => [c.missionCode, c]));
    const { boostBps, perSection } = this.computeBoost(completions);
    const completed = new Set(completions.filter((c) => c.status === 'completed').map((c) => c.missionCode));

    const sections: SectionView[] = CAMPAIGN_SECTIONS.map((section) => {
      const missions = CAMPAIGN_MISSIONS.filter((m) => m.section === section && m.active).map((mission) =>
        this.toMissionView(mission, byCode.get(mission.code), live.get(mission.code)),
      );
      return {
        section,
        earnedBps: perSection[section],
        maxBps: sectionMaxBps(section),
        missions,
        completionOutstanding: completionInputs(section)
          .filter((m) => !completed.has(m.code))
          .map((m) => m.code),
      };
    });

    // Read from the referral row rather than resolving `referredBy` to a wallet: the row is the
    // record the reward is paid against, so showing anything else could disagree with it.
    const referredByWallet = user.referredBy ? await this.referrerWalletOf(user) : null;

    return {
      wallet: address,
      chainId: user.chainId,
      referralCode: user.referralCode,
      referredByWallet,
      telegramLinked: Boolean(user.telegramUserId),
      telegramUsername: user.telegramUsername,
      xLinked: Boolean(user.xUserId),
      xHandle: user.xHandle,
      boostBps,
      maxBoostBps: campaignMaxBps(),
      sections,
      referrals: {
        total: referrals.length,
        qualified: referrals.filter((r) => r.status === 'qualified' || r.status === 'rewarded').length,
        invited: referrals.map((r) => ({
          wallet: r.referredWallet,
          status: r.status,
          qualifiedAt: r.qualifiedAt?.toISOString() ?? null,
        })),
      },
      sale: saleState
        ? {
            presaleAddress: saleState.presaleAddress,
            maxCampaignBoostBps: saleState.maxCampaignBoostBps,
            bonusRemaining: saleState.bonusRemaining,
            campaignEpoch: saleState.campaignEpoch,
          }
        : null,
      evaluatedAt: new Date().toISOString(),
    };
  }

  private async referrerWalletOf(user: CampaignUserRow): Promise<string | null> {
    const referral = await getReferralOfReferee(user.id);
    return referral?.referrerWallet ?? null;
  }

  /**
   * One mission's view, merging what was stored with what the live pass observed.
   *
   * The status precedence — completed, then whatever the live result says, then the stored status —
   * is what keeps a transient RPC failure from making an already-earned mission look unverified.
   */
  private toMissionView(
    mission: CampaignMission,
    stored: MissionCompletionRow | undefined,
    live: VerifierResult | undefined,
  ): MissionView {
    const verificationAvailable = this.isVerificationAvailable(mission);

    let status: MissionStatus;
    let note: string | null = null;
    let progress: { current: number; target: number } | null = null;

    if (stored?.status === 'completed') {
      status = 'completed';
    } else if (live && isUnavailable(live)) {
      status = 'verifying';
      note = live.reason;
    } else if (live && !live.met) {
      status = 'available';
      progress = live.progress ?? null;
    } else if (live?.met) {
      // Completed on this very pass; the stored row was written a moment ago.
      status = 'completed';
    } else if (stored?.status === 'verifying') {
      status = 'verifying';
      note = 'Waiting on verification.';
    } else if (stored?.status === 'failed') {
      status = 'failed';
      note = 'This mission was withdrawn by the team.';
    } else {
      status = 'available';
    }

    if (!verificationAvailable && status !== 'completed') {
      status = 'verifying';
      note = note ?? this.unavailableReason(mission);
    }

    return {
      code: mission.code,
      section: mission.section,
      name: mission.name,
      requirement: mission.requirement,
      boostBps: mission.boostBps,
      status,
      earned: stored?.status === 'completed' || live?.met === true,
      verificationType: mission.verificationType,
      verificationAvailable,
      note,
      progress,
      verifiedAt: stored?.verifiedAt?.toISOString() ?? null,
      verificationSource: stored?.verificationSource ?? null,
    };
  }

  /** Whether this deployment can check a mission automatically at all. */
  private isVerificationAvailable(mission: CampaignMission): boolean {
    switch (mission.verificationType) {
      case 'x':
        return xVerificationAvailable();
      case 'telegram':
        return telegramTargets().some((t) => t.missionCode === mission.code);
      case 'onchain_balance':
        // The BOT reading needs no token; the two stablecoin missions do.
        return mission.code === 'onchain_hold_bot' ? true : Boolean(campaignStableToken());
      default:
        return true;
    }
  }

  private unavailableReason(mission: CampaignMission): string {
    if (mission.verificationType === 'x') {
      return 'X verification is not available yet — the team confirms this mission manually.';
    }
    if (mission.verificationType === 'telegram') {
      return 'The Telegram channel for this mission is not configured yet.';
    }
    return 'This mission cannot be checked automatically on this deployment yet.';
  }

  // -------------------------------------------------------------------------
  // Vouchers
  // -------------------------------------------------------------------------

  /**
   * Issue a signed voucher for a wallet's current boost.
   *
   * Always re-evaluates first, ignoring the poll throttle. The voucher is the moment the campaign
   * commits to a number in a signature, so it must be scored against the wallet's state now rather
   * than against whatever a page last displayed. That is also what makes the short TTL safe: a wallet
   * that has just qualified gets the new rate on its next request rather than having to wait one out.
   *
   * The nonce is allocated *before* signing and recorded with the boost and the mission list it came
   * from, so `campaign_vouchers` answers all six of the spec's §15 audit questions for every
   * attestation whether or not it is ever spent.
   */
  async issueVoucher(wallet: string): Promise<{
    voucher: SignedVoucher;
    boostBps: number;
    missionCodes: string[];
    maxBoostBps: number;
  }> {
    this.ensureDb();
    const address = this.normalizeWallet(wallet);

    const user = await getCampaignUser(address);
    if (!user) throw new CampaignError('This wallet has not joined the campaign yet.', 'no_user', 404);

    await this.evaluate(address, { force: true });
    const completions = await listCompletions(user.id);
    const { boostBps, missionCodes } = this.computeBoost(completions);

    const state = await this.vouchers.readSaleState();
    if (!state) {
      throw new CampaignError(
        'The campaign cannot reach the presale contract right now. Try again in a moment.',
        'sale_unavailable',
        503,
      );
    }

    /**
     * The expiry is pinned before the nonce is allocated and then signed verbatim, so the row and the
     * signature carry the same deadline. Recording an approximation would make `campaign_vouchers`
     * unable to answer whether a voucher the chain refused was actually expired.
     */
    const deadline = this.vouchers.nextDeadline();
    const nonce = await issueVoucherRecord({
      campaignUserId: user.id,
      walletAddress: address,
      chainId: state.chainId,
      presaleAddress: state.presaleAddress,
      boostBps,
      missionCodes,
      campaignEpoch: state.campaignEpoch,
      deadline: new Date(deadline * 1000),
    });

    try {
      const signed = await this.vouchers.signVoucher({ wallet: address, boostBps, nonce, deadline });
      await writeAudit({
        wallet: address,
        missionCode: null,
        event: 'voucher_issued',
        detail: {
          nonce: nonce.toString(),
          boostBps,
          missionCodes,
          deadline: signed.voucher.deadline,
          presaleAddress: signed.voucher.presaleAddress,
          campaignEpoch: signed.voucher.campaignEpoch,
        },
      });
      return {
        voucher: signed.voucher,
        boostBps,
        missionCodes,
        maxBoostBps: state.maxCampaignBoostBps,
      };
    } catch (err) {
      // The nonce row stays: it is a record that this backend allocated the value, and reusing it
      // after a failed signature would let a later voucher share a nonce with an in-flight one.
      await writeAudit({
        wallet: address,
        missionCode: null,
        event: 'voucher_refused',
        detail: { nonce: nonce.toString(), boostBps, reason: (err as Error).message },
      });
      if (err instanceof VoucherError) {
        throw new CampaignError(err.message, err.code, err.status);
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Game-section progress, for Echo Arena
  // -------------------------------------------------------------------------

  /**
   * The Game Activity section for one wallet, whether or not it has joined the campaign.
   *
   * WHY THIS EXISTS AS ITS OWN READ. Echo Arena needs to tell a player that their runs are earning a
   * presale boost, and it needs to do that *before* they have signed into the campaign — that is the
   * whole conversion path the spec's Part 3 describes. Going through `getProfile` would be wrong twice:
   * it requires a campaign identity, and it would make the game a second campaign dashboard with its
   * own copy of the rates.
   *
   * So the missions are evaluated here from the same verifiers and the same catalog the presale uses,
   * and the game renders what it is told. Nothing is written: a wallet that has not joined gets its
   * progress computed and `joined: false`, and no campaign row is created by looking.
   *
   * ON EXPOSURE. This is deliberately session-free, because the game calls it server-side for its own
   * signed-in wallet and there is nothing here a session would protect: the numbers are how many Echo
   * Arena runs an address has filed and whether it holds a Game Pass — both already public, in the
   * game's own leaderboard and in the on-chain purchase respectively. It grants nothing, and no
   * voucher can be issued through it.
   */
  async getGameProgress(wallet: string): Promise<{
    wallet: string
    joined: boolean
    /** The game section's earned and maximum boost, in bps. */
    earnedBps: number
    maxBps: number
    /** The whole campaign's maximum, so the game can size the opportunity honestly. */
    campaignMaxBps: number
    validSessions: number
    passPurchased: boolean
    missions: MissionView[]
  }> {
    this.ensureDb();
    const address = this.normalizeWallet(wallet);

    const [game, pass, user] = await Promise.all([
      readGameActivity(address),
      readPassPurchase(address),
      getCampaignUser(address),
    ]);

    // Stored completions matter even here: a mission verified once is earned, so a player who has
    // since deleted... nothing, in fact — but a wallet whose 10th run was counted last week must not
    // show as unearned if the run ledger read fails right now.
    const stored = user ? await listCompletions(user.id) : [];
    const byCode = new Map(stored.map((c) => [c.missionCode, c]));

    /**
     * The verifiable missions first, then the completion bonus derived from them.
     *
     * Two passes rather than one, deliberately: a single pass would have the bonus read the results
     * accumulated so far, which is only correct while the bonus happens to be last in the catalog.
     * Reordering `GAME_MISSIONS` would then silently under-report it here while the presale page —
     * which derives it separately — kept reporting it correctly.
     */
    const views = new Map<string, MissionView>();
    for (const mission of missionsInSection('game')) {
      if (!mission.active || mission.verificationType === 'completion') continue;
      const result =
        mission.verificationType === 'game_pass'
          ? verifyPassPurchase(pass)
          : verifyGameSessions(game, mission.threshold ?? '1');
      views.set(mission.code, this.toMissionView(mission, byCode.get(mission.code), result));
    }

    for (const mission of missionsInSection('game')) {
      if (!mission.active || mission.verificationType !== 'completion') continue;
      const inputs = completionInputs('game');
      const done = inputs.filter((m) => views.get(m.code)?.earned).length;
      const result =
        done === inputs.length
          ? met('campaign:section_complete', inputs.map((m) => m.code).join(','))
          : notMet('campaign:section_complete', { current: done, target: inputs.length });
      views.set(mission.code, this.toMissionView(mission, byCode.get(mission.code), result));
    }

    // Rebuilt in catalog order so the game renders the missions in the same sequence the presale does.
    const missions = missionsInSection('game')
      .filter((m) => m.active)
      .map((m) => views.get(m.code))
      .filter((v): v is MissionView => Boolean(v));
    const earnedBps = missions.reduce(
      (total, view) => (view.earned ? total + view.boostBps : total),
      0,
    );

    return {
      wallet: address,
      joined: Boolean(user),
      earnedBps: Math.min(earnedBps, sectionMaxBps('game')),
      maxBps: sectionMaxBps('game'),
      campaignMaxBps: campaignMaxBps(),
      validSessions: game?.validSessions ?? 0,
      passPurchased: Boolean(pass),
      missions,
    };
  }

  // -------------------------------------------------------------------------
  // Public campaign description
  // -------------------------------------------------------------------------

  /**
   * The campaign as anyone can read it, with no wallet attached.
   *
   * Serves the presale page's mission list before a wallet connects, so the page can render the whole
   * campaign — and its honest verification status — to a visitor who has not signed anything.
   */
  async getPublicStatus(): Promise<{
    chainId: number;
    maxBoostBps: number;
    sections: Array<{
      section: CampaignSection;
      maxBps: number;
      missions: Array<{
        code: string;
        name: string;
        requirement: string;
        boostBps: number;
        verificationType: string;
        verificationAvailable: boolean;
      }>;
    }>;
    readiness: ReturnType<typeof campaignReadiness>;
    sale: Awaited<ReturnType<CampaignVoucherService['readSaleState']>>;
    social: { telegram: Array<{ missionCode: string; label: string }>; x: Array<{ missionCode: string; handle: string; label: string }> };
  }> {
    return {
      chainId: campaignChainId(),
      maxBoostBps: campaignMaxBps(),
      sections: CAMPAIGN_SECTIONS.map((section) => ({
        section,
        maxBps: sectionMaxBps(section),
        missions: CAMPAIGN_MISSIONS.filter((m) => m.section === section && m.active).map((m) => ({
          code: m.code,
          name: m.name,
          requirement: m.requirement,
          boostBps: m.boostBps,
          verificationType: m.verificationType,
          verificationAvailable: this.isVerificationAvailable(m),
        })),
      })),
      readiness: campaignReadiness(),
      sale: await this.vouchers.readSaleState(),
      social: {
        telegram: telegramTargets().map((t) => ({ missionCode: t.missionCode, label: t.label })),
        x: xTargets(),
      },
    };
  }
}
