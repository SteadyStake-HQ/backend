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
import { getGasProfile } from '../gas-profile';
import {
  CHAIN_NAMES,
  getChainIdsWithGasTank,
  getGasCostPerExecutionUsdc6Fallback,
  getRpc,
  getStableDecimals,
  getStableSymbol,
  getVaultUsdcGasTank,
} from '../config';
import { getChain, getNativePriceUsd } from '../run-executor';

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

interface ChainReading {
  gasPriceWei: bigint | null;
  onChainUsdc6: bigint | null;
  nativeUsd: number | null;
}

/**
 * Per-chain RPC/feed reads, cached briefly. The dashboard polls this and an operator will sit on
 * the page while deciding a price; without a cache that is one gas-price round trip per chain per
 * refresh, and CoinGecko rate-limits long before that becomes free.
 */
const READ_CACHE_TTL_MS = 30_000;
const readCache = new Map<number, { at: number; value: ChainReading }>();

async function readChain(chainId: number): Promise<ChainReading> {
  const cached = readCache.get(chainId);
  if (cached && Date.now() - cached.at < READ_CACHE_TTL_MS) return cached.value;

  const value: ChainReading = { gasPriceWei: null, onChainUsdc6: null, nativeUsd: null };
  const rpc = getRpc(chainId);
  const chain = getChain(chainId);
  const gasTank = getVaultUsdcGasTank(chainId)?.gasTank;

  if (rpc && chain) {
    const client = createPublicClient({ chain, transport: http(rpc) });
    // Independent reads: a chain whose GasTank is unreachable should still report its gas price,
    // and an RPC outage should not blank the token price, which comes from a feed.
    const [gasPrice, onChain] = await Promise.all([
      client.getGasPrice().catch(() => null),
      gasTank
        ? client
            .readContract({
              address: gasTank as `0x${string}`,
              abi: GAS_TANK_ABI,
              functionName: 'gasCostPerExecutionUsdc6',
            })
            .catch(() => null)
        : Promise.resolve(null),
    ]);
    value.gasPriceWei = gasPrice;
    value.onChainUsdc6 = onChain == null ? null : (onChain as bigint);
  }

  const nativeUsd = await getNativePriceUsd(chainId).catch(() => 0);
  value.nativeUsd = nativeUsd > 0 ? nativeUsd : null;

  readCache.set(chainId, { at: Date.now(), value });
  return value;
}

function usd(chainId: number, usdc6: bigint | null): number | null {
  return usdc6 == null ? null : Number(formatUnits(usdc6, getStableDecimals(chainId)));
}

/**
 * Everything about one chain's run price: what is charged, where that number comes from, and what
 * the run actually costs the relayer right now — the two side by side, because setting a flat rate
 * without seeing the live cost is how a rate ends up a tenth of what a run burns.
 */
async function describeChain(chainId: number) {
  const reading = await readChain(chainId);
  const manualUsdc6 = getRunPriceUsdc6(chainId);
  const envUsdc6 = getGasCostPerExecutionUsdc6Fallback(chainId);
  const onChainUsdc6 =
    reading.onChainUsdc6 != null && reading.onChainUsdc6 > 0n ? reading.onChainUsdc6 : null;

  const effectiveUsdc6 = manualUsdc6 ?? onChainUsdc6 ?? (envUsdc6 && envUsdc6 > 0n ? envUsdc6 : null);
  const source: PriceSource = manualUsdc6
    ? 'manual'
    : onChainUsdc6
      ? 'onchain'
      : envUsdc6 && envUsdc6 > 0n
        ? 'env'
        : 'live';

  const profile = getGasProfile(chainId);
  const gasUnits = BigInt(profile.gasUnitsPerRun);
  const feeNative =
    reading.gasPriceWei != null ? Number(formatUnits(reading.gasPriceWei * gasUnits, 18)) : null;
  const liveUsd = feeNative != null && reading.nativeUsd != null ? feeNative * reading.nativeUsd : null;

  const stored = getAllRunPrices()[String(chainId)] ?? null;

  return {
    chainId,
    name: CHAIN_NAMES[chainId] ?? `Chain ${chainId}`,
    stableSymbol: getStableSymbol(chainId),
    /** The number the relayer debits and the app quotes. Null only when nothing has set one. */
    effectiveUsdc6: effectiveUsdc6?.toString() ?? null,
    effectiveUsd: usd(chainId, effectiveUsdc6),
    source,
    manual: stored
      ? {
          usdc6: stored.usdc6,
          usd: usd(chainId, BigInt(stored.usdc6)),
          updatedAt: stored.updatedAt,
          updatedBy: stored.updatedBy,
          note: stored.note,
        }
      : null,
    onChain: { usdc6: onChainUsdc6?.toString() ?? null, usd: usd(chainId, onChainUsdc6) },
    env: { usdc6: envUsdc6?.toString() ?? null, usd: usd(chainId, envUsdc6 ?? null) },
    /** What the run costs the relayer at this moment — the three live inputs and their product. */
    live: {
      gasPriceWei: reading.gasPriceWei?.toString() ?? null,
      gasPriceGwei: reading.gasPriceWei != null ? Number(formatUnits(reading.gasPriceWei, 9)) : null,
      gasUnitsPerRun: profile.gasUnitsPerRun,
      gasUnitsSource: profile.source,
      gasUnitsSamples: profile.samples,
      nativeUsd: reading.nativeUsd,
      feeNative,
      usd: liveUsd,
    },
  };
}

/**
 * The per-run charge, per network.
 *
 * GET is open, like the rest of the read-only scheduler API — it is the same figure the app already
 * shows every user. POST changes what people are charged, so it is behind ADMIN_API_TOKEN.
 */
@Controller('api/run-price')
export class RunPriceController {
  @Get()
  async get(@Query('chainId') chainId?: string) {
    await refreshRunPrices();

    if (chainId != null && chainId !== '') {
      const parsed = Number(chainId);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new BadRequestException({ error: 'Invalid chainId' });
      }
      return describeChain(parsed);
    }

    const chainIds = getChainIdsWithGasTank().sort((a, b) => a - b);
    const chains = await Promise.all(chainIds.map(describeChain));
    return { chains };
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
