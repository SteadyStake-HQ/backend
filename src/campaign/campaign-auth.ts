/**
 * Campaign sign-in: a Sign-In with Ethereum challenge, and the bearer token it mints.
 *
 * WHY THE CAMPAIGN NEEDS ITS OWN AUTH AT ALL. Most of this backend is deliberately unguarded, because
 * its endpoints grant nothing — creating a Game Pass intent, reading plan history. The campaign is
 * different in one specific way: a wallet's campaign record accumulates *linked identities* (a Telegram
 * account) and a *referral relationship*, and both are claims a stranger must not be able to make on
 * someone else's behalf. Anyone able to POST an arbitrary wallet address could bind their own Telegram
 * account to a wallet they do not own, or set themselves as its referrer.
 *
 * WHAT THE SESSION IS NOT. It is not a capability to earn anything. Every boost is re-derived from
 * authoritative records at the moment a voucher is signed, so a stolen session cannot grant a mission —
 * the most it can do is read a progress page and link a social account. That is why a plain bearer
 * token is enough and there is no refresh, rotation or revocation machinery here.
 *
 * BEARER, NOT COOKIE. The presale runs on presale.steadystake.org and this backend on Railway, so a
 * cookie would be third-party: blocked by default in Safari and Firefox, and increasingly in Chrome. A
 * token the page holds in memory and sends as `Authorization: Bearer` works identically everywhere and
 * cannot be sent by a cross-site form.
 *
 * Signature verification accepts smart-contract wallets via `isValidSignature`, matching the game's own
 * verify route — a Safe cannot produce a recoverable ECDSA signature, and refusing them would exclude
 * exactly the wallets most likely to be holding size.
 */
import { randomBytes, createHmac, timingSafeEqual } from 'crypto';
import { createPublicClient, http, isAddress, recoverMessageAddress } from 'viem';
import { getRpc } from '../config';
import { getChain } from '../run-executor';
import { campaignChainId, sessionSecret, sessionTtlSeconds } from './campaign-config';

export const NONCE_TTL_SECONDS = 5 * 60;

/** The header the presale page and the game send the session token in. */
export const CAMPAIGN_AUTH_HEADER = 'authorization';

function base64Url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function newNonce(): string {
  return randomBytes(16).toString('hex');
}

export function newReferralCode(): string {
  /**
   * Eight characters from a Crockford-style alphabet with I, L, O, U and 0/1 removed.
   *
   * A referral code is read aloud, retyped from a screenshot, and pasted from chat apps that
   * helpfully capitalise. Excluding the glyph pairs people confuse (0/O, 1/I/L) removes the most
   * common way a referral is lost, and dropping U avoids generating unfortunate words.
   */
  const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  const bytes = randomBytes(8);
  let code = '';
  for (const byte of bytes) code += alphabet[byte % alphabet.length];
  return code;
}

/**
 * The exact text the wallet is asked to sign — a canonical EIP-4361 message.
 *
 * "Ethereum account" is the fixed SIWE phrasing for "the EVM address behind this wallet"; it is not a
 * claim about the network. Signing is off-chain, so no chain is touched — `Chain ID` is carried only so
 * the wallet can show which network the session is being opened for, and so this backend can refuse a
 * session opened against a chain the campaign does not run on.
 *
 * Keeping every required SIWE field in the canonical order (URI, Version, Chain ID, Nonce, Issued At)
 * is what lets wallets render this as a recognised sign-in rather than an opaque text blob.
 */
export function buildSignInMessage(options: {
  address: string;
  nonce: string;
  domain: string;
  uri: string;
  chainId: number;
  issuedAt: string;
}): string {
  return [
    `${options.domain} wants you to sign in with your Ethereum account:`,
    options.address,
    '',
    'Sign in to the SteadyStake Early Supporter Campaign to track your missions and Presale Boost. ' +
      'This request is free and sends no transaction.',
    '',
    `URI: ${options.uri}`,
    'Version: 1',
    `Chain ID: ${options.chainId}`,
    `Nonce: ${options.nonce}`,
    `Issued At: ${options.issuedAt}`,
  ].join('\n');
}

/**
 * Whether `signature` over `message` was made by `address`.
 *
 * Plain recovery first, then `isValidSignature` via RPC for contract wallets — the RPC round trip is
 * only paid when recovery has already failed, so an EOA sign-in costs nothing extra.
 */
export async function verifyWalletSignature(options: {
  address: string;
  message: string;
  signature: string;
  chainId: number;
}): Promise<boolean> {
  const address = options.address.toLowerCase();
  const signature = options.signature as `0x${string}`;

  try {
    const recovered = (await recoverMessageAddress({ message: options.message, signature })).toLowerCase();
    if (recovered === address) return true;
  } catch {
    // Not recoverable — which is the normal case for a contract wallet, so fall through.
  }

  const chain = getChain(options.chainId);
  const rpc = getRpc(options.chainId);
  if (!chain || !rpc) return false;

  try {
    const client = createPublicClient({ chain, transport: http(rpc) });
    return await client.verifyMessage({
      address: options.address as `0x${string}`,
      message: options.message,
      signature,
    });
  } catch {
    return false;
  }
}

/** A minted session: the token, and when it stops being accepted. */
export interface CampaignSession {
  token: string;
  address: string;
  expiresAt: Date;
}

/**
 * Mint a session token for an address whose signature has already been checked.
 *
 * `payload.payload` is base64url JSON rather than a JWT: there is no third party to interoperate with,
 * no algorithm to negotiate, and therefore no `alg: none` class of bug to guard against.
 */
export function createSessionToken(address: string, chainId: number): CampaignSession | null {
  const secret = sessionSecret();
  if (!secret) return null;

  const ttl = sessionTtlSeconds();
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const payload = base64Url(
    Buffer.from(
      JSON.stringify({
        address: address.toLowerCase(),
        chainId,
        exp: Math.floor(expiresAt.getTime() / 1000),
      }),
      'utf8',
    ),
  );
  const signature = base64Url(createHmac('sha256', secret).update(payload).digest());
  return { token: `${payload}.${signature}`, address: address.toLowerCase(), expiresAt };
}

/**
 * The address a token vouches for, or null when it is unusable for any reason.
 *
 * One null for every failure — bad signature, expired, malformed, wrong chain, no secret configured —
 * because a caller that could distinguish them would be a probe for forging one.
 */
export function readSessionToken(rawToken: string | undefined): { address: string; chainId: number } | null {
  const secret = sessionSecret();
  if (!secret || !rawToken) return null;

  // Accept both "Bearer <token>" and a bare token: the header form is what the clients send, and the
  // bare form keeps a curl reproduction of a bug report short.
  const token = rawToken.replace(/^Bearer\s+/i, '').trim();
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;

  try {
    const expected = createHmac('sha256', secret).update(payload).digest();
    const provided = fromBase64Url(signature);
    if (provided.length !== expected.length) return null;
    if (!timingSafeEqual(provided, expected)) return null;

    const claims = JSON.parse(fromBase64Url(payload).toString('utf8')) as {
      address?: string;
      chainId?: number;
      exp?: number;
    };
    if (!claims.address || !isAddress(claims.address)) return null;
    if (!claims.exp || claims.exp * 1000 <= Date.now()) return null;
    // A session opened before the campaign was pointed at a different chain is not a session for this
    // campaign. Re-signing costs the user one click and keeps chain-scoped missions honest.
    if (claims.chainId !== campaignChainId()) return null;

    return { address: claims.address.toLowerCase(), chainId: claims.chainId };
  } catch {
    return null;
  }
}
