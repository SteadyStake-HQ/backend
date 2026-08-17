/**
 * Operator surface for the Early Supporter Campaign (campaign spec §14 items 11 and 12).
 *
 * Behind `ADMIN_API_TOKEN` like the plan controls, and for a stronger reason than they have: these
 * endpoints can grant a wallet a Presale Boost by hand. That is the only path to the three X missions
 * while the X integration is offline, so it is a route that has to exist — and it is therefore also the
 * most abusable thing in the campaign. Every call through it is written to `campaign_audit_log` with
 * the note the operator supplied, so a granted mission is never anonymous.
 *
 * The guard fails closed when `ADMIN_API_TOKEN` is unset, which matters here: an unconfigured
 * deployment must not leave a "grant anyone 1%" endpoint open.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { isAddress } from 'viem';
import { AdminTokenGuard } from '../admin/admin-token.guard';
import {
  getCampaignTotals,
  getCampaignUser,
  listAudit,
  listCompletions,
  listParticipants,
  listVouchers,
  recordCompletion,
  revokeCompletion,
  setIndexCursor,
  writeAudit,
} from '../supabase/campaign-store';
import { campaignReadiness } from './campaign-config';
import { CAMPAIGN_MISSIONS, getMission, isMissionCode } from './campaign-missions';
import { CampaignService } from './campaign.service';
import { CampaignVoucherService } from './campaign-voucher';
import { PresaleIndexerService } from './presale-indexer';

@UseGuards(AdminTokenGuard)
@Controller('api/admin/campaign')
export class CampaignAdminController {
  constructor(
    private readonly campaign: CampaignService,
    private readonly vouchers: CampaignVoucherService,
    private readonly indexer: PresaleIndexerService,
  ) {}

  /**
   * GET /api/admin/campaign/overview — is the campaign actually working, and how is it doing?
   *
   * `readiness` is the half operators most need: it lists the missions this deployment cannot verify
   * and why, so "nobody is completing the X missions" is visibly a configuration fact rather than a
   * mystery. `signerMatches` compares the configured signing key against the sale's own record of who
   * holds CAMPAIGN_SIGNER_ROLE — the single most likely reason every voucher would be rejected.
   */
  @Get('overview')
  async overview() {
    const [totals, saleState] = await Promise.all([getCampaignTotals(), this.vouchers.readSaleState()]);
    const readiness = campaignReadiness();
    const signerAddress = this.vouchers.signerAddress();

    return {
      ok: true,
      readiness,
      signerAddress,
      sale: saleState,
      /**
       * A configured signer whose address the deployment record does not name is the failure that
       * looks like "vouchers just don't work". Reported rather than asserted, because the record can
       * legitimately lag a key rotation — the chain's own role grant is the authority.
       */
      signerNote: signerAddress
        ? 'Confirm this address holds CAMPAIGN_SIGNER_ROLE on the sale above; the chain is the authority.'
        : 'No SS4_CAMPAIGN_SIGNER_KEY is configured, so no vouchers can be issued.',
      missions: CAMPAIGN_MISSIONS.map((m) => ({
        code: m.code,
        section: m.section,
        boostBps: m.boostBps,
        verificationType: m.verificationType,
      })),
      totals,
    };
  }

  /** GET /api/admin/campaign/participants?search=&limit=&offset= */
  @Get('participants')
  async participants(
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const result = await listParticipants({
      search,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
    return { ok: true, ...result };
  }

  /**
   * GET /api/admin/campaign/participant/:wallet — one wallet, in full.
   *
   * Includes its vouchers, which is what makes a disputed boost answerable: every attestation this
   * backend signed, what it was worth, which missions produced it, and whether the chain spent it.
   */
  @Get('participant')
  async participant(@Query('wallet') wallet?: string) {
    const address = (wallet ?? '').trim();
    if (!isAddress(address)) {
      throw new BadRequestException({ ok: false, error: 'A valid wallet address is required.' });
    }
    const user = await getCampaignUser(address);
    if (!user) throw new NotFoundException({ ok: false, error: 'That wallet has not joined the campaign.' });

    const [profile, completions, vouchers, audit] = await Promise.all([
      this.campaign.getProfile(address).catch(() => null),
      listCompletions(user.id),
      listVouchers(user.id, 50),
      listAudit({ wallet: address, limit: 100 }),
    ]);

    return { ok: true, user, profile, completions, vouchers, audit };
  }

  /**
   * POST /api/admin/campaign/verify { wallet, missionCode, note, reference? }
   *
   * Record a mission as complete on an operator's authority. The only route to the X missions while X
   * verification is offline, and deliberately usable for nothing else automatic — an operator marking
   * `onchain_hold_bot` complete by hand would be overriding a check that works, so the note is
   * mandatory and the audit row names the mission, the operator's note and the evidence reference.
   *
   * The completion bonus is re-derived afterwards rather than granted here: an operator completing the
   * last outstanding community mission should see the +0.20% appear, and deriving it keeps that one
   * rule in one place.
   */
  @Post('verify')
  async verifyByHand(
    @Body() body: { wallet?: string; missionCode?: string; note?: string; reference?: string },
  ) {
    const address = (body?.wallet ?? '').trim();
    const missionCode = (body?.missionCode ?? '').trim();
    const note = (body?.note ?? '').trim();

    if (!isAddress(address)) {
      throw new BadRequestException({ ok: false, error: 'A valid wallet address is required.' });
    }
    if (!isMissionCode(missionCode)) {
      throw new BadRequestException({ ok: false, error: `Unknown mission code: ${missionCode}` });
    }
    if (!note) {
      throw new BadRequestException({
        ok: false,
        error: 'A note recording the evidence is required — this grants a real presale boost.',
      });
    }

    const mission = getMission(missionCode);
    if (mission?.verificationType === 'completion') {
      throw new BadRequestException({
        ok: false,
        error: 'Completion bonuses are derived from their section’s missions and cannot be granted directly.',
      });
    }

    const user = await getCampaignUser(address);
    if (!user) throw new NotFoundException({ ok: false, error: 'That wallet has not joined the campaign.' });

    const newlyCompleted = await recordCompletion({
      campaignUserId: user.id,
      missionCode,
      status: 'completed',
      boostBpsAwarded: mission?.boostBps ?? 0,
      verificationSource: 'admin:manual',
      verificationReference: (body?.reference ?? '').trim() || null,
    });

    await writeAudit({
      wallet: address,
      missionCode,
      event: newlyCompleted ? 'mission_completed_by_operator' : 'mission_already_complete',
      detail: { note, reference: body?.reference ?? null, boostBps: mission?.boostBps ?? 0 },
    });

    const profile = await this.campaign.getProfile(address, { force: true }).catch(() => null);
    return { ok: true, newlyCompleted, boostBps: profile?.boostBps ?? null, profile };
  }

  /**
   * POST /api/admin/campaign/revoke { wallet, missionCode, note }
   *
   * Withdraw a mission awarded in error. Note the limit, which is real and not a bug: vouchers already
   * signed keep their rate until they expire, because a signature cannot be recalled by a database
   * write. To invalidate outstanding vouchers, call `bumpCampaignEpoch()` on the sale — that is the
   * lever built for it, and it is admin-only on the contract rather than reachable from here, because
   * it invalidates *every* wallet's voucher and should not be one HTTP call away.
   */
  @Post('revoke')
  async revoke(@Body() body: { wallet?: string; missionCode?: string; note?: string }) {
    const address = (body?.wallet ?? '').trim();
    const missionCode = (body?.missionCode ?? '').trim();
    const note = (body?.note ?? '').trim();

    if (!isAddress(address)) {
      throw new BadRequestException({ ok: false, error: 'A valid wallet address is required.' });
    }
    if (!isMissionCode(missionCode)) {
      throw new BadRequestException({ ok: false, error: `Unknown mission code: ${missionCode}` });
    }
    if (!note) {
      throw new BadRequestException({ ok: false, error: 'A note recording the reason is required.' });
    }

    const user = await getCampaignUser(address);
    if (!user) throw new NotFoundException({ ok: false, error: 'That wallet has not joined the campaign.' });

    const revoked = await revokeCompletion(user.id, missionCode, 'admin:revoked');
    await writeAudit({
      wallet: address,
      missionCode,
      event: 'mission_revoked_by_operator',
      detail: { note, revoked },
    });

    const profile = await this.campaign.getProfile(address, { force: true }).catch(() => null);
    return {
      ok: true,
      revoked,
      boostBps: profile?.boostBps ?? null,
      note: 'Vouchers already signed keep their rate until they expire. Bump the sale’s campaign epoch to invalidate them.',
    };
  }

  /** GET /api/admin/campaign/audit?wallet=&event=&limit= — the append-only decision trail. */
  @Get('audit')
  async audit(
    @Query('wallet') wallet?: string,
    @Query('event') event?: string,
    @Query('limit') limit?: string,
  ) {
    return {
      ok: true,
      entries: await listAudit({
        wallet: wallet?.trim() || undefined,
        event: event?.trim() || undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
      }),
    };
  }

  /** POST /api/admin/campaign/index — run the presale event indexer now. */
  @Post('index')
  async index() {
    return { ok: true, result: await this.indexer.sync() };
  }

  /**
   * POST /api/admin/campaign/cursor { chainId, presaleAddress, fromBlock }
   *
   * Rewind (or fast-forward) the indexer. The one operation a fresh sale needs: the indexer starts at
   * the safe head rather than scanning a chain's whole history, so backfilling a sale that has already
   * taken purchases means pointing it at the sale's deployment block by hand.
   */
  @Post('cursor')
  async cursor(@Body() body: { chainId?: number; presaleAddress?: string; fromBlock?: string | number }) {
    const chainId = Number(body?.chainId);
    const presaleAddress = (body?.presaleAddress ?? '').trim();
    const fromBlock = body?.fromBlock;

    if (!Number.isFinite(chainId) || !isAddress(presaleAddress) || fromBlock === undefined) {
      throw new BadRequestException({
        ok: false,
        error: 'chainId, presaleAddress and fromBlock are all required.',
      });
    }

    let block: bigint;
    try {
      block = BigInt(String(fromBlock));
    } catch {
      throw new BadRequestException({ ok: false, error: 'fromBlock must be a whole number.' });
    }
    if (block < 0n) throw new BadRequestException({ ok: false, error: 'fromBlock must not be negative.' });

    // The cursor means "already read", so the next sync starts at block + 1. Storing `block - 1` lets
    // an operator pass the sale's deployment block and have it actually read that block's logs.
    const stored = block > 0n ? block - 1n : 0n;
    await setIndexCursor(chainId, presaleAddress, stored);
    await writeAudit({
      wallet: null,
      missionCode: null,
      event: 'indexer_cursor_set',
      detail: { chainId, presaleAddress: presaleAddress.toLowerCase(), nextBlock: block.toString() },
    });

    return { ok: true, chainId, presaleAddress: presaleAddress.toLowerCase(), nextBlock: block.toString() };
  }
}
