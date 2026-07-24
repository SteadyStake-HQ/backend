import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  BROWSER_EXECUTION_TTL_MS,
  clearPlanExecuting,
  getPlanExecutionMode,
  markPlanExecuting,
} from './plan-execution-state';

/**
 * Lets the web app report a wallet-signed execution so the operator dashboard shows the same
 * in-progress state it shows for relayer runs. The mark is advisory UI state — the vault's own
 * cooldown is what actually prevents a double swap — and it expires on its own, because a browser
 * that closes mid-transaction will never report completion.
 */
@Controller('api/plans')
export class PlanExecutionController {
  @Post('executing')
  @HttpCode(HttpStatus.OK)
  setExecuting(
    @Body()
    body: {
      chainId?: number;
      userAddress?: string;
      scheduleId?: string | number;
      executing?: boolean;
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
    if (typeof body?.executing !== 'boolean') {
      throw new BadRequestException({ ok: false, error: 'executing must be a boolean' });
    }

    if (body.executing) {
      markPlanExecuting(chainId, userAddress, scheduleId, 'manual', {
        source: 'browser',
        ttlMs: BROWSER_EXECUTION_TTL_MS,
      });
    } else {
      clearPlanExecuting(chainId, userAddress, scheduleId, { source: 'browser' });
    }

    return {
      ok: true,
      executionMode: getPlanExecutionMode(chainId, userAddress, scheduleId),
    };
  }
}
