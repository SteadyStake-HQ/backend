/**
 * What runs really cost on each chain, learned from the runs themselves.
 *
 * A run is two transactions the relayer signs: `executeSwap` on the vault and `recordExecution`
 * on the gas tank. Nothing about their cost is decided in advance any more — the tank is debited
 * the gas those two actually burned, priced in the network's own token (see run-executor.ts). So
 * this module is the record of what that came to, kept for two audiences:
 *
 *  - the relayer, which needs the median gas a run burns on a chain to size the charge for the
 *    `recordExecution` leg — the one transaction whose receipt does not exist yet when the amount
 *    to debit has to be chosen;
 *  - users, who are quoted the **average** and the **worst** of the last runs on that network
 *    rather than a flat rate, because a variable charge is only fair if its range is published.
 *
 * Measured on BOT Chain mainnet (677) from relayer receipts:
 *   executeSwap      187,631 / 205,666 / 238,931
 *   recordExecution   43,375 /  51,418 /  51,418
 *   per run          239,049 / 249,041 / 290,349
 * — a different number again on any chain whose swap path is not BDEX V2, which is why the seeds
 * below only cover the window before a chain has observations of its own.
 *
 * Samples are kept per chain and per leg. Cross-chain settlements — a run on one network paid out
 * of another network's tank — are recorded too, but never counted toward a chain's gas medians:
 * their two transactions ran on two chains at two gas prices, so their total is not a fact about
 * either one. They are counted in the cost statistics, where they belong, and flagged, because
 * costing more is exactly what users are told to expect of them.
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
 * Gas the `recordExecution` leg burns, before a chain has measured its own. It is the deduction
 * transaction, whose cost has to be *predicted* rather than read: the relayer must choose the
 * amount to debit before sending the transaction that debits it. Measured at 43k–51k on BOT
 * Chain; the seed rounds up, since under-estimating this leg is the one error that costs the
 * relayer money.
 */
const SEED_RECORD_GAS_UNITS = 60_000;

/**
 * Samples kept per chain — the window every published figure is drawn from, and the "last 1000
 * transactions" the app quotes. Wide enough that the average is a real average and the maximum
 * has seen a congested day, bounded so a chain's history cannot grow without limit.
 */
const MAX_SAMPLES = 1000;

/** A sane band for a per-run total. Anything outside is a mis-attributed or failed receipt. */
const MIN_PLAUSIBLE_GAS = 21_000;
const MAX_PLAUSIBLE_GAS = 5_000_000;

/**
 * A charge above this ($10 on the pooled 6-decimal scale) is not a run, it is a units mistake.
 * Recording one would poison the maximum users are quoted for the rest of the window.
 */
const MAX_PLAUSIBLE_COST_USD6 = 10_000_000;

/** One completed run, as it is persisted. Tuple-shaped: 1000 of these per chain, times 8 chains. */
type StoredSample = [
  /** Total gas both transactions burned. 0 when they ran on two different chains. */
  gas: number,
  /** Gas the `recordExecution` leg burned, on whichever chain settled it. 0 when unknown. */
  recordGas: number,
  /** What the tank was actually charged, on the pooled 6-decimal USD scale. */
  costUsd6: number,
  /** 1 when the paying tank was on another network, 0 when it was the execution chain's own. */
  cross: 0 | 1,
  /** When it ran, epoch ms. */
  at: number,
];

interface ChainSamples {
  runs: StoredSample[];
  updatedAt: string;
}

type GasProfileState = Record<string, ChainSamples>;

/** What the last runs on a chain were charged. Null figures mean nothing has run there yet. */
export interface RunCostStats {
  /** Runs behind these figures — up to MAX_SAMPLES. */
  samples: number;
  /** Mean charge over the window, pooled 6-decimal USD. */
  avgUsd6: number | null;
  /** The worst single charge in the window — what a user should be ready for. */
  maxUsd6: number | null;
  /** The cheapest, for the range. */
  minUsd6: number | null;
  /** The most recent charge. */
  lastUsd6: number | null;
  /** How many of the window's runs were paid out of another network's tank. */
  crossChainSamples: number;
  /** Mean charge of those, which is the premium the app warns users about, measured. */
  crossChainAvgUsd6: number | null;
  /** Mean charge of the runs paid from this network's own tank, for the comparison. */
  sameChainAvgUsd6: number | null;
}

