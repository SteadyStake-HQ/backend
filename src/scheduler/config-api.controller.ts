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

  /** Chain IDs that have a GasTank, i.e. the chains a run can execute on before allocation is applied. */
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
      staticTimeEnabled?: boolean;
      staticStartAt?: string;
    },
  ) {
    try {
      return await this.scheduler.setConfig({
        intervalMs: body.intervalMs,
        staticTimeEnabled: body.staticTimeEnabled,
        staticStartAt: body.staticStartAt,
      });
    } catch (e) {
      throw new BadRequestException({ error: (e as Error).message });
    }
  }
}
