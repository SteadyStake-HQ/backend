import {
  Controller,
  Body,
  BadRequestException,
  Post,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
} from '@nestjs/common';
import { SchedulerService } from './scheduler.service';

@Controller('api')
export class RunNowController {
  constructor(private readonly scheduler: SchedulerService) {}

  @Post('run-now')
  @HttpCode(HttpStatus.OK)
  async runNow() {
    try {
      return await this.scheduler.runOnce();
    } catch (e) {
      throw new InternalServerErrorException({
        ok: false,
        error: (e as Error).message,
      });
    }
  }

  @Post('execute-plan')
  @HttpCode(HttpStatus.OK)
  async executePlan(
    @Body()
    body: {
      chainId?: number;
      userAddress?: string;
      scheduleId?: string | number;
    },
  ) {
    const chainId = Number(body?.chainId);
    const userAddress = String(body?.userAddress ?? '').trim();
    const scheduleId = String(body?.scheduleId ?? '').trim();

    if (!Number.isInteger(chainId) || chainId <= 0) {
      throw new BadRequestException({ ok: false, error: 'Invalid chainId' });
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(userAddress)) {
      throw new BadRequestException({ ok: false, error: 'Invalid userAddress' });
    }
    if (!/^\d+$/.test(scheduleId)) {
      throw new BadRequestException({ ok: false, error: 'Invalid scheduleId' });
    }

    try {
      const result = await this.scheduler.runSelectedPlan({
        chainId,
        userAddress,
        scheduleId,
      });
      return {
        ...result,
        target: { chainId, userAddress, scheduleId },
      };
    } catch (e) {
      throw new InternalServerErrorException({
        ok: false,
        error: (e as Error).message,
      });
    }
  }
}
