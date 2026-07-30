import { Controller, Get, Query } from '@nestjs/common';
import { getAllGasProfiles, getGasProfile, type GasProfileEntry } from '../gas-profile';

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
    recordGasUnits: entry.recordGasUnits,
    samples: entry.samples,
    source: entry.source,
    updatedAt: entry.updatedAt,
    /**
     * What the last runs on this network were really charged. The app quotes the average and the
     * maximum side by side, because a charge that tracks gas has a spread and a user deciding how
     * much to top up needs the worse end of it, not just the typical one.
     */
    cost: {
      samples: entry.cost.samples,
      avgUsd: toUsd(entry.cost.avgUsd6),
      maxUsd: toUsd(entry.cost.maxUsd6),
      minUsd: toUsd(entry.cost.minUsd6),
      lastUsd: toUsd(entry.cost.lastUsd6),
      /** Runs in the window paid out of another network's tank, and what those cost on average. */
      crossChainSamples: entry.cost.crossChainSamples,
      crossChainAvgUsd: toUsd(entry.cost.crossChainAvgUsd6),
      sameChainAvgUsd: toUsd(entry.cost.sameChainAvgUsd6),
    },
  };
}

/**
 * What a run burns and what it was charged, per chain — the measured figures behind the gas tank
 * modal. `?chainId=` for one chain, no query for every chain that has a profile.
 */
@Controller('api')
export class GasProfileController {
  @Get('gas-profile')
  get(@Query('chainId') chainId?: string) {
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
