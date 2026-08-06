/**
 * The shape of the contract-balance report, shared by the service, the controllers and the page.
 *
 * The vocabulary here is deliberately about *custody* rather than about tokens. An operator looking
 * at this page is not asking "how much USDC is on chain 968" — they are asking "how much of this is
 * mine to take, and how much of it am I holding for somebody else". Those two questions have very
 * different answers on the same balance, and a report that only totalled tokens would let an
 * operator drain user float believing it was revenue. Every holding therefore carries its custody
 * class, and the totals are cut by that class before they are cut by anything else.
 */

/**
 * Who a balance actually belongs to.
 *
 * - `user-float`      — users' money the protocol is holding. Never withdrawable by an operator.
 * - `protocol-revenue`— fees the protocol has earned and may take.
 * - `stranded`        — sitting in a contract with no code path that can move it out.
 * - `pass-through`    — a contract that never holds value; any balance here is an accident.
 * - `operator-wallet` — the deployer/treasury EOA's own holdings, shown for context.
 */
export type CustodyClass =
  | 'user-float'
  | 'protocol-revenue'
  | 'stranded'
  | 'pass-through'
  | 'operator-wallet';

/** One token (or the native coin) held by one contract on one chain. */
export interface ContractHolding {
  /** Token contract, or null for the chain's native coin. */
  token: string | null;
  symbol: string;
  decimals: number;
  /** Base units as a string — a uint256 does not survive JSON as a number. */
  raw: string | null;
  /** Human amount. Null when the read failed. */
  amount: number | null;
  usd: number | null;
  custody: CustodyClass;
  /**
   * True only when a function in the *deployed bytecode* can move this balance to the admin.
   * Never a statement about what a redeployed contract could do.
   */
  withdrawable: boolean;
  /** The call that would move it, e.g. "withdrawFees()". Set iff `withdrawable`. */
  withdrawMethod: string | null;
  /** Why it cannot be moved. Set iff not `withdrawable`. */
  lockedReason: string | null;
}

/** A contract's identity, its accounting reads, and everything it holds. */
export interface ContractBalance {
  /** Stable slug: 'gasTank', 'dcaVault', 'checkout', … Used by the withdraw endpoint. */
  key: string;
  label: string;
  address: string;
  /** One line on what users put in here, so the page does not need a lookup table. */
  role: string;
  /** Owner / admin as the chain reports it, when the contract exposes one. */
  owner: string | null;
  /** True when this backend's signing key is that owner — i.e. it could withdraw. */
  ownedBySigner: boolean | null;
  holdings: ContractHolding[];
  heldUsd: number;
  withdrawableUsd: number;
  /** Contract-specific extras the page shows inline (treasury address, executor, …). */
  notes: { label: string; value: string | null; warn?: boolean }[];
  error: string | null;
}

export interface NetworkBalances {
  chainId: number;
  key: string;
  name: string;
  type: 'mainnet' | 'testnet';
  status: string;
  explorerUrl: string | null;
  nativeSymbol: string;
  nativeUsd: number | null;
  stableSymbol: string;
  stableAddress: string | null;
  stableDecimals: number;
  contracts: ContractBalance[];
  totals: BalanceTotals;
  /**
   * How many balance reads on this chain came back empty-handed.
   *
   * Carried separately from `error` because a partly-readable chain is the common case, not a
   * failure: a rate-limiting public RPC answers `getBalance` and refuses `balanceOf`. Without this
   * count the totals below would present a failed read as a confident $0.00, which is the one
   * wrong answer an operator would act on.
   */
  unreadable: number;
  error: string | null;
}

export interface BalanceTotals {
  heldUsd: number;
  withdrawableUsd: number;
  userFloatUsd: number;
  strandedUsd: number;
}

export interface BalancesPayload {
  /** The deployer / main admin wallet every withdrawal lands in. */
  admin: string | null;
  adminConfigured: boolean;
  networks: NetworkBalances[];
  analytics: BalanceAnalytics;
  updatedAt: string;
}

/**
 * Rollups of the *current* balances — no time series.
 *
 * Mainnet and testnet are summed apart and never added together. A testnet stablecoin is minted
 * freely from a faucet, so folding 9,959,648 test USDC into a treasury total would produce a
 * headline figure that is not merely wrong but actively misleading.
 */
export interface BalanceAnalytics {
  mainnet: BalanceTotals & { networks: number };
  testnet: BalanceTotals & { networks: number };
  byNetwork: (BalanceTotals & {
    chainId: number;
    name: string;
    type: 'mainnet' | 'testnet';
    contracts: number;
  })[];
  /** Same money cut by contract type instead of by chain — "how much is in gas tanks, everywhere". */
  byContract: (BalanceTotals & { key: string; label: string; deployments: number })[];
  /** The custody split, which is the only breakdown that answers "what may I take". */
  byCustody: { custody: CustodyClass; label: string; usd: number; share: number }[];
  /** Things an operator should look at: stranded funds, unclaimed revenue, misconfiguration. */
  alerts: { level: 'warn' | 'info'; chainId: number | null; message: string }[];
}
