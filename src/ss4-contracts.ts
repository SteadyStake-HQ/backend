/**
 * The `$SS4` token and presale deployments, read from contracts/deployed-ss4-contracts.json.
 *
 * Deliberately a sibling of game-contracts.ts rather than an extension of it. The two are written
 * by different deploy scripts into different files, and the SS4 suite is on its own release track
 * (outline §30): a chain can have the full Echo Arena game stack and no token at all, or the
 * reverse. Folding them into one file would make "not deployed" ambiguous between the two.
 *
 * The cache is keyed on the file's mtime for the same reason the game one is: redeploying rewrites
 * the file, and the dashboard exists to show what was *just* deployed, without a backend restart.
 */
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/** One of the six fixed allocation pools (§3.1) and where its supply was minted. */
export interface SS4AllocationInfo {
  bps: number;
  recipient: string;
}

/** The fixed-supply ERC-20 itself (§5). No mint, no owner, no upgrade path. */
export interface SS4TokenInfo {
  address: `0x${string}`;
  name: string;
  symbol: string;
  decimals: number;
  /** Base-unit string: 1e27 does not survive a JS number. */
  totalSupply: string;
  allocations: Record<string, SS4AllocationInfo> | null;
}

/**
 * The launch campaign carried by a v2 presale (§7 campaign extension).
 *
 * Present only on `SS4PresaleV2`. Everything here is frozen into the sale's `configHash`
 * alongside the price, so these values are what buyers are held to — the backend reads them
 * rather than keeping its own copy of the rates, because two copies of a published number
 * is one copy too many.
 */
export interface SS4CampaignInfo {
  /** `$SS4` base units reserved for all three bonuses combined. */
  bonusAllocation: string;
  /** Granted against a valid signed voucher. 200 = 2%. */
  socialBonusBps: number;
  /** Granted when the buyer's native BOT balance clears `holdRequirementWei`. 300 = 3%. */
  holdBonusBps: number;
  /** Credited to the referrer on the referee's purchase. 1000 = 10%. */
  referralBonusBps: number;
  /** Native BOT a buyer must hold to earn the holding bonus, in wei. */
  holdRequirementWei: string;
  /** Address whose signatures the contract accepts as social-task attestations. */
  campaignSigner: string | null;
  /** EIP-712 domain and type the voucher signer must reproduce exactly. */
  eip712: {
    name: string;
    version: string;
    domainSeparator: string | null;
    voucherType: string;
  } | null;
}

/** The presale (§7). Amount fields are base-unit strings for the same reason. */
export interface SS4PresaleInfo {
  address: `0x${string}`;
  /**
   * 1 for `SS4Presale`, 2 for `SS4PresaleV2`. Consumers that only read the sale terms can
   * ignore it; anything that builds a transaction must not, because v2's buy path takes a
   * referrer and a voucher that v1's ABI has no room for.
   */
  version: 1 | 2;
  /** Set on a v2 record: the contract key it replaces. Null on v1. */
  supersedes: string | null;
  /** The campaign, or null on a v1 sale which has none. */
  campaign: SS4CampaignInfo | null;
  admin: string | null;
  paymentToken: `0x${string}`;
  paymentSymbol: string | null;
  paymentDecimals: number;
  /** Price of 1e18 SS4 in USD scaled by 1e6. 25000 = $0.025. */
  priceUsdE6: string;
  saleAllocation: string;
  minPurchaseUsdE6: string;
  maxPurchasePerWalletUsdE6: string;
  softCapUsdE6: string;
  hardCapUsdE6: string;
  saleStart: number;
  saleEnd: number;
  claimStart: number;
  claimDeadline: number;
  tgeUnlockBps: number;
  configFrozen: boolean;
  /** Hash of the frozen terms, for comparing the live sale against what was published. */
  configHash: string | null;
}

/** Every SS4 contract recorded on one chain. Either slot may be null if it was not deployed. */
export interface SS4ContractsEntry {
  chainId: number;
  key: string | null;
  /** "testnet" | "mainnet" as the deploy recorded it. */
  environment: string | null;
  /** Operator-facing caveat carried from the deployment file, e.g. "testnet rehearsal only". */
  note: string | null;
  deployer: string | null;
  token: SS4TokenInfo | null;
  /**
   * The sale that is live: `SS4PresaleV2` when one is recorded, `SS4Presale` otherwise.
   *
   * Superseding rather than adding a second field is deliberate. v1 on BOT testnet is frozen
   * and cannot be upgraded, so v2 is a different contract at a different address that the
   * site now points at — "the presale" is unambiguously the newer one, and every existing
   * reader of this field should follow it there without being changed.
   */
  presale: SS4PresaleInfo | null;
  /**
   * Sales this chain has deployed that are no longer the live one, newest first.
   *
   * Kept rather than dropped because a superseded sale is not a dead one: v1 is frozen with
   * real positions recorded against it, and its buyers still need `claim()` and `refund()`
   * to be reachable. An operator looking for "where did that wallet buy" needs this list.
   */
  supersededPresales: SS4PresaleInfo[];
  /** When the deployment file was last written — how fresh these addresses are. */
  recordedAt: string | null;
}

