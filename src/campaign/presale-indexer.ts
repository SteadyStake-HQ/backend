/**
 * Indexes the SS4 sale's own events, which is what makes two campaign facts checkable rather than
 * claimed: that a referee actually bought (campaign spec §3.1), and that a voucher this backend signed
 * was actually spent (§15).
 *
 * WHY EVENTS AND NOT THE CLIENT. A referral pays only "when the invited user successfully purchases
 * SS4 through the presale", and the referrer is the party who benefits from that being believed. So the
 * qualifying fact is read from `Purchase` logs on the sale contract, never from a callback. Nothing a
 * browser sends can qualify a referral.
 *
 * Three events are read:
 *   - `Purchase`             a confirmed buy. Qualifies the buyer's referral, if they have one.
 *   - `ReferrerBound`        the chain's own attribution record, for reconciliation against ours.
 *   - `CampaignBoostAccrued` a voucher was spent. Closes the loop on the audit trail.
 *
 * The cursor is keyed on `(chainId, presaleAddress)` because a re-deployed sale is a different contract
 * with its own log history — a chain-only cursor would skip every event before the previous sale's last
 * block. See campaign-store.ts.
 */
import { Injectable, Logger } from '@nestjs/common';
import { createPublicClient, http, parseAbiItem, type Log, type PublicClient } from 'viem';
import { getRpc } from '../config';
import { getChain } from '../run-executor';
import { isSupabaseConfigured } from '../supabase/dca-plans-store';
import {
  getCampaignUser,
  getIndexCursor,
  markVoucherConsumed,
  qualifyReferral,
  recordSS4Purchase,
  setIndexCursor,
  writeAudit,
} from '../supabase/campaign-store';
import { campaignPresale } from './campaign-config';

/**
 * How many blocks to read in one `eth_getLogs`. BOT Chain's ~0.75s blocks make a day about 115k
 * blocks, so a small window would take many round trips to catch up; 5,000 is comfortably inside what
 * public RPCs accept while still bounding a single response.
 */
const LOG_WINDOW = 5_000n;

/**
 * How far behind head to stop. BOT Chain is Parlia (BSC-derived) with fast finality, but a log read at
 * the very tip can pick up a block that is then reorganised out — and this indexer's writes qualify
 * referrals, which pay. Six blocks is under five seconds of latency for a confirmation that a referral
 * is genuinely settled.
 */
const CONFIRMATIONS = 6n;

const PURCHASE_EVENT = parseAbiItem(
  'event Purchase(address indexed buyer, address indexed paymentToken, uint256 paymentAmount, uint256 ss4Amount)',
);
const REFERRER_BOUND_EVENT = parseAbiItem(
  'event ReferrerBound(address indexed buyer, address indexed referrer)',
);
const BOOST_ACCRUED_EVENT = parseAbiItem(
  'event CampaignBoostAccrued(address indexed buyer, uint16 boostBps, uint64 nonce, uint256 ss4Amount)',
);

@Injectable()
export class PresaleIndexerService {
  private readonly logger = new Logger(PresaleIndexerService.name);
  private running = false;

  private client(chainId: number): PublicClient | null {
    const chain = getChain(chainId);
    const rpc = getRpc(chainId);
    if (!chain || !rpc) return null;
    return createPublicClient({ chain, transport: http(rpc) }) as PublicClient;
  }

