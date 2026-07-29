/**
 * What one scheduled run costs the relayer on a given network, right now.
 *
 * A run is two transactions — `executeSwap` on the DCAVault and `recordExecution` on the GasTank —
 * and its cost is `gas those two burn x the chain's gas price x the USD price of the native token`.
 * The last two are read live (see native-price.ts for the price feeds). This module supplies the
 * first, and it does so by asking the chain rather than by assuming.
 *
 * The gas figure is resolved in three steps, best first, and every answer says which step produced
 * it so the dashboard never presents an assumption as a measurement:
 *
 *  1. **simulated** — a real plan on that network is picked, the exact calldata the relayer would
 *     send is built for it (including a live 0x quote on aggregator chains), and both transactions
 *     are put through `eth_estimateGas` from the relayer's own address. This is the number the next
 *     run would actually burn, on today's route, with today's contract code.
 *  2. **measured** — the median of what recent completed runs on that chain really used
 *     (gas-profile.ts). Used when nothing can be simulated, usually because no plan on that network
 *     is past its cooldown: `executeSwap` on a schedule that is not ready reverts, and a reverting
 *     call cannot be estimated.
 *  3. **seed** — the pre-measurement constant for the chain's swap path, for a network that has
 *     neither run nor anything to simulate.
 *
 * Estimating is not free — a cold simulation is roughly six round trips plus a 0x quote — so the
 * result is cached per chain, longer for a successful simulation than for a failed one. Gas price
 * and token price are cached separately and briefly, because those are the parts that actually move.
 */

import { createPublicClient, formatUnits, http, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getGasProfile } from './gas-profile';
import { getNativePriceQuote, type NativePriceQuote } from './native-price';
import { getRunPriceUsdc6 } from './run-price';
import {
  getGasCostPerExecutionUsdc6Fallback,
  getRpc,
  getStableOne,
  getSwapAdapter,
  getVaultUsdcGasTank,
  usesDirectSwapRouter,
} from './config';
import {
  DCA_VAULT_ABI,
  GAS_TANK_ABI,
  get0xQuote,
  getChain,
  netAmountAfterFee,
} from './run-executor';
import { getDcaPlanMembers, getDcaPlans, isSupabaseConfigured } from './supabase/dca-plans-store';

/** Where the gas-units figure came from. See the ladder in the module comment. */
export type GasUnitsSource = 'simulated' | 'measured' | 'seed';

export interface RunGasEstimate {
  /** Gas both transactions burn, per run. */
  gasUnits: number;
  source: GasUnitsSource;
  /** Completed runs behind a "measured" figure. 0 otherwise. */
  samples: number;
  /** Estimated gas for the vault's executeSwap, when it could be simulated. */
  executeSwapGas: number | null;
  /** Estimated gas for the gas tank's recordExecution, when it could be simulated. */
  recordExecutionGas: number | null;
  /** The plan the simulation ran against, when one was usable. */
  plan: { user: string; scheduleId: string } | null;
  /** In plain words: what was simulated, or why it could not be. */
  note: string;
}

export interface RunCostEstimate {
  chainId: number;
  gasPriceWei: bigint | null;
  gas: RunGasEstimate;
  native: NativePriceQuote;
  /** Native token spent per run: gas price x gas units. */
  feeNative: number | null;
  /** The same figure in USD. Null when either the gas price or the token price is missing. */
  usd: number | null;
}

/** An RPC that does not answer promptly must not hold up the network it belongs to. */
const RPC_TIMEOUT_MS = 9_000;

/** Gas price moves; the whole cost estimate is only held this long. */
const COST_CACHE_TTL_MS = 20_000;

/** A successful simulation is stable — the route and the contract code are what it measures. */
const SIM_CACHE_TTL_MS = 5 * 60_000;

/** A failed one is retried sooner, since a plan coming off cooldown is all it takes to succeed. */
const SIM_RETRY_TTL_MS = 90_000;

/** Users tried before giving up on a chain. One or two usually settles it either way. */
const MAX_CANDIDATE_USERS = 3;

const costCache = new Map<number, { at: number; value: RunCostEstimate }>();
const simCache = new Map<number, { at: number; ttl: number; value: RunGasEstimate }>();

function client(chainId: number): PublicClient | null {
  const rpc = getRpc(chainId);
  const chain = getChain(chainId);
  if (!rpc || !chain) return null;
  return createPublicClient({
    chain,
    transport: http(rpc, { timeout: RPC_TIMEOUT_MS, retryCount: 1 }),
  }) as PublicClient;
}

