/**
 * Reading how much cooldown one plan still owes, straight from the chain.
 *
 * This is the measurement taken at the instant an admin pauses a plan: it is the number the
 * dashboards then show frozen, and the number the resume path hands back as a gate. Everything
 * about a hold hangs off it, so it is read from the vault at the moment of the pause rather than
 * taken from whatever a dashboard happened to be displaying.
 */
import { createPublicClient, http } from 'viem';
import { getRpc, getVaultUsdcGasTank } from '../config';
import { DCA_VAULT_ABI, getChain } from '../run-executor';

/** Contract cadence per `frequency` enum value. Mirrors DCAVault's own intervals. */
const FREQUENCY_INTERVAL_SECONDS: Record<number, number> = {
  0: 60,
  1: 86_400,
  2: 604_800,
  3: 1_209_600,
  4: 2_592_000,
};

export interface PlanCooldown {
  /** Chain timestamp of the block the reading was taken at. */
  chainTime: number;
  /** Chain timestamp when the contract next permits execution. */
  dueTimestamp: number;
  /** Seconds still to wait, 0 once the plan is due. */
  remainingSeconds: number;
  active: boolean;
}

/**
 * The cooldown state of one plan, or null when it cannot be read — an unconfigured chain, an
 * unreachable RPC, or a plan that no longer exists. Callers treat null as "unknown" and carry on:
 * not being able to measure the wait is not a reason to refuse to pause a plan.
 */
export async function readPlanCooldown(
  chainId: number,
  userAddress: string,
  scheduleId: string | number,
): Promise<PlanCooldown | null> {
  const contracts = getVaultUsdcGasTank(chainId);
  const rpcUrl = getRpc(chainId);
  const chain = getChain(chainId);
  if (!contracts || !rpcUrl || !chain) return null;

  try {
    const client = createPublicClient({ chain, transport: http(rpcUrl) });
    const block = await client.getBlock({ blockTag: 'latest' });
    const schedule = (await client.readContract({
      address: contracts.vault as `0x${string}`,
      abi: DCA_VAULT_ABI,
      functionName: 'getSchedule',
      args: [userAddress as `0x${string}`, BigInt(scheduleId)],
      blockNumber: block.number,
    })) as { frequency: number; lastExecutionTime: bigint; active: boolean };

    const intervalSeconds = FREQUENCY_INTERVAL_SECONDS[Number(schedule.frequency)] ?? 86_400;
    const chainTime = Number(block.timestamp);
    const dueTimestamp = Number(schedule.lastExecutionTime) + intervalSeconds;
    return {
      chainTime,
      dueTimestamp,
      remainingSeconds: Math.max(0, dueTimestamp - chainTime),
      active: Boolean(schedule.active),
    };
  } catch {
    return null;
  }
}
