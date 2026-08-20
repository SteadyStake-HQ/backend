/**
 * Everything about the Early Supporter Campaign that is deployment-specific rather than economic.
 *
 * The rates live in campaign-missions.ts and are fixed. What lives here is which chain the campaign
 * runs on, which contracts its on-chain missions read, and which social accounts count — all of
 * which differ between the testnet rehearsal and the mainnet sale, and none of which may be guessed.
 *
 * The rule this file follows throughout: **never invent an address.** A mission whose contract is not
 * configured reports itself unverifiable rather than passing or failing, because both of those would
 * be a lie about a wallet's holdings. `campaignReadiness()` is what the admin dashboard reads to see
 * exactly which missions are live in this deployment.
 */
import { isAddress } from 'viem';
import { getSS4Contracts } from '../ss4-contracts';
import { NETWORK_REGISTRY } from '../networks/network-registry';

/** BOT Chain mainnet and testnet. The campaign runs on exactly one of them at a time. */
export const BOT_CHAIN_IDS = [677, 968] as const;

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

/**
 * The chain the campaign runs on.
 *
 * Defaults to **mainnet (677)** for the same reason the presale page does, and the default was flipped
 * from 968 alongside it when the sale went live on 2026-08-20. While nothing was deployed to mainnet a
 * testnet default was the honest one: it kept the backend from attesting boosts against a sale that
 * did not exist. Now that it does exist, the same default is the dangerous one — this process reads
 * its environment from a host that keeps it outside the repo, so a deploy that forgets
 * `CAMPAIGN_CHAIN_ID` would have the backend cheerfully signing vouchers for the *testnet* sale while
 * the presale page sells the mainnet one. Those vouchers verify against the wrong `domainSeparator`
 * and every buyer sees `InvalidVoucher` at their wallet, with nothing in the logs saying why.
 *
 * The two defaults must therefore agree, and they do: presale `envChainId()` and this function both
 * fall back to 677. Set `CAMPAIGN_CHAIN_ID=968` explicitly to score against the rehearsal.
 *
 * A value that is not a BOT Chain id is refused rather than accepted — the campaign's on-chain
 * missions are defined in terms of BOT and BOT Chain USDT, and scoring them on Base would be
 * meaningless.
 */
export function campaignChainId(): number {
  const raw = Number(env('CAMPAIGN_CHAIN_ID'));
  return (BOT_CHAIN_IDS as readonly number[]).includes(raw) ? raw : 677;
}

export function isCampaignChain(chainId: number): boolean {
  return chainId === campaignChainId();
}

/** The registry entry for the campaign chain — its name, explorer and default RPC. */
export function campaignChain() {
  const chainId = campaignChainId();
  return NETWORK_REGISTRY.find((n) => n.chainId === chainId) ?? null;
}

/**
 * The stablecoin the "Hold USDT" mission measures, on the campaign chain.
 *
 * Resolution order, and why: an explicit `CAMPAIGN_USDT_ADDRESS_<chainId>` wins, because an operator
 * pointing the mission at a specific token is the most specific statement available. Otherwise it
 * falls back to the *sale's own* payment token from deployed-ss4-contracts.json, which is the right
 * default for a mission whose purpose is "be ready to buy in the presale" — the asset a buyer needs
 * is the one the sale settles in, and on the testnet that is a 6-decimal USDC rather than USDT.
 *
 * Returns null when neither is available, which makes the mission unverifiable rather than failed.
 */
export function campaignStableToken(): { address: `0x${string}`; symbol: string; decimals: number } | null {
  const chainId = campaignChainId();

  const override = env(`CAMPAIGN_USDT_ADDRESS_${chainId}`);
  if (isAddress(override)) {
    const decimals = Number(env(`CAMPAIGN_USDT_DECIMALS_${chainId}`)) || 6;
    return {
      address: override.toLowerCase() as `0x${string}`,
      symbol: env(`CAMPAIGN_USDT_SYMBOL_${chainId}`) || 'USDT',
      decimals,
    };
  }

  const sale = getSS4Contracts(chainId)?.presale;
  if (sale?.paymentToken && isAddress(sale.paymentToken)) {
    return {
      address: sale.paymentToken.toLowerCase() as `0x${string}`,
      symbol: sale.paymentSymbol ?? 'USDT',
      decimals: sale.paymentDecimals,
    };
  }

  return null;
}

/**
 * The presale contract the campaign attests boosts for, and the version of its voucher.
 *
 * A v3 sale is required: v1 has no campaign at all, and v2's voucher carries no boost amount, so it
 * can only ever pay its own frozen social rate. Attesting a variable boost against either would
 * produce a signature the contract rejects — better to report the campaign as not deployed.
 *
 * `SS4_PRESALE_ADDRESS_<chainId>` overrides the deployment file, which is how the campaign is pointed
 * at a fresh rehearsal address without waiting for a `sync:ss4-contracts` run.
 */
