/**
 * What every deployed contract is holding, on every network it is deployed to — and which of it an
 * operator is actually allowed to take.
 *
 * This is a different question from the one TreasuryService answers. That service is about the
 * *relayer wallet*: can it still pay for runs, what has it collected, what does it cost per
 * execution. This one is about the *contracts*: an operator asking "where is the money, and how
 * much of it is mine" needs one page that reads every deployment on every chain and says so.
 *
 * Two rules shape the whole module.
 *
 * 1. **A balance is not revenue until the contract says it is.** GasTank's USDC is users' prepaid
 *    gas; DCAVault's USDC is users' in-flight deposits *plus* `totalFeesCollected`. Only the second
 *    is the protocol's. Every holding is therefore tagged with a custody class, and the withdrawable
 *    total is built from that tag rather than from the token balance.
 *
 * 2. **`withdrawable` describes the deployed bytecode, never an intention.** GasTank has no owner
 *    sweep and the swap adapters have no rescue function; anything sitting in them that is not owed
 *    to a user is stranded, and the honest thing to show is "stranded", not a disabled button that
 *    implies a redeploy is imminent. Adding those functions is a contract change with its own
 *    review — this page reports the chain as it is.
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createPublicClient, createWalletClient, formatUnits, http, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  CHAIN_NAMES,
  getAllNetworks,
  getRpc,
  getStableDecimals,
  getStableSymbol,
} from '../config';
import { getChain } from '../run-executor';
import { getGameContracts } from '../game-contracts';
import { getNativePriceQuote, prefetchNativePrices } from '../native-price';
import { getRegistryEntry } from '../networks/network-registry';
import { NetworkAllocationService } from '../networks/network-allocation.service';
import type {
  BalanceAnalytics,
  BalanceTotals,
  BalancesPayload,
  ContractBalance,
  ContractHolding,
  CustodyClass,
  NetworkBalances,
} from './contract-balances.types';

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;

const GAS_TANK_ABI = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'executor', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

const VAULT_ABI = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'totalFeesCollected', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'withdrawFees', stateMutability: 'nonpayable', inputs: [], outputs: [] },
] as const;

const CHECKOUT_ABI = [
  { type: 'function', name: 'treasury', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'stablecoin', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
] as const;

const RPC_TIMEOUT_MS = 9_000;
const CACHE_TTL_MS = 30_000;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Custody labels for the analytics breakdown, in the order the page stacks them. */
const CUSTODY_LABELS: Record<CustodyClass, string> = {
  'protocol-revenue': 'Protocol revenue (withdrawable)',
  'user-float': 'User float (owed to users)',
  stranded: 'Stranded (no withdrawal path)',
  'pass-through': 'Pass-through (should be empty)',
  'operator-wallet': 'Operator wallet',
};

const EMPTY_TOTALS = (): BalanceTotals => ({
  heldUsd: 0,
  withdrawableUsd: 0,
  userFloatUsd: 0,
  strandedUsd: 0,
});

@Injectable()
export class ContractBalancesService {
  private readonly logger = new Logger(ContractBalancesService.name);
  private cache: { at: number; payload: BalancesPayload } | null = null;
  private inFlight: Promise<BalancesPayload> | null = null;

  constructor(private readonly networks: NetworkAllocationService) {}

