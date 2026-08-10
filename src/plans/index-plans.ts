/**
 * Event indexer for DCA plans. Scans ScheduleCreated / ScheduleExecuted / ScheduleCancelled logs
 * from each DCAVault and materializes per-plan metadata into Supabase `dca_plans`.
 *
 * This is the source of truth for everything the live struct can't give you once a plan is
 * cancelled or depleted: creation time, end/cancel time, the original committed total, the exact
 * swapped amount, and the completed-vs-cancelled distinction. It is incremental (a per-chain block
 * cursor), so each run only scans new blocks; the first run backfills from a block lookback.
 *
 * Run standalone: node dist/plans/index-plans.js
 */
import 'dotenv/config';
import { createPublicClient, http, getAbiItem, type Log, type AbiEvent } from 'viem';
import { getVaultUsdcGasTank, getRpc, CHAIN_NAMES } from '../config';
import { DCA_VAULT_ABI, getChain, getAllowedChainIds, type ProgressCallback } from '../run-executor';
import {
  ensureDcaPlansSchema,
  getDcaPlans,
  upsertDcaPlans,
  getIndexCursor,
  setIndexCursor,
  isSupabaseConfigured,
  type DcaPlanRow,
  type DcaPlanStatus,
} from '../supabase/dca-plans-store';

const CREATED_EVENT = getAbiItem({ abi: DCA_VAULT_ABI, name: 'ScheduleCreated' }) as AbiEvent;
const EXECUTED_EVENT = getAbiItem({ abi: DCA_VAULT_ABI, name: 'ScheduleExecuted' }) as AbiEvent;
const CANCELLED_EVENT = getAbiItem({ abi: DCA_VAULT_ABI, name: 'ScheduleCancelled' }) as AbiEvent;

/** eth_getLogs block-range per request. Public RPCs cap this (sepolia.base.org ~1000). */
function getLogChunkBlocks(): bigint {
  const raw = process.env.DCA_INDEX_LOG_CHUNK_BLOCKS?.trim() ?? process.env.AUTOMATION_LOG_CHUNK_BLOCKS?.trim();
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? BigInt(n) : 999n;
}

/** How far back the first (cursorless) backfill scans. */
function getLookbackBlocks(): bigint {
  const raw = process.env.DCA_INDEX_LOOKBACK_BLOCKS?.trim() ?? process.env.AUTOMATION_LOG_LOOKBACK_BLOCKS?.trim();
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? BigInt(n) : 1_500_000n;
}

/** Concurrent getLogs workers per event. Kept modest so public testnet RPCs don't rate-limit. */
function getScanConcurrency(): number {
  const raw = process.env.DCA_INDEX_CONCURRENCY?.trim();
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 4;
}

/** Retry attempts per getLogs range before giving up and recording an error. */
function getMaxRetries(): number {
  const raw = process.env.DCA_INDEX_MAX_RETRIES?.trim();
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 6;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when an error looks like an HTTP 429 / RPC rate-limit response. */
function isRateLimit(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 429) return true;
  const msg = ((err as Error)?.message ?? '').toLowerCase();
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('-32005');
}

/** Exponential backoff with jitter; rate-limits (429) get a longer floor so the RPC can recover. */
function backoffDelay(attempt: number, err: unknown): number {
  const base = isRateLimit(err) ? 1000 : 300;
  const capped = Math.min(base * 2 ** attempt, 15_000);
  return capped + Math.random() * 250; // jitter to de-sync concurrent workers
}

/** Blocks to hold back from the chain tip for light reorg safety. */
function getConfirmations(): bigint {
  const raw = process.env.DCA_INDEX_CONFIRMATIONS?.trim();
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? BigInt(n) : 5n;
}

export interface IndexPlansResult {
  ok: boolean;
  generatedAt: string;
  chains: Array<{ chainId: number; chainName: string; fromBlock: string; toBlock: string; upserted: number }>;
  errors?: string[];
}

export interface IndexPlansOptions {
  chainIds?: number[];
}

type PublicClient = ReturnType<typeof createPublicClient>;