export function campaignPresale(): { address: `0x${string}`; chainId: number } | null {
  const chainId = campaignChainId();

  const override = env(`SS4_PRESALE_ADDRESS_${chainId}`);
  if (isAddress(override)) return { address: override.toLowerCase() as `0x${string}`, chainId };

  const sale = getSS4Contracts(chainId)?.presale;
  if (sale?.address && isAddress(sale.address) && sale.version >= 3) {
    return { address: sale.address.toLowerCase() as `0x${string}`, chainId };
  }
  return null;
}

/** The Telegram chats whose membership the two Telegram missions check. */
export interface TelegramTarget {
  missionCode: string;
  /** Numeric id (`-1001234567890`) or `@username`, as the Bot API accepts either. */
  chat: string;
  label: string;
}

/**
 * Telegram targets, one per mission. Unconfigured targets are simply absent, which leaves their
 * mission unverifiable — the bot cannot ask about a chat nobody named.
 *
 * `TELEGRAM_CAMPAIGN_CHAT` is accepted as an alias for the SteadyStake chat because it is the name
 * already documented in .env.example and possibly already set.
 */
/**
 * Normalise whatever an operator pasted into a `chat_id` the Bot API accepts.
 *
 * The API takes exactly two forms: a numeric id (negative for groups, e.g. `-1001234567890`) or a
 * `@username` string. Anything else comes back as `Bad Request: chat not found`, which the verifier
 * correctly reports as "unavailable" — so the mission silently stays manual and nothing says why.
 *
 * The two things an operator actually has in front of them are the invite link on the group's settings
 * dialog (`t.me/steadystake_org`) and the bare handle, and neither is a valid `chat_id`. Both are
 * accepted here and turned into `@steadystake_org`. Numeric ids are passed through untouched.
 */