/** The relayer's address. Only the address is needed — nothing here signs or sends anything. */
function relayerAddress(): `0x${string}` | null {
  const pk = process.env.RELAYER_PRIVATE_KEY?.trim();
  if (!pk) return null;
  try {
    return privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`).address;
  } catch {
    return null;
  }
}

function fallbackGas(chainId: number, note: string): RunGasEstimate {
  const profile = getGasProfile(chainId);
  return {
    gasUnits: profile.gasUnitsPerRun,
    source: profile.source,
    samples: profile.samples,
    executeSwapGas: null,
    recordExecutionGas: null,
    plan: null,
    note,
  };
}

/**
 * Addresses worth trying on this chain, best first: whoever the plan store says has a live plan,
 * then anyone else registered for automation there. The second list matters because the store can
 * lag the chain — a plan finished or created since the last index shows up in one and not the
 * other, and either way the vault is the thing being asked.
 */
async function candidateUsers(chainId: number): Promise<string[]> {
  if (!isSupabaseConfigured()) return [];
  const [plans, members] = await Promise.all([
    getDcaPlans([chainId]).catch(() => []),
    getDcaPlanMembers([chainId]).catch(() => [] as string[]),
  ]);

  const seen = new Set<string>();
  const users: string[] = [];
  const add = (raw: string) => {
    const user = raw.toLowerCase();
    if (seen.has(user)) return;
    seen.add(user);
    users.push(user);
  };

  for (const plan of plans) {
    if (plan.status === 'active') add(plan.userAddr);
  }
  // Members arrive as `${chainId}:${address}`; the query already restricted them to this chain.
  for (const member of members) add(member.split(':')[1] ?? '');
  return users.filter((user) => /^0x[0-9a-f]{40}$/.test(user));
}

/**
 * The amount to put through `recordExecution`. It has to be one the tank can actually pay, or the
 * call reverts and estimates nothing: the run price when the user's balance covers it, their whole
 * balance when it does not. The gas is the same either way — the same storage slots are written.
 */
function recordAmount(chainId: number, balance: bigint, effectivePrice: bigint | null): bigint {
  const price = effectivePrice && effectivePrice > 0n ? effectivePrice : getStableOne(chainId) / 100n;
  if (balance <= 0n) return 0n;
  return balance >= price ? price : balance;
}

/**
 * Put the two transactions of a real run through eth_estimateGas.
 *
 * Only a *ready* schedule can be estimated. `executeSwap` on one still inside its interval reverts,
 * and an estimate of a reverting call is not an estimate — so a chain whose plans are all mid-
 * cooldown falls back to its measured median, and says so.
 */
async function simulateRunGas(chainId: number): Promise<RunGasEstimate> {
  const cfg = getVaultUsdcGasTank(chainId);
  if (!cfg) return fallbackGas(chainId, 'No DCAVault/GasTank is deployed on this network.');

  const relayer = relayerAddress();
  if (!relayer) {
    return fallbackGas(
      chainId,
      'RELAYER_PRIVATE_KEY is not set, so the run transactions cannot be simulated from the address that would send them.',
    );
  }

  const publicClient = client(chainId);
  if (!publicClient) return fallbackGas(chainId, 'No RPC endpoint is configured for this network.');

  if (!isSupabaseConfigured()) {
    return fallbackGas(chainId, 'No plan store configured, so there is no real plan to simulate.');
  }

  const users = await candidateUsers(chainId);
  if (users.length === 0) {
    return fallbackGas(chainId, 'No plan or registered user on this network to simulate a run against.');
  }

  const vault = cfg.vault as `0x${string}`;
  const gasTank = cfg.gasTank as `0x${string}`;
  const effectivePrice =
    getRunPriceUsdc6(chainId) ?? getGasCostPerExecutionUsdc6Fallback(chainId) ?? null;

  let feeBps = 25;
  try {
    feeBps = Number(
      await publicClient.readContract({
        address: vault,
        abi: DCA_VAULT_ABI,
        functionName: 'feePercentage',
      }),
    );
  } catch {
    // The default matches the vault's own; a wrong fee only shifts the quoted sell amount slightly.
  }

  let lastReason = 'No plan on this network is past its cooldown, so no run can be simulated yet.';

  for (const address of users.slice(0, MAX_CANDIDATE_USERS)) {
    const user = address as `0x${string}`;

    let readyIds: bigint[] = [];
    try {
      readyIds = (await publicClient.readContract({
        address: vault,
        abi: DCA_VAULT_ABI,
        functionName: 'getReadyScheduleIds',
        args: [user],
      })) as bigint[];
    } catch (error) {
      lastReason = `The vault could not be read for a ready plan: ${(error as Error).message}`;
      continue;
    }
    if (readyIds.length === 0) continue;

    const scheduleId = readyIds[0];
    let schedule: { targetToken: `0x${string}`; amountPerInterval: bigint };
    try {
      schedule = (await publicClient.readContract({
        address: vault,
        abi: DCA_VAULT_ABI,
        functionName: 'getSchedule',
        args: [user, scheduleId],
      })) as { targetToken: `0x${string}`; amountPerInterval: bigint };
    } catch (error) {
      lastReason = `The ready plan could not be read: ${(error as Error).message}`;
      continue;
    }

    // The same calldata the relayer would send: empty for the direct-router chains, a live 0x v2
    // quote bound to the vault's adapter everywhere else (run-executor.ts builds it the same way).
    let swapData: string | null = '0x';
    if (!usesDirectSwapRouter(chainId)) {
      const adapter = getSwapAdapter(chainId);
      if (!adapter) {
        lastReason = 'This network has no swap adapter configured, so no swap calldata can be built.';
        continue;
      }
      swapData = await get0xQuote(
        chainId,
        cfg.usdc,
        schedule.targetToken,
        netAmountAfterFee(schedule.amountPerInterval, feeBps).toString(),
        adapter,
        process.env.ZERO_EX_API_KEY,
      ).catch(() => null);
      if (swapData === null) {
        lastReason = '0x had no executable quote for this plan, so the swap could not be simulated.';
        continue;
      }
    }

    let executeSwapGas: bigint;
    try {
      executeSwapGas = await publicClient.estimateContractGas({
        account: relayer,
        address: vault,
        abi: DCA_VAULT_ABI,
        functionName: 'executeSwap',
        args: [user, scheduleId, swapData as `0x${string}`],
      });
    } catch (error) {
      lastReason = `executeSwap could not be estimated: ${shortError(error)}`;
      continue;
    }

    let balance = 0n;
    try {
      balance = (await publicClient.readContract({
        address: gasTank,
        abi: GAS_TANK_ABI,
        functionName: 'balanceOf',
        args: [user],
      })) as bigint;
    } catch {
      // Treated as an empty tank below, which skips this user for the deduction leg.
    }
    const amount = recordAmount(chainId, balance, effectivePrice);
    if (amount <= 0n) {
      lastReason =
        'The plan that could be simulated has an empty gas tank on this network, so the deduction leg could not be estimated.';
      continue;
    }

    let recordGas: bigint;
    try {
      recordGas = await publicClient.estimateContractGas({
        account: relayer,
        address: gasTank,
        abi: GAS_TANK_ABI,
        functionName: 'recordExecution',
        args: [user, amount],
      });
    } catch (error) {
      lastReason = `recordExecution could not be estimated: ${shortError(error)}`;
      continue;
    }

    return {
      gasUnits: Number(executeSwapGas) + Number(recordGas),
      source: 'simulated',
      samples: 0,
      executeSwapGas: Number(executeSwapGas),
      recordExecutionGas: Number(recordGas),
      plan: { user: address, scheduleId: scheduleId.toString() },
      note: 'Estimated from the two transactions a run on this network would send right now.',
    };
  }

  return fallbackGas(chainId, lastReason);
}

/** Revert reasons arrive as multi-line RPC dumps; the dashboard has room for the first line. */
function shortError(error: unknown): string {
  const message = (error as Error)?.message ?? String(error);
  return message.split('\n')[0].slice(0, 160);
}

async function cachedSimulation(chainId: number): Promise<RunGasEstimate> {
  const cached = simCache.get(chainId);
  if (cached && Date.now() - cached.at < cached.ttl) return cached.value;

  const value = await simulateRunGas(chainId).catch((error) =>
    fallbackGas(chainId, `The run could not be simulated: ${shortError(error)}`),
  );
  simCache.set(chainId, {
    at: Date.now(),
    ttl: value.source === 'simulated' ? SIM_CACHE_TTL_MS : SIM_RETRY_TTL_MS,
    value,
  });
  return value;
}

/**
 * The chain's current gas price. `eth_gasPrice` already includes a priority tip on EIP-1559
 * chains; the fee-history estimate is the fallback for nodes that do not implement it.
 */
async function currentGasPrice(publicClient: PublicClient | null): Promise<bigint | null> {
  if (!publicClient) return null;
  const direct = await publicClient.getGasPrice().catch(() => null);
  if (direct != null && direct > 0n) return direct;
  const fees = await publicClient.estimateFeesPerGas().catch(() => null);
  return fees?.maxFeePerGas ?? fees?.gasPrice ?? null;
}

/**
 * What one run costs on this network at this moment. Independent legs: a chain whose RPC is down
 * still reports a token price, and a token with no feed still reports its gas price, because a
 * missing half is worth showing an operator and a blank card is not.
 */
export async function estimateRunCost(chainId: number): Promise<RunCostEstimate> {
  const cached = costCache.get(chainId);
  if (cached && Date.now() - cached.at < COST_CACHE_TTL_MS) return cached.value;

  const publicClient = client(chainId);
  const [gasPriceWei, gas, native] = await Promise.all([
    currentGasPrice(publicClient),
    cachedSimulation(chainId),
    getNativePriceQuote(chainId).catch(
      () => ({ chainId, usd: null, source: null, at: null, stale: false }) as NativePriceQuote,
    ),
  ]);

  const feeNative =
    gasPriceWei != null ? Number(formatUnits(gasPriceWei * BigInt(gas.gasUnits), 18)) : null;
  const usd = feeNative != null && native.usd != null ? feeNative * native.usd : null;

  const value: RunCostEstimate = { chainId, gasPriceWei, gas, native, feeNative, usd };
  costCache.set(chainId, { at: Date.now(), value });
  return value;
}
