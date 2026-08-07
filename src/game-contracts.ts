/**
 * The Echo Arena game contracts (blueprint §18), read from contracts/deployed-game-contracts.json.
 *
 * Three consumers used to resolve and parse that file themselves — the capacity permit signer, the
 * payment-network boot seed, and now the networks dashboard. They read the same three deployments
 * per chain, so the path search, the parse, and the shape live here once.
 *
 * The cache is keyed on the file's mtime rather than being read once at boot: redeploying the game
 * contracts rewrites this file, and the dashboard exists to show what was *just* deployed. An
 * operator who reruns the deploy script sees the new addresses on the next refresh, without a
 * backend restart.
 */
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/** The stablecoin checkout users buy game passes through. */
export interface GameCheckoutInfo {
  address: `0x${string}`;
  stablecoin: `0x${string}`;
  decimals: number;
}

/** The season reward NFT; holding one grants bonus Auto Execution slots. */
export interface SeasonRewardNftInfo {
  address: `0x${string}`;
}

/** The on-chain verifier for the EIP-712 capacity permits the backend signs. */
export interface CapacityVerifierInfo {
  address: `0x${string}`;
  /** Address holding SIGNER_ROLE — must match the backend's capacity-signer key. */
  signer: string | null;
  /** Address holding VAULT_ROLE, i.e. who may call `consumePermit`. */
  vaultRole: string | null;
  /** EIP-712 domain as deployed, "<name>/<version>". */
  domain: string;
  name: string;
  version: string;
}

/** Every game contract deployed to one chain. Any slot may be null if that one was skipped. */
export interface GameContractsEntry {
  chainId: number;
  /** Network key as the deploy script recorded it, e.g. "base-sepolia". */
  key: string | null;
  checkout: GameCheckoutInfo | null;
  seasonRewardNft: SeasonRewardNftInfo | null;
  capacityVerifier: CapacityVerifierInfo | null;
  /** When the deployment file was last written — how fresh these addresses are. */
  recordedAt: string | null;
}

const DEFAULT_DOMAIN = 'Echo Arena Capacity/1';

interface RawEntry {
  chainId?: number;
  key?: string;
  StablecoinGamePassCheckout?: { address?: string; stablecoin?: string; decimals?: number; skipped?: string };
  SeasonRewardNFT?: { address?: string; skipped?: string };
  AutoPlanCapacityVerifier?: {
    address?: string;
    signer?: string;
    vaultRole?: string;
    domain?: string;
    skipped?: string;
  };
}

/**
 * The deployed-game-contracts.json this process reads, or null when there is no deployment file.
 *
 * GAME_CONTRACTS_FILE is checked first: an explicit override that lost to a file that happened to
 * be sitting in the repo checkout would not be an override at all.
 *
 * The sibling contracts/ checkout is preferred over the copy shipped inside backend/, because the
 * deploy script writes the sibling one: an operator who reruns the deploy locally must see the new
 * addresses, not the snapshot from the last sync.
 *
 * The backend-local copy is the last candidate and the one that matters in production. backend/ and
 * contracts/ are separate repos, so Railway builds the backend alone and no sibling contracts/ ever
 * exists there. Without a file shipped inside this repo every consumer here silently reports "not
 * deployed" — the networks dashboard, the balances page, and the capacity permit signer alike.
 * Keep it in sync with `pnpm run sync:game-contracts`; it is committed for the same reason
 * deployed-addresses.json is.
 */
export function findGameContractsFile(): string | null {
  const candidates = [
    process.env.GAME_CONTRACTS_FILE?.trim() ?? '',
    join(process.cwd(), '..', 'contracts', 'deployed-game-contracts.json'),
    join(process.cwd(), 'contracts', 'deployed-game-contracts.json'),
    join(__dirname, '..', '..', 'contracts', 'deployed-game-contracts.json'),
    // Shipped with the backend repo: dist/game-contracts.js -> backend/, and cwd when run from
    // the backend root. Mirrors how config.ts resolves deployed-addresses.json.
    join(__dirname, '..', 'deployed-game-contracts.json'),
    join(process.cwd(), 'deployed-game-contracts.json'),
  ].filter(Boolean);
  return candidates.find((c) => existsSync(c)) ?? null;
}

let cache: { path: string; mtimeMs: number; entries: Record<number, GameContractsEntry> } | null = null;
let lastCheckedAt = 0;

/**
 * How long a parsed file is trusted before its mtime is checked again. One network list asks for
 * this once per registered chain, and a deployment an operator is watching for is worth waiting a
 * few seconds to see — not a stat syscall per chain per refresh.
 */
const RECHECK_INTERVAL_MS = 5_000;

/** Every chain with game contracts recorded, as chainId -> entry. Empty when the file is missing. */
export function loadGameContracts(): Record<number, GameContractsEntry> {
  const now = Date.now();
  if (cache && now - lastCheckedAt < RECHECK_INTERVAL_MS) return cache.entries;
  lastCheckedAt = now;

  const path = findGameContractsFile();
  if (!path) {
    cache = null;
    return {};
  }

  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    // Unreadable stat is not a reason to drop a cache that already parsed: fall through to the read,
    // which will fail the same way if the file really has gone.
  }
  if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache.entries;

  const entries: Record<number, GameContractsEntry> = {};
  const recordedAt = mtimeMs ? new Date(mtimeMs).toISOString() : null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, RawEntry>;
    for (const [chainKey, raw] of Object.entries(data)) {
      const chainId = raw?.chainId ?? parseInt(chainKey, 10);
      if (!Number.isFinite(chainId)) continue;
      entries[chainId] = {
        chainId,
        key: raw.key ?? null,
        checkout: parseCheckout(raw),
        seasonRewardNft: parseSeasonNft(raw),
        capacityVerifier: parseVerifier(raw),
        recordedAt,
      };
    }
  } catch {
    // A half-written file during a deploy must not take the dashboard (or the boot seed) down. The
    // next read retries, because nothing is cached on this path.
    return {};
  }

  cache = { path, mtimeMs, entries };
  return entries;
}

/** The game contracts on one chain, or null when nothing has been deployed there. */
export function getGameContracts(chainId: number): GameContractsEntry | null {
  return loadGameContracts()[chainId] ?? null;
}

function parseCheckout(raw: RawEntry): GameCheckoutInfo | null {
  const co = raw.StablecoinGamePassCheckout;
  if (!co?.address || !co.stablecoin || typeof co.decimals !== 'number') return null;
  return {
    address: co.address as `0x${string}`,
    stablecoin: co.stablecoin as `0x${string}`,
    decimals: co.decimals,
  };
}

function parseSeasonNft(raw: RawEntry): SeasonRewardNftInfo | null {
  const address = raw.SeasonRewardNFT?.address;
  return address ? { address: address as `0x${string}` } : null;
}

function parseVerifier(raw: RawEntry): CapacityVerifierInfo | null {
  const v = raw.AutoPlanCapacityVerifier;
  if (!v?.address) return null;
  const domain = v.domain ?? DEFAULT_DOMAIN;
  const [name, version] = domain.split('/');
  return {
    address: v.address as `0x${string}`,
    signer: v.signer ?? null,
    vaultRole: v.vaultRole ?? null,
    domain,
    name: name || 'Echo Arena Capacity',
    version: version || '1',
  };
}