function telegramChatId(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  // A numeric id, with or without the leading minus that every supergroup id carries.
  if (/^-?\d+$/.test(value)) return value;
  const handle = value
    .replace(/^https?:\/\//i, '')
    .replace(/^t\.me\//i, '')
    .replace(/^telegram\.me\//i, '')
    .replace(/^@/, '')
    .replace(/\/.*$/, '');
  return handle ? `@${handle}` : '';
}

export function telegramTargets(): TelegramTarget[] {
  const targets: TelegramTarget[] = [];
  const steadystake = telegramChatId(env('TELEGRAM_STEADYSTAKE_CHAT') || env('TELEGRAM_CAMPAIGN_CHAT'));
  if (steadystake) {
    targets.push({
      missionCode: 'community_join_steadystake_telegram',
      chat: steadystake,
      label: 'SteadyStake Telegram',
    });
  }
  const botchain = telegramChatId(env('TELEGRAM_BOTCHAIN_CHAT'));
  if (botchain) {
    targets.push({
      missionCode: 'community_join_botchain_telegram',
      chat: botchain,
      label: 'BOT Chain Telegram',
    });
  }
  return targets;
}

export function telegramBotToken(): string | null {
  return env('TELEGRAM_BOT_TOKEN') || null;
}

/** The X accounts and post the three X missions are about, for display and for a future verifier. */
export function xTargets(): Array<{ missionCode: string; handle: string; label: string }> {
  return [
    {
      missionCode: 'community_follow_steadystake_x',
      handle: env('X_STEADYSTAKE_HANDLE') || '@_steadystake',
      label: 'SteadyStake on X',
    },
    {
      missionCode: 'community_follow_botchain_x',
      handle: env('X_BOTCHAIN_HANDLE') || '@botchain_ai',
      label: 'BOT Chain on X',
    },
    {
      missionCode: 'community_campaign_engagement',
      handle: env('X_CAMPAIGN_POST_URL') || '',
      label: 'Campaign post',
    },
  ];
}

/**
 * How long a signed voucher stays valid.
 *
 * Short on purpose: the boost a voucher attests is a snapshot of missions the wallet had completed
 * when it was issued, and the campaign's whole premise is that the boost tracks real activity. Ten
 * minutes is long enough for a wallet to approve a stablecoin and then buy, and short enough that a
 * leaked voucher is worthless almost immediately. `CAMPAIGN_VOUCHER_TTL_SECONDS` moves it within
 * bounds that keep it a short-lived credential either way.
 */
export function voucherTtlSeconds(): number {
  const raw = Number(env('CAMPAIGN_VOUCHER_TTL_SECONDS'));
  if (!Number.isFinite(raw) || raw <= 0) return 600;
  return Math.min(Math.max(Math.floor(raw), 60), 3_600);
}

/**
 * How long a campaign sign-in session lasts. A session only ever addresses a wallet's own campaign
 * record; it grants no boost by itself, since every boost is re-derived from authoritative records
 * at voucher time.
 */
export function sessionTtlSeconds(): number {
  const raw = Number(env('CAMPAIGN_SESSION_TTL_SECONDS'));
  if (!Number.isFinite(raw) || raw <= 0) return 7 * 24 * 60 * 60;
  return Math.min(Math.max(Math.floor(raw), 300), 30 * 24 * 60 * 60);
}

/**
 * The secret campaign session tokens are signed with.
 *
 * Deliberately separate from `ADMIN_API_TOKEN`: one is an operator credential and the other mints
 * per-wallet bearer tokens, and a deployment that reused one for the other would let a leaked
 * session forge admin calls. Null disables campaign sign-in entirely, which fails the campaign
 * closed rather than open.
 */
export function sessionSecret(): string | null {
  return env('CAMPAIGN_SESSION_SECRET') || null;
}

/** The origins allowed to call the campaign API from a browser. */
export function allowedOrigins(): string[] {
  return env('CAMPAIGN_ALLOWED_ORIGINS')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

export interface CampaignReadiness {
  chainId: number;
  chainName: string | null;
  /** True when a v3 sale, a signer key and a session secret are all present. */
  ready: boolean;
  presaleAddress: string | null;
  presaleVersionOk: boolean;
  signerConfigured: boolean;
  sessionSecretConfigured: boolean;
  stableToken: { address: string; symbol: string; decimals: number } | null;
  telegramConfigured: boolean;
  telegramTargets: string[];
  xConfigured: boolean;
  /** Mission codes that cannot be verified in this deployment, and why. */
  unverifiable: Array<{ missionCode: string; reason: string }>;
}

/**
 * What this deployment can actually do, mission by mission.
 *
 * Written for the operator dashboard and for the campaign's own `/status` endpoint, because "the
 * campaign is live" is not a single boolean: a deployment can score every on-chain and game mission
 * perfectly while having no way to check a Telegram join, and the honest thing is to say which.
 */
export function campaignReadiness(): CampaignReadiness {
  const chainId = campaignChainId();
  const presale = campaignPresale();
  const stable = campaignStableToken();
  const telegram = telegramTargets();
  const telegramReady = Boolean(telegramBotToken()) && telegram.length > 0;
  const signerConfigured = Boolean(env('SS4_CAMPAIGN_SIGNER_KEY'));
  const sessionOk = Boolean(sessionSecret());
  const xReady = Boolean(env('X_API_BEARER_TOKEN'));

  const unverifiable: Array<{ missionCode: string; reason: string }> = [];
  if (!stable) {
    unverifiable.push({
      missionCode: 'onchain_hold_usdt',
      reason: `No stablecoin is configured for chain ${chainId}. Set CAMPAIGN_USDT_ADDRESS_${chainId} or deploy the sale.`,
    });
    unverifiable.push({
      missionCode: 'onchain_bot_usdt_ready',
      reason: 'Depends on the USDT holding check, which has no token configured.',
    });
  }
  if (!xReady) {
    for (const target of xTargets()) {
      unverifiable.push({
        missionCode: target.missionCode,
        reason: 'X verification is not wired (X_API_BEARER_TOKEN unset). Operator verification only.',
      });
    }
  }
  if (!telegramBotToken()) {
    unverifiable.push({
      missionCode: 'community_join_steadystake_telegram',
      reason: 'TELEGRAM_BOT_TOKEN is unset, so channel membership cannot be read.',
    });
    unverifiable.push({
      missionCode: 'community_join_botchain_telegram',
      reason: 'TELEGRAM_BOT_TOKEN is unset, so channel membership cannot be read.',
    });
  } else {
    const configured = new Set(telegram.map((t) => t.missionCode));
    for (const code of ['community_join_steadystake_telegram', 'community_join_botchain_telegram']) {
      if (!configured.has(code)) {
        unverifiable.push({ missionCode: code, reason: 'No Telegram chat is configured for this mission.' });
      }
    }
  }
  if (!presale) {
    unverifiable.push({
      missionCode: 'community_verified_referral',
      reason: 'No SS4PresaleV3 is configured, so a referee purchase cannot be confirmed.',
    });
  }

  return {
    chainId,
    chainName: campaignChain()?.name ?? null,
    ready: Boolean(presale) && signerConfigured && sessionOk,
    presaleAddress: presale?.address ?? null,
    presaleVersionOk: Boolean(presale),
    signerConfigured,
    sessionSecretConfigured: sessionOk,
    stableToken: stable ? { address: stable.address, symbol: stable.symbol, decimals: stable.decimals } : null,
    telegramConfigured: telegramReady,
    telegramTargets: telegram.map((t) => t.label),
    xConfigured: xReady,
    unverifiable,
  };
}
