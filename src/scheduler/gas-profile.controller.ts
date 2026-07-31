import { Controller, Get, Query } from '@nestjs/common';
import { getAllGasProfiles, getGasProfile, type GasProfileEntry } from '../gas-profile';
import { RunCostHistoryService } from '../history/run-cost-history.service';

/** Pooled 6-decimal base units -> dollars, for a figure that is shown rather than arithmetic'd. */
function toUsd(usd6: number | null): number | null {
  return usd6 == null ? null : usd6 / 1e6;
}

/**
 * One chain's profile as the app reads it. Costs cross the wire in dollars, not base units: they
 * are already pooled to one scale on the way in, and every consumer of this displays them.
 */
function present(entry: GasProfileEntry) {
  return {
    chainId: entry.chainId,
    gasUnitsPerRun: entry.gasUnitsPerRun,
    /**
     * The two legs separately, so a caller can reproduce what the relayer will charge rather than
     * approximate it. A run's swap is billed at exactly what its receipt says, and the deduction
     * that follows is billed at its measured gas widened by `recordBufferBps` — an estimate built
     * from the total alone omits that headroom and comes in under every time.
     */
    swapGasUnits: entry.swapGasUnits,
    recordGasUnits: entry.recordGasUnits,
    recordBufferBps: entry.recordBufferBps,
    /** The busy-day gas figure, for anything sizing a commitment rather than describing one. */
    gasUnitsP90: entry.gasUnitsP90,
    samples: entry.samples,
    source: entry.source,
    /**
     * Which record the measured figures came from. "history" is every execution ever saved on this
     * network, for every user; "relayer" is only what the running process has watched, which is
     * what there is when no database is configured.
     */
    basis: entry.basis,
    firstRunAt: entry.firstRunAt,
    lastRunAt: entry.lastRunAt,
    updatedAt: entry.updatedAt,
    /**
     * What the runs on this network were really charged. The app quotes the average and the
     * maximum side by side, because a charge that tracks gas has a spread and a user deciding how
     * much to top up needs the worse end of it, not just the typical one.
     */
    cost: {
      samples: entry.cost.samples,
      avgUsd: toUsd(entry.cost.avgUsd6),
      maxUsd: toUsd(entry.cost.maxUsd6),
      minUsd: toUsd(entry.cost.minUsd6),
      lastUsd: toUsd(entry.cost.lastUsd6),
      /** Runs paid out of another network's tank, and what those cost on average. */
      crossChainSamples: entry.cost.crossChainSamples,
      crossChainAvgUsd: toUsd(entry.cost.crossChainAvgUsd6),
      sameChainAvgUsd: toUsd(entry.cost.sameChainAvgUsd6),
    },
  };
}

/**
 * What a run burns and what it was charged, per chain — the measured figures behind the gas tank
 * modal. `?chainId=` for one chain, no query for every chain that has a profile.
 *
 * The figures are drawn from the whole execution record rather than a window or a wallet: every
 * run ever saved on that network, whoever owned the plan. `ensureLoaded` is awaited so a request
 * arriving just after a deploy gets the record rather than the seeds — it is a no-op once the
 * snapshot is warm, and the snapshot is refreshed on a timer regardless.
 */
@Controller('api')
export class GasProfileController {
  constructor(private readonly runCostHistory: RunCostHistoryService) {}

  @Get('gas-profile')
  async get(@Query('chainId') chainId?: string) {
    await this.runCostHistory.ensureLoaded().catch(() => undefined);

    if (chainId != null && chainId !== '') {
      const parsed = Number(chainId);
      if (!Number.isFinite(parsed)) {
        return { error: 'Invalid chainId' };
      }
      return present(getGasProfile(parsed));
    }
    return { profiles: getAllGasProfiles().map(present) };
  }
}