interface RawEntry {
  chainId?: number;
  key?: string;
  environment?: string;
  note?: string;
  deployer?: string;
  SS4Token?: Record<string, unknown>;
  SS4Presale?: Record<string, unknown>;
  SS4PresaleV2?: Record<string, unknown>;
}

/**
 * The deployed-ss4-contracts.json this process reads, or null when nothing is deployed anywhere.
 *
 * Candidate order matches findGameContractsFile() exactly, and for the same reasons: an explicit
 * SS4_CONTRACTS_FILE override wins; the sibling contracts/ checkout beats the backend's own copy so
 * a local redeploy is visible immediately; and the backend-local copy is last but is the one that
 * matters in production, because backend/ and contracts/ are separate repos and Railway only ever
 * builds this one. Keep it current with `pnpm run sync:ss4-contracts`.
 */
export function findSS4ContractsFile(): string | null {
  const candidates = [
    process.env.SS4_CONTRACTS_FILE?.trim() ?? '',
    join(process.cwd(), '..', 'contracts', 'deployed-ss4-contracts.json'),
    join(process.cwd(), 'contracts', 'deployed-ss4-contracts.json'),
    join(__dirname, '..', '..', 'contracts', 'deployed-ss4-contracts.json'),
    join(__dirname, '..', 'deployed-ss4-contracts.json'),
    join(process.cwd(), 'deployed-ss4-contracts.json'),
  ].filter(Boolean);
  return candidates.find((c) => existsSync(c)) ?? null;
}

let cache: { path: string; mtimeMs: number; entries: Record<number, SS4ContractsEntry> } | null = null;
let lastCheckedAt = 0;

const RECHECK_INTERVAL_MS = 5_000;

/** Every chain with SS4 contracts recorded, as chainId -> entry. Empty when the file is missing. */
export function loadSS4Contracts(): Record<number, SS4ContractsEntry> {
  const now = Date.now();
  if (cache && now - lastCheckedAt < RECHECK_INTERVAL_MS) return cache.entries;
  lastCheckedAt = now;

  const path = findSS4ContractsFile();
  if (!path) {
    cache = null;
    return {};
  }

  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    // Unreadable stat is not a reason to drop a cache that already parsed.
  }
  if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache.entries;

  const entries: Record<number, SS4ContractsEntry> = {};
  const recordedAt = mtimeMs ? new Date(mtimeMs).toISOString() : null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, RawEntry>;
    for (const [chainKey, raw] of Object.entries(data)) {
      const chainId = raw?.chainId ?? parseInt(chainKey, 10);
      if (!Number.isFinite(chainId)) continue;
      entries[chainId] = {
        chainId,
        key: raw.key ?? null,
        environment: raw.environment ?? null,
        note: raw.note ?? null,
        deployer: raw.deployer ?? null,
        token: parseToken(raw),
        presale: pickLivePresale(raw),
        supersededPresales: pickSupersededPresales(raw),
        recordedAt,
      };
    }
  } catch {
    // A half-written file during a deploy must not take the dashboard down. The next read retries,
    // because nothing is cached on this path.
    return {};
  }

  cache = { path, mtimeMs, entries };
  return entries;
}

/** The SS4 contracts on one chain, or null when nothing has been deployed there. */
export function getSS4Contracts(chainId: number): SS4ContractsEntry | null {
  return loadSS4Contracts()[chainId] ?? null;
}