/** Build [from,to] ranges honoring the RPC chunk cap. */
function buildRanges(startBlock: bigint, endBlock: bigint, chunkSize: bigint): Array<[bigint, bigint]> {
  const ranges: Array<[bigint, bigint]> = [];
  for (let fromBlock = startBlock; fromBlock <= endBlock; fromBlock += chunkSize + 1n) {
    const toBlock = fromBlock + chunkSize > endBlock ? endBlock : fromBlock + chunkSize;
    ranges.push([fromBlock, toBlock]);
  }
  return ranges;
}

/** Scan one event type across all ranges with bounded concurrency. */
async function scanEvent(
  client: PublicClient,
  vault: `0x${string}`,
  event: AbiEvent,
  ranges: Array<[bigint, bigint]>,
  errors: string[],
): Promise<Log[]> {
  const collected: Log[] = [];
  let idx = 0;
  const worker = async () => {
    while (idx < ranges.length) {
      const [fromBlock, toBlock] = ranges[idx++];
      // Retry with backoff so a transient rate-limit (429) on a range doesn't silently drop its logs.
      let lastErr: unknown;
      for (let attempt = 0; attempt < getMaxRetries(); attempt++) {
        try {
          const logs = (await client.getLogs({ address: vault, event, fromBlock, toBlock })) as Log[];
          collected.push(...logs);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (attempt < getMaxRetries() - 1) await sleep(backoffDelay(attempt, e));
        }
      }
      if (lastErr) errors.push(`getLogs ${event.name} [${fromBlock}-${toBlock}]: ${(lastErr as Error).message}`);
    }
  };
  await Promise.all(Array.from({ length: getScanConcurrency() }, () => worker()));
  return collected;
}

/** Resolve block timestamps for a set of block numbers, deduped and concurrency-bounded. */
async function fetchBlockTimestamps(client: PublicClient, blockNumbers: Set<bigint>): Promise<Map<bigint, Date>> {
  const map = new Map<bigint, Date>();
  const nums = [...blockNumbers];
  let idx = 0;
  const worker = async () => {
    while (idx < nums.length) {
      const bn = nums[idx++];
      try {
        const block = await client.getBlock({ blockNumber: bn });
        map.set(bn, new Date(Number(block.timestamp) * 1000));
      } catch {
        // leave unset; caller falls back to whatever timestamp it already had
      }
    }
  };
  await Promise.all(Array.from({ length: getScanConcurrency() }, () => worker()));
  return map;
}

const keyOf = (user: string, scheduleId: bigint | number) => `${user.toLowerCase()}:${scheduleId.toString()}`;

