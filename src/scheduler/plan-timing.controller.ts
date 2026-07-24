import {
  BadRequestException,
  Controller,
  Get,
  ServiceUnavailableException,
  Query,
} from '@nestjs/common';
import { createPublicClient, http, isAddress } from 'viem';
import { getRpc, getVaultUsdcGasTank } from '../config';
import { DCA_VAULT_ABI, getChain } from '../run-executor';
import { SchedulerService } from './scheduler.service';
import { getPlanExecutionMode } from '../plans/plan-execution-state';
import { isSupabaseConfigured } from '../supabase/dca-plans-store';
import {
  getMemberPlanAdminControlMap,
  planAdminControlKey,
  type PlanAdminControl,
} from '../supabase/plan-admin-controls';

const FREQUENCY_INTERVAL_SECONDS: Record<number, number> = {
  0: 60,
  1: 86_400,
  2: 604_800,
  3: 1_209_600,
  4: 2_592_000,
};

type ScheduleSnapshot = {
  targetToken: `0x${string}`;
  frequency: number;
  amountPerInterval: bigint;
  lastExecutionTime: bigint;
  totalAmount: bigint;
  executedCount: bigint;
  active: boolean;
};

@Controller('api/plans')
export class PlanTimingController {
  constructor(private readonly scheduler: SchedulerService) {}

  @Get('timing')
  async getPlanTiming(
    @Query('chainId') chainIdInput?: string,
    @Query('user') userInput?: string,
  ) {
    const chainId = Number(chainIdInput);
    const user = userInput?.trim();
    if (!Number.isInteger(chainId) || chainId <= 0) {
      throw new BadRequestException('A valid chainId is required.');
    }
    if (!user || !isAddress(user)) {
      throw new BadRequestException('A valid user address is required.');
    }

    const contracts = getVaultUsdcGasTank(chainId);
    const rpcUrl = getRpc(chainId);
    const chain = getChain(chainId);
    if (!contracts || !rpcUrl || !chain) {
      throw new BadRequestException(`Backend execution is not configured for chain ${chainId}.`);
    }

    // Admin holds for this one wallet. Read outside the main try so a database hiccup shows the
    // plans without hold notices rather than making the whole dashboard countdown unavailable.
    let adminControls = new Map<string, PlanAdminControl>();
    if (isSupabaseConfigured()) {
      try {
        adminControls = await getMemberPlanAdminControlMap(chainId, user);
      } catch {
        // Leave empty: the executor enforces holds regardless of what this view can show.
      }
    }

    try {
      const timing = await this.scheduler.getTimingContext();
      const client = createPublicClient({ chain, transport: http(rpcUrl) });
      const latestBlock = await client.getBlock({ blockTag: 'latest' });
      const blockNumber = latestBlock.number;
      const [scheduleCountValue, activeScheduleIds, readyScheduleIds, enrolledScheduleIds] =
        await Promise.all([
          client.readContract({
            address: contracts.vault as `0x${string}`,
            abi: DCA_VAULT_ABI,
            functionName: 'scheduleCount',
            args: [user],
            blockNumber,
          }) as Promise<bigint>,
          client.readContract({
            address: contracts.vault as `0x${string}`,
            abi: DCA_VAULT_ABI,
            functionName: 'getActiveSchedules',
            args: [user],
            blockNumber,
          }) as Promise<readonly bigint[]>,
          client.readContract({
            address: contracts.vault as `0x${string}`,
            abi: DCA_VAULT_ABI,
            functionName: 'getReadyScheduleIds',
            args: [user],
            blockNumber,
          }) as Promise<readonly bigint[]>,
          client.readContract({
            address: contracts.vault as `0x${string}`,
            abi: DCA_VAULT_ABI,
            functionName: 'getEnrolledScheduleIds',
            args: [user],
            blockNumber,
          }) as Promise<readonly bigint[]>,
        ]);

      const chainTime = Number(latestBlock.timestamp);
      const scheduleCount = Number(scheduleCountValue);
      if (!Number.isSafeInteger(scheduleCount) || scheduleCount < 0) {
        throw new Error(`Invalid schedule count: ${scheduleCountValue.toString()}`);
      }
      const readySet = new Set(readyScheduleIds.map((id) => id.toString()));
      const enrolledSet = new Set(enrolledScheduleIds.map((id) => id.toString()));
      const scheduleIds = Array.from({ length: scheduleCount }, (_, index) => BigInt(index));
      const plans = await Promise.all(
        scheduleIds.map(async (scheduleId) => {
          const schedule = (await client.readContract({
            address: contracts.vault as `0x${string}`,
            abi: DCA_VAULT_ABI,
            functionName: 'getSchedule',
            args: [user, scheduleId],
            blockNumber,
          })) as ScheduleSnapshot;
          const intervalSeconds =
            FREQUENCY_INTERVAL_SECONDS[Number(schedule.frequency)] ?? 86_400;
          const dueTimestamp = Number(schedule.lastExecutionTime) + intervalSeconds;
          const ready = readySet.has(scheduleId.toString());
          const isEnrolledForAutoExecution = enrolledSet.has(scheduleId.toString());
          const hold = adminControls.get(planAdminControlKey(chainId, user, scheduleId));

          return {
            scheduleId: scheduleId.toString(),
            targetToken: schedule.targetToken,
            frequency: Number(schedule.frequency),
            amountPerInterval: schedule.amountPerInterval.toString(),
            lastExecutionTime: Number(schedule.lastExecutionTime),
            totalAmount: schedule.totalAmount.toString(),
            executedCount: Number(schedule.executedCount),
            active: Boolean(schedule.active),
            intervalSeconds,
            dueTimestamp,
            ready,
            isEnrolledForAutoExecution,
            executionMode: getPlanExecutionMode(chainId, user, scheduleId),
            // This endpoint is proxied to the end user's browser, so the hold is reported without
            // `updatedBy` — the plan owner needs to know automation stopped and why, not which
            // operator account did it.
            adminControl: hold
              ? {
                  status: hold.status,
                  reason: hold.reason,
                  updatedAt: hold.updatedAt.toISOString(),
                }
              : null,
          };
        }),
      );

      return {
        ok: true,
        chainId,
        user,
        serverTime: timing.serverTime,
        chainTime,
        observedBlockNumber: blockNumber.toString(),
        scheduleCount,
        activeScheduleIds: activeScheduleIds.map((id) => id.toString()),
        enrolledCount: enrolledScheduleIds.length,
        scheduler: {
          lastRunAt: timing.lastRunAt,
          nextRunAt: timing.nextRunAt,
          nextRunTimestamp: timing.nextRunTimestamp,
          intervalMs: timing.intervalMs,
          isRunning: timing.isRunning,
        },
        plans,
      };
    } catch (error) {
      throw new ServiceUnavailableException({
        ok: false,
        error: (error as Error).message,
      });
    }
  }
}
