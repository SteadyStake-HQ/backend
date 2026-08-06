/**
 * Event indexer for Game Pass payments. Scans `PassPaid` logs from each network's
 * StablecoinGamePassCheckout, matches them to a stored purchase intent, and extends the paying
 * wallet's pass entitlement exactly once (blueprint §7.3).
 *
 * Mirrors index-plans.ts: an incremental per-chain block cursor, chunked getLogs with backoff, and a
 * confirmations holdback from the chain tip. Because we never scan past `tip - requiredConfirmations`,
 * any event we act on already satisfies that network's confirmation rule.
 *
 * Run standalone:  node dist/payments/pass-indexer.js
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { getSharedPool } from '../supabase/pg-pool';
import { createPublicClient, http, getAbiItem, type AbiEvent, type Log } from 'viem';
import { getRpc, CHAIN_NAMES } from '../config';
import { getChain } from '../run-executor';
import { getPaymentNetworks, type PaymentNetworkRow } from '../supabase/payment-networks';
import { getPurchaseIntent, markPurchaseConfirmed } from '../supabase/purchase-intents';
import { extendPassEntitlement } from '../supabase/pass-entitlements';
import { PASS_CHECKOUT_ABI } from './pass-checkout-abi';

const PASS_PAID_EVENT = getAbiItem({ abi: PASS_CHECKOUT_ABI, name: 'PassPaid' }) as AbiEvent;

function getPool(): Pool | null {
  return getSharedPool();
}

export const PASS_INDEX_CURSOR_DDL = `
  CREATE TABLE IF NOT EXISTS pass_index_cursor (
    chain_id integer PRIMARY KEY,
    last_block bigint NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
`;

async function getCursor(chainId: number): Promise<bigint | null> {
  const p = getPool();
  if (!p) return null;
  const { rows } = await p.query('SELECT last_block FROM pass_index_cursor WHERE chain_id = $1', [chainId]);
  return rows.length ? BigInt(rows[0].last_block) : null;
}

async function setCursor(chainId: number, lastBlock: bigint): Promise<void> {
  const p = getPool();
  if (!p) return;
  await p.query(
    `INSERT INTO pass_index_cursor (chain_id, last_block, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (chain_id) DO UPDATE SET last_block = EXCLUDED.last_block, updated_at = now()`,
    [chainId, lastBlock.toString()],
  );
}

function chunkBlocks(): bigint {
  const n = parseInt(process.env.PASS_INDEX_LOG_CHUNK_BLOCKS?.trim() ?? '', 10);
  return Number.isFinite(n) && n > 0 ? BigInt(n) : 999n;
}
function lookbackBlocks(): bigint {
  const n = parseInt(process.env.PASS_INDEX_LOOKBACK_BLOCKS?.trim() ?? '', 10);
  return Number.isFinite(n) && n > 0 ? BigInt(n) : 200_000n;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface IndexPassResult {
  ok: boolean;
  generatedAt: string;
  chains: Array<{ chainId: number; chainName: string; fromBlock: string; toBlock: string; confirmed: number }>;
  errors?: string[];
}

/** Verify a PassPaid log against its intent, then confirm + extend the pass once. */
async function handlePassPaid(
  chainId: number,
  network: PaymentNetworkRow,
  log: Log,
  timestampOf: (blockNumber: bigint) => Promise<Date>,
): Promise<boolean> {
  const args = (log as unknown as { args: { purchaseId: string; buyer: string; paymentToken: string; amount: bigint; durationSeconds: number } }).args;
  const purchaseId = args.purchaseId.toLowerCase();
  const intent = await getPurchaseIntent(purchaseId);
  if (!intent) return false; // not one of ours — an intent this backend never issued

  // Reject anything that does not match the trusted intent exactly (§7.3 verification).
  if (
    intent.chainId !== chainId ||
    intent.walletAddress !== args.buyer.toLowerCase() ||
    intent.paymentToken !== args.paymentToken.toLowerCase() ||
    intent.expectedAmountAtomic !== args.amount.toString()
  ) {
    console.warn(`[pass-indexer] mismatched PassPaid for ${purchaseId} on ${chainId}; not activating`);
    return false;
  }

  const txHash = (log.transactionHash ?? '0x').toLowerCase();
  const confirmedAt = await timestampOf(log.blockNumber ?? 0n);

  const firstTime = await markPurchaseConfirmed(purchaseId, txHash, confirmedAt);
  if (firstTime) {
    await extendPassEntitlement(intent.walletAddress, confirmedAt, intent.durationSeconds, purchaseId);
    console.log(`[pass-indexer] pass extended for ${intent.walletAddress} via ${purchaseId} (${CHAIN_NAMES[chainId] ?? chainId})`);
  }
  return firstTime;
}

