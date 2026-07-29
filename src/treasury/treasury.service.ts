/**
 * The operator wallet, network by network — what it holds, what it earns, and what it burns.
 *
 * One address does two jobs at once, and conflating them is how a relayer runs dry while the books
 * look healthy:
 *
 *  - **It pays.** Every auto-execution is two transactions the relayer signs (`executeSwap` on the
 *    vault, `recordExecution` on the GasTank), both paid in the chain's *native* token out of this
 *    wallet's balance. That balance is the thing that stops automation when it hits zero, and it is
 *    per chain — a funded relayer on Base does nothing for a dry one on Polygon.
 *  - **It earns.** `GasTank.recordExecution` transfers the user's charge to `msg.sender`, which is
 *    this same wallet. So the platform's execution fee arrives here, in the chain's *stablecoin*.
 *
 * The two legs are different tokens, so the wallet can be accumulating fees steadily and still be
 * minutes from being unable to execute. The margin between them is the actual business: charge is a
 * price (usually flat, set per network), spend is a cost (gas price x gas used, moving constantly),
 * and only their difference says whether running the network pays for itself.
 *
 * Two further balances belong to the same picture and are read alongside:
 *  - `DCAVault.totalFeesCollected` — the protocol's 0.25% swap fee and 3% early-cancel fee, accrued
 *    inside the vault and withdrawable by its owner. Money earned but not yet in a wallet.
 *  - `DCAVault.autoPlanFeeRecipient` — where the flat second-auto-plan fee is sent, which may or may
 *    not be the relayer. Read rather than assumed, because a misconfigured recipient sends revenue
 *    to an address nobody is watching.
 *
 * Every read here is best-effort per chain. One unreachable RPC reports its own error and leaves the
 * other networks whole; it never takes the page down.
 */

import { Injectable, Logger } from '@nestjs/common';
import { createPublicClient, formatUnits, http, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  CHAIN_NAMES,
  getRpc,
  getStableDecimals,
  getStableSymbol,
  getVaultUsdcGasTank,
  getChainIdsWithGasTank,
} from '../config';
import { getChain } from '../run-executor';
import { getNativePriceQuote, prefetchNativePrices, type NativePriceQuote } from '../native-price';
import { getGasProfile } from '../gas-profile';
import { getRegistryEntry } from '../networks/network-registry';
import { NetworkAllocationService } from '../networks/network-allocation.service';
import { HistoryService } from '../history/history.service';
import { getTokenMetaMap, type TokenMeta } from '../token-metadata';
import type { ExecutedTask } from '../run-executor';

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const;

