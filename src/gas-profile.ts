/**
 * How much gas a run actually burns, learned from the runs themselves.
 *
 * A run is two transactions the relayer signs: `executeSwap` on the vault and `recordExecution`
 * on the gas tank. Their combined gas is the multiplier in
 * `run cost = gas units x gas price x native token price` — the only one of the three that was
 * ever a hardcoded constant. Gas price and token price are read live per chain; the units were
 * a single 200,000 shared by every network, hand-anchored to a BOT Chain estimate.
 *
 * Measured on BOT Chain mainnet (677) from relayer receipts, that constant was low:
 *   executeSwap      187,631 / 205,666 / 238,931
 *   recordExecution   43,375 /  51,418 /  51,418
 *   per run          239,049 / 249,041 / 290,349
 * — roughly 25% more than 200,000, and a different number again on any chain whose swap path
 * is not BDEX V2. Guessing it per chain does not scale and goes stale the moment a route changes.
 *
 * So it is not guessed: every completed run reports its two receipts here, and the quote users
 * see is the median of what recent runs on that chain really cost. The seeds below only cover
 * the window before a chain has observations of its own.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

/**
 * Gas units per run assumed before a chain has measured any of its own runs. Seeded from real
 * receipts where we have them, and from the same figure as a generic starting point where we do
 * not — a seed is only ever used until the first run on that chain replaces it.
 */
const SEED_GAS_UNITS: Record<number, number> = {
  677: 260_000, // BOT Chain mainnet, from the receipts above (median 249k, rounded up)
  968: 260_000, // BOT Chain testnet — same contracts, same swap path
  // The chains below have not run yet, so these are the direct/aggregator split above, not
  // measurements. The first completed run on each replaces its seed with its own median.
  84532: 260_000, // Base Sepolia — MockSwapRouter, one hop, same shape as BOT Chain
  11155111: 260_000, // Ethereum Sepolia — MockSwapRouter
  8453: 320_000, // Base — 0x aggregator route
  56: 320_000, // BSC — 0x aggregator route
  137: 320_000, // Polygon — 0x aggregator route
  2222: 320_000, // Kava — 0x aggregator route
};

/**
 * Fallback seed for a chain with neither observations nor an entry above — a new deployment on
 * the aggregator path, which is the more expensive of the two and the safer thing to assume.
 */
const DEFAULT_SEED_GAS_UNITS = 320_000;

/**
 * Samples kept per chain. Enough that one anomalous run cannot move the median, few enough that
 * the number still tracks a real change in the swap path rather than averaging over its history.
 */
const MAX_SAMPLES = 25;

/** A sane band for a per-run total. Anything outside is a mis-attributed or failed receipt. */
const MIN_PLAUSIBLE_GAS = 21_000;
const MAX_PLAUSIBLE_GAS = 5_000_000;

interface ChainGasSamples {
  /** Total gas (swap + record) for recent runs, oldest first. */
  samples: number[];
  updatedAt: string;
}

type GasProfileState = Record<string, ChainGasSamples>;

export interface GasProfileEntry {
  chainId: number;
  /** Gas units one run burns across both transactions. */
  gasUnitsPerRun: number;
  /** How many real runs that figure is drawn from. 0 means the seed is still in use. */
  samples: number;
  /** "measured" once this chain has run at least once; "seed" until then. */
  source: 'measured' | 'seed';
  updatedAt: string | null;
}

const state: GasProfileState = {};
let loaded = false;

/**
 * Where the samples survive a restart. Same strategy as scheduler-state.json: the working
 * directory when it is writable, the temp dir when the deploy target has a read-only bundle.
 */
function stateFileCandidates(): string[] {
  return [
    join(process.cwd(), 'gas-profile.json'),
    join(tmpdir(), 'steadystake-gas-profile.json'),
  ];
}

function load(): void {
  if (loaded) return;
  loaded = true;
  for (const path of stateFileCandidates()) {
    try {
      if (!existsSync(path)) continue;
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as GasProfileState;
      for (const [chainId, entry] of Object.entries(parsed ?? {})) {
        const samples = (entry?.samples ?? []).filter(
          (n) => Number.isFinite(n) && n >= MIN_PLAUSIBLE_GAS && n <= MAX_PLAUSIBLE_GAS,
        );
        if (samples.length > 0) {
          state[chainId] = { samples: samples.slice(-MAX_SAMPLES), updatedAt: entry.updatedAt };
        }
      }
      return;
    } catch {
      // A corrupt or unreadable file must not stop the relayer: fall through to the seeds.
    }
  }
}

function persist(): void {
  const serialized = JSON.stringify(state, null, 2);
  for (const path of stateFileCandidates()) {
    try {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(path, serialized, 'utf-8');
      return;
    } catch {
      // Try the next candidate; losing persistence costs accuracy after a restart, nothing more.
    }
  }
}

/** The median, which one freak run cannot drag the way a mean can. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

/**
 * Report what one completed run burned. `recordGasUsed` is null when the swap landed but the
 * gas-tank deduction did not — that run is not a complete two-transaction sample, so it is
 * dropped rather than recorded as an artificially cheap one.
 */
export function recordRunGas(
  chainId: number,
  swapGasUsed: bigint,
  recordGasUsed: bigint | null,
): void {
  if (recordGasUsed == null) return;
  load();
  const total = Number(swapGasUsed) + Number(recordGasUsed);
  if (!Number.isFinite(total) || total < MIN_PLAUSIBLE_GAS || total > MAX_PLAUSIBLE_GAS) return;

  const key = String(chainId);
  const entry = state[key] ?? { samples: [], updatedAt: new Date().toISOString() };
  entry.samples = [...entry.samples, total].slice(-MAX_SAMPLES);
  entry.updatedAt = new Date().toISOString();
  state[key] = entry;
  persist();
}

/** The gas-units figure for one chain, measured where possible and seeded until then. */
export function getGasProfile(chainId: number): GasProfileEntry {
  load();
  const entry = state[String(chainId)];
  if (entry && entry.samples.length > 0) {
    return {
      chainId,
      gasUnitsPerRun: median(entry.samples),
      samples: entry.samples.length,
      source: 'measured',
      updatedAt: entry.updatedAt,
    };
  }
  return {
    chainId,
    gasUnitsPerRun: SEED_GAS_UNITS[chainId] ?? DEFAULT_SEED_GAS_UNITS,
    samples: 0,
    source: 'seed',
    updatedAt: null,
  };
}

/** Every chain with a profile: those that have run, plus every chain carrying a seed. */
export function getAllGasProfiles(): GasProfileEntry[] {
  load();
  const chainIds = new Set<number>([
    ...Object.keys(state).map(Number),
    ...Object.keys(SEED_GAS_UNITS).map(Number),
  ]);
  return [...chainIds]
    .filter((id) => Number.isFinite(id))
    .sort((a, b) => a - b)
    .map(getGasProfile);
}
