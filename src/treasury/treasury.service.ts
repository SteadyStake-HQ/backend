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

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  parseUnits,
  type PublicClient,
} from 'viem';
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

/*
 * `gasCostPerExecutionUsdc6` is deliberately absent. The contract still stores and still exposes it,
 * but nothing has read it since a run started being charged the gas it actually burned (see
 * config.ts) — and reading a dead field only to print it next to the live per-run figure gave an
 * operator two prices for the same thing, one of which no user is ever charged.
 */
const GAS_TANK_READ_ABI = [
  { type: 'function', name: 'executor', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'owner', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
] as const;

const VAULT_READ_ABI = [
  { type: 'function', name: 'owner', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'totalFeesCollected', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'feePercentage', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'additionalAutoPlanFeeUsdc6', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'autoPlanFeeRecipient', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
] as const;

const VAULT_WRITE_ABI = [
  { type: 'function', name: 'setFeePercentage', inputs: [{ name: 'newFee', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'setAdditionalAutoPlanFeeUsdc6', inputs: [{ name: 'feeUsdc6', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
] as const;

/**
 * The fee ceiling the contract enforces, in its own unit of hundredths of a percent, and the scale
 * it divides by. Mirrored from DCAVault.sol (MAX_FEE, FEE_PRECISION) so a rejected value is caught
 * here with a sentence rather than as an opaque revert.
 */
const MAX_FEE_BPS = 500;

/**
 * The early-cancellation fee, as a percentage.
 *
 * A `constant` in DCAVault.sol, which means it is compiled into every deployed vault's bytecode and
 * there is no setter for it — not a permission this backend lacks, but a function that does not
 * exist. Surfaced here so the dashboard can state the real figure and say plainly that changing it
 * needs a contract change and a redeployment, rather than offering an input that cannot work.
 */
const EARLY_CANCEL_FEE_PERCENT = 3;
/** Remaining balance above this share of the original total still counts as an early exit. */
const EARLY_CANCEL_THRESHOLD_PERCENT = 50;

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
  };

  vault: {
    address: string | null;
    owner: string | null;
    /** Swap + early-cancel fees accrued in the vault, withdrawable by the owner. */
    claimableRaw: string | null;
    claimableUsd: number | null;
    /** Swap fee, as a percentage (0.25 means 0.25%). */
    feePercent: number | null;
    /** The ceiling `setFeePercentage` enforces, as a percentage. */
    maxFeePercent: number;
    /** Compiled into the bytecode; reported so the page can show it and explain why it is fixed. */
    earlyCancelFeePercent: number;
    earlyCancelThresholdPercent: number;
    /**
     * True when the relayer key this backend holds is the vault's owner, i.e. when the fee editors
     * on the dashboard can actually work. Null when either address is unknown.
     */
    ownedByRelayer: boolean | null;
    /** Flat fee for a user's second and later auto plans. */
    autoPlanFeeRaw: string | null;
    autoPlanFeeUsd: number | null;
    autoPlanFeeRecipient: string | null;
    /** The recipient's own stablecoin balance, when it is an address distinct from the relayer. */
    autoPlanFeeRecipientBalanceRaw: string | null;
    autoPlanFeeRecipientBalanceUsd: number | null;
  };

  nativePrice: NativePriceQuote;

  /**
   * How many more runs the relayer's native balance covers on this chain: the balance divided by
   * `costPerRunUsd`, which is an *average* run and not a price anybody sets. There is no per-run
   * price left to divide by — the contract's is dead and unread (see GAS_TANK_READ_ABI above) — so
   * this figure moves with what runs here have really been costing, which is the point of it.
   */
  runwayRuns: number | null;
  /** The average per-run cost behind `runwayRuns`, USD. */
  costPerRunUsd: number | null;
  /**
   * Where that average came from. `recorded` is the mean of what runs on this chain actually
   * burned; `projected` multiplies the chain's gas profile by its gas price right now, which is
   * what a run *would* cost rather than what one did. Reported so the UI never presents the second
   * as the first. Null when neither could be worked out.
   */
  costPerRunSource: 'recorded' | 'projected' | null;

  error: string | null;
}

/**
 * One leg of what an execution burned: gas paid on one chain, in that chain's own native token.
 *
 * A run is two transactions and they are not always on the same chain — the swap runs where the
 * plan lives, the GasTank deduction runs wherever the user's balance happens to be. Reporting them
 * as one number was the bug this shape exists to prevent: a BSC run whose tank was debited on BOT
 * Chain showed "$0.0213 spent" against a BSC transaction that cost $0.0112, because $0.0101 of BOT
 * gas had been folded in with no way to see it.
 */
export interface TreasurySpendLeg {
  /** What this leg paid for. */
  kind: 'swap' | 'record';
  chainId: number;
  chainName: string;
  nativeSymbol: string;
  explorerUrl: string | null;
  /** Native token burned, in whole tokens of *this leg's* chain. */
  native: number | null;
  usd: number | null;
  gasUsed: string | null;
  /** True when `native` was reconstructed from gas used rather than recorded by the run. */
  estimated: boolean;
  /**
   * True when `usd` uses the token's price *now* rather than the price the run recorded. The native
   * amount is still exact; only its dollar value moved. Reported separately from `estimated`
   * because the two are different claims and only one of them is about the gas.
   */
  repriced: boolean;
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
  /**
   * Chain whose GasTank was actually debited — which is where the relayer's stablecoin fee landed,
   * and not always the chain the swap ran on. Null when the deduction did not land.
   */
  chargeChainId: number | null;
  chargeChainName: string | null;
  /** True when the fee was collected on a different chain from the one that burned the gas. */
  settledCrossChain: boolean;

  /**
   * Every leg of gas this execution burned, each on its own chain in its own token. The swap leg is
   * always present; the record leg only when the deduction landed.
   */
  spend: TreasurySpendLeg[];

  /**
   * Native burned *on the execution chain*, in that chain's token. A cross-chain deduction is
   * deliberately excluded — a sum of BNB and BOT is a number in no currency. Use `spend` for the
   * full picture and `spentUsd` for the total.
   */
  spentNative: number | null;
  /** Every leg's USD added together: the true all-in cost of this execution. */
  spentUsd: number | null;
  nativeSymbol: string;
  /** True when any leg's native amount was reconstructed from gas used rather than recorded. */
  spendEstimated: boolean;
  /** True when any leg's USD had to use today's token price instead of the run's own. */
  spendRepriced: boolean;

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
  /**
   * Per network, from the point of view of the wallet on it — which is the only view that answers
   * "does this chain pay for itself".
   *
   * Both sides are booked to the chain the money actually moved on, not to the chain the plan ran
   * on. A BSC execution settled on BOT Chain puts its BSC gas on BSC and its stablecoin fee on BOT;
   * booking the fee to BSC (as this used to) showed a profitable BSC wallet whose balance never
   * moved, and a BOT wallet that appeared to earn nothing while collecting all the revenue.
   */
  byNetwork: Array<{
    chainId: number;
    name: string;
    nativeSymbol: string;
    /** Executions whose swap ran here. */
    executions: number;
    /** Fees collected into the relayer's wallet *on this chain*, whoever's run earned them. */
    chargedUsd: number;
    /** Deductions that landed on this chain, including those for runs executed elsewhere. */
    settlements: number;
    /** Gas burned on this chain, in USD — swap legs that ran here plus record legs that settled here. */
    spentUsd: number;
    /** The same, in this chain's own native token. Coherent now that only this chain's legs are in it. */
    spentNative: number;
    /** chargedUsd − spentUsd: what the wallet on this chain earned net, over the window. */
    marginUsd: number;
    /** Executions that ran here but were paid for by a tank on another chain. */
    settledAway: number;
    freeRuns: number;
  }>;
  /**
   * Executions whose gas and whose income landed on different chains, grouped by the pair. Empty
   * when every run settled where it ran — which is the case the page should not spend space on.
   */
  byRoute: Array<{
    execChainId: number;
    execChainName: string;
    settleChainId: number;
    settleChainName: string;
    executions: number;
    /** Stablecoin collected on the settle chain. */
    chargedUsd: number;
    /** Gas burned on the execution chain, USD, and in its own token. */
    execGasUsd: number;
    execGasNative: number;
    execNativeSymbol: string;
    /** Gas burned on the settle chain running the deduction, USD, and in its own token. */
    settleGasUsd: number;
    settleGasNative: number;
    settleNativeSymbol: string;
    marginUsd: number;
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
    /**
     * Executions whose gas is exact but whose dollar value uses today's token price, because the
     * run recorded no price of its own. Counted apart from `estimatedSpends`: the gas is a
     * measurement in both cases, and only the conversion moved.
     */
    repricedSpends: number;
    /** Executions whose spend could not be worked out at all, even approximately. */
    unpricedExecutions: number;
  };
  window: { from: string | null; to: string | null; runs: number };
  /** Runs on record that executed something — the ceiling the window sizes are measured against. */
  totalExecutingRuns: number;
  /**
   * What each selectable window actually contains, so the history picker can say so instead of
   * offering three indistinguishable run counts. Derived from one read of the largest window, so
   * describing all three costs nothing beyond the read the request already makes.
   */
  windowOptions: Array<{
    runs: number;
    /** Runs actually available at this size — smaller than `runs` before enough have accumulated. */
    availableRuns: number;
    executions: number;
    from: string | null;
    to: string | null;
  }>;
}

/**
 * The windows the dashboard offers, counted in runs that *executed* something. The largest is also
 * the cap this API enforces.
 *
 * Deliberately not counted in runs. The scheduler sweeps every few seconds and records the sweep
 * whether or not a plan was due, so around 99 in 100 rows execute nothing: "the last 100 runs" was
 * about nine minutes of clock time and usually held no execution at all. An execution was saved
 * correctly and still left the page within minutes of happening — the record was never lost, the
 * window had simply moved past it. Counting executing runs makes the largest window reach the
 * whole history instead of the last few minutes of idling.
 */
const WINDOW_SIZES = [50, 250, 1000] as const;

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
      gasTank: { address: cfg?.gasTank ?? null, owner: null, floatRaw: null, floatUsd: null },
      vault: {
        address: cfg?.vault ?? null,
        owner: null,
        claimableRaw: null,
        claimableUsd: null,
        feePercent: null,
        maxFeePercent: (MAX_FEE_BPS / FEE_PRECISION) * 100,
        earlyCancelFeePercent: EARLY_CANCEL_FEE_PERCENT,
        earlyCancelThresholdPercent: EARLY_CANCEL_THRESHOLD_PERCENT,
        ownedByRelayer: null,
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
        },
        vault: {
          address: cfg.vault,
          owner: vaultOwner,
          claimableRaw: claimable?.toString() ?? null,
          claimableUsd: toStable(claimable),
          feePercent: feeBps != null ? (Number(feeBps) / FEE_PRECISION) * 100 : null,
          maxFeePercent: (MAX_FEE_BPS / FEE_PRECISION) * 100,
          earlyCancelFeePercent: EARLY_CANCEL_FEE_PERCENT,
          earlyCancelThresholdPercent: EARLY_CANCEL_THRESHOLD_PERCENT,
          ownedByRelayer:
            vaultOwner == null || relayer == null
              ? null
              : vaultOwner.toLowerCase() === relayer.toLowerCase(),
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
  /* ==========================================================================================
     Fee writes

     These are the only calls in this service that change anything. Each one follows the same
     three steps, in this order, and none of them is optional:

       1. **Check the signer owns the vault.** `onlyOwner` reverts otherwise, and "execution
          reverted" tells an operator nothing about which of the several possible causes it was.
       2. **Simulate.** The contract's own `require` is the authority on what it will accept; a
          simulation surfaces that as its real message before any gas is spent.
       3. **Wait for the receipt, and re-read.** A submitted transaction is not a changed fee. The
          value returned is the one read back from the chain afterwards, so the dashboard shows
          what is true rather than what was asked for.
     ========================================================================================== */

  /** Set DCAVault.feePercentage. `percent` is a percentage: 0.25 means 0.25%. */
  async setSwapFeePercent(chainId: number, percent: number) {
    if (percent > (MAX_FEE_BPS / FEE_PRECISION) * 100) {
      throw new BadRequestException({
        ok: false,
        error: `The vault caps its swap fee at ${(MAX_FEE_BPS / FEE_PRECISION) * 100}%; ${percent}% would revert.`,
      });
    }

    // The contract's unit is hundredths of a percent, and it takes a uint — a fraction of one is
    // not representable, so it is refused here rather than silently rounded to a different fee.
    const bps = percent * FEE_PRECISION / 100;
    if (!Number.isInteger(bps)) {
      throw new BadRequestException({
        ok: false,
        error:
          `The vault stores this fee in hundredths of a percent, so ${percent}% cannot be set exactly. ` +
          `Use a multiple of 0.01% (for example ${(Math.round(bps) / 100).toFixed(2)}%).`,
      });
    }

    const { hash } = await this.writeToVault(chainId, 'setFeePercentage', [BigInt(bps)]);
    const after = await this.readVaultNumber(chainId, 'feePercentage');
    return {
      ok: true,
      chainId,
      txHash: hash,
      /** Read back from the chain, not echoed from the request. */
      feePercent: after != null ? (Number(after) / FEE_PRECISION) * 100 : null,
    };
  }

  /** Set DCAVault.additionalAutoPlanFeeUsdc6. `usd` is whole stablecoin: 10 means $10. */
  async setAutoPlanFeeUsd(chainId: number, usd: number) {
    // Scaled by the chain's own stablecoin decimals rather than a fixed 1e6: the contract transfers
    // this amount of the settlement token directly, and on BSC that token has 18 decimals. The
    // `Usdc6` in the field name predates per-chain decimals and is a misnomer (see config.ts).
    const decimals = getStableDecimals(chainId);
    let raw: bigint;
    try {
      raw = parseUnits(String(usd), decimals);
    } catch {
      throw new BadRequestException({
        ok: false,
        error: `${usd} is not a valid amount for a ${decimals}-decimal token.`,
      });
    }

    const { hash } = await this.writeToVault(chainId, 'setAdditionalAutoPlanFeeUsdc6', [raw]);
    const after = await this.readVaultNumber(chainId, 'additionalAutoPlanFeeUsdc6');
    return {
      ok: true,
      chainId,
      txHash: hash,
      autoPlanFeeUsd: after != null ? Number(formatUnits(after, decimals)) : null,
    };
  }

  /** Sign, simulate and send one owner-only vault call. Throws with a readable reason on any leg. */
  private async writeToVault(
    chainId: number,
    functionName: 'setFeePercentage' | 'setAdditionalAutoPlanFeeUsdc6',
    args: readonly [bigint],
  ): Promise<{ hash: string }> {
    const pk = process.env.RELAYER_PRIVATE_KEY?.trim();
    if (!pk) {
      throw new BadRequestException({
        ok: false,
        error: 'RELAYER_PRIVATE_KEY is not set on this backend, so nothing here can sign a transaction.',
      });
    }

    const cfg = getVaultUsdcGasTank(chainId);
    const rpc = getRpc(chainId);
    const chain = getChain(chainId);
    if (!cfg || !rpc || !chain) {
      throw new BadRequestException({
        ok: false,
        error: `Chain ${chainId} has no deployed vault or no RPC configured.`,
      });
    }

    const account = privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`);
    const vault = cfg.vault as `0x${string}`;
    const publicClient = createPublicClient({ chain, transport: http(rpc, { timeout: RPC_TIMEOUT_MS }) });
    const walletClient = createWalletClient({ account, chain, transport: http(rpc, { timeout: RPC_TIMEOUT_MS }) });

    const owner = (await publicClient
      .readContract({ address: vault, abi: VAULT_READ_ABI, functionName: 'owner' })
      .catch(() => null)) as string | null;
    if (owner && owner.toLowerCase() !== account.address.toLowerCase()) {
      throw new BadRequestException({
        ok: false,
        error:
          `This backend signs as ${account.address}, but the vault on chain ${chainId} is owned by ` +
          `${owner}. Only the owner can change its fees, so this change has to be sent from that key.`,
      });
    }

    try {
      await publicClient.simulateContract({ account, address: vault, abi: VAULT_WRITE_ABI, functionName, args });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new BadRequestException({ ok: false, error: `The vault refused this change: ${reason}` });
    }

    const hash = await walletClient.writeContract({ address: vault, abi: VAULT_WRITE_ABI, functionName, args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new BadRequestException({
        ok: false,
        error: `The transaction reverted on chain (${hash}). The fee is unchanged.`,
      });
    }

    // The cached wallet payload now describes a vault that no longer exists as described.
    this.walletsCache = null;
    this.logger.log(`${functionName}(${args[0]}) on chain ${chainId} confirmed in ${hash}.`);
    return { hash };
  }

  private async readVaultNumber(
    chainId: number,
    functionName: 'feePercentage' | 'additionalAutoPlanFeeUsdc6',
  ): Promise<bigint | null> {
    const cfg = getVaultUsdcGasTank(chainId);
    const client = this.client(chainId);
    if (!cfg || !client) return null;
    return (await client
      .readContract({ address: cfg.vault as `0x${string}`, abi: VAULT_READ_ABI, functionName })
      .catch(() => null)) as bigint | null;
  }

  private async spendPerRunByChain(): Promise<Map<number, number>> {
    // Executing runs only. Asking for the last 100 rows meant 100 idle sweeps with no task in them,
    // so `recorded` was always empty and every chain's runway silently fell back to a projection.
    const runs = await this.history.getRunsWithExecutions(100);
    const totals = new Map<number, { usd: number; count: number }>();

    for (const run of runs) {
      for (const task of run.executedTasks ?? []) {
        // Both chains a run can touch, so the deduction's gas counts towards the runway of the
        // wallet that actually paid it.
        const touched = new Set([task.chainId, task.gasDeductChainId ?? task.chainId]);
        for (const chainId of touched) {
          const spend = spentUsdOfLegsOn(task, chainId);
          if (spend == null || spend <= 0) continue;
          const bucket = totals.get(chainId) ?? { usd: 0, count: 0 };
          bucket.usd += spend;
          bucket.count += 1;
          totals.set(chainId, bucket);
        }
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
    const size = Math.min(Math.max(limit, 1), WINDOW_SIZES[WINDOW_SIZES.length - 1]);

    // The largest window is read whatever was asked for, and the requested one is a slice of it.
    // That is one query either way, and it is what lets the history picker describe every option
    // rather than presenting three run counts that mean nothing until one is chosen.
    //
    // Executing runs only — see WINDOW_SIZES. Idle sweeps contribute nothing to any figure on this
    // page and, being ~99% of the table, are the entire reason a real execution used to scroll out
    // of view minutes after it was recorded.
    const [allRuns, totalExecutingRuns] = await Promise.all([
      this.history.getRunsWithExecutions(WINDOW_SIZES[WINDOW_SIZES.length - 1]),
      this.history.countRunsWithExecutions().catch(() => 0),
    ]);
    const runs = allRuns.slice(0, size);

    // Prices for the chains that appear, before anything is priced: a per-flow price lookup would
    // be dozens of identical requests, and the batched call is what keeps the feeds from 429ing.
    //
    // Deduct chains are in the set as well as execution chains. They are usually the same, but when
    // they are not, the deduction's own chain is the only thing that can price its gas — and without
    // it that leg used to be dropped silently, understating the run's cost by however much the
    // deduction burned.
    const chainIds = [
      ...new Set(
        runs.flatMap((run) =>
          (run.executedTasks ?? []).flatMap((t) =>
            t.gasDeductChainId != null && t.gasDeductChainId !== t.chainId
              ? [t.chainId, t.gasDeductChainId]
              : [t.chainId],
          ),
        ),
      ),
    ];
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
      byRoute: rollUpRoutes(flows),
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
        repricedSpends: flows.filter((f) => !f.spendEstimated && f.spendRepriced && f.spentUsd != null).length,
        unpricedExecutions: flows.filter((f) => f.spentUsd == null).length,
      },
      window: {
        from: flows.length ? flows[flows.length - 1].at : null,
        to: flows.length ? flows[0].at : null,
        runs: runs.length,
      },
      totalExecutingRuns,
      windowOptions: WINDOW_SIZES.map((windowSize) => {
        // Every run in `allRuns` executed something, so the slice and its span are the same set —
        // no second filter is needed to keep the dates off runs that found nothing due.
        const slice = allRuns.slice(0, windowSize);
        return {
          runs: windowSize,
          availableRuns: slice.length,
          executions: slice.reduce((sum, run) => sum + (run.executedTasks ?? []).length, 0),
          from: slice.length ? slice[slice.length - 1].at : null,
          to: slice.length ? slice[0].at : null,
        };
      }),
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

    const spend = spendLegs(task, nativeUsdByChain, gasPriceByChain);
    const swapLeg = spend.find((leg) => leg.kind === 'swap') ?? null;

    // Only the execution chain's own token, so this stays an amount of one currency. The record
    // leg joins it only when it ran on the same chain and is therefore the same token.
    const sameChainLegs = spend.filter((leg) => leg.chainId === chainId && leg.native != null);
    const spentNative = sameChainLegs.length ? sameChainLegs.reduce((sum, leg) => sum + (leg.native ?? 0), 0) : null;

    // Null only when nothing could be priced at all. A leg that priced contributes even if the
    // other did not — an execution with a known half-cost is not an execution that cost nothing.
    const pricedLegs = spend.filter((leg) => leg.usd != null);
    const spentUsd = pricedLegs.length ? pricedLegs.reduce((sum, leg) => sum + (leg.usd ?? 0), 0) : null;

    const chargeChainId = task.gasDeductChainId ?? null;

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
      chargeChainId,
      chargeChainName: chargeChainId != null ? (CHAIN_NAMES[chargeChainId] ?? `Chain ${chargeChainId}`) : null,
      settledCrossChain: chargeChainId != null && chargeChainId !== chainId,
      spend,
      spentNative,
      spentUsd,
      nativeSymbol: entry?.nativeSymbol ?? 'ETH',
      spendEstimated: spend.some((leg) => leg.estimated),
      spendRepriced: spend.some((leg) => leg.repriced),
      marginUsd: chargedUsd != null && spentUsd != null ? chargedUsd - spentUsd : null,
      gasUsed: swapLeg?.gasUsed ?? task.gasUsed ?? null,
    };
  }
}

/** Wei to whole native tokens. Null rather than NaN when the value is not a parseable integer. */
function fromWei(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  try {
    return Number(formatUnits(BigInt(raw), 18));
  } catch {
    return null;
  }
}

/**
 * Every leg of gas one execution burned, each attributed to the chain that actually burned it.
 *
 * A run is two transactions. The swap runs on the plan's chain; `recordExecution` runs on whichever
 * chain holds the user's gas tank balance, which is frequently a *different* chain. Those two legs
 * are then different native tokens at different prices, and the only correct way to report them is
 * separately — which is what this returns, instead of one number that silently spans two chains.
 *
 * Each leg is priced from the run's own record where it has one. Runs predating that carry only
 * `gasUsed`, so their amount is reconstructed at today's gas price and flagged `estimated`; a leg
 * whose token price was missing at execution time is priced at today's and flagged `repriced`. The
 * two flags are kept apart because they are different claims: one is about the gas, one about the
 * dollars.
 */
function spendLegs(
  task: ExecutedTask,
  nativeUsdByChain: Map<number, number | null>,
  gasPriceByChain: Map<number, bigint | null>,
): TreasurySpendLeg[] {
  const describe = (chainId: number, kind: 'swap' | 'record'): Omit<TreasurySpendLeg, 'native' | 'usd' | 'gasUsed' | 'estimated' | 'repriced'> => {
    const entry = getRegistryEntry(chainId);
    return {
      kind,
      chainId,
      chainName: CHAIN_NAMES[chainId] ?? `Chain ${chainId}`,
      nativeSymbol: entry?.nativeSymbol ?? 'ETH',
      explorerUrl: entry?.explorerUrl ?? null,
    };
  };

  /** One leg, from whichever of its three possible records survived. */
  const leg = (
    chainId: number,
    kind: 'swap' | 'record',
    spentWei: string | undefined,
    gasUsedRaw: string | undefined,
    gasPriceRaw: string | undefined,
    recordedPriceUsd: number | undefined,
  ): TreasurySpendLeg | null => {
    const gasUsed = gasUsedRaw != null ? Number(gasUsedRaw) : null;

    let native = fromWei(spentWei);
    let estimated = false;
    if (native == null) {
      // Reconstructed: the leg's own gas price when it recorded one, today's otherwise.
      const gasPriceWei =
        gasPriceRaw != null
          ? Number(gasPriceRaw)
          : gasPriceByChain.get(chainId) != null
            ? Number(gasPriceByChain.get(chainId))
            : null;
      if (gasUsed == null || gasPriceWei == null) return null;
      native = (gasUsed * gasPriceWei) / 1e18;
      estimated = true;
    }

    // The price the run recorded is the right one; today's is the fallback, and saying so is the
    // difference between an exact figure and one that moved with the market since.
    const priceNow = nativeUsdByChain.get(chainId) ?? null;
    const priceUsd = recordedPriceUsd ?? priceNow;
    const repriced = recordedPriceUsd == null && priceNow != null;

    return {
      ...describe(chainId, kind),
      native,
      usd: priceUsd != null ? native * priceUsd : null,
      gasUsed: gasUsedRaw ?? null,
      estimated,
      repriced,
    };
  };

  const legs: TreasurySpendLeg[] = [];

  const swap = leg(task.chainId, 'swap', task.nativeSpentWei, task.gasUsed, task.gasPriceWei, task.nativeUsd);
  if (swap) legs.push(swap);

  // The deduction leg exists only when the deduction landed — a reverted `recordExecution` burned
  // no gas that the run kept a record of, and inventing one would overstate a run that was free.
  const recordChainId = task.gasDeductChainId ?? task.chainId;
  if (task.recordNativeSpentWei != null || task.recordGasUsed != null) {
    const record = leg(
      recordChainId,
      'record',
      task.recordNativeSpentWei,
      task.recordGasUsed,
      task.recordGasPriceWei,
      // `recordNativeUsd` is only written when the deduct chain differed; on a same-chain deduction
      // the execution chain's own recorded price is the price of this leg too.
      recordChainId === task.chainId ? task.nativeUsd : task.recordNativeUsd,
    );
    if (record) legs.push(record);
  }

  return legs;
}

/**
 * USD a task burned *on `chainId`*, for that chain's runway average.
 *
 * Only the exactly-recorded spend counts here, unlike the charts: the runway this feeds is labelled
 * `recorded`, and a chain whose history is all reconstructions has a live `projected` figure waiting
 * for it that is better than a reconstruction from stale gas prices.
 *
 * Attributed by leg, so a run executed on BSC and settled on BOT Chain contributes its BSC gas to
 * BSC's runway and its BOT gas to BOT's. Charging the whole cross-chain cost to the execution chain
 * shortened its runway by a spend its wallet never made, and left the chain that did make it
 * reporting a runway longer than the balance supports.
 */
function spentUsdOfLegsOn(task: ExecutedTask, chainId: number): number | null {
  const priced = (spentWei: string | undefined, priceUsd: number | undefined) => {
    const native = fromWei(spentWei);
    return native != null && priceUsd != null && priceUsd > 0 ? native * priceUsd : null;
  };

  let total: number | null = null;
  const add = (value: number | null) => {
    if (value != null) total = (total ?? 0) + value;
  };

  if (task.chainId === chainId) add(priced(task.nativeSpentWei, task.nativeUsd));

  const recordChainId = task.gasDeductChainId ?? task.chainId;
  if (recordChainId === chainId) {
    add(priced(task.recordNativeSpentWei, recordChainId === task.chainId ? task.nativeUsd : task.recordNativeUsd));
  }
  return total;
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

/**
 * Per network, booked to where the money moved rather than to where the plan ran.
 *
 * Gas follows the leg that burned it; the fee follows the tank that was debited. A chain therefore
 * appears here if it executed anything *or* if it settled anything, and its margin is the honest
 * answer to "did the wallet on this chain earn more than it spent" — which is the question the
 * relayer cards further down the page are about, and which the old execution-chain attribution
 * could not answer.
 */
function rollUpNetworks(flows: TreasuryFlow[]): TreasuryFlowsPayload['byNetwork'] {
  const byChain = new Map<number, TreasuryFlowsPayload['byNetwork'][number]>();
  const bucketFor = (chainId: number, name: string, nativeSymbol: string) => {
    let bucket = byChain.get(chainId);
    if (!bucket) {
      bucket = {
        chainId,
        name,
        nativeSymbol,
        executions: 0,
        chargedUsd: 0,
        settlements: 0,
        spentUsd: 0,
        spentNative: 0,
        marginUsd: 0,
        settledAway: 0,
        freeRuns: 0,
      };
      byChain.set(chainId, bucket);
    }
    return bucket;
  };

  for (const flow of flows) {
    const executed = bucketFor(flow.chainId, flow.chainName, flow.nativeSymbol);
    executed.executions += 1;
    if (!flow.charged) executed.freeRuns += 1;
    if (flow.settledCrossChain) executed.settledAway += 1;

    // Gas, leg by leg. `spentNative` is only ever added to its own chain's bucket, so it stays an
    // amount of that chain's token rather than a sum across two.
    for (const legSpend of flow.spend) {
      const bucket = bucketFor(legSpend.chainId, legSpend.chainName, legSpend.nativeSymbol);
      bucket.spentUsd += legSpend.usd ?? 0;
      bucket.spentNative += legSpend.native ?? 0;
    }

    // The fee, to whichever wallet received it.
    if (flow.charged && flow.chargedUsd) {
      const settleChainId = flow.chargeChainId ?? flow.chainId;
      const settle = bucketFor(
        settleChainId,
        flow.chargeChainName ?? CHAIN_NAMES[settleChainId] ?? `Chain ${settleChainId}`,
        getRegistryEntry(settleChainId)?.nativeSymbol ?? 'ETH',
      );
      settle.chargedUsd += flow.chargedUsd;
      settle.settlements += 1;
    }
  }

  for (const bucket of byChain.values()) bucket.marginUsd = bucket.chargedUsd - bucket.spentUsd;

  // Executions first, then settlement-only chains — which are real rows, not noise: a chain that
  // collects every fee and runs nothing is exactly the situation this rollup exists to surface.
  return [...byChain.values()].sort(
    (a, b) => b.executions - a.executions || b.settlements - a.settlements,
  );
}

/** Cross-chain pairs only: where the gas was burned against where the fee was collected. */
function rollUpRoutes(flows: TreasuryFlow[]): TreasuryFlowsPayload['byRoute'] {
  const byPair = new Map<string, TreasuryFlowsPayload['byRoute'][number]>();

  for (const flow of flows) {
    if (!flow.settledCrossChain || flow.chargeChainId == null) continue;
    const key = `${flow.chainId}:${flow.chargeChainId}`;
    const swap = flow.spend.find((leg) => leg.kind === 'swap');
    const record = flow.spend.find((leg) => leg.kind === 'record');

    const bucket = byPair.get(key) ?? {
      execChainId: flow.chainId,
      execChainName: flow.chainName,
      settleChainId: flow.chargeChainId,
      settleChainName: flow.chargeChainName ?? CHAIN_NAMES[flow.chargeChainId] ?? `Chain ${flow.chargeChainId}`,
      executions: 0,
      chargedUsd: 0,
      execGasUsd: 0,
      execGasNative: 0,
      execNativeSymbol: swap?.nativeSymbol ?? flow.nativeSymbol,
      settleGasUsd: 0,
      settleGasNative: 0,
      settleNativeSymbol: record?.nativeSymbol ?? '',
      marginUsd: 0,
    };

    bucket.executions += 1;
    bucket.chargedUsd += flow.chargedUsd ?? 0;
    bucket.execGasUsd += swap?.usd ?? 0;
    bucket.execGasNative += swap?.native ?? 0;
    bucket.settleGasUsd += record?.usd ?? 0;
    bucket.settleGasNative += record?.native ?? 0;
    if (record?.nativeSymbol) bucket.settleNativeSymbol = record.nativeSymbol;
    bucket.marginUsd = bucket.chargedUsd - bucket.execGasUsd - bucket.settleGasUsd;
    byPair.set(key, bucket);
  }

  return [...byPair.values()].sort((a, b) => b.executions - a.executions);
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
