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
 *  - users, who are quoted the **average** and the **worst** of the runs on that network rather
 *    than a flat rate, because a variable charge is only fair if its range is published.
 *
 * The figures users see no longer come from the samples below. This file's store is process-local
 * — a JSON file in the working directory or /tmp — so on a host that redeploys it is empty every
 * time anyone asks, and in production it always was: the gas tank's average and maximum never
 * appeared at all, and the estimate beside them multiplied a seed. `getGasProfile` now prefers the
 * durable record in `run_history`, aggregated per chain over every execution ever saved (see
 * run-cost-history.ts), and falls back to these samples only where there is no database to read it
 * from.
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
import {
  getRunCostHistory,
  getRunCostHistoryChainIds,
  runCostHistoryLoadedAt,
} from './run-cost-history';

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
 * Headroom on the one leg of a run that has to be priced before it happens.
 *
 * The swap's cost is read from its receipt — exact, no guess involved. The `recordExecution` that
 * debits the tank cannot be: the amount it debits is an argument to it, so it must be chosen
 * before the transaction exists. run-executor.ts prices it from the measured record-leg gas below
 * and widens it by this, because that estimate being low is the only way the relayer ends up
 * paying for part of a user's run out of its own pocket.
 *
 * It lives here rather than in run-executor.ts because it is part of what a run *costs*, and every
 * screen that estimates a charge ahead of a run has to apply it or quote under what will be
 * debited. Published on every profile for exactly that reason.
 */
export const RECORD_BUFFER_BPS = 12000; // 1.2x on the estimated deduction leg

/**
 * Samples this process keeps per chain.
 *
 * No longer the window the app quotes from — that is now every execution on record, aggregated
 * out of `run_history` (see run-cost-history.ts and the merge in getGasProfile). This is the
 * local cache behind it: what the running relayer has watched happen, which is all there is when
 * no database is configured, and which is a little fresher than the snapshot in between refreshes.
 * Bounded so a long-lived process's file cannot grow without limit.
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

/**
 * What runs on a chain were charged. Null figures mean nothing has run there yet.
 *
 * Drawn from every execution on record for that network — every user, no window — whenever the
 * durable history is reachable, and from this process's own samples when it is not.
 */
