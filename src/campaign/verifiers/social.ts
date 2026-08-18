/**
 * The community missions that live off-chain: Telegram membership and the three X missions
 * (campaign spec §3, §9).
 *
 * These are the missions no EVM can read, and they divide sharply by whether an honest automatic check
 * is possible at all today.
 *
 * TELEGRAM — IMPLEMENTED. The Bot API's `getChatMember` answers "is this user in this chat" directly,
 * and it needs nothing but a bot token and a chat the bot administers. The only piece the campaign has
 * to supply is *which* Telegram account belongs to which wallet, which comes from the Telegram Login
 * Widget: it hands the browser a signed payload, and the signature is verifiable offline against the
 * bot token (see `verifyTelegramLogin`). So this path is end-to-end trustworthy — the user cannot claim
 * an account they do not control, and the membership answer comes from Telegram rather than the client.
 *
 * X — NOT IMPLEMENTED, AND SAYING SO. SteadyStake's X integration is offline: revoked tokens, a dead
 * proxy, and no API credits. Reading whether a wallet's linked X account follows an account or reposted
 * a post needs the X API, and there is no way to fake that responsibly — inferring it from a
 * client-side "I followed" button would hand out 0.40% of the campaign to anyone who clicked, which is
 * the exact abuse §10 exists to prevent. So `verifyXMission` returns `unavailable` with a reason the UI
 * shows, and the only route to those three missions is an operator recording evidence by hand through
 * the admin endpoint. `X_API_BEARER_TOKEN` plus the marked implementation below switches it on.
 */
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { telegramBotToken, telegramTargets } from '../campaign-config';
import { getMission, xVerificationAvailable } from '../campaign-missions';
import { met, notMet, unavailable, type VerifierResult } from './verifier-types';

const SOURCE_TELEGRAM = 'telegram_bot_api:get_chat_member';
const SOURCE_X = 'x_api:unavailable';

/** Statuses `getChatMember` reports for someone who is actually in the chat. */
const MEMBER_STATUSES = new Set(['creator', 'administrator', 'member', 'restricted']);

/**
 * The payload the Telegram Login Widget hands the browser. Every field is Telegram's, and `hash` is
 * what makes the rest trustworthy.
 */
export interface TelegramLoginPayload {
  id: number | string;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number | string;
  hash: string;
}

/** How stale a login payload may be. Telegram's own guidance; bounds a replayed widget response. */
const TELEGRAM_LOGIN_MAX_AGE_SECONDS = 24 * 60 * 60;

/**
 * Verify a Telegram Login Widget payload and return the account it proves.
 *
 * The scheme, from Telegram's docs: build a newline-joined `key=value` string of every field except
 * `hash`, sorted by key; the HMAC-SHA256 of that string, under a key of `SHA256(bot_token)`, must equal
 * `hash`. Because the key is derived from the bot token, only someone holding the token can produce a
 * valid payload — which is why this can be checked entirely offline with no call to Telegram.
 *
 * Returns null on any failure, deliberately without saying which: a caller that distinguished "bad
 * signature" from "expired" would be an oracle for forging one.
 */
