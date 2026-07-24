import { Body, Controller, Get, Post, BadRequestException } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { getChainIdsWithGasTank, getAllNetworks } from '../config';

@Controller('api/config')
export class ConfigApiController {
  constructor(private readonly scheduler: SchedulerService) {}

  @Get()
  getConfig() {
    return this.scheduler.getConfig();
  }

  /** Available chain IDs that have a GasTank (for network selector in dashboard). */
  @Get('chains')
  getChains() {
    return { chainIds: getChainIdsWithGasTank().sort((a, b) => a - b) };
  }

  /** All deployed networks with their contract addresses (for the dashboard). */
  @Get('networks')
  getNetworks() {
    return { networks: getAllNetworks() };
  }

  @Post()
  async setConfig(
    @Body()
    body: {
      intervalMs?: number;
      chainIds?: number[];
      staticTimeEnabled?: boolean;
      staticStartAt?: string;
    },
  ) {
    try {
      return await this.scheduler.setConfig({
        intervalMs: body.intervalMs,
        chainIds: body.chainIds,
        staticTimeEnabled: body.staticTimeEnabled,
        staticStartAt: body.staticStartAt,
      });
    } catch (e) {
      throw new BadRequestException({ error: (e as Error).message });
    }
  }
}