export interface GasProfileEntry {
  chainId: number;
  /** Gas units one run burns across both transactions. */
  gasUnitsPerRun: number;
  /** Gas the deduction leg alone burns — what the relayer prices before it can measure it. */
  recordGasUnits: number;
  /** How many same-chain runs those gas figures are drawn from. 0 means the seed is still in use. */
  samples: number;
  /** "measured" once this chain has run at least once; "seed" until then. */
  source: 'measured' | 'seed';
  /** What those runs were charged. */
  cost: RunCostStats;
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

function plausibleGas(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= MIN_PLAUSIBLE_GAS && n <= MAX_PLAUSIBLE_GAS
    ? n
    : 0;
}

/**
 * Read one persisted run, in either shape this file has had.
 *
 * The first version stored gas totals alone (`samples: number[]`) and knew nothing about what a
 * run was charged, because back then it was charged a flat rate that had nothing to do with gas.
 * Those totals are still true and still worth their place in the median, so they are carried
 * forward with no cost attached rather than discarded — a chain that has been running for months
 * should not go back to reading "estimated" because the format changed underneath it.
 */
function parseSample(raw: unknown): StoredSample | null {
  if (typeof raw === 'number') {
    const gas = plausibleGas(raw);
    return gas === 0 ? null : [gas, 0, 0, 0, 0];
  }
  if (!Array.isArray(raw)) return null;
  const gas = plausibleGas(raw[0]);
  const recordGas = plausibleGas(raw[1]);
  const cost =
    typeof raw[2] === 'number' && Number.isFinite(raw[2]) && raw[2] > 0 && raw[2] <= MAX_PLAUSIBLE_COST_USD6
      ? Math.round(raw[2])
      : 0;
  if (gas === 0 && recordGas === 0 && cost === 0) return null;
  const at = typeof raw[4] === 'number' && Number.isFinite(raw[4]) ? raw[4] : 0;
  return [gas, recordGas, cost, raw[3] === 1 ? 1 : 0, at];
}

function load(): void {
  if (loaded) return;
  loaded = true;
  for (const path of stateFileCandidates()) {
    try {
      if (!existsSync(path)) continue;
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
      for (const [chainId, entry] of Object.entries(parsed ?? {})) {
        const record = entry as { runs?: unknown[]; samples?: unknown[]; updatedAt?: string } | null;
        const rawRuns = record?.runs ?? record?.samples ?? [];
        const runs = rawRuns
          .map(parseSample)
          .filter((s): s is StoredSample => s !== null)
          .slice(-MAX_SAMPLES);
        if (runs.length > 0) {
          state[chainId] = {
            runs,
            updatedAt: typeof record?.updatedAt === 'string' ? record.updatedAt : new Date().toISOString(),
          };
        }
      }
      return;
    } catch {
      // A corrupt or unreadable file must not stop the relayer: fall through to the seeds.
    }
  }
}

function persist(): void {
  const serialized = JSON.stringify(state);
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

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, n) => sum + n, 0) / values.length);
}

/**
 * Report what one completed run cost.
 *
 * `swapGasUsed` and `recordGasUsed` are receipts. `chargedUsd6` is what the tank was actually
 * debited, on the pooled scale, and is what users are quoted from — so a run that executed but
 * whose deduction never landed reports `chargedUsd6: 0` and is kept only for its gas.
 *
 * `crossChain` marks a run settled from another network's tank. Such a run's two transactions
 * ran at two different gas prices, so its total is excluded from this chain's gas medians while
 * its cost still counts: the premium is real and users are told about it.
 */
export function recordRun(input: {
  chainId: number;
  swapGasUsed: bigint;
  recordGasUsed: bigint | null;
  chargedUsd6: bigint;
  crossChain: boolean;
}): void {
  load();
  const { chainId, swapGasUsed, recordGasUsed, chargedUsd6, crossChain } = input;

  const recordGas = recordGasUsed == null ? 0 : plausibleGas(Number(recordGasUsed));
  // A total is only a total when both legs are in it and both ran here.
  const total =
    crossChain || recordGas === 0 ? 0 : plausibleGas(Number(swapGasUsed) + recordGas);
  const cost = Number(chargedUsd6);
  const costUsd6 =
    Number.isFinite(cost) && cost > 0 && cost <= MAX_PLAUSIBLE_COST_USD6 ? Math.round(cost) : 0;
  // Nothing usable happened — neither a gas measurement nor a charge worth publishing.
  if (total === 0 && costUsd6 === 0 && (crossChain || recordGas === 0)) return;

  const key = String(chainId);
  const entry = state[key] ?? { runs: [], updatedAt: new Date().toISOString() };
  entry.runs = [
    ...entry.runs,
    [total, crossChain ? 0 : recordGas, costUsd6, crossChain ? 1 : 0, Date.now()] as StoredSample,
  ].slice(-MAX_SAMPLES);
  entry.updatedAt = new Date().toISOString();
  state[key] = entry;
  persist();
}

function costStats(runs: StoredSample[]): RunCostStats {
  const charged = runs.filter((r) => r[2] > 0);
  const costs = charged.map((r) => r[2]);
  const cross = charged.filter((r) => r[3] === 1).map((r) => r[2]);
  const same = charged.filter((r) => r[3] === 0).map((r) => r[2]);
  return {
    samples: costs.length,
    avgUsd6: mean(costs),
    maxUsd6: costs.length > 0 ? Math.max(...costs) : null,
    minUsd6: costs.length > 0 ? Math.min(...costs) : null,
    lastUsd6: charged.length > 0 ? charged[charged.length - 1][2] : null,
    crossChainSamples: cross.length,
    crossChainAvgUsd6: mean(cross),
    sameChainAvgUsd6: mean(same),
  };
}

/** The gas-units figure for one chain, measured where possible and seeded until then. */
export function getGasProfile(chainId: number): GasProfileEntry {
  load();
  const entry = state[String(chainId)];
  const runs = entry?.runs ?? [];
  const totals = runs.map((r) => r[0]).filter((n) => n > 0);
  const recordGas = runs.map((r) => r[1]).filter((n) => n > 0);

  return {
    chainId,
    gasUnitsPerRun:
      totals.length > 0
        ? median(totals)
        : (SEED_GAS_UNITS[chainId] ?? DEFAULT_SEED_GAS_UNITS),
    recordGasUnits: recordGas.length > 0 ? median(recordGas) : SEED_RECORD_GAS_UNITS,
    samples: totals.length,
    source: totals.length > 0 ? 'measured' : 'seed',
    cost: costStats(runs),
    updatedAt: entry?.updatedAt ?? null,
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
