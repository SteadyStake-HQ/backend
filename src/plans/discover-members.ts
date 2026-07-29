/**
 * Cross-chain member discovery for the plan read.
 *
 * Membership is stored as `chainId:user`, and it is written through when a plan is created. That
 * makes the plan list only as complete as the recording path: if `POST /api/plans/record` never
 * lands — the frontend was built with a chain filtered out of its supported list, the write failed,
 * the plan predates recording — the plan exists on-chain, the user sees it in the app, and the
 * operator dashboard never hears about it. There is nothing to retry, because a member nobody
 * recorded is a member nobody knows to ask about.
 *
 * This closes that hole from the other end. A wallet the DB has seen on *any* chain is asked, once
 * per chain, for its `scheduleCount`. That is one eth_call per (wallet, chain) pair, no log scan,
 * and a positive answer is written back into `automation_users` so the finding is permanent and the
 * executor sees the member too. Negative answers are cached in-process for a while, so the steady
 * state of a dashboard polling every few seconds is zero extra calls.
 *
 * What it cannot find is a wallet that has never been recorded on any chain at all. Recovering
 * those still needs the log scan behind `POST /api/plans/reindex`.
 */
import { createPublicClient, http } from 'viem';
import { getVaultUsdcGasTank, getRpc } from '../config';
import { DCA_VAULT_ABI, getChain, type ProgressCallback } from '../run-executor';
import { registerAutomationUsers } from '../supabase/dca-plans-store';

/** How long a "this wallet has no schedules here" answer is trusted before being asked again. */
function getNegativeTtlMs(): number {
  const raw = process.env.PLAN_DISCOVERY_TTL_SECONDS?.trim();
  const n = raw ? parseInt(raw, 10) : NaN;
  return (Number.isFinite(n) && n > 0 ? n : 900) * 1000;
}

/**
 * Ceiling on probes per read. Discovery is O(wallets x chains) the first time it runs, and the
 * dashboard read must stay bounded however large the member list grows; anything over the cap is
 * simply left for the next read, whose negative cache has already retired the pairs just checked.
 */
function getMaxProbes(): number {
  const raw = process.env.PLAN_DISCOVERY_MAX_PROBES?.trim();
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 200;
}

function getConcurrency(): number {
  const raw = process.env.PLAN_DISCOVERY_CONCURRENCY?.trim();
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 8;
}

/** Set PLAN_DISCOVERY=off to serve the plan list from recorded members alone. */
export function isDiscoveryEnabled(): boolean {
  const raw = process.env.PLAN_DISCOVERY?.trim().toLowerCase();
  return raw !== 'off' && raw !== 'false' && raw !== '0';
}

/** `${chainId}:${user}` -> epoch ms after which the pair is worth asking about again. */
const checkedUntil = new Map<string, number>();

/** Test seam: forget every cached negative so the next read probes from scratch. */
export function resetDiscoveryCache(): void {
  checkedUntil.clear();
}

export interface DiscoverMembersResult {
  /** Newly found `${chainId}:${user}` members, lowercased, not present in `knownMembers`. */
  members: string[];
  /** How many (wallet, chain) pairs were actually asked about. */
  probed: number;
}

/**
 * Ask every allowed chain which of `wallets` holds schedules there.
 *
 * Never throws: an unreachable RPC costs the chains behind it, not the plan list. Pairs that failed
 * are deliberately left out of the negative cache so the next read retries them.
 */
export async function discoverMembers(
  allowedChains: Set<number>,
  knownMembers: Set<string>,
  wallets: string[],
  log: ProgressCallback = () => {},
  errors: string[] = [],
): Promise<DiscoverMembersResult> {
  if (!isDiscoveryEnabled() || wallets.length === 0) return { members: [], probed: 0 };

  const now = Date.now();
  const ttl = getNegativeTtlMs();
  const maxProbes = getMaxProbes();

  // One client per chain: the pairs for a chain all talk to the same RPC.
  const clients = new Map<number, ReturnType<typeof createPublicClient>>();
  const vaults = new Map<number, `0x${string}`>();
  for (const chainId of allowedChains) {
    const cfg = getVaultUsdcGasTank(chainId);
    const rpcUrl = getRpc(chainId);
    const chain = getChain(chainId);
    if (!cfg || !rpcUrl || !chain) continue; // fetchAllPlans reports missing config per member
    clients.set(chainId, createPublicClient({ chain, transport: http(rpcUrl) }));
    vaults.set(chainId, cfg.vault as `0x${string}`);
  }

  const pending: Array<{ chainId: number; user: string; key: string }> = [];
  for (const chainId of [...allowedChains].sort((a, b) => a - b)) {
    if (!clients.has(chainId)) continue;
    for (const wallet of wallets) {
      const user = wallet.toLowerCase();
      const key = `${chainId}:${user}`;
      if (knownMembers.has(key)) continue;
      if ((checkedUntil.get(key) ?? 0) > now) continue;
      pending.push({ chainId, user, key });
    }
  }
  if (pending.length === 0) return { members: [], probed: 0 };

  const probes = pending.slice(0, maxProbes);
  if (pending.length > probes.length) {
    log(
      `Member discovery: ${pending.length} wallet/chain pairs to check, doing ${probes.length} this read ` +
        `(PLAN_DISCOVERY_MAX_PROBES=${maxProbes}).`,
    );
  } else {
    log(`Member discovery: checking ${probes.length} wallet/chain pair(s) not yet recorded…`);
  }

  const found: string[] = [];
  let index = 0;
  const worker = async () => {
    while (index < probes.length) {
      const { chainId, user, key } = probes[index++];
      try {
        const count = (await clients.get(chainId)!.readContract({
          address: vaults.get(chainId)!,
          abi: DCA_VAULT_ABI,
          functionName: 'scheduleCount',
          args: [user as `0x${string}`],
        })) as bigint;
        checkedUntil.set(key, Date.now() + ttl);
        if (count > 0n) found.push(key);
      } catch (e) {
        // Not cached: a failed probe must not be mistaken for "no schedules here" until the TTL.
        errors.push(`Member discovery ${key}: ${(e as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(getConcurrency(), probes.length) }, worker));

  if (found.length > 0) {
    log(`Member discovery found ${found.length} unrecorded member(s): ${found.join(', ')}`);
    // Persist so the finding outlives this process and the executor sees the member as well. A
    // failure here only costs the shortcut — the plans are already in this read's answer.
    try {
      await registerAutomationUsers(
        found.map((key) => {
          const [chainIdStr, user] = key.split(':');
          return { chainId: parseInt(chainIdStr, 10), userAddr: user };
        }),
      );
    } catch (e) {
      errors.push(`Discovered members could not be registered: ${(e as Error).message}`);
      log(`Discovered members could not be registered: ${(e as Error).message}`);
    }
  }

  return { members: found, probed: probes.length };
}