  /**
   * The deployer / main admin wallet.
   *
   * Every withdrawal this service can perform lands here, and not by choice: `DCAVault.withdrawFees`
   * transfers to `msg.sender`, so the destination *is* the signing key. An operator who wants the
   * money somewhere else moves it on from this wallet — the contract offers no recipient argument,
   * and pretending otherwise in the API would be a lie the chain would then contradict.
   */
  adminAddress(): `0x${string}` | null {
    const pk = process.env.RELAYER_PRIVATE_KEY?.trim();
    if (!pk) return null;
    try {
      return privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`).address;
    } catch {
      this.logger.warn('RELAYER_PRIVATE_KEY is set but is not a valid private key.');
      return null;
    }
  }

  async getBalances(forceRefresh = false): Promise<BalancesPayload> {
    if (!forceRefresh && this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) {
      return this.cache.payload;
    }
    if (!forceRefresh && this.inFlight) return this.inFlight;

    this.inFlight = this.read()
      .then((payload) => {
        this.cache = { at: Date.now(), payload };
        return payload;
      })
      .catch((error) => {
        // Serving a stale read beats an error page: an operator watching a balance move is better
        // served by a figure half a minute old than by nothing at all.
        if (this.cache) return this.cache.payload;
        throw error;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  /** Drop the cache. Called after any write so the next read reflects it. */
  invalidate(): void {
    this.cache = null;
  }

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  private async read(): Promise<BalancesPayload> {
    const admin = this.adminAddress();

    // Every chain with a deployment record, not just the ones with a GasTank: the point of the page
    // is to find money in places nobody is looking, and a chain excluded from the list is exactly
    // where that money would sit unnoticed.
    const chainIds = getAllNetworks()
      .map((n) => n.chainId)
      .sort((a, b) => a - b);

    // One batched price request rather than one per chain — the free CoinGecko tier answers the
    // first few and rate-limits the rest.
    await prefetchNativePrices(chainIds).catch(() => undefined);

    const allocations = await this.networks
      .listNetworks()
      .then((list) => new Map(list.map((n) => [n.chainId, n])))
      .catch(() => new Map<number, { status: string; executable: boolean; type: 'mainnet' | 'testnet' }>());

    const networks = await Promise.all(
      chainIds.map((chainId) => this.readNetwork(chainId, admin, allocations)),
    );

    return {
      admin,
      adminConfigured: admin != null,
      networks,
      analytics: buildAnalytics(networks),
      updatedAt: new Date().toISOString(),
    };
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

  private async readNetwork(
    chainId: number,
    admin: `0x${string}` | null,
    allocations: Map<number, { status: string; executable: boolean; type: 'mainnet' | 'testnet' }>,
  ): Promise<NetworkBalances> {
    const entry = getRegistryEntry(chainId);
    const allocation = allocations.get(chainId);
    const deployment = getAllNetworks().find((n) => n.chainId === chainId);
    const game = getGameContracts(chainId);
    const stableAddress = deployment?.contracts.USDC ?? null;
    const stableDecimals = getStableDecimals(chainId);

    const nativeUsd = await getNativePriceQuote(chainId)
      .then((quote) => quote.usd)
      .catch(() => null);

    const base: NetworkBalances = {
      chainId,
      key: entry?.key ?? `chain-${chainId}`,
      name: CHAIN_NAMES[chainId] ?? `Chain ${chainId}`,
      type: allocation?.type ?? entry?.type ?? 'mainnet',
      status: allocation?.status ?? 'enabled',
      explorerUrl: entry?.explorerUrl ?? null,
      nativeSymbol: entry?.nativeSymbol ?? 'ETH',
      nativeUsd,
      stableSymbol: getStableSymbol(chainId),
      stableAddress,
      stableDecimals,
      contracts: [],
      totals: EMPTY_TOTALS(),
      unreadable: 0,
      error: null,
    };

    const client = this.client(chainId);
    if (!client) return { ...base, error: 'No RPC configured for this chain.' };

    /** A balance read that never rejects — one dead contract must not blank the whole network. */
    const stableBalance = async (address: string): Promise<bigint | null> => {
      if (!stableAddress) return null;
      return client
        .readContract({
          address: stableAddress as `0x${string}`,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [address as `0x${string}`],
        })
        .catch(() => null) as Promise<bigint | null>;
    };
    const nativeBalance = (address: string) =>
      client.getBalance({ address: address as `0x${string}` }).catch(() => null);
    const read = <T>(promise: Promise<T>): Promise<T | null> => promise.catch(() => null);

    const toStableUsd = (raw: bigint | null) =>
      raw == null ? null : Number(formatUnits(raw, stableDecimals));
    const toNativeUsd = (raw: bigint | null) =>
      raw == null || nativeUsd == null ? null : Number(formatUnits(raw, 18)) * nativeUsd;

    const contracts: ContractBalance[] = [];

    /** Native dust in a contract that has no `receive()` — always stranded when non-zero. */
    const nativeDust = (raw: bigint | null): ContractHolding[] => {
      if (raw == null || raw === 0n) return [];
      return [
        {
          token: null,
          symbol: base.nativeSymbol,
          decimals: 18,
          raw: raw.toString(),
          amount: Number(formatUnits(raw, 18)),
          usd: toNativeUsd(raw),
          custody: 'stranded',
          withdrawable: false,
          withdrawMethod: null,
          lockedReason: 'This contract has no payable receive() and no rescue function.',
        },
      ];
    };

    // ---- GasTank ----------------------------------------------------------
    const gasTank = deployment?.contracts.GasTank;
    if (gasTank && gasTank !== ZERO_ADDRESS) {
      const [float, native, owner, executor] = await Promise.all([
        stableBalance(gasTank),
        nativeBalance(gasTank),
        read(client.readContract({ address: gasTank as `0x${string}`, abi: GAS_TANK_ABI, functionName: 'owner' })),
        read(client.readContract({ address: gasTank as `0x${string}`, abi: GAS_TANK_ABI, functionName: 'executor' })),
      ]);

      contracts.push(
        finalise({
          key: 'gasTank',
          label: 'Gas Tank',
          address: gasTank,
          role: 'Users prepay execution gas here; the relayer draws it down per run.',
          owner: (owner as string) ?? null,
          ownedBySigner: ownedBy(owner as string | null, admin),
          holdings: [
            {
              token: stableAddress,
              symbol: base.stableSymbol,
              decimals: stableDecimals,
              raw: float?.toString() ?? null,
              amount: toStableUsd(float),
              usd: toStableUsd(float),
              custody: 'user-float',
              withdrawable: false,
              withdrawMethod: null,
              lockedReason:
                'Users’ prepaid gas. GasTank has no owner sweep — withdraw() only moves the ' +
                'caller’s own balance — so no admin key can move this, by design.',
            },
            ...nativeDust(native),
          ],
          notes: [
            { label: 'Executor', value: (executor as string) ?? null, warn: !sameAddress(executor as string | null, admin) },
          ],
          error: null,
        }),
      );
    }

    // ---- DCAVault ---------------------------------------------------------
    const vault = deployment?.contracts.DCAVault;
    if (vault && vault !== ZERO_ADDRESS) {
      const [held, native, owner, fees] = await Promise.all([
        stableBalance(vault),
        nativeBalance(vault),
        read(client.readContract({ address: vault as `0x${string}`, abi: VAULT_ABI, functionName: 'owner' })),
        read(client.readContract({ address: vault as `0x${string}`, abi: VAULT_ABI, functionName: 'totalFeesCollected' })),
      ]);

      // The vault's token balance is user deposits *and* accrued fees in one pot; only the fee
      // counter is the protocol's. Splitting them here is what stops the page from inviting an
      // operator to "withdraw" a figure that includes somebody's pending DCA capital.
      const feeRaw = (fees as bigint | null) ?? null;
      const depositRaw = held != null && feeRaw != null ? clampZero(held - feeRaw) : null;

      contracts.push(
        finalise({
          key: 'dcaVault',
          label: 'DCA Vault',
          address: vault,
          role: 'Holds users’ DCA capital and accrues the protocol swap fee.',
          owner: (owner as string) ?? null,
          ownedBySigner: ownedBy(owner as string | null, admin),
          holdings: [
            {
              token: stableAddress,
              symbol: base.stableSymbol,
              decimals: stableDecimals,
              raw: feeRaw?.toString() ?? null,
              amount: toStableUsd(feeRaw),
              usd: toStableUsd(feeRaw),
              custody: 'protocol-revenue',
              withdrawable: (feeRaw ?? 0n) > 0n && ownedBy(owner as string | null, admin) === true,
              withdrawMethod: 'withdrawFees()',
              lockedReason:
                (feeRaw ?? 0n) > 0n && ownedBy(owner as string | null, admin) !== true
                  ? 'This backend’s key is not the vault owner, so it cannot call withdrawFees().'
                  : null,
            },
            {
              token: stableAddress,
              symbol: base.stableSymbol,
              decimals: stableDecimals,
              raw: depositRaw?.toString() ?? null,
              amount: toStableUsd(depositRaw),
              usd: toStableUsd(depositRaw),
              custody: 'user-float',
              withdrawable: false,
              withdrawMethod: null,
              lockedReason:
                'Users’ DCA capital awaiting execution. withdrawFees() takes only the fee ' +
                'counter and cannot reach this.',
            },
            ...nativeDust(native),
          ],
          notes: [],
          error: null,
        }),
      );
    }

    // ---- Swap adapter / resolver (transient by design) ---------------------
    for (const [key, label, address, role] of [
      ['swapAdapter', 'Swap Adapter', deployment?.contracts.ZeroExAdapter, 'Routes a swap mid-execution; holds nothing between runs.'],
      ['resolver', 'DCA Resolver', deployment?.contracts.DCAResolver, 'Read-only schedule checker; never custodies funds.'],
    ] as const) {
      if (!address || address === ZERO_ADDRESS) continue;
      const [held, native] = await Promise.all([stableBalance(address), nativeBalance(address)]);
      const holdings: ContractHolding[] = [];
      if ((held ?? 0n) > 0n) {
        holdings.push({
          token: stableAddress,
          symbol: base.stableSymbol,
          decimals: stableDecimals,
          raw: held!.toString(),
          amount: toStableUsd(held),
          usd: toStableUsd(held),
          custody: 'stranded',
          withdrawable: false,
          withdrawMethod: null,
          lockedReason:
            'This contract has no owner and no rescue function. Anything left here after a failed ' +
            'or partial swap cannot be recovered by any key.',
        });
      }
      holdings.push(...nativeDust(native));
      contracts.push(
        finalise({
          key,
          label,
          address,
          role,
          owner: null,
          ownedBySigner: null,
          holdings,
          notes: [],
          error: null,
        }),
      );
    }

    // ---- Game Pass checkout ----------------------------------------------
    const checkout = game?.checkout;
    if (checkout) {
      const token = checkout.address;
      const [treasury, held, native, paused] = await Promise.all([
        read(client.readContract({ address: token, abi: CHECKOUT_ABI, functionName: 'treasury' })),
        read(
          client.readContract({
            address: checkout.stablecoin,
            abi: ERC20_ABI,
            functionName: 'balanceOf',
            args: [token],
          }),
        ) as Promise<bigint | null>,
        nativeBalance(token),
        read(client.readContract({ address: token, abi: CHECKOUT_ABI, functionName: 'paused' })),
      ]);

      const treasuryAddress = (treasury as string | null) ?? null;
      const treasuryHeld = treasuryAddress
        ? ((await read(
            client.readContract({
              address: checkout.stablecoin,
              abi: ERC20_ABI,
              functionName: 'balanceOf',
              args: [treasuryAddress as `0x${string}`],
            }),
          )) as bigint | null)
        : null;

      const toCheckoutUsd = (raw: bigint | null) =>
        raw == null ? null : Number(formatUnits(raw, checkout.decimals));

      const holdings: ContractHolding[] = [];
      if ((held ?? 0n) > 0n) {
        holdings.push({
          token: checkout.stablecoin,
          symbol: 'USDC',
          decimals: checkout.decimals,
          raw: held!.toString(),
          amount: toCheckoutUsd(held),
          usd: toCheckoutUsd(held),
          custody: 'stranded',
          withdrawable: false,
          withdrawMethod: null,
          lockedReason:
            'buyPass() forwards payment straight to the treasury, so this contract should hold ' +
            'nothing. A non-zero balance was sent here directly and there is no sweep to recover it.',
        });
      }
      holdings.push(...nativeDust(native));

      // Two distinct failure modes, and the operator has to be able to tell them apart:
      // a treasury equal to the buyer makes every purchase revert (the balance delta is zero), and
      // a treasury set to a burn address makes every purchase succeed into nothing.
      const notes: { label: string; value: string | null; warn?: boolean }[] = [
        {
          label: 'Treasury',
          value: isDeadAddress(treasuryAddress)
            ? `${treasuryAddress} — a burn address: purchases succeed and the payment is destroyed`
            : treasuryAddress,
          warn: isDeadAddress(treasuryAddress),
        },
        {
          label: 'Treasury balance',
          value:
            treasuryHeld != null
              ? `${formatUnits(treasuryHeld, checkout.decimals)} USDC`
              : null,
        },
      ];
      if (paused === true) notes.push({ label: 'Status', value: 'Paused — purchases blocked', warn: true });
      if (sameAddress(treasuryAddress, admin)) {
        notes.push({
          label: 'Config',
          value: 'Treasury is the admin/relayer wallet — that wallet cannot buy a pass',
          warn: true,
        });
      }

      contracts.push(
        finalise({
          key: 'checkout',
          label: 'Game Pass Checkout',
          address: token,
          role: 'Takes Game Pass payments and forwards them to the treasury in the same call.',
          owner: treasuryAddress,
          ownedBySigner: null,
          holdings,
          notes,
          error: null,
        }),
      );
    }

    // ---- Season reward NFT / capacity verifier -----------------------------
    for (const [key, label, address, role] of [
      ['seasonRewardNft', 'Season Reward NFT', game?.seasonRewardNft?.address, 'Mints soulbound season cards; takes no payment.'],
      ['capacityVerifier', 'Capacity Verifier', game?.capacityVerifier?.address, 'Verifies EIP-712 capacity permits; takes no payment.'],
    ] as const) {
      if (!address) continue;
      const [held, native] = await Promise.all([stableBalance(address), nativeBalance(address)]);
      const holdings: ContractHolding[] = [];
      if ((held ?? 0n) > 0n) {
        holdings.push({
          token: stableAddress,
          symbol: base.stableSymbol,
          decimals: stableDecimals,
          raw: held!.toString(),
          amount: toStableUsd(held),
          usd: toStableUsd(held),
          custody: 'stranded',
          withdrawable: false,
          withdrawMethod: null,
          lockedReason: 'This contract has no token-handling code and no rescue function.',
        });
      }
      holdings.push(...nativeDust(native));
      // Only surfaced when it is actually holding something — a page listing six always-empty rows
      // per chain buries the two rows that matter.
      if (holdings.length === 0) continue;
      contracts.push(
        finalise({ key, label, address, role, owner: null, ownedBySigner: null, holdings, notes: [], error: null }),
      );
    }

    // ---- The admin wallet itself ------------------------------------------
    if (admin) {
      const [native, stable] = await Promise.all([nativeBalance(admin), stableBalance(admin)]);
      contracts.push(
        finalise({
          key: 'adminWallet',
          label: 'Deployer / Admin Wallet',
          address: admin,
          role: 'Where every withdrawal lands, and the key that pays for execution gas.',
          owner: admin,
          ownedBySigner: true,
          holdings: [
            {
              token: null,
              symbol: base.nativeSymbol,
              decimals: 18,
              raw: native?.toString() ?? null,
              amount: native != null ? Number(formatUnits(native, 18)) : null,
              usd: toNativeUsd(native),
              custody: 'operator-wallet',
              withdrawable: false,
              withdrawMethod: null,
              lockedReason: 'Already in the admin wallet.',
            },
            {
              token: stableAddress,
              symbol: base.stableSymbol,
              decimals: stableDecimals,
              raw: stable?.toString() ?? null,
              amount: toStableUsd(stable),
              usd: toStableUsd(stable),
              custody: 'operator-wallet',
              withdrawable: false,
              withdrawMethod: null,
              lockedReason: 'Already in the admin wallet.',
            },
          ],
          notes: [],
          error: null,
        }),
      );
    }

    return {
      ...base,
      contracts,
      totals: sumTotals(contracts),
      unreadable: contracts.reduce(
        (count, contract) => count + contract.holdings.filter((h) => h.raw == null).length,
        0,
      ),
    };
  }

  // ---------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------

  /**
   * Withdraw one contract's protocol revenue to the admin wallet.
   *
   * Only `dcaVault` is accepted, and that is not an oversight: it is the only deployed contract with
   * a function that moves value to an admin. The endpoint refuses anything else by name rather than
   * silently succeeding on a no-op, so a caller cannot come away believing a gas tank was swept.
   *
   * The sequence — ownership check, simulate, send, wait, re-read — is the same one the fee setters
   * use, and for the same reason: "execution reverted" tells an operator nothing about which of the
   * several possible causes it was.
   */
  async withdraw(chainId: number, contractKey: string): Promise<{
    ok: true;
    chainId: number;
    contract: string;
    txHash: string;
    withdrawnUsd: number;
    to: string;
    remainingUsd: number;
  }> {
    if (contractKey !== 'dcaVault') {
      throw new BadRequestException({
        ok: false,
        error:
          `"${contractKey}" has no withdrawal function in its deployed bytecode. Only the DCA Vault ` +
          `exposes one (withdrawFees()). Gas Tank balances are users’ prepaid gas and the swap ` +
          `adapters have no rescue function, so nothing on this backend can move either.`,
      });
    }

    const pk = process.env.RELAYER_PRIVATE_KEY?.trim();
    if (!pk) {
      throw new BadRequestException({
        ok: false,
        error: 'RELAYER_PRIVATE_KEY is not set on this backend, so nothing here can sign a transaction.',
      });
    }

    const deployment = getAllNetworks().find((n) => n.chainId === chainId);
    const vault = deployment?.contracts.DCAVault;
    const rpc = getRpc(chainId);
    const chain = getChain(chainId);
    if (!vault || vault === ZERO_ADDRESS || !rpc || !chain) {
      throw new BadRequestException({
        ok: false,
        error: `Chain ${chainId} has no deployed DCA Vault or no RPC configured.`,
      });
    }

    const account = privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`);
    const address = vault as `0x${string}`;
    const publicClient = createPublicClient({ chain, transport: http(rpc, { timeout: RPC_TIMEOUT_MS }) });
    const walletClient = createWalletClient({ account, chain, transport: http(rpc, { timeout: RPC_TIMEOUT_MS }) });
    const decimals = getStableDecimals(chainId);

    const owner = (await publicClient
      .readContract({ address, abi: VAULT_ABI, functionName: 'owner' })
      .catch(() => null)) as string | null;
    if (owner && owner.toLowerCase() !== account.address.toLowerCase()) {
      throw new BadRequestException({
        ok: false,
        error:
          `This backend signs as ${account.address}, but the vault on chain ${chainId} is owned by ` +
          `${owner}. withdrawFees() is onlyOwner, so it has to be sent from that key.`,
      });
    }

    const before = (await publicClient
      .readContract({ address, abi: VAULT_ABI, functionName: 'totalFeesCollected' })
      .catch(() => null)) as bigint | null;
    if (before == null) {
      throw new BadRequestException({
        ok: false,
        error: `Could not read totalFeesCollected on chain ${chainId}; refusing to send blind.`,
      });
    }
    if (before === 0n) {
      throw new BadRequestException({
        ok: false,
        error: `There are no collected fees to withdraw on chain ${chainId}.`,
      });
    }

    try {
      await publicClient.simulateContract({ account, address, abi: VAULT_ABI, functionName: 'withdrawFees' });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new BadRequestException({ ok: false, error: `The vault refused this withdrawal: ${reason}` });
    }

    const hash = await walletClient.writeContract({ address, abi: VAULT_ABI, functionName: 'withdrawFees' });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new BadRequestException({
        ok: false,
        error: `The transaction reverted on chain (${hash}). Nothing was withdrawn.`,
      });
    }

