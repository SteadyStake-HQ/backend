import { Controller, Get, Query } from '@nestjs/common';
import { NetworkMetricsService } from './network-metrics.service';

@Controller('api')
export class NetworkMetricsController {
  constructor(private readonly networkMetricsService: NetworkMetricsService) {}

  @Get('network-metrics')
  getNetworkMetrics(@Query('force') force?: string) {
    return this.networkMetricsService.getNetworkMetrics(force === 'true');
  }
}
