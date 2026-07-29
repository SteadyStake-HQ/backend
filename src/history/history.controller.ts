import {
  Controller,
  Get,
  Param,
  Query,
  NotFoundException,
} from '@nestjs/common';
import { HistoryService } from './history.service';

@Controller('api/history')
export class HistoryController {
  constructor(private readonly history: HistoryService) {}

  /**
   * GET /api/history/runs?limit=50&executedOnly=1
   *
   * `executedOnly` is the one worth asking for when the question is "what has this relayer done":
   * the scheduler records a row per sweep and ~99% of them execute nothing, so an unfiltered page
   * of the newest rows is a few minutes of idle ticks and typically contains no execution at all.
   */
  @Get('runs')
  async getRuns(
    @Query('limit') limit?: string,
    @Query('executedOnly') executedOnly?: string,
  ) {
    const onlyExecuted = executedOnly === '1' || executedOnly === 'true';
    // Executing runs are rare and each one matters, so that view is allowed a deeper page than the
    // raw tick log, where 100 rows is already more than anyone reads.
    const cap = onlyExecuted ? 1000 : 100;
    const limitNum = Math.min(parseInt(limit ?? '50', 10) || 50, cap);
    const runs = onlyExecuted
      ? await this.history.getRunsWithExecutions(limitNum)
      : await this.history.getRuns(limitNum);
    return { runs };
  }

  @Get('runs/:runId')
  async getRun(@Param('runId') runId: string) {
    const run = await this.history.getRun(runId);
    if (!run) {
      throw new NotFoundException('Run not found');
    }
    return run;
  }

  @Get('gas')
  async getGas(
    @Query('user') user?: string,
    @Query('chainId') chainIdRaw?: string,
  ) {
    const chainId =
      chainIdRaw != null && chainIdRaw !== ''
        ? parseInt(chainIdRaw, 10)
        : undefined;
    const entries = await this.history.getGasHistory(user, chainId);
    return { entries };
  }

  @Get('portfolio')
  async getPortfolio(
    @Query('user') user: string,
    @Query('chainId') chainIdRaw: string,
    @Query('limit') limit?: string,
  ) {
    if (!user?.trim() || !chainIdRaw?.trim()) {
      return { points: [] };
    }
    const chainId = parseInt(chainIdRaw, 10);
    if (isNaN(chainId)) return { points: [] };
    const limitNum = Math.min(parseInt(limit ?? '200', 10) || 200, 500);
    const points = await this.history.getPortfolioHistory(
      user.trim(),
      chainId,
      limitNum,
    );
    return { points };
  }

  @Get('scheduler-settings')
  async getSchedulerSettingsHistory(@Query('limit') limit?: string) {
    const limitNum = Math.min(parseInt(limit ?? '50', 10) || 50, 100);
    const entries = await this.history.getSchedulerSettingsHistory(limitNum);
    return { entries };
  }

  @Get('execution-timing')
  async getExecutionTimingHistory(@Query('limit') limit?: string) {
    const limitNum = Math.min(parseInt(limit ?? '50', 10) || 50, 100);
    const entries = await this.history.getExecutionTimingHistory(limitNum);
    return { entries };
  }
}
