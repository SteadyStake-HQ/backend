import { Controller, Get, Query } from '@nestjs/common';
import { getAllGasProfiles, getGasProfile } from '../gas-profile';

/**
 * What a run burns, per chain — the measured multiplier behind the gas tank modal's per-run
 * quote. `?chainId=` for one chain, no query for every chain that has a profile.
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
      return getGasProfile(parsed);
    }
    return { profiles: getAllGasProfiles() };
  }
}
