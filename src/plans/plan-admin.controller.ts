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
import {
  clearPlanExecutionGate,
  getPlanExecutionGate,
  setPlanExecutionGate,
} from '../supabase/plan-execution-gates';
import { readPlanCooldown } from './plan-cooldown';

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
      // Freeze the countdown: whatever wait the plan still owed at this instant is stored with the
      // hold, shown in place of a ticking clock, and handed back when the hold is lifted.
      //
      // A plan that was resumed and is still serving a gate is measured from that gate rather than
      // from the chain: its contract cooldown has already elapsed, so the chain would report zero
      // and a pause would silently cancel the wait the previous pause had preserved.
      const cooldownRemainingSeconds = await this.freezeCooldown(target);

      const control = await setPlanAdminControl({
        ...target,
        status,
        reason,
        updatedBy,
        cooldownRemainingSeconds,
      });
      return { ok: true, control: serialize(control) };
    } catch (e) {
      throw new InternalServerErrorException({ ok: false, error: (e as Error).message });
    }
  }

  /**
   * Capture the wait a plan still owes and take it out of the gate table, so the hold is the only
   * thing holding it. Returns null when the wait could not be measured, which leaves the plan
   * behaving as it did before holds froze anything: resumable, and due as soon as the chain says.
   */
  private async freezeCooldown(target: {
    chainId: number;
    userAddress: string;
    scheduleId: string;
  }): Promise<number | null> {
    let remaining: number | null = null;

    try {
      const gate = await getPlanExecutionGate(
        target.chainId,
        target.userAddress,
        target.scheduleId,
      );
      if (gate) {
        remaining = Math.max(0, Math.round((gate.notBefore.getTime() - Date.now()) / 1000));
      }
    } catch {
      // No gate reading: fall through to the chain, which is the normal source anyway.
    }

    if (remaining == null) {
      const cooldown = await readPlanCooldown(
        target.chainId,
        target.userAddress,
        target.scheduleId,
      );
      remaining = cooldown ? cooldown.remainingSeconds : null;
    }

    // The hold now owns the wait; a leftover gate would double-count it on resume.
    try {
      await clearPlanExecutionGate(target.chainId, target.userAddress, target.scheduleId);
    } catch {
      // Best effort. The resume path rewrites the gate from the hold regardless.
    }

    return remaining;
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
      // Read the hold before lifting it: it carries the countdown as it stood when the plan was
      // paused, and that is what the plan resumes with.
      const held = await getPlanAdminControl(
        target.chainId,
        target.userAddress,
        target.scheduleId,
      );
      const cleared = await clearPlanAdminControl(
        target.chainId,
        target.userAddress,
        target.scheduleId,
      );

      // Restart the clock from where it stopped rather than from zero. Without this the plan
      // executes on the very next tick: its contract cooldown carried on elapsing throughout the
      // pause, so by the time anyone resumes it the chain considers it long overdue.
      //
      // Only a resume that actually lifted a hold writes the gate. A second click — or a second
      // operator on the same plan — finds no hold and must leave the running gate alone, or it
      // would clear the very wait the first resume just granted.
      const remainingSeconds = cleared ? held?.cooldownRemainingSeconds ?? 0 : 0;
      let gate = null as Awaited<ReturnType<typeof setPlanExecutionGate>> | null;
      if (cleared) {
        gate =
          remainingSeconds > 0
            ? await setPlanExecutionGate({ ...target, remainingSeconds })
            : null;
        if (!gate) {
          await clearPlanExecutionGate(target.chainId, target.userAddress, target.scheduleId);
        }
      }

      return {
        ok: true,
        cleared,
        // Not an error: the caller wanted the plan running and it is. Saying which of the two
        // happened lets the dashboard tell "resumed" from "someone else already resumed it".
        message: cleared
          ? gate
            ? `Plan resumed — its next buy is ${formatDuration(remainingSeconds)} away, the wait it had left when it was paused.`
            : 'Plan resumed.'
          : 'Plan was not on hold.',
        resumesInSeconds: gate ? remainingSeconds : 0,
        resumesAt: gate ? gate.notBefore.toISOString() : null,
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

/** "27s" / "4m 10s" / "2h 5m" — for the one-line result the operator sees after resuming. */
function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;
  if (total < 3600) {
    const s = total % 60;
    return s === 0 ? `${Math.floor(total / 60)}m` : `${Math.floor(total / 60)}m ${s}s`;
  }
  if (total < 86400) {
    const m = Math.floor((total % 3600) / 60);
    return m === 0 ? `${Math.floor(total / 3600)}h` : `${Math.floor(total / 3600)}h ${m}m`;
  }
  const h = Math.floor((total % 86400) / 3600);
  return h === 0 ? `${Math.floor(total / 86400)}d` : `${Math.floor(total / 86400)}d ${h}h`;
}

function serialize(control: PlanAdminControl) {
  return {
    chainId: control.chainId,
    userAddress: control.userAddr,
    scheduleId: String(control.scheduleId),
    status: control.status,
    reason: control.reason,
    updatedBy: control.updatedBy,
    cooldownRemainingSeconds: control.cooldownRemainingSeconds,
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
