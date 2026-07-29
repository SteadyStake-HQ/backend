/**
 * Reads every DCA plan from the database, enriched with live contract state.
 *
 * The database is the source of truth: members and every off-chain fact (created/ended timestamps,
 * the committed total, swapped amount, completed-vs-cancelled) come from the `dca_plans` table,
 * which is written through as plans are created / executed / cancelled. Nothing here scans block
 * logs — the previous member-discovery fallback scanned ~1500 block ranges per chain on every read.
 *
 * On top of that, plans get a bounded live read from the DCAVault (a handful of eth_calls per
 * member, no log scanning). `scheduleCount` lets us enumerate every schedule ID, including
 * completed/cancelled schedules that have fallen out of `getActiveSchedules`, while the ready and
 * enrolled helpers provide the flags that still matter for active plans.
 *
 * Facts that were never recorded stay null rather than being guessed at, and the dashboard renders
 * them as "Not recorded".
 *
 * Run standalone: node dist/plans/fetch-plans.js  (reads every deployed chain; pass chainIds to narrow)
 */
import "dotenv/config";
import { createPublicClient, http, formatUnits } from "viem";
import { getVaultUsdcGasTank, getRpc, getStableDecimals, CHAIN_NAMES } from "../config";
import {
  DCA_VAULT_ABI,
  getChain,
  getAllowedChainIds,
  resolveMembers,
  type ProgressCallback,
} from "../run-executor";
import {
  getDcaPlans,
  isSupabaseConfigured,
  type DcaPlanRow,
  type DcaPlanStatus,
} from "../supabase/dca-plans-store";
import {
  getPlanExecutionMode,
  type PlanExecutionMode,
} from "./plan-execution-state";
import {
  getPlanAdminControlMap,
  planAdminControlKey,
  type PlanAdminControl,
  type PlanAdminStatus,
} from "../supabase/plan-admin-controls";
import {
  getPlanExecutionGateMap,
  planExecutionGateKey,
  type PlanExecutionGate,
} from "../supabase/plan-execution-gates";

/** DCAFrequency enum in DCAVault.sol: 0=ONEMIN, 1=DAILY, 2=WEEKLY, 3=BIWEEKLY, 4=MONTHLY. */
const FREQUENCY_LABELS: Record<number, string> = {
  0: "Every minute",
  1: "Daily",
  2: "Weekly",
  3: "Biweekly",
  4: "Monthly",
};

