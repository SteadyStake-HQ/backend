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

/** The presale (§7). Amount fields are base-unit strings for the same reason. */
export interface SS4PresaleInfo {
  address: `0x${string}`;
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
  presale: SS4PresaleInfo | null;
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
        presale: parsePresale(raw),
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

function parsePresale(raw: RawEntry): SS4PresaleInfo | null {
  const p = raw.SS4Presale;
  const address = str(p?.address);
  const paymentToken = str(p?.paymentToken);
  if (!p || !address || !paymentToken) return null;

  return {
    address: address as `0x${string}`,
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
