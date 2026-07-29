import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { createPublicClient, http, formatUnits } from 'viem';
import { AdminTokenGuard } from '../admin/admin-token.guard';
import {
  getAllRunPrices,
  getRunPriceUsdc6,
  parseUsdToUsdc6,
  refreshRunPrices,
  RunPriceError,
  setRunPrice,
} from '../run-price';
import { estimateRunCost, type RunCostEstimate } from '../run-cost';
import {
  CHAIN_NAMES,
  getChainIdsWithGasTank,
  getGasCostPerExecutionUsdc6Fallback,
  getRpc,
  getStableDecimals,
  getStableSymbol,
  getVaultUsdcGasTank,
} from '../config';
import { getChain } from '../run-executor';

/** Where the number a user is charged came from, in the order the relayer resolves them. */
type PriceSource = 'manual' | 'onchain' | 'env' | 'live';

const GAS_TANK_ABI = [
  {
    type: 'function',
    name: 'gasCostPerExecutionUsdc6',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

/**
 * The GasTank's own price, cached briefly. Only an owner transaction changes it, and an operator
 * sits on this page while deciding a rate — without a cache that is one round trip per chain per
 * refresh for a number that moves perhaps once a year.
 */
const ON_CHAIN_CACHE_TTL_MS = 30_000;
const onChainCache = new Map<number, { at: number; value: bigint | null }>();

/** Bounded: a network whose RPC has stopped answering must not hold the request open. */
const RPC_TIMEOUT_MS = 9_000;

async function readOnChainPrice(chainId: number): Promise<bigint | null> {
  const cached = onChainCache.get(chainId);
  if (cached && Date.now() - cached.at < ON_CHAIN_CACHE_TTL_MS) return cached.value;

  const rpc = getRpc(chainId);
  const chain = getChain(chainId);
  const gasTank = getVaultUsdcGasTank(chainId)?.gasTank;
  let value: bigint | null = null;
  if (rpc && chain && gasTank) {
    const client = createPublicClient({
      chain,
      transport: http(rpc, { timeout: RPC_TIMEOUT_MS, retryCount: 1 }),
    });
    value = (await client
      .readContract({
        address: gasTank as `0x${string}`,
        abi: GAS_TANK_ABI,
        functionName: 'gasCostPerExecutionUsdc6',
      })
      .catch(() => null)) as bigint | null;
  }
  onChainCache.set(chainId, { at: Date.now(), value });
  return value;
}

function usd(chainId: number, usdc6: bigint | null): number | null {
  return usdc6 == null ? null : Number(formatUnits(usdc6, getStableDecimals(chainId)));
}

/** The stored price and the env fallback — the two halves that need no network to answer. */
function storedPrices(chainId: number) {
  const stored = getAllRunPrices()[String(chainId)] ?? null;
  const envUsdc6 = getGasCostPerExecutionUsdc6Fallback(chainId);
  return {
    stored,
    envUsdc6: envUsdc6 && envUsdc6 > 0n ? envUsdc6 : null,
    manual: stored
      ? {
          usdc6: stored.usdc6,
          usd: usd(chainId, BigInt(stored.usdc6)),
          updatedAt: stored.updatedAt,
          updatedBy: stored.updatedBy,
          note: stored.note,
        }
      : null,
  };
}

function identity(chainId: number) {
  return {
    chainId,
    name: CHAIN_NAMES[chainId] ?? `Chain ${chainId}`,
    stableSymbol: getStableSymbol(chainId),
  };
}

/**
 * One network before anything has been read from it: the operator's own price and the env
 * fallback, both of which are already in memory.
 *
 * This is what the list endpoint answers with, and it answers instantly. Everything a network can
 * be slow or unreachable about — its gas price, its GasTank's rate, the USD price of its token —
 * is deliberately absent here and fetched per network afterwards. Before that split, one throttled
 * price feed or one stalled RPC delayed, and often blanked, every other network on the page.
 */
function summariseChain(chainId: number) {
  const { manual, envUsdc6 } = storedPrices(chainId);
  const effectiveUsdc6 = manual ? BigInt(manual.usdc6) : null;
  return {
    ...identity(chainId),
    effectiveUsdc6: effectiveUsdc6?.toString() ?? null,
    effectiveUsd: usd(chainId, effectiveUsdc6),
    /** Null until the live read resolves it — the contract may hold a price this cannot see. */
    source: manual ? ('manual' as PriceSource) : null,
    manual,
    onChain: { usdc6: null as string | null, usd: null as number | null },
    env: { usdc6: envUsdc6?.toString() ?? null, usd: usd(chainId, envUsdc6) },
    live: null,
    /** True while the network-bound half of this card is still to be fetched. */
    pending: true,
  };
}

function describeLive(chainId: number, cost: RunCostEstimate) {
  return {
    gasPriceWei: cost.gasPriceWei?.toString() ?? null,
    gasPriceGwei: cost.gasPriceWei != null ? Number(formatUnits(cost.gasPriceWei, 9)) : null,
    gasUnitsPerRun: cost.gas.gasUnits,
    /** "simulated" (estimated from the real transactions), "measured", or "seed". */
    gasUnitsSource: cost.gas.source,
    gasUnitsSamples: cost.gas.samples,
    executeSwapGas: cost.gas.executeSwapGas,
    recordExecutionGas: cost.gas.recordExecutionGas,
    simulatedPlan: cost.gas.plan,
    gasNote: cost.gas.note,
    nativeUsd: cost.native.usd,
    nativeSource: cost.native.source,
    nativeAt: cost.native.at,
    /** True when every feed failed just now and this is the last price they gave. */
    nativeStale: cost.native.stale,
    feeNative: cost.feeNative,
    usd: cost.usd,
  };
}

/**
 * Everything about one chain's run price: what is charged, where that number comes from, and what
 * the run actually costs the relayer right now — the two side by side, because setting a flat rate
 * without seeing the live cost is how a rate ends up a tenth of what a run burns.
 */
async function describeChain(chainId: number) {
  const { manual, envUsdc6 } = storedPrices(chainId);
  const manualUsdc6 = getRunPriceUsdc6(chainId);

  const [onChainRaw, cost] = await Promise.all([
    readOnChainPrice(chainId),
    estimateRunCost(chainId),
  ]);
  const onChainUsdc6 = onChainRaw != null && onChainRaw > 0n ? onChainRaw : null;

  const effectiveUsdc6 = manualUsdc6 ?? onChainUsdc6 ?? envUsdc6;
  const source: PriceSource = manualUsdc6
    ? 'manual'
    : onChainUsdc6
      ? 'onchain'
      : envUsdc6
        ? 'env'
        : 'live';

  return {
    ...identity(chainId),
    /** The number the relayer debits and the app quotes. Null only when nothing has set one. */
    effectiveUsdc6: effectiveUsdc6?.toString() ?? null,
    effectiveUsd: usd(chainId, effectiveUsdc6),
    source,
    manual,
    onChain: { usdc6: onChainUsdc6?.toString() ?? null, usd: usd(chainId, onChainUsdc6) },
    env: { usdc6: envUsdc6?.toString() ?? null, usd: usd(chainId, envUsdc6) },
    /** What the run costs the relayer at this moment, from a simulated execution. */
    live: describeLive(chainId, cost),
    pending: false,
  };
}

function parseChainId(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new BadRequestException({ error: 'A valid chainId is required.' });
  }
  return parsed;
}

/**
 * The per-run charge, per network.
 *
 * GET is open, like the rest of the read-only scheduler API — it is the same figure the app already
 * shows every user. POST changes what people are charged, so it is behind ADMIN_API_TOKEN.
 */
@Controller('api/run-price')
export class RunPriceController {
  /**
   * Without `chainId`, the list of networks with their stored prices and nothing network-bound —
   * immediate, so the page can draw every card and then fill each one in from `/live`.
   *
   * With `chainId`, the full picture for that one network, live cost included. The app's
   * /api/run-price proxy calls it that way and reads the operator price out of it.
   */
  @Get()
  async get(@Query('chainId') chainId?: string) {
    await refreshRunPrices();

    if (chainId != null && chainId !== '') {
      return describeChain(parseChainId(chainId));
    }

    const chainIds = getChainIdsWithGasTank().sort((a, b) => a - b);
    return { chains: chainIds.map(summariseChain) };
  }

  /**
   * The network-bound half for one chain: its GasTank's rate, and what a run costs there right now.
   *
   * One chain per request on purpose. These are the slow reads — an RPC round trip, a price feed,
   * and a simulated execution — and batching them meant the slowest network set the speed of the
   * page and any one failure took the rest of the page's live figures down with it.
   */
  @Get('live')
  async live(@Query('chainId') chainId?: string) {
    await refreshRunPrices();
    return describeChain(parseChainId(chainId));
  }

  @Post()
  @UseGuards(AdminTokenGuard)
  async set(
    @Body()
    body: {
      chainId?: number | string;
      /** Dollars per run, e.g. "0.05". Omit or send null to clear and fall back to the contract. */
      usd?: string | number | null;
      updatedBy?: string | null;
      note?: string | null;
    },
  ) {
    const chainId = Number(body?.chainId);
    if (!Number.isFinite(chainId) || chainId <= 0) {
      throw new BadRequestException({ error: 'A valid chainId is required.' });
    }
    try {
      const usdc6 = body?.usd == null || String(body.usd).trim() === '' ? null : parseUsdToUsdc6(chainId, body.usd);
      await setRunPrice(chainId, usdc6, { updatedBy: body?.updatedBy, note: body?.note });
      // Re-read so the response is the state the next run will actually price against, not the
      // state this request hoped to write.
      await refreshRunPrices(true);
      return { ok: true, chain: await describeChain(chainId) };
    } catch (error) {
      if (error instanceof RunPriceError) {
        throw new BadRequestException({ ok: false, error: error.message });
      }
      throw error;
    }
  }
}