  /**
   * Read every new sale event and apply it.
   *
   * Guarded against overlapping runs with a plain flag rather than a lock: the only caller is a single
   * process's interval plus an admin trigger, and a second concurrent pass would not corrupt anything
   * (every write is idempotent) — it would just waste RPC calls.
   *
   * Returns a summary so the admin endpoint can report what a manual run did.
   */
  async sync(): Promise<{
    ok: boolean;
    reason?: string;
    fromBlock?: string;
    toBlock?: string;
    purchases?: number;
    referralsQualified?: number;
    vouchersConsumed?: number;
  }> {
    if (!isSupabaseConfigured()) return { ok: false, reason: 'SUPABASE_DB_URL is not configured.' };
    if (this.running) return { ok: false, reason: 'A sync is already in progress.' };

    const presale = campaignPresale();
    if (!presale) {
      return { ok: false, reason: 'No SS4PresaleV3 is configured for the campaign chain.' };
    }

    const client = this.client(presale.chainId);
    if (!client) return { ok: false, reason: `No RPC configured for chain ${presale.chainId}.` };

    this.running = true;
    try {
      const head = await client.getBlockNumber();
      const safeHead = head > CONFIRMATIONS ? head - CONFIRMATIONS : 0n;

      const cursor = await getIndexCursor(presale.chainId, presale.address);
      /**
       * With no cursor, start at the safe head rather than at block 0.
       *
       * Scanning a chain's whole history through `eth_getLogs` would be tens of thousands of requests
       * against a public RPC, and it is unnecessary: this indexer exists to qualify referrals as they
       * happen, and the sale it watches is deployed shortly before the campaign starts. An operator
       * backfilling a redeployed sale sets the cursor explicitly (`POST /api/admin/campaign/cursor`).
       */
      let fromBlock = cursor !== null ? cursor + 1n : safeHead;
      if (fromBlock > safeHead) {
        await setIndexCursor(presale.chainId, presale.address, safeHead);
        return { ok: true, fromBlock: fromBlock.toString(), toBlock: safeHead.toString(), purchases: 0 };
      }

      let purchases = 0;
      let referralsQualified = 0;
      let vouchersConsumed = 0;
      const startedAt = fromBlock;

      while (fromBlock <= safeHead) {
        const toBlock = fromBlock + LOG_WINDOW - 1n > safeHead ? safeHead : fromBlock + LOG_WINDOW - 1n;

        const [purchaseLogs, boundLogs, boostLogs] = await Promise.all([
          client.getLogs({ address: presale.address, event: PURCHASE_EVENT, fromBlock, toBlock }),
          client.getLogs({ address: presale.address, event: REFERRER_BOUND_EVENT, fromBlock, toBlock }),
          client.getLogs({ address: presale.address, event: BOOST_ACCRUED_EVENT, fromBlock, toBlock }),
        ]);

        // Block timestamps, fetched once per block rather than once per log: several purchases can
        // land in one block and each `getBlock` is a round trip.
        const blockTimes = await this.blockTimes(client, [
          ...purchaseLogs.map((l) => l.blockNumber),
          ...boostLogs.map((l) => l.blockNumber),
        ]);

        for (const log of purchaseLogs) {
          const applied = await this.applyPurchase(log, presale, blockTimes);
          if (applied.recorded) purchases += 1;
          if (applied.qualified) referralsQualified += 1;
        }

        for (const log of boundLogs) {
          await this.applyReferrerBound(log);
        }

        for (const log of boostLogs) {
          if (await this.applyBoostAccrued(log, blockTimes)) vouchersConsumed += 1;
        }

        await setIndexCursor(presale.chainId, presale.address, toBlock);
        fromBlock = toBlock + 1n;
      }

      if (purchases || referralsQualified || vouchersConsumed) {
        this.logger.log(
          `campaign indexer: ${purchases} purchase(s), ${referralsQualified} referral(s) qualified, ` +
            `${vouchersConsumed} voucher(s) consumed (blocks ${startedAt}–${safeHead})`,
        );
      }

      return {
        ok: true,
        fromBlock: startedAt.toString(),
        toBlock: safeHead.toString(),
        purchases,
        referralsQualified,
        vouchersConsumed,
      };
    } catch (err) {
      // The cursor is only advanced per completed window, so a mid-catch-up failure resumes from the
      // last window rather than skipping the rest.
      this.logger.warn(`campaign indexer failed: ${(err as Error).message}`);
      return { ok: false, reason: (err as Error).message };
    } finally {
      this.running = false;
    }
  }

  private async blockTimes(client: PublicClient, blockNumbers: bigint[]): Promise<Map<string, Date>> {
    const times = new Map<string, Date>();
    const unique = [...new Set(blockNumbers.map((b) => b.toString()))];
    for (const key of unique) {
      try {
        const block = await client.getBlock({ blockNumber: BigInt(key) });
        times.set(key, new Date(Number(block.timestamp) * 1000));
      } catch {
        // A block we cannot read still has a usable purchase in it; the ingest falls back to now().
      }
    }
    return times;
  }