const FREQUENCY_INTERVAL_SECONDS: Record<number, number> = {
  0: 60,
  1: 86_400,
  2: 604_800,
  3: 1_209_600,
  4: 2_592_000,
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const ERC20_SYMBOL_ABI = [
  { type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
] as const;

interface TokenSymbolEntry {
  /** The token's symbol, or null when it could not be read. */
  symbol: string | null;
  /** When a null may be read again. Infinity once a symbol is known — symbols do not change. */
  retryAt: number;
}

/**
 * `chainId:token` → symbol, cached for the life of the process.
 *
 * The dashboard polls this read every few seconds and many plans buy the same token, so without a
 * cache every poll would add an eth_call per plan. A failed read is cached too, but only briefly:
 * a token that has no `symbol()` is permanent, an unreachable RPC is not, and the two are not worth
 * telling apart when a retry costs one call every ten minutes.
 */
const tokenSymbolCache = new Map<string, TokenSymbolEntry>();
/** Reads in flight, so members holding the same token share one call rather than racing. */
const tokenSymbolReads = new Map<string, Promise<string | null>>();
const TOKEN_SYMBOL_RETRY_MS = 10 * 60 * 1000;

const tokenKey = (chainId: number, token: string) => `${chainId}:${token.toLowerCase()}`;

async function readTokenSymbol(chainId: number, token: string): Promise<string | null> {
  const rpcUrl = getRpc(chainId);
  const chain = getChain(chainId);
  if (!rpcUrl || !chain) return null;
  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  try {
    const symbol = (await client.readContract({
      address: token as `0x${string}`,
      abi: ERC20_SYMBOL_ABI,
      functionName: "symbol",
    })) as string;
    const trimmed = String(symbol).trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // A token that doesn't answer `symbol()` (a bytes32-symbol token, or a chain that is down) is
    // not an error worth surfacing — the dashboard falls back to showing the address.
    return null;
  }
}

/** Symbol of an ERC-20, from cache when known. Never throws; null means "show the address". */
async function getTokenSymbol(chainId: number, token: string): Promise<string | null> {
  const key = tokenKey(chainId, token);
  const cached = tokenSymbolCache.get(key);
  if (cached && Date.now() < cached.retryAt) return cached.symbol;

  const inFlight = tokenSymbolReads.get(key);
  if (inFlight) return inFlight;

  const read = readTokenSymbol(chainId, token)
    .then((symbol) => {
      tokenSymbolCache.set(key, {
        symbol,
        retryAt: symbol == null ? Date.now() + TOKEN_SYMBOL_RETRY_MS : Infinity,
      });
      return symbol;
    })
    .finally(() => {
      tokenSymbolReads.delete(key);
    });
  tokenSymbolReads.set(key, read);
  return read;
}

/** An admin hold as it appears on a plan; null when nothing is holding the plan. */
export interface PlanAdminControlView {
  status: PlanAdminStatus;
  reason: string | null;
  updatedBy: string | null;
  updatedAt: string;
  /** The plan's countdown as it stood when the hold was placed, frozen. null when unknown. */
  cooldownRemainingSeconds: number | null;
}

/** The wait a resumed plan is still serving; null once it is free to run. */
export interface PlanExecutionGateView {
  /** ISO instant the relayer may execute from. */
  notBefore: string;
  remainingSeconds: number;
}

export interface PlanDetail {
  scheduleId: string;
  targetToken: string | null;
  /** ERC-20 symbol of the target token, read from the chain. null when it is not readable. */
  targetTokenSymbol: string | null;
  frequency: number | null;
  frequencyLabel: string;
  /** amountPerInterval in USDC (6 decimals), raw. null when never recorded and not live on-chain. */
  amountPerIntervalUsdc6: string | null;
  /** amountPerInterval as a human decimal string */
  amountPerInterval: string | null;
  /** unix seconds of last execution (0 if never executed) */
  lastExecutionTime: number;
  /** contract cadence in seconds */
  intervalSeconds: number | null;
  /** unix timestamp when the contract next permits execution */
  dueTimestamp: number | null;
  /** unix timestamp the plan can next actually run at — `dueTimestamp` plus any resume gate */
  effectiveDueTimestamp: number | null;
  totalAmountUsdc6: string;
  executedCount: number;
  active: boolean;
  /** the contract's own view: its cooldown has elapsed, whatever the relayer intends to do */
  contractReady: boolean;
  /** the relayer's view: due, not held, and not still finishing a paused countdown */
  ready: boolean;
  enrolled: boolean;
  executionMode: PlanExecutionMode | null;
  /** Admin hold stopping auto-execution of this plan; null when the plan is not held. */
  adminControl: PlanAdminControlView | null;
  /** Wait left over from a pause, being served since the plan was resumed; null when free. */
  executionGate: PlanExecutionGateView | null;

  // ---- Merged / derived detail ----
  /** 'active' | 'completed' | 'cancelled' */
  status: DcaPlanStatus;
  /** original total committed at creation, raw 6-decimal */
  committedUsdc6: string | null;
  committed: string | null;
  /** USDC actually swapped so far, raw 6-decimal */
  swappedUsdc6: string | null;
  swapped: string | null;
  /** USDC still available to swap in the plan (0 for ended plans), raw 6-decimal */
  remainingUsdc6: string | null;
  remaining: string | null;
  /** total planned executions (committed / amountPerInterval) */
  totalExecutions: number | null;
  /** executions still to run (0 for ended plans) */
  executionsRemaining: number | null;
  /** 0..100, null when committed is unknown */
  progressPct: number | null;
  /** ISO timestamps, null when never recorded */
  createdAt: string | null;
  lastExecutionAt: string | null;
  endedAt: string | null;

  /** false when the plan has no database row — it exists on-chain but its history was never
   * recorded, so dates/committed are shown as "Not recorded" instead of being inferred. */
  recorded: boolean;
  /** true when live contract state was merged in on this read */
  live: boolean;
}

export interface MemberPlans {
  chainId: number;
  chainName: string;
  user: string;
  /** timestamp of the block used for the live plan snapshot */
  chainTime: number | null;
  plans: PlanDetail[];
}

export interface FetchAllPlansResult {
  ok: boolean;
  generatedAt: string;
  /** "database" when the chain could not be reached and only stored state is shown */
  source: "database" | "database+chain";
  memberCount: number;
  planCount: number;
  members: MemberPlans[];
  errors?: string[];
}

export interface FetchAllPlansOptions {
  /** When set, only read these chain IDs. Otherwise every chain with a GasTank. */
  chainIds?: number[];
  /** Skip the live contract enrich and serve purely from stored state. */
  dbOnly?: boolean;
}

type RawSchedule = {
  targetToken: `0x${string}`;
  frequency: number;
  amountPerInterval: bigint;
  lastExecutionTime: bigint;
  totalAmount: bigint;
  executedCount: bigint;
  active: boolean;
};

/** Live state for one member, read with a bounded number of eth_calls (never a log scan). */
interface LiveMemberState {
  schedules: Map<string, RawSchedule>;
  readySet: Set<string>;
  enrolledSet: Set<string>;
  chainTime: number;
}

const memberKey = (chainId: number, user: string) => `${chainId}:${user.toLowerCase()}`;

/** Compute committed/swapped/remaining + progress + execution counts. */
function deriveAmounts(input: {
  /** Decides the display scale: the settlement stablecoin is 18-decimal on BSC, 6 elsewhere. */
  chainId: number;
  amountPerIntervalUsdc6: bigint | null;
  executedCount: number;
  /** live in-plan balance for active plans; 0 for ended plans */
  remainingUsdc6: bigint;
  swappedUsdc6: bigint | null;
  committedUsdc6: bigint | null;
}) {
  const decimals = getStableDecimals(input.chainId);
  const perInterval = input.amountPerIntervalUsdc6;
  const remaining = input.remainingUsdc6;

  const swapped =
    input.swappedUsdc6 != null
      ? input.swappedUsdc6
      : perInterval != null
        ? perInterval * BigInt(input.executedCount)
        : null;
  const committed = input.committedUsdc6 != null ? input.committedUsdc6 : swapped != null ? swapped + remaining : null;

  const totalExecutions =
    perInterval != null && perInterval > 0n && committed != null
      ? Math.max(input.executedCount, Math.round(Number(committed) / Number(perInterval)))
      : null;
  const executionsRemaining = totalExecutions != null ? Math.max(0, totalExecutions - input.executedCount) : null;
  const progressPct =
    committed != null && committed > 0n && swapped != null
      ? Math.min(100, Math.round((Number(swapped) / Number(committed)) * 1000) / 10)
      : null;

  return {
    committedUsdc6: committed?.toString() ?? null,
    committed: committed != null ? formatUnits(committed, decimals) : null,
    swappedUsdc6: swapped?.toString() ?? null,
    swapped: swapped != null ? formatUnits(swapped, decimals) : null,
    remainingUsdc6: remaining.toString(),
    remaining: formatUnits(remaining, decimals),
    totalExecutions,
    executionsRemaining,
    progressPct,
  };
}

/**
 * Read live state for one member: every schedule struct plus the ready/enrolled flags.
 *
 * The contract retains `schedules[user][id]` after a schedule ends. Enumerating `0..scheduleCount`
 * is therefore the only non-log-scanning way to recover an older completed plan that was never
 * written to the database. Reading only `getActiveSchedules` silently omitted those plans.
 *
 * Bounded (1 + 2 + N eth_calls); returns null if the chain is unreachable, in which case the
 * caller falls back to stored state alone.
 */
async function readLiveMemberState(
  chainId: number,
  userAddress: string,
  errors: string[],
): Promise<LiveMemberState | null> {
  const cfg = getVaultUsdcGasTank(chainId);
  const rpcUrl = getRpc(chainId);
  const chain = getChain(chainId);
  if (!cfg || !rpcUrl || !chain) {
    errors.push(`No vault/RPC/chain config for chain ${chainId}`);
    return null;
  }
  const vault = cfg.vault as `0x${string}`;
  const user = userAddress as `0x${string}`;
  const client = createPublicClient({ chain, transport: http(rpcUrl) });

  let scheduleCount: number;
  let blockNumber: bigint;
  let chainTime: number;
  try {
    const latestBlock = await client.getBlock({ blockTag: "latest" });
    blockNumber = latestBlock.number;
    chainTime = Number(latestBlock.timestamp);
    const count = (await client.readContract({
      address: vault,
      abi: DCA_VAULT_ABI,
      functionName: "scheduleCount",
      args: [user],
      blockNumber,
    })) as bigint;
    scheduleCount = Number(count);
    if (!Number.isSafeInteger(scheduleCount) || scheduleCount < 0) {
      throw new Error(`Invalid schedule count: ${count.toString()}`);
    }
  } catch (e) {
    errors.push(`scheduleCount ${chainId}:${userAddress}: ${(e as Error).message}`);
    return null;
  }

  const scheduleIds = Array.from({ length: scheduleCount }, (_, index) => BigInt(index));
  const [readyIds, enrolledIds] = await Promise.all([
    client
      .readContract({ address: vault, abi: DCA_VAULT_ABI, functionName: "getReadyScheduleIds", args: [user], blockNumber })
      .then((v) => v as bigint[])
      .catch(() => [] as bigint[]),
    client
      .readContract({ address: vault, abi: DCA_VAULT_ABI, functionName: "getEnrolledScheduleIds", args: [user], blockNumber })
      .then((v) => v as bigint[])
      .catch(() => [] as bigint[]),
  ]);

  const entries = await Promise.all(
    scheduleIds.map((scheduleId) =>
      client
        .readContract({ address: vault, abi: DCA_VAULT_ABI, functionName: "getSchedule", args: [user, scheduleId], blockNumber })
        .then((s) => [scheduleId.toString(), s as RawSchedule] as const)
        .catch((e) => {
          errors.push(`getSchedule ${chainId}:${userAddress} ${scheduleId}: ${(e as Error).message}`);
          return null;
        }),
    ),
  );

  return {
    schedules: new Map(entries.filter((e): e is readonly [string, RawSchedule] => e !== null)),
    readySet: new Set(readyIds.map((id) => id.toString())),
    enrolledSet: new Set(enrolledIds.map((id) => id.toString())),
    chainTime,
  };
}

/**
 * Build one plan view from its stored row and/or its live struct. Either side may be absent:
 * a row with no struct is an ended plan (or one we couldn't read); a struct with no row is a plan
 * created outside the recording path, whose history reads as "Not recorded".
 *
 * `liveKnown` says whether the chain read for this member actually succeeded. It is what separates
 * "the plan is gone from the vault" from "we couldn't reach the RPC" — without it an unreachable
 * RPC would silently retire every active plan.
 */
function buildPlan(
  chainId: number,
  userAddress: string,
  scheduleId: string,
  row: DcaPlanRow | undefined,
  live: RawSchedule | undefined,
  flags: {
    ready: boolean;
    enrolled: boolean;
    liveKnown: boolean;
    chainTime: number | null;
    adminControl: PlanAdminControl | undefined;
    executionGate: PlanExecutionGate | undefined;
  },
): PlanDetail {
  const isLiveActive = live != null && Boolean(live.active);

  // A live active struct is authoritative. Otherwise a recorded end state (cancelled/completed)
  // stands. Failing both: if we did read the chain and the vault no longer lists the plan, it has
  // run to completion — the executor normally records that, but this covers a plan that finished
  // while the executor was down. If the chain read failed, keep whatever was recorded.
  const status: DcaPlanStatus = isLiveActive
    ? "active"
    : row?.status && row.status !== "active"
      ? row.status
      : flags.liveKnown
        ? "completed"
        : row?.status ?? "active";
  const ended = status !== "active";

  const perInterval =
    live?.amountPerInterval ?? (row?.amountPerIntervalUsdc6 != null ? BigInt(row.amountPerIntervalUsdc6) : null);
  const frequency = live != null ? Number(live.frequency) : row?.frequency ?? null;
  const targetToken = live?.targetToken ?? row?.targetToken ?? null;

  // Executed count: the struct keeps it even after a plan ends, so prefer it when present.
  const executedCount = live != null ? Number(live.executedCount) : row?.executedCount ?? 0;
  // Remaining: 0 once ended (the vault zeroes the deposit on cancel and depletion).
  const remaining = ended ? 0n : live?.totalAmount ?? 0n;

  // Swapped: the drawn-down deposit is perInterval * executedCount and stays exact after the plan
  // ends, so derive it live when we can and fall back to what was recorded.
  const swapped =
    live != null && perInterval != null
      ? perInterval * live.executedCount
      : row?.swappedUsdc6 != null
        ? BigInt(row.swappedUsdc6)
        : null;

  // Committed: prefer the total recorded at creation — it is the only unambiguous source once a
  // plan has ended. Otherwise reconstruct it from live state.
  const committed =
    row?.committedUsdc6 != null
      ? BigInt(row.committedUsdc6)
      : status === "cancelled" && row?.returnedUsdc6 != null && swapped != null
        ? swapped + BigInt(row.returnedUsdc6)
        : null;

  const derived = deriveAmounts({
    chainId,
    amountPerIntervalUsdc6: perInterval,
    executedCount,
    remainingUsdc6: remaining,
    swappedUsdc6: swapped,
    committedUsdc6: committed,
  });

  const lastExecutionTime = live != null ? Number(live.lastExecutionTime) : row?.lastExecutionAt ? Math.floor(row.lastExecutionAt.getTime() / 1000) : 0;
  const intervalSeconds =
    frequency == null ? null : FREQUENCY_INTERVAL_SECONDS[frequency] ?? null;
  const dueTimestamp =
    status === "active" && intervalSeconds != null && lastExecutionTime > 0
      ? lastExecutionTime + intervalSeconds
      : null;
  const contractReady =
    status === "active" &&
    (flags.ready ||
      (dueTimestamp != null &&
        flags.chainTime != null &&
        dueTimestamp <= flags.chainTime));

  // A plan resumed with time still on its clock is finishing that wait. The gate is wall-clock, so
  // it is folded into the chain's clock here — the one the countdowns on both dashboards run
  // against — and it can only ever push the due time later, never bring it forward.
  const gateRemainingSeconds =
    status === "active" && flags.executionGate
      ? Math.max(0, Math.round((flags.executionGate.notBefore.getTime() - Date.now()) / 1000))
      : 0;
  const effectiveDueTimestamp =
    gateRemainingSeconds > 0 && flags.chainTime != null
      ? Math.max(dueTimestamp ?? 0, flags.chainTime + gateRemainingSeconds)
      : dueTimestamp;
  // What the relayer will do, as against what the contract would allow: a held plan or one still
  // serving a paused countdown is not ready, however long its on-chain cooldown has been elapsed.
  const ready = contractReady && flags.adminControl == null && gateRemainingSeconds === 0;

  return {
    scheduleId,
    targetToken: targetToken === ZERO_ADDRESS ? null : targetToken,
    // Filled in by the live enrich in fetchAllPlans; it is a chain read like the rest of it.
    targetTokenSymbol: null,
    frequency,
    frequencyLabel: frequency == null ? "Not recorded" : FREQUENCY_LABELS[frequency] ?? `Unknown (${frequency})`,
    amountPerIntervalUsdc6: perInterval?.toString() ?? null,
    amountPerInterval: perInterval != null ? formatUnits(perInterval, getStableDecimals(chainId)) : null,
    lastExecutionTime,
    intervalSeconds,
    dueTimestamp,
    effectiveDueTimestamp,
    totalAmountUsdc6: remaining.toString(),
    executedCount,
    active: isLiveActive,
    // `contractReady` stays a statement about the contract cooldown alone; holds and resume gates
    // are separate facts, so callers can show "cooldown elapsed, but automation is paused" rather
    // than conflating the two.
    contractReady,
    ready,
    enrolled: flags.enrolled,
    executionMode: getPlanExecutionMode(chainId, userAddress, scheduleId),
    adminControl: flags.adminControl
      ? {
          status: flags.adminControl.status,
          reason: flags.adminControl.reason,
          updatedBy: flags.adminControl.updatedBy,
          updatedAt: flags.adminControl.updatedAt.toISOString(),
          cooldownRemainingSeconds: flags.adminControl.cooldownRemainingSeconds,
        }
      : null,
    executionGate:
      gateRemainingSeconds > 0 && flags.executionGate
        ? {
            notBefore: flags.executionGate.notBefore.toISOString(),
            remainingSeconds: gateRemainingSeconds,
          }
        : null,
    status,
    ...derived,
    createdAt: row?.createdAt ? row.createdAt.toISOString() : null,
    // Fall back to the struct's own timestamp so a plan whose executions predate recording still
    // shows when it last ran.
    lastExecutionAt: row?.lastExecutionAt
      ? row.lastExecutionAt.toISOString()
      : lastExecutionTime > 0
        ? new Date(lastExecutionTime * 1000).toISOString()
        : null,
    endedAt: row?.endedAt ? row.endedAt.toISOString() : null,
    recorded: row != null,
    live: live != null,
  };
}

/**
 * Fetch all DCA plans for every member known to the database, enriched with live contract state.
 * Never throws for per-member/per-chain issues — those are collected into `errors`.
 */
export async function fetchAllPlans(
  onProgress?: ProgressCallback,
  options?: FetchAllPlansOptions,
): Promise<FetchAllPlansResult> {
  const log = (msg: string) => onProgress?.(msg);
  const generatedAt = new Date().toISOString();

  const allowedChains =
    options?.chainIds && options.chainIds.length > 0 ? new Set(options.chainIds) : getAllowedChainIds();
  log(`Reading plans for chains: ${[...allowedChains].sort((a, b) => a - b).join(", ")}`);

  const errors: string[] = [];

  if (!isSupabaseConfigured()) {
    log("Supabase not configured — no plan store to read. Set SUPABASE_DB_URL.");
    return {
      ok: false,
      generatedAt,
      source: "database",
      memberCount: 0,
      planCount: 0,
      members: [],
      errors: ["SUPABASE_DB_URL is not configured; plans are read from the database."],
    };
  }

  // ---- Stored state: the source of truth for members and off-chain history. ----
  const dbByMember = new Map<string, Map<string, DcaPlanRow>>();
  try {
    log("Reading stored plans from the database…");
    const startedAt = Date.now();
    const rows = await getDcaPlans([...allowedChains]);
    for (const row of rows) {
      const mk = memberKey(row.chainId, row.userAddr);
      let byId = dbByMember.get(mk);
      if (!byId) {
        byId = new Map();
        dbByMember.set(mk, byId);
      }
      byId.set(String(row.scheduleId), row);
    }
    log(`Database returned ${rows.length} stored plan(s) in ${Date.now() - startedAt}ms`);
  } catch (e) {
    log(`Database read failed: ${(e as Error).message}`);
    return {
      ok: false,
      generatedAt,
      source: "database",
      memberCount: 0,
      planCount: 0,
      members: [],
      errors: [`Database read failed: ${(e as Error).message}`],
    };
  }

  // Admin holds, read once for the whole snapshot. Unlike the executor this is a read-only view,
  // so a failure here degrades to "no holds shown" rather than failing the whole plan list.
  let adminControls = new Map<string, PlanAdminControl>();
  try {
    adminControls = await getPlanAdminControlMap([...allowedChains]);
    if (adminControls.size > 0) log(`Admin holds in force: ${adminControls.size} plan(s)`);
  } catch (e) {
    errors.push(`Admin plan holds could not be read: ${(e as Error).message}`);
    log(`Admin plan holds could not be read: ${(e as Error).message}`);
  }

  // Resume gates, read the same way and with the same tolerance: a failure here costs the "still
  // finishing its paused countdown" note on a card, not the plan list.
  let executionGates = new Map<string, PlanExecutionGate>();
  try {
    executionGates = await getPlanExecutionGateMap([...allowedChains]);
    if (executionGates.size > 0) {
      log(`Resumed plans still finishing a paused countdown: ${executionGates.size}`);
    }
  } catch (e) {
    errors.push(`Plan resume gates could not be read: ${(e as Error).message}`);
    log(`Plan resume gates could not be read: ${(e as Error).message}`);
  }

  const members = await resolveMembers(allowedChains, log);
  // Anyone with a stored plan is a member even if the registry row is missing.
  const allMembers = [...new Set([...members, ...dbByMember.keys()])]
    .filter((mk) => allowedChains.has(parseInt(mk.split(":")[0], 10)))
    .sort();
  log(`Members: ${allMembers.length}`);

  const results: MemberPlans[] = [];
  let planCount = 0;
  let anyLive = false;

  // Live enrich runs per member with a bounded call count; members are independent, so read them
  // in parallel rather than serially as the old scan-based path did.
  const perMember = await Promise.all(
    allMembers.map(async (mk) => {
      const [chainIdStr, userAddress] = mk.split(":");
      const chainId = parseInt(chainIdStr, 10);
      if (!userAddress || isNaN(chainId)) return null;

      const dbById = dbByMember.get(mk);
      const liveState = options?.dbOnly ? null : await readLiveMemberState(chainId, userAddress, errors);

      const ids = new Set<string>([...(dbById?.keys() ?? []), ...(liveState?.schedules.keys() ?? [])]);
      const plans = [...ids].map((id) =>
        buildPlan(chainId, userAddress, id, dbById?.get(id), liveState?.schedules.get(id), {
          ready: liveState?.readySet.has(id) ?? false,
          enrolled: liveState?.enrolledSet.has(id) ?? false,
          liveKnown: liveState != null,
          chainTime: liveState?.chainTime ?? null,
          adminControl: adminControls.get(planAdminControlKey(chainId, userAddress, id)),
          executionGate: executionGates.get(planExecutionGateKey(chainId, userAddress, id)),
        }),
      );
      plans.sort((a, b) => Number(BigInt(a.scheduleId) - BigInt(b.scheduleId)));

      // Label the buy side with the token's own symbol. Cached per token, so this is at most one
      // extra eth_call per distinct target token per process, and none once the cache is warm.
      if (!options?.dbOnly) {
        await Promise.all(
          plans.map(async (plan) => {
            if (!plan.targetToken) return;
            plan.targetTokenSymbol = await getTokenSymbol(chainId, plan.targetToken);
          }),
        );
      }

      return {
        chainId,
        userAddress,
        chainTime: liveState?.chainTime ?? null,
        plans,
        live: liveState != null,
      };
    }),
  );

  for (const entry of perMember) {
    if (!entry) continue;
    if (entry.live) anyLive = true;
    if (entry.plans.length === 0) continue;
    planCount += entry.plans.length;
    results.push({
      chainId: entry.chainId,
      chainName: CHAIN_NAMES[entry.chainId] ?? `Chain ${entry.chainId}`,
      user: entry.userAddress,
      chainTime: entry.chainTime,
      plans: entry.plans,
    });
    const unrecorded = entry.plans.filter((p) => !p.recorded).length;
    log(
      `  [${entry.chainId}:${entry.userAddress}] ${entry.plans.length} plan(s)` +
        (unrecorded > 0 ? ` · ${unrecorded} not recorded` : "") +
        (entry.live ? "" : " · live state unavailable"),
    );
  }

  results.sort((a, b) => a.chainId - b.chainId || a.user.localeCompare(b.user));

  return {
    ok: true,
    generatedAt,
    source: anyLive ? "database+chain" : "database",
    memberCount: results.length,
    planCount,
    members: results,
    ...(errors.length ? { errors } : {}),
  };
}

/** CLI entry: fetch once and print JSON. */
async function main() {
  const result = await fetchAllPlans((msg) => console.error(msg));
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