export function verifyTelegramLogin(
  payload: TelegramLoginPayload,
): { telegramUserId: string; username: string | null } | null {
  const token = telegramBotToken();
  if (!token) return null;
  if (!payload || typeof payload.hash !== 'string' || !payload.id || !payload.auth_date) return null;

  const authDate = Number(payload.auth_date);
  if (!Number.isFinite(authDate)) return null;
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  // Future-dated payloads are rejected too: a clock skew of a few seconds is fine, but a payload
  // dated tomorrow is not something Telegram produced.
  if (ageSeconds > TELEGRAM_LOGIN_MAX_AGE_SECONDS || ageSeconds < -300) return null;

  const dataCheckString = Object.entries(payload)
    .filter(([key, value]) => key !== 'hash' && value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${String(value)}`)
    .sort()
    .join('\n');

  const secret = createHash('sha256').update(token).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest('hex');

  const provided = payload.hash.trim().toLowerCase();
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'))) return null;

  return {
    telegramUserId: String(payload.id),
    username: payload.username ? String(payload.username) : null,
  };
}

/**
 * Ask Telegram whether `telegramUserId` is in the chat this mission is about.
 *
 * Distinguishes three outcomes rather than two, per verifier-types.ts:
 *  - a `member`-ish status: met
 *  - `left` / `kicked`: not met, and the user can fix it by joining
 *  - a transport error, a missing token, an unconfigured chat, or a chat the bot cannot read at all
 *    (a private one it has not been added to): unavailable, because none of those are facts about the
 *    user. A public chat needs no membership on the bot's part — Telegram answers for any @username.
 */
export async function verifyTelegramMembership(
  missionCode: string,
  telegramUserId: string | null,
): Promise<VerifierResult> {
  const token = telegramBotToken();
  if (!token) {
    return unavailable(SOURCE_TELEGRAM, 'Telegram verification is not configured on this deployment yet.');
  }

  const target = telegramTargets().find((t) => t.missionCode === missionCode);
  if (!target) {
    return unavailable(SOURCE_TELEGRAM, 'The Telegram channel for this mission is not configured yet.');
  }

  if (!telegramUserId) {
    // Not "unavailable": the user genuinely has an action to take, and it is theirs to take.
    return notMet(SOURCE_TELEGRAM, { current: 0, target: 1 }, { needsLink: true, channel: target.label });
  }

  try {
    const url = `https://api.telegram.org/bot${token}/getChatMember`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: target.chat, user_id: Number(telegramUserId) }),
      signal: AbortSignal.timeout(8_000),
    });

    const body = (await response.json()) as {
      ok?: boolean;
      description?: string;
      result?: { status?: string };
    };

    if (!body?.ok) {
      const description = body?.description ?? `HTTP ${response.status}`;
      // Two Bot API errors ARE facts about the user rather than about us, and both have to be read as
      // "not met" so the page tells them to go and join. Everything else — a bad chat id, a bot without
      // the rights it needs, rate limiting — is our problem and reports as unavailable.
      //
      //   "member not found"  the account exists but is not in this chat. This is the ordinary answer
      //                       for someone who has not joined yet, and it is what a public supergroup
      //                       returns; matching only "user not found" sent it down the unavailable
      //                       path, so a user who simply had not joined was told to try again later.
      //   "user not found"    no such account at all.
      if (/(user|member) not found/i.test(description)) {
        return notMet(SOURCE_TELEGRAM, { current: 0, target: 1 }, { channel: target.label });
      }
      return unavailable(SOURCE_TELEGRAM, 'Telegram could not confirm your membership right now. Try again.', {
        description,
      });
    }

    const status = body.result?.status ?? 'unknown';
    if (MEMBER_STATUSES.has(status)) {
      return met(SOURCE_TELEGRAM, `telegram:${telegramUserId}`, { status, channel: target.label });
    }
    return notMet(SOURCE_TELEGRAM, { current: 0, target: 1 }, { status, channel: target.label });
  } catch (err) {
    return unavailable(SOURCE_TELEGRAM, 'Telegram could not be reached right now. Try again in a moment.', {
      error: (err as Error).message,
    });
  }
}

/**
 * The three X missions: two follows and the campaign post's like + repost.
 *
 * Always `unavailable` in this deployment, with the reason carried through to the campaign page so a
 * user sees "we can't check this yet" rather than a mission that silently never completes. See the
 * module note for why there is no honest shortcut.
 *
 * TO IMPLEMENT: set `X_API_BEARER_TOKEN`, add an X account link flow (OAuth 2.0 PKCE, storing
 * `x_user_id` on the campaign user the same way Telegram does), and replace the body below with reads
 * of `GET /2/users/:id/following` for the follow missions and `GET /2/tweets/:id/retweeted_by` +
 * `/liking_users` for the engagement mission. Everything around it — the mission catalog, the
 * completion rows, the boost arithmetic, the audit trail — is already in place and needs no change.
 */
export async function verifyXMission(missionCode: string, xUserId: string | null): Promise<VerifierResult> {
  const mission = getMission(missionCode);
  const label = mission?.name ?? missionCode;

  if (!xVerificationAvailable()) {
    return unavailable(
      SOURCE_X,
      'X verification is not available yet. This mission has to be confirmed by the team.',
      { mission: label, linkedAccount: xUserId },
    );
  }

  // Reachable only once X_API_BEARER_TOKEN is set, which is also the switch that turns the mission
  // from operator-verified to automatic. Failing closed rather than passing is the safe half of the
  // half-built state: an operator can still verify by hand, and nobody is paid for an unchecked claim.
  return unavailable(
    SOURCE_X,
    'X verification is configured but not implemented in this build. This mission has to be confirmed by the team.',
    { mission: label, linkedAccount: xUserId },
  );
}