export interface RunCostStats {
  /** Runs behind these figures. */
  samples: number;
  /** Mean charge, pooled 6-decimal USD. */
  avgUsd6: number | null;
  /** The worst single charge on record — what a user should be ready for. */
  maxUsd6: number | null;
  /** The cheapest, for the range. */
  minUsd6: number | null;
  /** The most recent charge. */
  lastUsd6: number | null;
  /** How many of those runs were paid out of another network's tank. */
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
  /** The swap leg on its own. Null until measured — the seed only covers the two-leg total. */
  swapGasUnits: number | null;
  /** Gas the deduction leg alone burns — what the relayer prices before it can measure it. */
  recordGasUnits: number;
  /**
   * The busy-day gas figure: nine runs in ten burned no more than this. Anything sizing a
   * commitment rather than describing one should quote it, for the same reason the cost statistics
   * publish a maximum next to the average.
   */
  gasUnitsP90: number | null;
  /** How many same-chain runs those gas figures are drawn from. 0 means the seed is still in use. */
  samples: number;
  /** "measured" once this chain has run at least once; "seed" until then. */
  source: 'measured' | 'seed';
  /**
   * Where the measured figures came from. "history" is the durable execution record — every run on
   * this network, every user, no window. "relayer" is the current process's own samples, used only
   * when there is no database to read the record from.
   */
  basis: 'history' | 'relayer' | 'seed';
  /**
   * The headroom the relayer adds to the deduction leg when it charges (RECORD_BUFFER_BPS in
   * run-executor.ts). Published so anything estimating a charge ahead of a run can reproduce the
   * relayer's arithmetic exactly instead of quoting the bare gas and coming in under.
   */
  recordBufferBps: number;
  /** What those runs were charged. */
  cost: RunCostStats;
  /** When the earliest and latest run behind these figures ran. Null where nothing has. */
  firstRunAt: string | null;
  lastRunAt: string | null;
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

/** Dollars -> the pooled 6-decimal scale the cost statistics are stated on. */
function toUsd6(usd: number | null | undefined): number | null {
  return typeof usd === 'number' && Number.isFinite(usd) && usd > 0 ? Math.round(usd * 1e6) : null;
}

/**
 * One chain's profile: what a run there burns, and what runs there have been charged.
 *
 * Two records can answer that, and they are not equal. The durable one is `run_history` — every
 * execution ever saved, every user, no window — reached through the snapshot in
 * run-cost-history.ts. The other is the sample file this module writes, which holds whatever the
 * current process has watched happen. The first is a superset of the second by construction (the
 * executor writes both on every run), and it survives a redeploy, which the file does not, so it
 * wins wherever it has anything to say.
 *
 * The file is still read, and still matters: it is all there is when no database is configured,
 * and it is fresher than the snapshot by up to its refresh interval, so a chain that has just run
 * for the very first time gets a figure from it rather than waiting.
 */
export function getGasProfile(chainId: number): GasProfileEntry {
  load();
  const entry = state[String(chainId)];
  const runs = entry?.runs ?? [];
  const totals = runs.map((r) => r[0]).filter((n) => n > 0);
  const localRecordGas = runs.map((r) => r[1]).filter((n) => n > 0);
  const localCost = costStats(runs);

  const durable = getRunCostHistory(chainId);
  const durableGas = durable && durable.gasSamples > 0 ? durable : null;
  const durableCost = durable && durable.costSamples > 0 ? durable : null;

  /*
   * The legs have their own precedence, deliberately, and it is looser than the total's.
   *
   * A two-leg *total* only counts when both legs ran on this chain — a cross-chain settlement
   * burned its two halves at two gas prices, so its sum is a fact about neither. But each half on
   * its own is still a measurement of the chain it ran on, so a network whose runs have all been
   * settled from elsewhere has a perfectly good swap-leg figure and no total at all. Reading the
   * legs from `durable` rather than `durableGas` keeps that measurement instead of falling to a
   * seed beside it.
   *
   * The deduction leg matters most of the three: it is the one the relayer has to charge against
   * before it can measure it, so reaching for the seed too eagerly there costs real money.
   */
  const swapGasUnits = durable?.swapGasMedian ?? null;
  const recordGasUnits =
    durable?.recordGasMedian ??
    (localRecordGas.length > 0 ? median(localRecordGas) : SEED_RECORD_GAS_UNITS);

  const gasUnitsPerRun =
    durableGas?.gasUnitsMedian ??
    (totals.length > 0
      ? median(totals)
      : // The legs never ran here together, but the swap leg did. Its measurement plus whatever
        // the deduction leg resolved to beats a seed that knows about neither.
        (swapGasUnits != null
          ? swapGasUnits + recordGasUnits
          : (SEED_GAS_UNITS[chainId] ?? DEFAULT_SEED_GAS_UNITS)));
  const gasSamples = durableGas?.gasSamples ?? totals.length;

  const cost: RunCostStats = durableCost
    ? {
        samples: durableCost.costSamples,
        avgUsd6: toUsd6(durableCost.costAvgUsd),
        maxUsd6: toUsd6(durableCost.costMaxUsd),
        minUsd6: toUsd6(durableCost.costMinUsd),
        lastUsd6: toUsd6(durableCost.costLastUsd),
        crossChainSamples: durableCost.crossChainSamples,
        crossChainAvgUsd6: toUsd6(durableCost.crossChainAvgUsd),
        sameChainAvgUsd6: toUsd6(durableCost.sameChainAvgUsd),
      }
    : localCost;

  const basis: GasProfileEntry['basis'] =
    durableGas || durableCost ? 'history' : gasSamples > 0 || cost.samples > 0 ? 'relayer' : 'seed';

  return {
    chainId,
    gasUnitsPerRun,
    swapGasUnits,
    recordGasUnits,
    gasUnitsP90: durableGas?.gasUnitsP90 ?? null,
    samples: gasSamples,
    // "measured" the moment either record has seen a run here — a chain with charges on file is
    // not still guessing, whichever half of the profile the samples landed in.
    source: gasSamples > 0 || cost.samples > 0 ? 'measured' : 'seed',
    basis,
    recordBufferBps: RECORD_BUFFER_BPS,
    cost,
    firstRunAt: durable?.firstAt ?? null,
    lastRunAt: durable?.lastAt ?? null,
    updatedAt: entry?.updatedAt ?? (basis === 'history' ? runCostHistoryLoadedAt() : null),
  };
}

/** Every chain with a profile: those on record, those the relayer has watched, and the seeds. */
export function getAllGasProfiles(): GasProfileEntry[] {
  load();
  const chainIds = new Set<number>([
    ...Object.keys(state).map(Number),
    ...Object.keys(SEED_GAS_UNITS).map(Number),
    ...getRunCostHistoryChainIds(),
  ]);
  return [...chainIds]
    .filter((id) => Number.isFinite(id))
    .sort((a, b) => a - b)
    .map(getGasProfile);
}