export async function indexPassPayments(): Promise<IndexPassResult> {
  const p = getPool();
  if (!p) return { ok: false, generatedAt: new Date().toISOString(), chains: [], errors: ['SUPABASE_DB_URL not configured'] };
  await p.query(PASS_INDEX_CURSOR_DDL);

  const networks = await getPaymentNetworks(true);
  const chains: IndexPassResult['chains'] = [];
  const errors: string[] = [];

  for (const network of networks) {
    const chainId = network.chainId;
    const chain = getChain(chainId);
    const rpc = getRpc(chainId);
    if (!chain || !rpc) {
      errors.push(`no chain/rpc for ${chainId}`);
      continue;
    }
    const client = createPublicClient({ chain, transport: http(rpc) });
    const blockCache = new Map<string, Date>();
    const timestampOf = async (bn: bigint): Promise<Date> => {
      const key = bn.toString();
      const hit = blockCache.get(key);
      if (hit) return hit;
      const block = await client.getBlock({ blockNumber: bn });
      const d = new Date(Number(block.timestamp) * 1000);
      blockCache.set(key, d);
      return d;
    };

    try {
      const tip = await client.getBlockNumber();
      const toBlock = tip - BigInt(network.requiredConfirmations);
      if (toBlock <= 0n) continue;

      const cursor = await getCursor(chainId);
      let fromBlock = cursor === null ? (toBlock > lookbackBlocks() ? toBlock - lookbackBlocks() : 0n) : cursor + 1n;
      if (fromBlock > toBlock) {
        chains.push({ chainId, chainName: CHAIN_NAMES[chainId] ?? String(chainId), fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), confirmed: 0 });
        continue;
      }

      let confirmed = 0;
      const chunk = chunkBlocks();
      for (let start = fromBlock; start <= toBlock; start += chunk) {
        const end = start + chunk - 1n > toBlock ? toBlock : start + chunk - 1n;
        let attempt = 0;
        // Small retry loop for flaky public RPCs.
        for (;;) {
          try {
            const logs = await client.getLogs({ address: network.checkoutContract as `0x${string}`, event: PASS_PAID_EVENT, fromBlock: start, toBlock: end });
            for (const log of logs) {
              if (await handlePassPaid(chainId, network, log, timestampOf)) confirmed += 1;
            }
            break;
          } catch (err) {
            if (attempt >= 5) throw err;
            await sleep(Math.min(300 * 2 ** attempt, 8000) + Math.random() * 200);
            attempt += 1;
          }
        }
      }

      await setCursor(chainId, toBlock);
      chains.push({ chainId, chainName: CHAIN_NAMES[chainId] ?? String(chainId), fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), confirmed });
    } catch (err) {
      errors.push(`${chainId}: ${(err as Error).message}`);
    }
  }

  return { ok: errors.length === 0, generatedAt: new Date().toISOString(), chains, errors: errors.length ? errors : undefined };
}

// Standalone entry: node dist/payments/pass-indexer.js
if (require.main === module) {
  indexPassPayments()
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
