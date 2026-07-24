export type PlanExecutionMode = "auto" | "manual";

/**
 * Who reported the execution. The relayer clears its own marks in a `finally`, so those are
 * self-healing; a browser may close its tab mid-transaction and never report completion, so
 * browser marks must expire on their own.
 */
export type PlanExecutionSource = "relayer" | "browser";

interface PlanExecutionEntry {
  mode: PlanExecutionMode;
  source: PlanExecutionSource;
  /** null = held until explicitly cleared. */
  expiresAt: number | null;
}

/** Long enough to cover a wallet confirmation plus mining, short enough to unstick a dead tab. */
export const BROWSER_EXECUTION_TTL_MS = 3 * 60 * 1000;

const executingPlans = new Map<string, PlanExecutionEntry>();

function planKey(chainId: number, userAddress: string, scheduleId: string | bigint): string {
  return `${chainId}:${userAddress.toLowerCase()}:${scheduleId.toString()}`;
}

function readLive(key: string): PlanExecutionEntry | null {
  const entry = executingPlans.get(key);
  if (!entry) return null;
  if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
    executingPlans.delete(key);
    return null;
  }
  return entry;
}

export function markPlanExecuting(
  chainId: number,
  userAddress: string,
  scheduleId: string | bigint,
  mode: PlanExecutionMode,
  options: { source?: PlanExecutionSource; ttlMs?: number } = {},
): void {
  const { source = "relayer", ttlMs } = options;
  executingPlans.set(planKey(chainId, userAddress, scheduleId), {
    mode,
    source,
    expiresAt: typeof ttlMs === "number" ? Date.now() + ttlMs : null,
  });
}

/**
 * Clearing is scoped to the source that set the mark so the two reporters cannot wipe each other:
 * a browser finishing its own swap must not re-enable the button while the relayer is mid-run.
 */
export function clearPlanExecuting(
  chainId: number,
  userAddress: string,
  scheduleId: string | bigint,
  options: { source?: PlanExecutionSource } = {},
): void {
  const key = planKey(chainId, userAddress, scheduleId);
  const entry = readLive(key);
  if (!entry) return;
  if (options.source && entry.source !== options.source) return;
  executingPlans.delete(key);
}

export function getPlanExecutionMode(
  chainId: number,
  userAddress: string,
  scheduleId: string | bigint,
): PlanExecutionMode | null {
  return readLive(planKey(chainId, userAddress, scheduleId))?.mode ?? null;
}