const GAS_TANK_READ_ABI = [
  { type: 'function', name: 'executor', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'owner', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'gasCostPerExecutionUsdc6', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const;

const VAULT_READ_ABI = [
  { type: 'function', name: 'owner', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'totalFeesCollected', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'feePercentage', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'additionalAutoPlanFeeUsdc6', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'autoPlanFeeRecipient', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
] as const;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** An RPC that will not answer promptly must not hold up the networks that would. */
const RPC_TIMEOUT_MS = 9_000;

/** Balances move with every run, but not within one operator's page refresh. */
const WALLETS_CACHE_TTL_MS = 30_000;

/** `feePercentage` is in hundredths of a percent — FEE_PRECISION is 10000 in DCAVault.sol. */
const FEE_PRECISION = 10_000;

export interface TreasuryWalletNetwork {
  chainId: number;
  key: string;
  name: string;
  type: 'mainnet' | 'testnet';
  /** Operator allocation: enabled / paused / disabled. A paused chain still holds real money. */
  status: string;
  executable: boolean;
  explorerUrl: string | null;
  nativeSymbol: string;
  stableSymbol: string;
  stableDecimals: number;

  relayer: {
    address: string | null;
    /** Native balance — the tank that pays for gas. This is what runs out. */
    nativeWei: string | null;
    native: number | null;
    nativeUsd: number | null;
    /** Stablecoin balance — execution fees that have already been collected here. */
    stableRaw: string | null;
    stableUsd: number | null;
    /**
     * True when this wallet is the GasTank's `executor`. When it is not, every `recordExecution`
     * reverts: swaps still run and cost gas, and nothing is ever charged for them.
     */
    isGasTankExecutor: boolean | null;
    /** Whoever the GasTank actually names, when it is not the relayer. */
    gasTankExecutor: string | null;
  };

  gasTank: {
    address: string | null;
    owner: string | null;
    /** Users' prepaid balances sitting in the contract. A liability, not revenue. */
    floatRaw: string | null;
    floatUsd: number | null;
    /** The contract's own per-run price, in stablecoin base units. */
    priceRaw: string | null;
    priceUsd: number | null;
  };

  vault: {
    address: string | null;
    owner: string | null;
    /** Swap + early-cancel fees accrued in the vault, withdrawable by the owner. */
    claimableRaw: string | null;
    claimableUsd: number | null;
    /** Swap fee, as a percentage (0.25 means 0.25%). */
    feePercent: number | null;
    /** Flat fee for a user's second and later auto plans. */
    autoPlanFeeRaw: string | null;
    autoPlanFeeUsd: number | null;
    autoPlanFeeRecipient: string | null;
    /** The recipient's own stablecoin balance, when it is an address distinct from the relayer. */
    autoPlanFeeRecipientBalanceRaw: string | null;
    autoPlanFeeRecipientBalanceUsd: number | null;
  };

  nativePrice: NativePriceQuote;

  /** How many more runs the relayer's native balance covers on this chain. */
  runwayRuns: number | null;
  /** The per-run cost behind `runwayRuns`, USD. */
  costPerRunUsd: number | null;
  /**
   * Where that cost came from. `recorded` is the mean of what runs on this chain actually burned;
   * `projected` multiplies the chain's gas profile by its gas price right now, which is what a run
   * *would* cost rather than what one did. Reported so the UI never presents the second as the
   * first. Null when neither could be worked out.
   */
  costPerRunSource: 'recorded' | 'projected' | null;

  error: string | null;
}

/** One auto-execution, priced on both sides. */
export interface TreasuryFlow {
  at: string;
  runId: string;
  chainId: number;
  chainName: string;
  explorerUrl: string | null;
  user: string;
  scheduleId: string;
  txHash: string;

  /** The stablecoin the user's plan swapped away this run, in whole tokens. */
  amountIn: number | null;
  stableSymbol: string;

  /**
   * Target token the swap delivered, in whole tokens. Null on runs recorded before the executor
   * started reading it off the receipt, and on tokens whose decimals could not be read.
   */
  amountOut: number | null;

  /** What the plan bought. */
  token: {
    address: string | null;
    symbol: string | null;
    name: string | null;
    decimals: number | null;
    logoUrl: string | null;
  };

  /** Charged to the user's gas tank and paid to the relayer, in whole stablecoin. */
  chargedUsd: number | null;
  /** False when the swap ran but the deduction did not: that run was executed for free. */
  charged: boolean;
  chargeChainId: number | null;

  /** Native token the relayer burned for this run, and the same in USD. */
  spentNative: number | null;
  spentUsd: number | null;
  nativeSymbol: string;
  /** True when the spend was reconstructed from gas used rather than recorded by the run itself. */
  spendEstimated: boolean;

  /** chargedUsd − spentUsd. Null when either side is unknown. */
  marginUsd: number | null;
  gasUsed: string | null;
}

export interface TreasuryFlowsPayload {
  flows: TreasuryFlow[];
  /** Per-day totals over the requested window, oldest first — the shape the charts plot. */
  daily: Array<{
    date: string;
    executions: number;
    chargedUsd: number;
    spentUsd: number;
    marginUsd: number;
    /**
     * Executions that day whose gas spend could not be priced at all. Reported so a day with an
     * unknown spend is never drawn as a day that spent nothing — which would read as pure profit.
     */
    unpricedExecutions: number;
  }>;
  byNetwork: Array<{
    chainId: number;
    name: string;
    nativeSymbol: string;
    executions: number;
    chargedUsd: number;
    spentUsd: number;
    marginUsd: number;
    spentNative: number;
    freeRuns: number;
  }>;
  byToken: Array<{
    address: string;
    chainId: number;
    chainName: string;
    symbol: string | null;
    name: string | null;
    logoUrl: string | null;
    executions: number;
    /** Stablecoin swapped into this token over the window. */
    volumeUsd: number;
    /** Token delivered over the window, in the token's own units. Null when never recorded. */
    amountOut: number | null;
    chargedUsd: number;
  }>;
  totals: {
    runs: number;
    executions: number;
    /** Executions whose GasTank deduction did not land — work done and not paid for. */
    freeRuns: number;
    chargedUsd: number;
    spentUsd: number;
    marginUsd: number;
    volumeUsd: number;
    /** Executions whose spend had to be estimated rather than read from the record. */
    estimatedSpends: number;
    /** Executions whose spend could not be worked out at all, even approximately. */
    unpricedExecutions: number;
  };
  window: { from: string | null; to: string | null; runs: number };
}

@Injectable()
export class TreasuryService {
  private readonly logger = new Logger(TreasuryService.name);
  private walletsCache: { at: number; payload: Awaited<ReturnType<TreasuryService['readWallets']>> } | null = null;
  private walletsInFlight: Promise<Awaited<ReturnType<TreasuryService['readWallets']>>> | null = null;

  constructor(
    private readonly history: HistoryService,
    private readonly networks: NetworkAllocationService,
  ) {}

  /**
   * The relayer's address, derived from the signing key.
   *
   * Only the address is taken — nothing in this module signs or sends. The key is the same on every
   * chain, so the address is too; what differs per network is what that address holds.
   */
  relayerAddress(): `0x${string}` | null {
    const pk = process.env.RELAYER_PRIVATE_KEY?.trim();
    if (!pk) return null;
    try {
      return privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`).address;
    } catch {
      // A malformed key is a deployment error, not a reason to fail the page — the UI says the
      // address is unknown and every balance reads as unavailable.
      this.logger.warn('RELAYER_PRIVATE_KEY is set but is not a valid private key.');
      return null;
    }
  }

  async getWallets(forceRefresh = false) {
    if (!forceRefresh && this.walletsCache && Date.now() - this.walletsCache.at < WALLETS_CACHE_TTL_MS) {
      return this.walletsCache.payload;
    }
    if (!forceRefresh && this.walletsInFlight) return this.walletsInFlight;

    this.walletsInFlight = this.readWallets()
      .then((payload) => {
        this.walletsCache = { at: Date.now(), payload };
        return payload;
      })
      .catch((error) => {
        // A total failure still serves the last good read: an operator watching a balance drain is
        // better served by a figure a minute old than by an error page.
        if (this.walletsCache) return this.walletsCache.payload;
        throw error;
      })
      .finally(() => {
        this.walletsInFlight = null;
      });

    return this.walletsInFlight;
  }

  private client(chainId: number): PublicClient | null {
    const rpc = getRpc(chainId);
    const chain = getChain(chainId);
    if (!rpc || !chain) return null;
    return createPublicClient({
      chain,
      transport: http(rpc, { timeout: RPC_TIMEOUT_MS, retryCount: 1 }),
    }) as PublicClient;
  }

  private async readWallets() {
    const relayer = this.relayerAddress();
    const chainIds = getChainIdsWithGasTank().sort((a, b) => a - b);

    // One batched price request for every chain rather than one per chain — the free CoinGecko
    // tier answers the first few and rate-limits the rest.
    await prefetchNativePrices(chainIds).catch(() => undefined);

    const allocations = await this.networks
      .listNetworks()
      .then((list) => new Map(list.map((n) => [n.chainId, n])))
      .catch(() => new Map<number, { status: string; executable: boolean; type: 'mainnet' | 'testnet' }>());

    // Per-chain spend history, so each network can state its own runway in its own token.
    const spendByChain = await this.spendPerRunByChain().catch(() => new Map<number, number>());

    const networks = await Promise.all(
      chainIds.map((chainId) => this.readOneNetwork(chainId, relayer, allocations, spendByChain)),
    );

    // Only mainnets are summed. A testnet's native token has no market price (tBOT is pinned to a
    // notional figure precisely so it cannot be mistaken for one), and folding that into a total
    // would put imaginary dollars beside real ones.
    const mainnets = networks.filter((n) => n.type === 'mainnet');
    const sum = (pick: (n: TreasuryWalletNetwork) => number | null) =>
      mainnets.reduce((total, n) => total + (pick(n) ?? 0), 0);

    return {
      relayer,
      relayerConfigured: relayer != null,
      networks,
      totals: {
        /** Gas reserve: what the relayer can still pay for, across mainnets. */
        gasReserveUsd: sum((n) => n.relayer.nativeUsd),
        /** Execution fees already collected into the wallet. */
        collectedFeesUsd: sum((n) => n.relayer.stableUsd),
        /** Protocol fees accrued in the vaults, not yet withdrawn. */
        claimableFeesUsd: sum((n) => n.vault.claimableUsd),
        /** Users' prepaid gas sitting in the tanks. Owed, not earned. */
        userFloatUsd: sum((n) => n.gasTank.floatUsd),
        networksLive: networks.filter((n) => n.executable && !n.error).length,
        networksTotal: networks.length,
        /** Networks where the relayer is not the GasTank executor — every charge there reverts. */
        executorMismatches: networks.filter((n) => n.relayer.isGasTankExecutor === false).length,
      },
      updatedAt: new Date().toISOString(),
    };
  }

  private async readOneNetwork(
    chainId: number,
    relayer: `0x${string}` | null,
    allocations: Map<number, { status: string; executable: boolean; type: 'mainnet' | 'testnet' }>,
    spendByChain: Map<number, number>,
  ): Promise<TreasuryWalletNetwork> {
    const entry = getRegistryEntry(chainId);
    const allocation = allocations.get(chainId);
    const cfg = getVaultUsdcGasTank(chainId);
    const decimals = getStableDecimals(chainId);
    const nativePrice = await getNativePriceQuote(chainId).catch(
      () => ({ chainId, usd: null, source: null, at: null, stale: false }) as NativePriceQuote,
    );

    const base: TreasuryWalletNetwork = {
      chainId,
      key: entry?.key ?? `chain-${chainId}`,
      name: CHAIN_NAMES[chainId] ?? `Chain ${chainId}`,
      type: allocation?.type ?? entry?.type ?? 'mainnet',
      status: allocation?.status ?? 'enabled',
      executable: allocation?.executable ?? true,
      explorerUrl: entry?.explorerUrl ?? null,
      nativeSymbol: entry?.nativeSymbol ?? 'ETH',
      stableSymbol: getStableSymbol(chainId),
      stableDecimals: decimals,
      relayer: {
        address: relayer,
        nativeWei: null,
        native: null,
        nativeUsd: null,
        stableRaw: null,
        stableUsd: null,
        isGasTankExecutor: null,
        gasTankExecutor: null,
      },
      gasTank: { address: cfg?.gasTank ?? null, owner: null, floatRaw: null, floatUsd: null, priceRaw: null, priceUsd: null },
      vault: {
        address: cfg?.vault ?? null,
        owner: null,
        claimableRaw: null,
        claimableUsd: null,
        feePercent: null,
        autoPlanFeeRaw: null,
        autoPlanFeeUsd: null,
        autoPlanFeeRecipient: null,
        autoPlanFeeRecipientBalanceRaw: null,
        autoPlanFeeRecipientBalanceUsd: null,
      },
      nativePrice,
      runwayRuns: null,
      costPerRunUsd: null,
      costPerRunSource: null,
      error: null,
    };

    const client = this.client(chainId);
    if (!client || !cfg) {
      return { ...base, error: !cfg ? 'No deployed vault/GasTank for this chain.' : 'No RPC configured for this chain.' };
    }

    const stable = cfg.usdc as `0x${string}`;
    const toStable = (raw: bigint | null) => (raw == null ? null : Number(formatUnits(raw, decimals)));

    /** Each read is independent: a vault that predates `autoPlanFeeRecipient` must not blank the row. */
    const settle = async <T>(read: Promise<T>): Promise<T | null> => read.catch(() => null);

    try {
      const [
        nativeWei,
        relayerStable,
        gasTankFloat,
        gasTankExecutor,
        gasTankOwner,
        gasTankPrice,
        vaultOwner,
        claimable,
        feeBps,
        autoPlanFee,
        autoPlanRecipient,
        gasPriceWei,
      ] = await Promise.all([
        relayer ? settle(client.getBalance({ address: relayer })) : Promise.resolve(null),
        relayer
          ? settle(client.readContract({ address: stable, abi: ERC20_ABI, functionName: 'balanceOf', args: [relayer] }) as Promise<bigint>)
          : Promise.resolve(null),
        // The stablecoin the tank contract holds — the sum of every user's prepaid balance. Asked
        // of the token, not of the tank: `GasTank.balanceOf` is its own per-user mapping, which
        // takes a user and would answer for the tank's own (always empty) entry.
        settle(client.readContract({ address: stable, abi: ERC20_ABI, functionName: 'balanceOf', args: [cfg.gasTank as `0x${string}`] }) as Promise<bigint>),
        settle(client.readContract({ address: cfg.gasTank as `0x${string}`, abi: GAS_TANK_READ_ABI, functionName: 'executor' }) as Promise<string>),
        settle(client.readContract({ address: cfg.gasTank as `0x${string}`, abi: GAS_TANK_READ_ABI, functionName: 'owner' }) as Promise<string>),
        settle(client.readContract({ address: cfg.gasTank as `0x${string}`, abi: GAS_TANK_READ_ABI, functionName: 'gasCostPerExecutionUsdc6' }) as Promise<bigint>),
        settle(client.readContract({ address: cfg.vault as `0x${string}`, abi: VAULT_READ_ABI, functionName: 'owner' }) as Promise<string>),
        settle(client.readContract({ address: cfg.vault as `0x${string}`, abi: VAULT_READ_ABI, functionName: 'totalFeesCollected' }) as Promise<bigint>),
        settle(client.readContract({ address: cfg.vault as `0x${string}`, abi: VAULT_READ_ABI, functionName: 'feePercentage' }) as Promise<bigint>),
        settle(client.readContract({ address: cfg.vault as `0x${string}`, abi: VAULT_READ_ABI, functionName: 'additionalAutoPlanFeeUsdc6' }) as Promise<bigint>),
        settle(client.readContract({ address: cfg.vault as `0x${string}`, abi: VAULT_READ_ABI, functionName: 'autoPlanFeeRecipient' }) as Promise<string>),
        // One extra call, for the runway projection below. Cheap next to the contract reads that
        // are already in flight, and it is the only leg of the projection that has to be live.
        settle(client.getGasPrice()),
      ]);

      // Only worth a second call when the recipient is a real, distinct address — otherwise it is
      // either unset or the relayer's balance, which is already read above.
      const recipientDistinct =
        autoPlanRecipient != null &&
        autoPlanRecipient !== ZERO_ADDRESS &&
        autoPlanRecipient.toLowerCase() !== relayer?.toLowerCase();
      const recipientBalance = recipientDistinct
        ? await settle(
            client.readContract({
              address: stable,
              abi: ERC20_ABI,
              functionName: 'balanceOf',
              args: [autoPlanRecipient as `0x${string}`],
            }) as Promise<bigint>,
          )
        : null;

      const native = nativeWei != null ? Number(formatUnits(nativeWei, 18)) : null;
      const nativeUsd = native != null && nativePrice.usd != null ? native * nativePrice.usd : null;

      // What runs here have actually cost, when any have recorded it. Otherwise what one would cost
      // right now: the chain's gas profile (measured across past runs, or its seed) at the current
      // gas price. The second is a projection and is labelled as one — but a projected runway is
      // far more use than a blank where the "top this up" signal should be.
      const recorded = spendByChain.get(chainId) ?? null;
      const projected =
        gasPriceWei != null && nativePrice.usd != null
          ? (getGasProfile(chainId).gasUnitsPerRun * Number(formatUnits(gasPriceWei, 18))) * nativePrice.usd
          : null;
      const costPerRunUsd = recorded ?? (projected && projected > 0 ? projected : null);
      const costPerRunSource: 'recorded' | 'projected' | null =
        recorded != null ? 'recorded' : costPerRunUsd != null ? 'projected' : null;

      return {
        ...base,
        relayer: {
          address: relayer,
          nativeWei: nativeWei?.toString() ?? null,
          native,
          nativeUsd,
          stableRaw: relayerStable?.toString() ?? null,
          stableUsd: toStable(relayerStable),
          isGasTankExecutor:
            gasTankExecutor == null || relayer == null
              ? null
              : gasTankExecutor.toLowerCase() === relayer.toLowerCase(),
          gasTankExecutor,
        },
        gasTank: {
          address: cfg.gasTank,
          owner: gasTankOwner,
          floatRaw: gasTankFloat?.toString() ?? null,
          floatUsd: toStable(gasTankFloat),
          priceRaw: gasTankPrice?.toString() ?? null,
          priceUsd: toStable(gasTankPrice),
        },
        vault: {
          address: cfg.vault,
          owner: vaultOwner,
          claimableRaw: claimable?.toString() ?? null,
          claimableUsd: toStable(claimable),
          feePercent: feeBps != null ? (Number(feeBps) / FEE_PRECISION) * 100 : null,
          autoPlanFeeRaw: autoPlanFee?.toString() ?? null,
          autoPlanFeeUsd: toStable(autoPlanFee),
          autoPlanFeeRecipient: autoPlanRecipient,
          autoPlanFeeRecipientBalanceRaw: recipientBalance?.toString() ?? null,
          autoPlanFeeRecipientBalanceUsd: toStable(recipientBalance),
        },
        nativePrice,
        costPerRunUsd,
        costPerRunSource,
        runwayRuns:
          nativeUsd != null && costPerRunUsd != null && costPerRunUsd > 0
            ? Math.floor(nativeUsd / costPerRunUsd)
            : null,
      };
    } catch (error) {
      return { ...base, error: error instanceof Error ? error.message : 'Failed to read network state.' };
    }
  }

  /**
   * Mean USD spend per run on each chain, from what runs there actually burned. Feeds the runway
   * figure, which is deliberately backward-looking: what the next run will cost is a separate,
   * simulated question (run-cost.ts), and mixing a projection into a "how many runs left" number
   * would make it move for reasons that have nothing to do with the balance it is about.
   */
  private async spendPerRunByChain(): Promise<Map<number, number>> {
    const runs = await this.history.getRuns(100);
    const totals = new Map<number, { usd: number; count: number }>();

    for (const run of runs) {
      for (const task of run.executedTasks ?? []) {
        const spend = spentUsdOf(task);
        if (spend == null || spend <= 0) continue;
        const bucket = totals.get(task.chainId) ?? { usd: 0, count: 0 };
        bucket.usd += spend;
        bucket.count += 1;
        totals.set(task.chainId, bucket);
      }
    }

    return new Map([...totals].map(([chainId, { usd, count }]) => [chainId, usd / count]));
  }

  /**
   * Every auto-execution in the last `runs` runs, priced on both sides, plus the daily, per-network
   * and per-token rollups the page charts.
   *
   * Aggregated on the server rather than in the browser because pricing a run means knowing each
   * chain's stablecoin decimals and its native token price — backend facts — and because the token
   * identities have to be read from the chains anyway.
   */
  async getFlows(limit = 50): Promise<TreasuryFlowsPayload> {
    const runs = await this.history.getRuns(Math.min(Math.max(limit, 1), 100));

    // Prices for the chains that appear, before anything is priced: a per-flow price lookup would
    // be dozens of identical requests, and the batched call is what keeps the feeds from 429ing.
    const chainIds = [...new Set(runs.flatMap((run) => (run.executedTasks ?? []).map((t) => t.chainId)))];
    await prefetchNativePrices(chainIds).catch(() => undefined);
    const nativeUsdByChain = new Map(
      await Promise.all(
        chainIds.map(async (chainId) => [chainId, (await getNativePriceQuote(chainId).catch(() => null))?.usd ?? null] as const),
      ),
    );

    // Today's gas price per chain, for runs recorded before the executor saved its own. Without it
    // those executions have no spend at all, and a day of them would be charted as a day that spent
    // nothing — which reads as pure profit. An approximation flagged as one is the honest answer;
    // a zero is not. Best-effort: a chain that will not answer stays unpriced and is counted.
    const gasPriceByChain = new Map(
      await Promise.all(
        chainIds.map(async (chainId) => {
          const client = this.client(chainId);
          if (!client) return [chainId, null] as const;
          const price = await client.getGasPrice().catch(() => null);
          return [chainId, price] as const;
        }),
      ),
    );

    const tokens = await getTokenMetaMap(
      runs.flatMap((run) =>
        (run.executedTasks ?? [])
          .filter((task) => task.targetToken)
          .map((task) => ({ chainId: task.chainId, address: task.targetToken as string })),
      ),
    ).catch(() => new Map<string, TokenMeta>());

    const flows: TreasuryFlow[] = [];
    for (const run of runs) {
      for (const task of run.executedTasks ?? []) {
        flows.push(this.describeFlow(run.runId, run.at, task, tokens, nativeUsdByChain, gasPriceByChain));
      }
    }
    // Newest first: the operator's first question is nearly always "what just happened".
    flows.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    return {
      flows,
      daily: rollUpDaily(flows),
      byNetwork: rollUpNetworks(flows),
      byToken: rollUpTokens(flows),
      totals: {
        runs: runs.length,
        executions: flows.length,
        freeRuns: flows.filter((f) => !f.charged).length,
        chargedUsd: total(flows, (f) => f.chargedUsd),
        spentUsd: total(flows, (f) => f.spentUsd),
        marginUsd: total(flows, (f) => f.marginUsd),
        volumeUsd: total(flows, (f) => f.amountIn),
        estimatedSpends: flows.filter((f) => f.spendEstimated && f.spentUsd != null).length,
        unpricedExecutions: flows.filter((f) => f.spentUsd == null).length,
      },
      window: {
        from: flows.length ? flows[flows.length - 1].at : null,
        to: flows.length ? flows[0].at : null,
        runs: runs.length,
      },
    };
  }

  private describeFlow(
    runId: string,
    at: string,
    task: ExecutedTask,
    tokens: Map<string, TokenMeta>,
    nativeUsdByChain: Map<number, number | null>,
    gasPriceByChain: Map<number, bigint | null>,
  ): TreasuryFlow {
    const chainId = task.chainId;
    const entry = getRegistryEntry(chainId);
    const decimals = getStableDecimals(chainId);
    const meta = task.targetToken ? tokens.get(`${chainId}:${task.targetToken.toLowerCase()}`) : undefined;

    const asStable = (raw: string | undefined) => {
      if (raw == null) return null;
      try {
        return Number(formatUnits(BigInt(raw), decimals));
      } catch {
        return null;
      }
    };

    // The charge only counts when the deduction actually landed. A run whose `recordExecution`
    // reverted did the work and collected nothing, and booking its price as revenue is precisely
    // the error that would hide the failure.
    const chargedUsd = task.gasDeducted === false ? 0 : asStable(task.costUsdc6);

    const { spentNative, spentUsd, estimated } = spendOf(
      task,
      nativeUsdByChain.get(chainId) ?? null,
      gasPriceByChain.get(chainId) ?? null,
    );

    return {
      at,
      runId,
      chainId,
      chainName: CHAIN_NAMES[chainId] ?? `Chain ${chainId}`,
      explorerUrl: entry?.explorerUrl ?? null,
      user: task.user,
      scheduleId: task.scheduleId,
      txHash: task.txHash,
      amountIn: asStable(task.amountPerIntervalUsdc6),
      // Formatted with the token's own decimals, never a presumed 18: a 6-decimal target would
      // otherwise be reported a trillion times too small and read as zero.
      amountOut:
        task.amountOutRaw != null && meta?.decimals != null
          ? safeFormat(task.amountOutRaw, meta.decimals)
          : null,
      stableSymbol: getStableSymbol(chainId),
      token: {
        address: task.targetToken ?? null,
        symbol: meta?.symbol ?? null,
        name: meta?.name ?? null,
        decimals: meta?.decimals ?? null,
        logoUrl: meta?.logoUrl ?? null,
      },
      chargedUsd,
      charged: task.gasDeducted !== false,
      chargeChainId: task.gasDeductChainId ?? null,
      spentNative,
      spentUsd,
      nativeSymbol: entry?.nativeSymbol ?? 'ETH',
      spendEstimated: estimated,
      marginUsd: chargedUsd != null && spentUsd != null ? chargedUsd - spentUsd : null,
      gasUsed: task.gasUsed ?? null,
    };
  }
}

/**
 * Native token and USD the relayer burned on one execution.
 *
 * Runs recorded since the treasury page was added carry their own `nativeSpentWei` and the native
 * price at the time, which is exact. Older records hold only `gasUsed`, so their spend is
 * reconstructed against *today's* gas price and token price — flagged `estimated`, because the gas
 * price that actually applied is gone and a reconstruction is not a measurement.
 *
 * The deduction leg is added only when it ran on the execution chain. When the tank debited was on
 * another chain the two legs are different native tokens, and its USD value is added while its
 * native amount is not — a sum of BOT and POL is a number in no currency.
 */
function spendOf(
  task: ExecutedTask,
  nativeUsdNow: number | null,
  gasPriceNowWei: bigint | null,
): { spentNative: number | null; spentUsd: number | null; estimated: boolean } {
  const wei = (raw: string | undefined) => {
    if (raw == null) return null;
    try {
      return Number(formatUnits(BigInt(raw), 18));
    } catch {
      return null;
    }
  };

  const recordedNative = wei(task.nativeSpentWei);
  const nativeUsd = task.nativeUsd ?? nativeUsdNow;

  if (recordedNative != null) {
    const sameChain = task.gasDeductChainId == null || task.gasDeductChainId === task.chainId;
    const recordNative = wei(task.recordNativeSpentWei);
    const spentNative = recordedNative + (sameChain ? (recordNative ?? 0) : 0);

    let spentUsd = nativeUsd != null ? spentNative * nativeUsd : null;
    if (!sameChain && recordNative != null && task.recordNativeUsd != null && spentUsd != null) {
      spentUsd += recordNative * task.recordNativeUsd;
    }
    return { spentNative, spentUsd, estimated: false };
  }

  // No recorded spend: reconstruct from gas used, at the run's own gas price when it has one and
  // today's otherwise. Null only when even that is impossible — an unpriced execution is reported
  // as unpriced, never folded in as a zero.
  const gasUsed = task.gasUsed != null ? Number(task.gasUsed) : null;
  const gasPriceWei =
    task.gasPriceWei != null
      ? Number(task.gasPriceWei)
      : gasPriceNowWei != null
        ? Number(gasPriceNowWei)
        : null;
  if (gasUsed == null || gasPriceWei == null || nativeUsd == null) {
    return { spentNative: null, spentUsd: null, estimated: true };
  }
  const spentNative = (gasUsed * gasPriceWei) / 1e18;
  return { spentNative, spentUsd: spentNative * nativeUsd, estimated: true };
}

/**
 * USD spend of one task, for the runway average.
 *
 * Only the exactly-recorded spend counts here, unlike the charts: the runway this feeds is labelled
 * `recorded`, and a chain whose history is all reconstructions has a live `projected` figure waiting
 * for it that is better than a reconstruction from stale gas prices.
 */
function spentUsdOf(task: ExecutedTask): number | null {
  const { spentUsd, estimated } = spendOf(task, null, null);
  return estimated ? null : spentUsd;
}

/** Base units to whole tokens. Null rather than NaN when the value is not a parseable integer. */
function safeFormat(raw: string, decimals: number): number | null {
  try {
    return Number(formatUnits(BigInt(raw), decimals));
  } catch {
    return null;
  }
}

function total(flows: TreasuryFlow[], pick: (flow: TreasuryFlow) => number | null): number {
  return flows.reduce((sum, flow) => sum + (pick(flow) ?? 0), 0);
}

/** Per-day totals, oldest first, with no gaps: a day nothing ran is a zero, not a missing point. */
function rollUpDaily(flows: TreasuryFlow[]): TreasuryFlowsPayload['daily'] {
  const byDate = new Map<
    string,
    { executions: number; chargedUsd: number; spentUsd: number; unpricedExecutions: number }
  >();
  for (const flow of flows) {
    const date = flow.at.slice(0, 10);
    const bucket = byDate.get(date) ?? { executions: 0, chargedUsd: 0, spentUsd: 0, unpricedExecutions: 0 };
    bucket.executions += 1;
    bucket.chargedUsd += flow.chargedUsd ?? 0;
    bucket.spentUsd += flow.spentUsd ?? 0;
    if (flow.spentUsd == null) bucket.unpricedExecutions += 1;
    byDate.set(date, bucket);
  }
  if (byDate.size === 0) return [];

  const dates = [...byDate.keys()].sort();
  const out: TreasuryFlowsPayload['daily'] = [];
  // Walked day by day rather than over the keys, so a quiet Sunday shows as a gap in the line
  // instead of being closed up and making the surrounding days look adjacent.
  for (let day = new Date(dates[0] + 'T00:00:00Z'); day <= new Date(dates[dates.length - 1] + 'T00:00:00Z'); day.setUTCDate(day.getUTCDate() + 1)) {
    const date = day.toISOString().slice(0, 10);
    const bucket = byDate.get(date) ?? { executions: 0, chargedUsd: 0, spentUsd: 0, unpricedExecutions: 0 };
    out.push({
      date,
      executions: bucket.executions,
      chargedUsd: bucket.chargedUsd,
      spentUsd: bucket.spentUsd,
      marginUsd: bucket.chargedUsd - bucket.spentUsd,
      unpricedExecutions: bucket.unpricedExecutions,
    });
  }
  return out;
}

function rollUpNetworks(flows: TreasuryFlow[]): TreasuryFlowsPayload['byNetwork'] {
  const byChain = new Map<number, TreasuryFlowsPayload['byNetwork'][number]>();
  for (const flow of flows) {
    const bucket = byChain.get(flow.chainId) ?? {
      chainId: flow.chainId,
      name: flow.chainName,
      nativeSymbol: flow.nativeSymbol,
      executions: 0,
      chargedUsd: 0,
      spentUsd: 0,
      marginUsd: 0,
      spentNative: 0,
      freeRuns: 0,
    };
    bucket.executions += 1;
    bucket.chargedUsd += flow.chargedUsd ?? 0;
    bucket.spentUsd += flow.spentUsd ?? 0;
    bucket.spentNative += flow.spentNative ?? 0;
    if (!flow.charged) bucket.freeRuns += 1;
    bucket.marginUsd = bucket.chargedUsd - bucket.spentUsd;
    byChain.set(flow.chainId, bucket);
  }
  return [...byChain.values()].sort((a, b) => b.executions - a.executions);
}

function rollUpTokens(flows: TreasuryFlow[]): TreasuryFlowsPayload['byToken'] {
  const byToken = new Map<string, TreasuryFlowsPayload['byToken'][number]>();
  for (const flow of flows) {
    if (!flow.token.address) continue;
    // Keyed by chain as well as address: the same address on two chains is two different tokens,
    // and one of them is usually a mock.
    const key = `${flow.chainId}:${flow.token.address.toLowerCase()}`;
    const bucket = byToken.get(key) ?? {
      address: flow.token.address,
      chainId: flow.chainId,
      chainName: flow.chainName,
      symbol: flow.token.symbol,
      name: flow.token.name,
      logoUrl: flow.token.logoUrl,
      executions: 0,
      volumeUsd: 0,
      amountOut: null,
      chargedUsd: 0,
    };
    bucket.executions += 1;
    bucket.volumeUsd += flow.amountIn ?? 0;
    bucket.chargedUsd += flow.chargedUsd ?? 0;
    // Stays null until something was recorded, so a token whose runs all predate the amount-out
    // capture reads as "not recorded" rather than as a genuine zero delivered.
    if (flow.amountOut != null) bucket.amountOut = (bucket.amountOut ?? 0) + flow.amountOut;
    byToken.set(key, bucket);
  }
  return [...byToken.values()].sort((a, b) => b.volumeUsd - a.volumeUsd);
}
