import { randomBytes } from 'crypto';
import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createPublicClient, encodeFunctionData, http, isAddress } from 'viem';
import { getRpc } from '../config';
import { getChain } from '../run-executor';
import {
  getPaymentNetworks,
  getPaymentNetwork,
  type PaymentNetworkRow,
} from '../supabase/payment-networks';
import {
  createPurchaseIntent,
  getPurchaseIntent,
  attachTransactionHash,
  type PurchaseIntentRow,
} from '../supabase/purchase-intents';
import { getPassEntitlement } from '../supabase/pass-entitlements';
import { isSupabaseConfigured } from '../supabase/dca-plans-store';
import { PASS_PLANS, getPassPlan, planAmountAtomic } from './pass-plans';
import { PASS_CHECKOUT_ABI, ERC20_APPROVE_ABI } from './pass-checkout-abi';

const INTENT_TTL_SECONDS = 10 * 60; // §7.1

/** How long an on-chain plan-enablement read is reused. Plans change by an admin tx, not by traffic. */
const PLAN_CACHE_TTL_MS = 60_000;

export interface PassStatus {
  active: boolean;
  expiresAt: string | null;
  startsAt: string | null;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  /** chainId => the plan ids that network's checkout will actually sell, and when we last looked. */
  private readonly planCache = new Map<number, { ids: Set<number>; at: number }>();