    // Read back rather than assume: the figure shown is the one the chain agrees with.
    const after = (await publicClient
      .readContract({ address, abi: VAULT_ABI, functionName: 'totalFeesCollected' })
      .catch(() => null)) as bigint | null;

    this.invalidate();
    this.logger.log(
      `withdrawFees() on chain ${chainId} confirmed in ${hash}: ${formatUnits(before, decimals)} to ${account.address}.`,
    );

    return {
      ok: true,
      chainId,
      contract: contractKey,
      txHash: hash,
      withdrawnUsd: Number(formatUnits(before, decimals)),
      to: account.address,
      remainingUsd: after != null ? Number(formatUnits(after, decimals)) : 0,
    };
  }

  /**
   * Withdraw collected fees on every chain that has any.
   *
   * Sent one chain at a time rather than in parallel: these are transactions from a single EOA, and
   * firing them concurrently races them onto the same nonce, which drops all but one.
   */
  async withdrawAll(): Promise<{
    ok: true;
    results: ({ chainId: number } & ({ ok: true; txHash: string; withdrawnUsd: number } | { ok: false; error: string }))[];
    totalUsd: number;
  }> {
    const payload = await this.getBalances(true);
    const candidates = payload.networks.filter((network) =>
      network.contracts.some((c) => c.key === 'dcaVault' && c.withdrawableUsd > 0),
    );

    const results: ({ chainId: number } & ({ ok: true; txHash: string; withdrawnUsd: number } | { ok: false; error: string }))[] = [];
    let totalUsd = 0;

    for (const network of candidates) {
      try {
        const result = await this.withdraw(network.chainId, 'dcaVault');
        totalUsd += result.withdrawnUsd;
        results.push({ chainId: network.chainId, ok: true, txHash: result.txHash, withdrawnUsd: result.withdrawnUsd });
      } catch (error) {
        const message =
          error instanceof BadRequestException
            ? ((error.getResponse() as { error?: string })?.error ?? error.message)
            : error instanceof Error
              ? error.message
              : String(error);
        results.push({ chainId: network.chainId, ok: false, error: message });
      }
    }

    this.invalidate();
    return { ok: true, results, totalUsd };
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function clampZero(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function ownedBy(owner: string | null, admin: string | null): boolean | null {
  if (owner == null || admin == null) return null;
  return owner.toLowerCase() === admin.toLowerCase();
}

/** 0x0 and the conventional burn address both mean "payments here are gone". */
function isDeadAddress(address: string | null): boolean {
  if (!address) return false;
  const lower = address.toLowerCase();
  return lower === ZERO_ADDRESS || /^0x0*dead$/.test(lower);
}

/** Fill in a contract's derived totals from its holdings. */
function finalise(contract: Omit<ContractBalance, 'heldUsd' | 'withdrawableUsd'>): ContractBalance {
  const heldUsd = contract.holdings.reduce((sum, h) => sum + (h.usd ?? 0), 0);
  const withdrawableUsd = contract.holdings.reduce(
    (sum, h) => sum + (h.withdrawable ? (h.usd ?? 0) : 0),
    0,
  );
  return { ...contract, heldUsd, withdrawableUsd };
}

/**
 * Totals over a set of contracts.
 *
 * The admin wallet is excluded from every figure. It is shown on the page for context — an operator
 * needs to see the gas balance next to the contracts it serves — but it is not held *by* the
 * protocol, and adding it to "total held" would double-count every withdrawal the moment it landed.
 */
function sumTotals(contracts: ContractBalance[]): BalanceTotals {
  const totals = EMPTY_TOTALS();
  for (const contract of contracts) {
    if (contract.key === 'adminWallet') continue;
    for (const holding of contract.holdings) {
      const usd = holding.usd ?? 0;
      totals.heldUsd += usd;
      if (holding.withdrawable) totals.withdrawableUsd += usd;
      if (holding.custody === 'user-float') totals.userFloatUsd += usd;
      if (holding.custody === 'stranded' || holding.custody === 'pass-through') totals.strandedUsd += usd;
    }
  }
  return totals;
}

function addTotals(into: BalanceTotals, from: BalanceTotals): void {
  into.heldUsd += from.heldUsd;
  into.withdrawableUsd += from.withdrawableUsd;
  into.userFloatUsd += from.userFloatUsd;
  into.strandedUsd += from.strandedUsd;
}

function buildAnalytics(networks: NetworkBalances[]): BalanceAnalytics {
  const mainnet = { ...EMPTY_TOTALS(), networks: 0 };
  const testnet = { ...EMPTY_TOTALS(), networks: 0 };

  for (const network of networks) {
    const bucket = network.type === 'mainnet' ? mainnet : testnet;
    addTotals(bucket, network.totals);
    bucket.networks += 1;
  }

  const byNetwork = networks
    .map((network) => ({
      chainId: network.chainId,
      name: network.name,
      type: network.type,
      contracts: network.contracts.filter((c) => c.key !== 'adminWallet').length,
      ...network.totals,
    }))
    .sort((a, b) => b.heldUsd - a.heldUsd || a.chainId - b.chainId);

  // Cut by contract type instead of by chain: "how much is in gas tanks everywhere" is the question
  // that decides whether a float looks healthy, and it is invisible in a per-chain table.
  const contractBuckets = new Map<string, BalanceTotals & { key: string; label: string; deployments: number }>();
  const custody = new Map<CustodyClass, number>();

  for (const network of networks) {
    for (const contract of network.contracts) {
      if (contract.key === 'adminWallet') continue;
      const bucket =
        contractBuckets.get(contract.key) ??
        { key: contract.key, label: contract.label, deployments: 0, ...EMPTY_TOTALS() };
      bucket.deployments += 1;
      bucket.heldUsd += contract.heldUsd;
      bucket.withdrawableUsd += contract.withdrawableUsd;
      for (const holding of contract.holdings) {
        const usd = holding.usd ?? 0;
        if (holding.custody === 'user-float') bucket.userFloatUsd += usd;
        if (holding.custody === 'stranded' || holding.custody === 'pass-through') bucket.strandedUsd += usd;
        custody.set(holding.custody, (custody.get(holding.custody) ?? 0) + usd);
      }
      contractBuckets.set(contract.key, bucket);
    }
  }

  const custodyTotal = [...custody.values()].reduce((sum, usd) => sum + usd, 0);
  const byCustody = (Object.keys(CUSTODY_LABELS) as CustodyClass[])
    .map((key) => ({
      custody: key,
      label: CUSTODY_LABELS[key],
      usd: custody.get(key) ?? 0,
      share: custodyTotal > 0 ? ((custody.get(key) ?? 0) / custodyTotal) * 100 : 0,
    }))
    .filter((row) => row.usd > 0);

  return {
    mainnet,
    testnet,
    byNetwork,
    byContract: [...contractBuckets.values()].sort((a, b) => b.heldUsd - a.heldUsd),
    byCustody,
    alerts: buildAlerts(networks),
  };
}

/** The short list of things worth acting on, so an operator does not have to scan every card. */
function buildAlerts(networks: NetworkBalances[]): BalanceAnalytics['alerts'] {
  const alerts: BalanceAnalytics['alerts'] = [];

  for (const network of networks) {
    if (network.error) {
      alerts.push({ level: 'warn', chainId: network.chainId, message: `${network.name}: ${network.error}` });
      continue;
    }
    // Said before anything else about this chain: every figure below it is a floor, not a total.
    if (network.unreadable > 0) {
      alerts.push({
        level: 'warn',
        chainId: network.chainId,
        message:
          `${network.name}: ${network.unreadable} balance read(s) failed — its RPC refused them. ` +
          `The totals shown for this network are a lower bound, not a complete figure.`,
      });
    }
    for (const contract of network.contracts) {
      if (contract.key === 'adminWallet') continue;

      const stranded = contract.holdings
        .filter((h) => h.custody === 'stranded' || h.custody === 'pass-through')
        .reduce((sum, h) => sum + (h.usd ?? 0), 0);
      if (stranded > 0) {
        alerts.push({
          level: 'warn',
          chainId: network.chainId,
          message:
            `${network.name}: ${formatUsd(stranded)} is stranded in ${contract.label} ` +
            `(${contract.address}) with no code path to recover it.`,
        });
      }
      if (contract.withdrawableUsd > 0) {
        alerts.push({
          level: 'info',
          chainId: network.chainId,
          message: `${network.name}: ${formatUsd(contract.withdrawableUsd)} of protocol revenue is ready to withdraw from ${contract.label}.`,
        });
      }
      for (const note of contract.notes) {
        if (note.warn) {
          alerts.push({
            level: 'warn',
            chainId: network.chainId,
            message: `${network.name} — ${contract.label}: ${note.label} ${note.value ?? 'unset'}.`,
          });
        }
      }
    }
  }

  return alerts;
}

function formatUsd(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}
