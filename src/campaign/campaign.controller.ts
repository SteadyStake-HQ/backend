/**
 * The Early Supporter Campaign's player API.
 *
 * Two tiers of access, and the split is deliberate:
 *
 *   - `GET /status` is open. It describes the campaign — missions, rates, which verifications this
 *     deployment can actually perform — and names no wallet, so the presale page can render the whole
 *     thing to a visitor who has not connected anything.
 *
 *   - Everything else requires a campaign session, minted by signing a SIWE challenge. Not because the
 *     data is secret, but because these endpoints *write*: they link a Telegram account to a wallet,
 *     record a referral relationship, and issue signed vouchers. Each of those is a claim only the
 *     wallet's owner may make. See campaign-auth.ts.
 *
 * A session grants no boost. Every boost is re-derived from authoritative records at voucher time, so
 * the worst a stolen session can do is read a progress page — which is why there is no session
 * revocation surface here.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  Headers,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { isAddress } from 'viem';
import {
  buildSignInMessage,
  createSessionToken,
  newNonce,
  NONCE_TTL_SECONDS,
  readSessionToken,
  verifyWalletSignature,
} from './campaign-auth';
import { campaignChainId, isCampaignChain, sessionSecret } from './campaign-config';
import { CampaignError, CampaignService } from './campaign.service';
import {
  consumeAuthNonce,
  createAuthNonce,
  expireStaleAuthNonces,
  writeAudit,
} from '../supabase/campaign-store';
import type { TelegramLoginPayload } from './verifiers/social';

@Controller('api/campaign')
export class CampaignController {
  constructor(private readonly campaign: CampaignService) {}

  /**
   * Translate the service's typed errors into HTTP without losing their code.
   *
   * The `code` matters to the client: the presale page distinguishes "you have not joined yet" (open a
   * session) from "the sale cannot be read" (show a banner and retry) from "your voucher expired"
   * (request another), and a bare status would collapse all three.
   */
  private rethrow(err: unknown): never {
    if (err instanceof CampaignError) {
      throw new HttpException({ ok: false, error: err.message, code: err.code }, err.status);
    }
    throw err;
  }

  /** The address a request's session vouches for, or a 401. */
  private requireSession(authorization: string | undefined): { address: string; chainId: number } {
    if (!sessionSecret()) {
      throw new ServiceUnavailableException({
        ok: false,
        error: 'Campaign sign-in is disabled: CAMPAIGN_SESSION_SECRET is not set on this backend.',
        code: 'no_session_secret',
      });
    }
    const session = readSessionToken(authorization);
    if (!session) {
      throw new HttpException(
        { ok: false, error: 'Sign in with your wallet to use the campaign.', code: 'no_session' },
        401,
      );
    }
    return session;
  }

  // -------------------------------------------------------------------------
  // Public
  // -------------------------------------------------------------------------

  /** GET /api/campaign/status — the whole campaign, no wallet required. */
  @Get('status')
  async status() {
    return { ok: true, ...(await this.campaign.getPublicStatus()) };
  }

  /**
   * GET /api/campaign/game-progress/:wallet — the Game Activity section for one wallet.
   *
   * Session-free on purpose. Echo Arena calls it server-side for its own signed-in wallet so it can
   * tell a player their runs are already earning a presale boost *before* they join the campaign —
   * which is the conversion path Part 3 of the campaign exists to build. It writes nothing, grants
   * nothing, and cannot issue a voucher; see `CampaignService.getGameProgress` on why the two facts it
   * exposes are already public.
   */
  @Get('game-progress/:wallet')
  async gameProgress(@Param('wallet') wallet: string) {
    try {
      return { ok: true, ...(await this.campaign.getGameProgress(wallet)) };
    } catch (err) {
      return this.rethrow(err);
    }
  }

  // -------------------------------------------------------------------------
  // Sign-in
  // -------------------------------------------------------------------------

  /**
   * POST /api/campaign/auth/nonce { wallet, chainId } — a one-shot challenge to sign.
   *
   * The message is built and stored server-side, verbatim, so verification never has to guess how the
   * challenge was worded — a client that reformats a single space would otherwise fail to verify
   * against a message we reconstructed.
   */
  @Post('auth/nonce')
  async nonce(@Body() body: { wallet?: string; chainId?: number; domain?: string; uri?: string }) {
    const wallet = (body?.wallet ?? '').trim();
    if (!isAddress(wallet)) {
      throw new BadRequestException({ ok: false, error: 'A valid wallet address is required.', code: 'bad_wallet' });
    }
    const chainId = Number(body?.chainId ?? campaignChainId());
    if (!isCampaignChain(chainId)) {
      throw new BadRequestException({
        ok: false,
        error: `The campaign runs on chain ${campaignChainId()}. Switch networks and try again.`,
        code: 'wrong_chain',
      });
    }

    // Opportunistic sweep, matching the nonce-sweep style elsewhere in this backend.
    await expireStaleAuthNonces();

    const nonce = newNonce();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + NONCE_TTL_SECONDS * 1000);
    /**
     * The domain and URI are what the wallet shows the user, so they are taken from the request rather
     * than hard-coded — the campaign is reachable from the presale site and from the game, and a
     * message naming the wrong one reads as a phishing attempt. They are sanitised to a hostname and
     * an https URL: an attacker-controlled string here would be text the user is asked to trust.
     */
    const domain = sanitizeDomain(body?.domain) ?? 'presale.steadystake.org';
    const uri = sanitizeUri(body?.uri) ?? `https://${domain}`;

    const message = buildSignInMessage({
      address: wallet,
      nonce,
      domain,
      uri,
      chainId,
      issuedAt: issuedAt.toISOString(),
    });

    await createAuthNonce({ nonce, wallet, chainId, message, expiresAt });
    return { ok: true, nonce, message, expiresAt: expiresAt.toISOString() };
  }

  /**
   * POST /api/campaign/auth/verify { wallet, nonce, signature, referralCode? } — redeem and sign in.
   *
   * The challenge is deleted as it is read, before the signature is even checked, so a captured
   * signature cannot open a second session.
   *
   * `referralCode` is accepted here rather than on a separate call because this is the first moment the
   * wallet is proved *and* the invitee is still holding the link they arrived on. The referral's outcome
   * is reported alongside the session rather than as an error: a stale or self-referring code must not
   * stop someone signing in.
   */
  @Post('auth/verify')
  async verify(
    @Body() body: { wallet?: string; nonce?: string; signature?: string; referralCode?: string },
  ) {
    const wallet = (body?.wallet ?? '').trim();
    const nonce = (body?.nonce ?? '').trim();
    const signature = (body?.signature ?? '').trim();

    if (!isAddress(wallet) || !nonce || !signature) {
      throw new BadRequestException({
        ok: false,
        error: 'wallet, nonce and signature are all required.',
        code: 'bad_request',
      });
    }
    if (!sessionSecret()) {
      throw new ServiceUnavailableException({
        ok: false,
        error: 'Campaign sign-in is disabled: CAMPAIGN_SESSION_SECRET is not set on this backend.',
        code: 'no_session_secret',
      });
    }

    let challenge: { message: string; chainId: number } | null;
    try {
      challenge = await consumeAuthNonce(nonce, wallet);
    } catch (err) {
      return this.rethrow(err);
    }
    if (!challenge) {
      throw new HttpException(
        { ok: false, error: 'That sign-in request expired. Try connecting again.', code: 'nonce_expired' },
        400,
      );
    }

    const signedByWallet = await verifyWalletSignature({
      address: wallet,
      message: challenge.message,
      signature,
      chainId: challenge.chainId,
    });
    if (!signedByWallet) {
      await writeAudit({
        wallet,
        missionCode: null,
        event: 'signin_rejected',
        detail: { reason: 'signature_mismatch' },
      });
      throw new HttpException(
        { ok: false, error: 'That signature does not match the connected wallet.', code: 'bad_signature' },
        401,
      );
    }

    try {
      await this.campaign.ensureUser(wallet, challenge.chainId);

      let referral: { ok: boolean; message: string } | null = null;
      const code = (body?.referralCode ?? '').trim();
      if (code) referral = await this.campaign.claimReferral(wallet, code);

      const session = createSessionToken(wallet, challenge.chainId);
      if (!session) {
        throw new ServiceUnavailableException({
          ok: false,
          error: 'Campaign sign-in is disabled on this backend.',
          code: 'no_session_secret',
        });
      }

      await writeAudit({
        wallet,
        missionCode: null,
        event: 'signin',
        detail: { chainId: challenge.chainId, referralClaimed: referral?.ok ?? null },
      });

      return {
        ok: true,
        token: session.token,
        wallet: session.address,
        chainId: challenge.chainId,
        expiresAt: session.expiresAt.toISOString(),
        referral,
      };
    } catch (err) {
      return this.rethrow(err);
    }
  }

  // -------------------------------------------------------------------------
  // Session-scoped
  // -------------------------------------------------------------------------

  /**
   * GET /api/campaign/me — the wallet's full campaign dashboard.
   *
   * Re-evaluates every mission on the way, subject to a 30-second throttle so an open page does not
   * generate load. `?refresh=1` forces a pass, which is what the "check again" button sends.
   */
  @Get('me')
  async me(@Headers('authorization') authorization: string | undefined, @Query('refresh') refresh?: string) {
    const session = this.requireSession(authorization);
    try {
      const profile = await this.campaign.getProfile(session.address, { force: refresh === '1' });
      return { ok: true, ...profile };
    } catch (err) {
      return this.rethrow(err);
    }
  }

  /**
   * POST /api/campaign/verify — force a fresh verification pass.
   *
   * Distinct from `GET /me?refresh=1` only in intent, and kept because "I just did the thing, check
   * again" is a user action that deserves its own endpoint in the client's code.
   */
  @Post('verify')
  async verifyMissions(@Headers('authorization') authorization: string | undefined) {
    const session = this.requireSession(authorization);
    try {
      const profile = await this.campaign.getProfile(session.address, { force: true });
      return { ok: true, ...profile };
    } catch (err) {
      return this.rethrow(err);
    }
  }

  /** POST /api/campaign/referral { code } — attach a referrer after sign-in. */
  @Post('referral')
  async referral(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: { code?: string },
  ) {
    const session = this.requireSession(authorization);
    const code = (body?.code ?? '').trim();
    if (!code) {
      throw new BadRequestException({ ok: false, error: 'A referral code is required.', code: 'bad_request' });
    }
    try {
      // Nested rather than spread: the service's own `ok` means "the referral was recorded", while the
      // envelope's means "the request succeeded", and a rejected code is a successful request.
      return { ok: true, referral: await this.campaign.claimReferral(session.address, code) };
    } catch (err) {
      return this.rethrow(err);
    }
  }

  /**
   * POST /api/campaign/telegram/link — link a Telegram account from a Login Widget payload.
   *
   * The payload's `hash` is verified against the bot token before anything is written, so this endpoint
   * cannot be used to claim an account the caller does not control.
   */
  @Post('telegram/link')
  async telegramLink(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: TelegramLoginPayload,
  ) {
    const session = this.requireSession(authorization);
    try {
      // Nested for the same reason as `referral` above: a payload we could not verify is a refusal to
      // link, not a failed request.
      return { ok: true, link: await this.campaign.linkTelegram(session.address, body) };
    } catch (err) {
      return this.rethrow(err);
    }
  }

  /**
   * POST /api/campaign/voucher — a signed attestation of this wallet's current boost.
   *
   * Called immediately before a purchase. Re-scores every mission first, ignoring the throttle, so the
   * signature commits to the wallet's state now rather than to whatever the page last displayed.
   */
  @Post('voucher')
  async voucher(@Headers('authorization') authorization: string | undefined) {
    const session = this.requireSession(authorization);
    try {
      return { ok: true, ...(await this.campaign.issueVoucher(session.address)) };
    } catch (err) {
      return this.rethrow(err);
    }
  }
}

/**
 * A hostname, or null.
 *
 * The value ends up in text a user is asked to sign, so it is reduced to a hostname rather than
 * escaped: anything with a scheme, a path, or a newline could be used to dress a sign-in request up as
 * something else entirely.
 */
function sanitizeDomain(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(value)) return null;
  return value.toLowerCase();
}

/** An http(s) URL with no credentials, or null. Same reasoning as `sanitizeDomain`. */
function sanitizeUri(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}