  /**
   * Which PASS_PLANS the network's checkout contract has seeded and enabled.
   *
   * PASS_PLANS is the backend's price table; `plans(planId)` on the checkout is what `buyPass` will
   * honour. They drift whenever a plan is added to the table after a contract was deployed, and the
   * drift is expensive for the player: the Game Pass screen offers the plan, the wallet pays gas to
   * approve, and only then does `buyPass` revert with PlanDisabled. So the two are reconciled here,
   * before either an offer or an intent is made.
   *
   * Returns null when the chain cannot be read — an RPC outage should not close checkout on plans
   * that are seeded, and a plan that is genuinely missing still surfaces as a reverted `buyPass`.
   */
  private async enabledPlanIds(network: PaymentNetworkRow): Promise<Set<number> | null> {
    const cached = this.planCache.get(network.chainId);
    if (cached && Date.now() - cached.at < PLAN_CACHE_TTL_MS) return cached.ids;

    const chain = getChain(network.chainId);
    const rpc = getRpc(network.chainId);
    if (!chain || !rpc) return null;

    try {
      const client = createPublicClient({ chain, transport: http(rpc) });
      const ids = new Set<number>();
      for (const plan of PASS_PLANS) {
        const [, , enabled] = await client.readContract({
          address: network.checkoutContract as `0x${string}`,
          abi: PASS_CHECKOUT_ABI,
          functionName: 'plans',
          args: [plan.id],
        });
        if (enabled) ids.add(plan.id);
      }
      this.planCache.set(network.chainId, { ids, at: Date.now() });
      return ids;
    } catch (err) {
      this.logger.warn(
        `Could not read plan config from ${network.checkoutContract} on ${network.chainId}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private ensureDb() {
    if (!isSupabaseConfigured()) {
      throw new ServiceUnavailableException({ ok: false, error: 'Payments are unavailable: the database is not configured.' });
    }
  }

  /**
   * Enabled payment networks with their plan prices, for the game's Game Pass screen.
   *
   * `plans` stays the full price table so a client can label any plan it sees; each network also
   * carries `planIds` — the subset its checkout will actually sell — so the screen offers a plan
   * only on the networks where buying it can succeed.
   */
  async listCheckoutOptions() {
    this.ensureDb();
    const networks = await getPaymentNetworks(true);
    const allIds = PASS_PLANS.map((p) => p.id);
    const withPlans = await Promise.all(
      networks.map(async (n) => {
        const enabled = await this.enabledPlanIds(n);
        return {
          chainId: n.chainId,
          stablecoinSymbol: n.stablecoinSymbol,
          stablecoinDecimals: n.stablecoinDecimals,
          checkoutContract: n.checkoutContract,
          planIds: enabled ? allIds.filter((id) => enabled.has(id)) : allIds,
        };
      }),
    );
    return {
      ok: true,
      plans: PASS_PLANS.map((p) => ({ id: p.id, key: p.key, label: p.label, durationSeconds: p.durationSeconds, priceCents: p.priceCents })),
      networks: withPlans,
    };
  }

  /**
   * Create a purchase intent and return the exact transaction request (§7.1). The client supplies
   * only wallet, chainId and planId; price, token, duration and treasury all come from trusted config.
   */
  async createIntent(input: { wallet?: string; chainId?: number; planId?: number }) {
    this.ensureDb();

    if (!input.wallet || !isAddress(input.wallet)) {
      throw new BadRequestException({ ok: false, error: 'A valid wallet address is required.' });
    }
    const chainId = Number(input.chainId);
    const plan = getPassPlan(Number(input.planId));
    if (!plan) throw new BadRequestException({ ok: false, error: 'Unknown pass plan.' });

    const network = await getPaymentNetwork(chainId);
    if (!network || !network.enabled) {
      throw new BadRequestException({ ok: false, error: 'That network is not available for pass payment.' });
    }

    // Refuse a checkout this network's contract cannot honour, rather than letting the player pay
    // gas to approve and then watch `buyPass` revert with PlanDisabled.
    const enabledPlans = await this.enabledPlanIds(network);
    if (enabledPlans && !enabledPlans.has(plan.id)) {
      this.logger.warn(
        `Plan ${plan.id} (${plan.key}) is in PASS_PLANS but not enabled on ${network.checkoutContract} (chain ${chainId}); seed it with setPlan().`,
      );
      throw new BadRequestException({
        ok: false,
        error: `The ${plan.label} is not available on this network. Pick another pass or another network.`,
      });
    }

    const amount = planAmountAtomic(plan, network.stablecoinDecimals);
    const purchaseId = `0x${randomBytes(32).toString('hex')}`;
    const wallet = input.wallet.toLowerCase();
    const expiresAt = new Date(Date.now() + INTENT_TTL_SECONDS * 1000);

    await createPurchaseIntent({
      purchaseId,
      walletAddress: wallet,
      chainId,
      passPlanId: plan.id,
      durationSeconds: plan.durationSeconds,
      paymentToken: network.stablecoinAddress,
      expectedAmountAtomic: amount.toString(),
      checkoutContract: network.checkoutContract,
      expiresAt,
    });

    const approveData = encodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      functionName: 'approve',
      args: [network.checkoutContract as `0x${string}`, amount],
    });
    const buyPassData = encodeFunctionData({
      abi: PASS_CHECKOUT_ABI,
      functionName: 'buyPass',
      args: [plan.id, purchaseId as `0x${string}`],
    });

    return {
      ok: true,
      purchaseId,
      chainId,
      plan: { id: plan.id, label: plan.label, durationSeconds: plan.durationSeconds },
      amountAtomic: amount.toString(),
      stablecoin: {
        address: network.stablecoinAddress,
        symbol: network.stablecoinSymbol,
        decimals: network.stablecoinDecimals,
      },
      checkoutContract: network.checkoutContract,
      // The exact calls the wallet should make: approve the checkout for the exact amount, then buy.
      approve: { to: network.stablecoinAddress, data: approveData, spender: network.checkoutContract, amount: amount.toString() },
      buyPass: { to: network.checkoutContract, data: buyPassData, planId: plan.id },
      expiresAt: expiresAt.toISOString(),
    };
  }

  /** Record the submitted tx hash against an intent (§7.2 step 7). Idempotent. */
  async submitTransaction(purchaseId: string, txHash: string) {
    this.ensureDb();
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash ?? '')) {
      throw new BadRequestException({ ok: false, error: 'A valid transaction hash is required.' });
    }
    const intent = await getPurchaseIntent(purchaseId);
    if (!intent) throw new NotFoundException({ ok: false, error: 'Unknown purchase intent.' });
    await attachTransactionHash(purchaseId, txHash);
    return { ok: true };
  }

  /** Poll target: the intent's confirmation state plus the wallet's resulting pass (§7.3 step 7). */
  async getIntentStatus(purchaseId: string) {
    this.ensureDb();
    const intent = await getPurchaseIntent(purchaseId);
    if (!intent) throw new NotFoundException({ ok: false, error: 'Unknown purchase intent.' });
    const pass = await this.passStatusFor(intent.walletAddress);
    return {
      ok: true,
      purchaseId: intent.purchaseId,
      status: intent.status,
      chainId: intent.chainId,
      transactionHash: intent.transactionHash,
      confirmedAt: intent.confirmedAt?.toISOString() ?? null,
      pass,
    };
  }

  async getEntitlement(wallet: string) {
    this.ensureDb();
    if (!isAddress(wallet)) throw new BadRequestException({ ok: false, error: 'A valid wallet address is required.' });
    return { ok: true, wallet: wallet.toLowerCase(), pass: await this.passStatusFor(wallet) };
  }

  private async passStatusFor(wallet: string): Promise<PassStatus> {
    const row = await getPassEntitlement(wallet);
    const expiresAt = row?.expiresAt ?? null;
    return {
      active: !!expiresAt && expiresAt.getTime() > Date.now(),
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      startsAt: row?.startsAt ? row.startsAt.toISOString() : null,
    };
  }
}
