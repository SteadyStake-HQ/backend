import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Post,
  Query,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { AdminTokenGuard } from '../admin/admin-token.guard';
import { isSupabaseConfigured } from '../supabase/dca-plans-store';
import {
  clearPlanAdminControl,
  getPlanAdminControl,
  getPlanAdminControls,
  PLAN_ADMIN_STATUSES,
  setPlanAdminControl,
  type PlanAdminControl,
  type PlanAdminStatus,
} from '../supabase/plan-admin-controls';

/** Longer than this is a paste, not a reason; the frontend renders it inside a plan card. */
const MAX_REASON_LENGTH = 500;
const MAX_UPDATED_BY_LENGTH = 120;

interface PlanControlBody {
  chainId?: number;
  userAddress?: string;
  scheduleId?: string | number;
  status?: string;
  reason?: string;
  updatedBy?: string;
}

/**
 * Admin control over auto-execution of a single DCA plan.
 *
 * Everything here is off-chain: placing a hold stops the relayer from executing the plan and puts a
 * notice on the user's plan card, but the schedule, its enrollment and the user's deposit are
 * untouched. The user keeps the ability to cancel their own plan and be refunded.
 *
 * Guarded by ADMIN_API_TOKEN — see AdminTokenGuard.
 */
@Controller('api/admin/plans')
@UseGuards(AdminTokenGuard)
export class PlanAdminController {
  /** GET /api/admin/plans/controls — every hold in force. ?chainIds=8453,84532 to restrict. */
  @Get('controls')
  async listControls(@Query('chainIds') chainIds?: string) {
    requireStore();
    try {
      const controls = await getPlanAdminControls(parseChainIds(chainIds));
      return { ok: true, count: controls.length, controls: controls.map(serialize) };
    } catch (e) {
      throw new InternalServerErrorException({ ok: false, error: (e as Error).message });
    }
  }

  /**
   * POST /api/admin/plans/control — place or update a hold.
   * Body: { chainId, userAddress, scheduleId, status: 'paused' | 'cancelled', reason?, updatedBy? }
   */
  @Post('control')
  @HttpCode(HttpStatus.OK)
  async setControl(@Body() body: PlanControlBody) {
    requireStore();
    const target = parseTarget(body);
    const status = String(body?.status ?? '').trim().toLowerCase();
    if (!isPlanAdminStatus(status)) {
      throw new BadRequestException({
        ok: false,
        error: `status must be one of: ${PLAN_ADMIN_STATUSES.join(', ')}`,
      });
    }

    const reason = optionalText(body?.reason, MAX_REASON_LENGTH, 'reason');
    const updatedBy = optionalText(body?.updatedBy, MAX_UPDATED_BY_LENGTH, 'updatedBy');

    try {
      const control = await setPlanAdminControl({ ...target, status, reason, updatedBy });
      return { ok: true, control: serialize(control) };
    } catch (e) {
      throw new InternalServerErrorException({ ok: false, error: (e as Error).message });
    }
  }

  /**
   * POST /api/admin/plans/resume — lift a hold and let the relayer auto-execute the plan again.
   * Body: { chainId, userAddress, scheduleId }
   */
  @Post('resume')
  @HttpCode(HttpStatus.OK)
  async resume(@Body() body: PlanControlBody) {
    requireStore();
    const target = parseTarget(body);
    try {
      const cleared = await clearPlanAdminControl(
        target.chainId,
        target.userAddress,
        target.scheduleId,
      );
      return {
        ok: true,
        cleared,
        // Not an error: the caller wanted the plan running and it is. Saying which of the two
        // happened lets the dashboard tell "resumed" from "someone else already resumed it".
        message: cleared ? 'Plan resumed.' : 'Plan was not on hold.',
        control: null,
      };
    } catch (e) {
      throw new InternalServerErrorException({ ok: false, error: (e as Error).message });
    }
  }

  /** GET /api/admin/plans/control?chainId=&userAddress=&scheduleId= — the hold on one plan. */
  @Get('control')
  async getControl(
    @Query('chainId') chainIdInput?: string,
    @Query('userAddress') userAddress?: string,
    @Query('scheduleId') scheduleId?: string,
  ) {
    requireStore();
    const target = parseTarget({
      chainId: Number(chainIdInput),
      userAddress,
      scheduleId,
    });
    try {
      const control = await getPlanAdminControl(
        target.chainId,
        target.userAddress,
        target.scheduleId,
      );
      return { ok: true, control: control ? serialize(control) : null };
    } catch (e) {
      throw new InternalServerErrorException({ ok: false, error: (e as Error).message });
    }
  }
}

function requireStore(): void {
  if (!isSupabaseConfigured()) {
    throw new ServiceUnavailableException({
      ok: false,
      error: 'SUPABASE_DB_URL is not configured; admin plan controls are stored in the database.',
    });
  }
}

function parseTarget(body: PlanControlBody): {
  chainId: number;
  userAddress: string;
  scheduleId: string;
} {
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
  return { chainId, userAddress, scheduleId };
}

function optionalText(value: unknown, maxLength: number, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw new BadRequestException({ ok: false, error: `${field} must be a string` });
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) {
    throw new BadRequestException({
      ok: false,
      error: `${field} must be ${maxLength} characters or fewer`,
    });
  }
  return trimmed;
}

function isPlanAdminStatus(value: string): value is PlanAdminStatus {
  return (PLAN_ADMIN_STATUSES as readonly string[]).includes(value);
}

function serialize(control: PlanAdminControl) {
  return {
    chainId: control.chainId,
    userAddress: control.userAddr,
    scheduleId: String(control.scheduleId),
    status: control.status,
    reason: control.reason,
    updatedBy: control.updatedBy,
    createdAt: control.createdAt.toISOString(),
    updatedAt: control.updatedAt.toISOString(),
  };
}

function parseChainIds(chainIds?: string): number[] | undefined {
  return chainIds
    ?.split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n > 0);
}