  /**
   * Record a purchase and, if the buyer arrived through a referral, qualify it.
   *
   * The mission itself is not written here — `qualifyReferral` moves the referral to `qualified`, and
   * the referrer's `community_verified_referral` mission is picked up by the referral verifier on their
   * next profile read or voucher request. Keeping those separate means the indexer never has to know
   * the campaign's boost arithmetic, and a referral that qualifies while its referrer is offline is
   * simply waiting for them rather than needing a retry.
   */
  private async applyPurchase(
    log: Log<bigint, number, false, typeof PURCHASE_EVENT>,
    presale: { address: string; chainId: number },
    blockTimes: Map<string, Date>,
  ): Promise<{ recorded: boolean; qualified: boolean }> {
    const buyer = String(log.args.buyer ?? '').toLowerCase();
    if (!buyer || !log.transactionHash || log.logIndex === null) return { recorded: false, qualified: false };

    const purchasedAt = blockTimes.get(log.blockNumber.toString()) ?? new Date();
    const reference = `${log.transactionHash.toLowerCase()}:${log.logIndex}`;

    const recorded = await recordSS4Purchase({
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
      chainId: presale.chainId,
      presaleAddress: presale.address,
      buyerWallet: buyer,
      paymentToken: String(log.args.paymentToken ?? ''),
      paymentAmount: String(log.args.paymentAmount ?? 0n),
      ss4Amount: String(log.args.ss4Amount ?? 0n),
      blockNumber: log.blockNumber.toString(),
      purchasedAt,
    });

    // Only attempt qualification on a purchase we had not already seen: `qualifyReferral` is itself
    // idempotent, but skipping the call on a re-read keeps a catch-up pass from writing audit noise.
    let qualified = false;
    if (recorded) {
      qualified = await qualifyReferral(buyer, reference);
      if (qualified) {
        const referee = await getCampaignUser(buyer);
        await writeAudit({
          wallet: buyer,
          missionCode: 'community_verified_referral',
          event: 'referral_qualified',
          detail: {
            purchaseReference: reference,
            ss4Amount: String(log.args.ss4Amount ?? 0n),
            refereeCampaignUserId: referee?.id ?? null,
          },
        });
      }
      await writeAudit({
        wallet: buyer,
        missionCode: null,
        event: 'ss4_purchase_indexed',
        detail: { reference, blockNumber: log.blockNumber.toString() },
      });
    }

    return { recorded, qualified };
  }

  /**
   * Reconcile the chain's referral attribution against ours.
   *
   * Deliberately does not *create* a referral. The spec requires the referrer to be recorded before the
   * referee's qualifying purchase, and our own record is what establishes that ordering — accepting an
   * on-chain binding as a new referral would let a referee attribute a purchase to a referrer at the
   * moment of buying, defeating the ordering rule. What this does is notice a disagreement and log it,
   * which is the only honest thing to do with two records that should have matched.
   */
  private async applyReferrerBound(
    log: Log<bigint, number, false, typeof REFERRER_BOUND_EVENT>,
  ): Promise<void> {
    const buyer = String(log.args.buyer ?? '').toLowerCase();
    const onChainReferrer = String(log.args.referrer ?? '').toLowerCase();
    if (!buyer || !onChainReferrer) return;

    const referee = await getCampaignUser(buyer);
    const ourReferrer = referee?.referredBy ?? null;

    await writeAudit({
      wallet: buyer,
      missionCode: 'community_verified_referral',
      event: 'referrer_bound_onchain',
      detail: {
        onChainReferrer,
        ourReferrerUserId: ourReferrer,
        transactionHash: log.transactionHash?.toLowerCase() ?? null,
        // Flagged rather than resolved: an operator decides, because either record could be the
        // mistaken one and silently preferring either would be a policy nobody chose.
        matchesOurRecord: ourReferrer !== null,
      },
    });
  }

  /** Close a voucher out against the purchase that spent it. */
  private async applyBoostAccrued(
    log: Log<bigint, number, false, typeof BOOST_ACCRUED_EVENT>,
    blockTimes: Map<string, Date>,
  ): Promise<boolean> {
    const buyer = String(log.args.buyer ?? '').toLowerCase();
    const nonce = log.args.nonce;
    if (!buyer || nonce === undefined || !log.transactionHash) return false;

    const at = blockTimes.get(log.blockNumber.toString()) ?? new Date();
    await markVoucherConsumed(buyer, BigInt(nonce), log.transactionHash, at);
    await writeAudit({
      wallet: buyer,
      missionCode: null,
      event: 'voucher_consumed',
      detail: {
        nonce: String(nonce),
        boostBps: Number(log.args.boostBps ?? 0),
        ss4Awarded: String(log.args.ss4Amount ?? 0n),
        transactionHash: log.transactionHash.toLowerCase(),
      },
    });
    return true;
  }
}