function str(v: unknown, fallback: string | null = null): string | null {
  return typeof v === 'string' && v ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Amounts stay strings end to end: SS4 supply is 1e27, far past Number.MAX_SAFE_INTEGER. */
function amount(v: unknown): string {
  if (typeof v === 'string' && v) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '0';
}

function parseToken(raw: RawEntry): SS4TokenInfo | null {
  const t = raw.SS4Token;
  const address = str(t?.address);
  if (!t || !address) return null;

  let allocations: Record<string, SS4AllocationInfo> | null = null;
  const rawAllocations = t.allocations;
  if (rawAllocations && typeof rawAllocations === 'object') {
    allocations = {};
    for (const [pool, value] of Object.entries(rawAllocations as Record<string, unknown>)) {
      const v = value as { bps?: unknown; recipient?: unknown };
      allocations[pool] = { bps: num(v?.bps), recipient: str(v?.recipient, '') ?? '' };
    }
  }

  return {
    address: address as `0x${string}`,
    name: str(t.name, 'SteadyStake') ?? 'SteadyStake',
    symbol: str(t.symbol, 'SS4') ?? 'SS4',
    decimals: num(t.decimals, 18),
    totalSupply: amount(t.totalSupply),
    allocations,
  };
}

/** The sale a client should be pointed at: v2 when it exists, otherwise v1. */
function pickLivePresale(raw: RawEntry): SS4PresaleInfo | null {
  return parsePresale(raw.SS4PresaleV2, 2) ?? parsePresale(raw.SS4Presale, 1);
}

/** Everything else that was ever deployed here, newest first. */
function pickSupersededPresales(raw: RawEntry): SS4PresaleInfo[] {
  // Only meaningful once a v2 exists; before that there is nothing being superseded.
  if (!raw.SS4PresaleV2) return [];
  const v1 = parsePresale(raw.SS4Presale, 1);
  return v1 ? [v1] : [];
}

function parsePresale(p: Record<string, unknown> | undefined, version: 1 | 2): SS4PresaleInfo | null {
  const address = str(p?.address);
  const paymentToken = str(p?.paymentToken);
  if (!p || !address || !paymentToken) return null;

  return {
    address: address as `0x${string}`,
    version,
    supersedes: str(p.supersedes),
    campaign: version === 2 ? parseCampaign(p.campaign) : null,
    admin: str(p.admin),
    paymentToken: paymentToken as `0x${string}`,
    paymentSymbol: str(p.paymentSymbol),
    paymentDecimals: num(p.paymentDecimals, 6),
    priceUsdE6: amount(p.priceUsdE6),
    saleAllocation: amount(p.saleAllocation),
    minPurchaseUsdE6: amount(p.minPurchaseUsdE6),
    maxPurchasePerWalletUsdE6: amount(p.maxPurchasePerWalletUsdE6),
    softCapUsdE6: amount(p.softCapUsdE6),
    hardCapUsdE6: amount(p.hardCapUsdE6),
    saleStart: num(p.saleStart),
    saleEnd: num(p.saleEnd),
    claimStart: num(p.claimStart),
    claimDeadline: num(p.claimDeadline),
    tgeUnlockBps: num(p.tgeUnlockBps, 10_000),
    configFrozen: p.configFrozen === true,
    configHash: str(p.configHash),
  };
}

/**
 * The campaign block on a v2 record.
 *
 * Returns null rather than a zeroed object when the block is absent: "this sale has no
 * campaign" and "this sale has a campaign paying 0%" are different facts, and only the
 * second one should ever render a rewards panel.
 */
function parseCampaign(value: unknown): SS4CampaignInfo | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;

  const rawEip712 = c.eip712;
  let eip712: SS4CampaignInfo['eip712'] = null;
  if (rawEip712 && typeof rawEip712 === 'object') {
    const e = rawEip712 as Record<string, unknown>;
    eip712 = {
      name: str(e.name, 'SS4Presale') ?? 'SS4Presale',
      version: str(e.version, '2') ?? '2',
      domainSeparator: str(e.domainSeparator),
      voucherType:
        str(e.voucherType, 'CampaignVoucher(address buyer,uint64 deadline,uint64 epoch)') ??
        'CampaignVoucher(address buyer,uint64 deadline,uint64 epoch)',
    };
  }

  return {
    bonusAllocation: amount(c.bonusAllocation),
    socialBonusBps: num(c.socialBonusBps),
    holdBonusBps: num(c.holdBonusBps),
    referralBonusBps: num(c.referralBonusBps),
    holdRequirementWei: amount(c.holdRequirementWei),
    campaignSigner: str(c.campaignSigner),
    eip712,
  };
}

/**
 * The sale's lifecycle state derived from its timestamps (§7.1), for display only.
 *
 * This is the honest subset of what the contract's own `state()` reports: without an RPC call the
 * backend cannot know whether the sale sold out, hit its hard cap, or was finalized or cancelled,
 * so those are never guessed here. "ended" means only that the window has closed by the clock.
 */
export function derivePresalePhase(
  presale: SS4PresaleInfo | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): 'not-deployed' | 'unfrozen' | 'upcoming' | 'active' | 'ended' | 'claimable' {
  if (!presale) return 'not-deployed';
  if (!presale.configFrozen) return 'unfrozen';
  if (nowSeconds < presale.saleStart) return 'upcoming';
  if (nowSeconds < presale.saleEnd) return 'active';
  if (presale.claimStart && nowSeconds >= presale.claimStart) return 'claimable';
  return 'ended';
}