/** Index a single chain: scan new logs, fold onto stored state, reconcile with the live struct, upsert. */
async function indexChain(
  chainId: number,
  errors: string[],
  log: (msg: string) => void,
): Promise<IndexPlansResult['chains'][number] | null> {
  const cfg = getVaultUsdcGasTank(chainId);
  const rpcUrl = getRpc(chainId);
  const chain = getChain(chainId);
  const chainName = CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;
  if (!cfg || !rpcUrl || !chain) {
    errors.push(`No vault/RPC/chain config for chain ${chainId}`);
    return null;
  }
  const vault = cfg.vault as `0x${string}`;
  const client = createPublicClient({ chain, transport: http(rpcUrl) });

  const latest = await client.getBlockNumber();
  const confirmations = getConfirmations();
  const toBlock = latest > confirmations ? latest - confirmations : latest;

  const cursor = await getIndexCursor(chainId);
  const lookback = getLookbackBlocks();
  const fromBlock = cursor != null ? cursor + 1n : toBlock > lookback ? toBlock - lookback : 0n;

  if (fromBlock > toBlock) {
    log(`[${chainName}] up to date (cursor ${cursor ?? 'none'}, tip ${toBlock})`);
    return { chainId, chainName, fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), upserted: 0 };
  }
  log(`[${chainName}] scanning blocks ${fromBlock}..${toBlock}`);

  const ranges = buildRanges(fromBlock, toBlock, getLogChunkBlocks());
  // Scan events sequentially (not Promise.all): each scanEvent already fans out to
  // getScanConcurrency() workers, so running the three in parallel tripled peak concurrency
  // and tripped rate limits on public RPCs. Serializing keeps peak in-flight requests bounded.
  const createdLogs = await scanEvent(client, vault, CREATED_EVENT, ranges, errors);
  const executedLogs = await scanEvent(client, vault, EXECUTED_EVENT, ranges, errors);
  const cancelledLogs = await scanEvent(client, vault, CANCELLED_EVENT, ranges, errors);

  const allLogs = [...createdLogs, ...executedLogs, ...cancelledLogs];
  if (allLogs.length === 0) {
    await setIndexCursor(chainId, toBlock);
    log(`[${chainName}] no new events`);
    return { chainId, chainName, fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), upserted: 0 };
  }

  // Resolve block timestamps once for every block we saw an event in.
  const blockNums = new Set<bigint>();
  for (const l of allLogs) if (l.blockNumber != null) blockNums.add(l.blockNumber);
  const blockTs = await fetchBlockTimestamps(client, blockNums);

  // Seed working rows from what's already stored so incremental deltas add on top of history.
  const existing = await getDcaPlans([chainId]);
  const rows = new Map<string, DcaPlanRow>();
  for (const r of existing) rows.set(keyOf(r.userAddr, r.scheduleId), r);

  const touched = new Set<string>();
  const ensureRow = (user: string, scheduleId: bigint): DcaPlanRow => {
    const k = keyOf(user, scheduleId);
    touched.add(k);
    let row = rows.get(k);
    if (!row) {
      row = {
        chainId,
        userAddr: user.toLowerCase(),
        scheduleId: Number(scheduleId),
        targetToken: null,
        frequency: null,
        amountPerIntervalUsdc6: null,
        committedUsdc6: null,
        swappedUsdc6: '0',
        executedCount: 0,
        createdAt: null,
        lastExecutionAt: null,
        endedAt: null,
        status: 'active',
        returnedUsdc6: null,
        // A backfill reads block logs long after the fact, and the price a token had at a buy that
        // happened last month is not something any feed will hand back. Prices are stamped only by
        // the code paths that are present when a run happens, and upsertDcaPlans leaves these
        // columns alone so a reindex cannot erase the ones that were.
        startPriceUsd: null,
        lastPriceUsd: null,
        lastPriceAt: null,
        avgPriceUsd: null,
        pricedCount: 0,
      };
      rows.set(k, row);
    }
    return row;
  };

  // Order events deterministically (block, then log index) before folding.
  const ordered = [...allLogs].sort((a, b) => {
    const bd = Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n));
    if (bd !== 0) return bd;
    return (a.logIndex ?? 0) - (b.logIndex ?? 0);
  });

  for (const l of ordered) {
    const args = (l as unknown as { args: Record<string, unknown>; eventName?: string }).args;
    const user = args.user as string;
    const scheduleId = args.scheduleId as bigint;
    if (typeof user !== 'string' || typeof scheduleId !== 'bigint') continue;
    const ts = l.blockNumber != null ? blockTs.get(l.blockNumber) ?? null : null;
    const row = ensureRow(user, scheduleId);
    const name = (l as unknown as { eventName?: string }).eventName;

    if (name === 'ScheduleCreated') {
      row.createdAt = ts ?? row.createdAt;
      row.targetToken = (args.targetToken as string) ?? row.targetToken;
      row.frequency = args.frequency != null ? Number(args.frequency) : row.frequency;
      row.amountPerIntervalUsdc6 = args.amountPerInterval != null ? (args.amountPerInterval as bigint).toString() : row.amountPerIntervalUsdc6;
    } else if (name === 'ScheduleExecuted') {
      // usdcAmount is net (after fee); the deposit is drawn down by the gross swapAmount
      // (net + fee). Track gross so committed = swapped + remaining equals the exact deposit.
      const usdcNet = (args.usdcAmount as bigint) ?? 0n;
      const fee = (args.fee as bigint) ?? 0n;
      row.swappedUsdc6 = (BigInt(row.swappedUsdc6 ?? '0') + usdcNet + fee).toString();
      row.executedCount += 1;
      row.lastExecutionAt = ts ?? row.lastExecutionAt;
      if (!row.targetToken && typeof args.targetToken === 'string') row.targetToken = args.targetToken;
    } else if (name === 'ScheduleCancelled') {
      row.status = 'cancelled';
      row.endedAt = ts ?? row.endedAt;
      row.returnedUsdc6 = ((args.returnedAmount as bigint) ?? 0n).toString();
    }
  }

  // Reconcile each touched plan against the live struct: on-chain remaining/active is authoritative
  // for committed and status, while the exact swapped/timestamps come from events.
  const touchedRows = [...touched].map((k) => rows.get(k)!).filter(Boolean);
  await Promise.all(
    touchedRows.map(async (row) => {
      try {
        const s = (await client.readContract({
          address: vault,
          abi: DCA_VAULT_ABI,
          functionName: 'getSchedule',
          args: [row.userAddr as `0x${string}`, BigInt(row.scheduleId)],
        })) as {
          amountPerInterval: bigint;
          totalAmount: bigint;
          executedCount: bigint;
          active: boolean;
          targetToken: `0x${string}`;
          frequency: number;
        };
        if (!row.amountPerIntervalUsdc6) row.amountPerIntervalUsdc6 = s.amountPerInterval.toString();
        if (!row.targetToken) row.targetToken = s.targetToken;
        if (row.frequency == null) row.frequency = Number(s.frequency);
        // Derive amounts from the struct, not from event sums: the deposit is drawn down by the
        // gross amountPerInterval each execution and executedCount is preserved even after a plan
        // ends, so this stays exact even when older execution logs fall outside the scanned window.
        // (It can overcount by at most one partial final swap near exact depletion — bounded and rare.)
        const perInterval = s.amountPerInterval;
        row.executedCount = Number(s.executedCount);
        const grossSpent = perInterval * s.executedCount;
        row.swappedUsdc6 = grossSpent.toString();
        if (row.status === 'cancelled') {
          // Pocket = refunded amount (totalAmount was zeroed on cancel).
          row.committedUsdc6 = (grossSpent + BigInt(row.returnedUsdc6 ?? '0')).toString();
        } else if (s.active) {
          row.status = 'active';
          row.committedUsdc6 = (grossSpent + s.totalAmount).toString();
        } else {
          // Not active and not cancelled => depleted / completed (pocket = 0).
          row.status = 'completed';
          row.committedUsdc6 = grossSpent.toString();
          row.endedAt = row.endedAt ?? row.lastExecutionAt;
        }
      } catch (e) {
        errors.push(`getSchedule reconcile ${chainId}:${row.userAddr}:${row.scheduleId}: ${(e as Error).message}`);
        // Best-effort fallback without a struct read: use event-summed gross swapped.
        const swapped = BigInt(row.swappedUsdc6 ?? '0');
        if (row.status === 'cancelled') row.committedUsdc6 = (swapped + BigInt(row.returnedUsdc6 ?? '0')).toString();
        else row.committedUsdc6 = row.committedUsdc6 ?? swapped.toString();
      }
    }),
  );

  await upsertDcaPlans(touchedRows);
  await setIndexCursor(chainId, toBlock);
  log(`[${chainName}] upserted ${touchedRows.length} plan(s)`);
  return { chainId, chainName, fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), upserted: touchedRows.length };
}

/** Index all allowed chains. Never throws for per-chain issues — those go into `errors`. */
export async function indexAllPlans(
  onProgress?: ProgressCallback,
  options?: IndexPlansOptions,
): Promise<IndexPlansResult> {
  const log = (msg: string) => onProgress?.(msg);
  const generatedAt = new Date().toISOString();

  if (!isSupabaseConfigured()) {
    return { ok: false, generatedAt, chains: [], errors: ['SUPABASE_DB_URL not configured; indexer skipped.'] };
  }
  await ensureDcaPlansSchema();

  const allowed =
    options?.chainIds && options.chainIds.length > 0 ? new Set(options.chainIds) : getAllowedChainIds();
  const errors: string[] = [];
  const chains: IndexPlansResult['chains'] = [];

  for (const chainId of [...allowed].sort((a, b) => a - b)) {
    try {
      const result = await indexChain(chainId, errors, log);
      if (result) chains.push(result);
    } catch (e) {
      errors.push(`indexChain ${chainId}: ${(e as Error).message}`);
    }
  }

  return { ok: errors.length === 0, generatedAt, chains, ...(errors.length ? { errors } : {}) };
}

async function main() {
  const result = await indexAllPlans((msg) => console.error(msg));
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
