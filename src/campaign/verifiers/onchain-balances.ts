/**
 * The "Record On-Chain" holding missions: `onchain_hold_bot`, `onchain_hold_usdt` and the
 * `onchain_bot_usdt_ready` bonus that requires both at the same instant (campaign spec §4.1–§4.3).
 *
 * These are the missions the spec is most specific about, and the reason is anti-abuse: §10 says "do
 * not trust wallet-provided balance values from the frontend". So both balances are read here, from
 * the campaign chain's own RPC, in a single multicall-free pair of reads against the block the node
 * currently considers latest. The connected wallet address is the only input the client supplies, and
 * it has already been proved by a signature before this runs.
 *
 * WHY BOTH BALANCES COME FROM ONE READ. `onchain_bot_usdt_ready` pays for holding both "at the same
 * verification point". Reading BOT now and USDT thirty seconds later would let a wallet with enough
 * for one of them satisfy both by moving funds between two calls. `readBalances` therefore pins a
 * block number from the first call and reads the second `at` that block, so the pair is a single
 * observation of one state rather than two observations of two.
 */
import { createPublicClient, http, type PublicClient } from 'viem';
import { getRpc } from '../../config';
import { getChain } from '../../run-executor';
import { campaignChainId, campaignStableToken } from '../campaign-config';
import { met, notMet, unavailable, type VerifierResult } from './verifier-types';

/** Just `balanceOf`; nothing else about the stablecoin is needed to score a holding. */
const ERC20_BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

const SOURCE_NATIVE = 'botchain_rpc:native_balance';
const SOURCE_ERC20 = 'botchain_rpc:erc20_balance';

export interface WalletBalances {
  chainId: number;
  blockNumber: bigint;
  /** Native BOT, in wei. */
  native: bigint;
  /** The configured stablecoin, in its own base units. Null when no token is configured. */
  stable: bigint | null;
  stableSymbol: string | null;
  stableDecimals: number | null;
}

function client(chainId: number): PublicClient | null {
  const chain = getChain(chainId);
  const rpc = getRpc(chainId);
  if (!chain || !rpc) return null;
  return createPublicClient({ chain, transport: http(rpc) }) as PublicClient;
}

/**
 * Both balances for one wallet, as one observation of one block.
 *
 * Returns null when the chain is unreachable, which every caller must treat as "cannot tell" rather
 * than "holds nothing" — see verifier-types.ts.
 */
export async function readBalances(wallet: string): Promise<WalletBalances | null> {
  const chainId = campaignChainId();
  const rpc = client(chainId);
  if (!rpc) return null;

  const address = wallet.toLowerCase() as `0x${string}`;
  const token = campaignStableToken();

  try {
    // The block is pinned from this first call and reused below, so both readings describe the same
    // chain state even if a block lands between them.
    const blockNumber = await rpc.getBlockNumber();
    const native = await rpc.getBalance({ address, blockNumber });

    let stable: bigint | null = null;
    if (token) {
      stable = (await rpc.readContract({
        address: token.address,
        abi: ERC20_BALANCE_ABI,
        functionName: 'balanceOf',
        args: [address],
        blockNumber,
      })) as bigint;
    }

    return {
      chainId,
      blockNumber,
      native,
      stable,
      stableSymbol: token?.symbol ?? null,
      stableDecimals: token?.decimals ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * `onchain_hold_bot` — native BOT at or above the threshold.
 *
 * The threshold is compared with `>=`, matching the spec's `BOT balance >= 1 BOT`. Note that a wallet
 * holding exactly 1 BOT and nothing more will satisfy this mission but cannot then pay gas for the
 * purchase itself, which is why the campaign copy says "1 BOT plus gas" — the same caveat v2's
 * on-chain holding bonus carried, for the same reason.
 */
export function verifyHoldBot(balances: WalletBalances | null, thresholdWei: string): VerifierResult {
  if (!balances) {
    return unavailable(SOURCE_NATIVE, 'Could not reach BOT Chain to read this wallet’s balance. Try again.');
  }

  const threshold = BigInt(thresholdWei);
  const detail = {
    balanceWei: balances.native.toString(),
    thresholdWei,
    blockNumber: balances.blockNumber.toString(),
  };

  if (balances.native >= threshold) {
    return met(SOURCE_NATIVE, `block:${balances.blockNumber}`, detail);
  }
  return notMet(
    SOURCE_NATIVE,
    // Whole BOT, floored — a progress bar reading "0 of 1" is more honest than "0.94 of 1" rounding up.
    { current: Number(balances.native / 10n ** 16n) / 100, target: Number(threshold / 10n ** 16n) / 100 },
    detail,
  );
}

/**
 * `onchain_hold_usdt` — the configured stablecoin at or above the threshold.
 *
 * Unavailable rather than failed when no token is configured for the campaign chain: a mission about
 * holding USDT cannot be judged without knowing which contract is USDT here, and guessing an address
 * would score a wallet's holding of something else entirely.
 */
export function verifyHoldStable(balances: WalletBalances | null, thresholdBaseUnits: string): VerifierResult {
  if (!balances) {
    return unavailable(SOURCE_ERC20, 'Could not reach BOT Chain to read this wallet’s balance. Try again.');
  }
  if (balances.stable === null) {
    return unavailable(
      SOURCE_ERC20,
      'The stablecoin for this network is not configured yet, so this mission cannot be checked.',
    );
  }

  const threshold = BigInt(thresholdBaseUnits);
  const decimals = balances.stableDecimals ?? 6;
  const scale = 10n ** BigInt(decimals);
  const detail = {
    balance: balances.stable.toString(),
    threshold: thresholdBaseUnits,
    symbol: balances.stableSymbol,
    decimals,
    blockNumber: balances.blockNumber.toString(),
  };

  if (balances.stable >= threshold) {
    return met(SOURCE_ERC20, `block:${balances.blockNumber}`, detail);
  }
  return notMet(
    SOURCE_ERC20,
    { current: Number((balances.stable * 100n) / scale) / 100, target: Number((threshold * 100n) / scale) / 100 },
    detail,
  );
}

/**
 * `onchain_bot_usdt_ready` — both minimums, at one verification point.
 *
 * Takes the same `WalletBalances` the two individual missions were scored from, which is what makes
 * "at the same time" true by construction rather than by a comment.
 */
export function verifyBotAndStableReady(
  balances: WalletBalances | null,
  botThresholdWei: string,
  stableThresholdBaseUnits: string,
): VerifierResult {
  if (!balances) {
    return unavailable(
      'botchain_rpc:both_balances',
      'Could not reach BOT Chain to read this wallet’s balances. Try again.',
    );
  }
  if (balances.stable === null) {
    return unavailable(
      'botchain_rpc:both_balances',
      'The stablecoin for this network is not configured yet, so this mission cannot be checked.',
    );
  }

  const botOk = balances.native >= BigInt(botThresholdWei);
  const stableOk = balances.stable >= BigInt(stableThresholdBaseUnits);
  const detail = {
    botOk,
    stableOk,
    balanceWei: balances.native.toString(),
    stableBalance: balances.stable.toString(),
    blockNumber: balances.blockNumber.toString(),
  };

  if (botOk && stableOk) {
    return met('botchain_rpc:both_balances', `block:${balances.blockNumber}`, detail);
  }
  // Two conditions, so the progress is "how many of the two are satisfied" rather than an amount.
  return notMet('botchain_rpc:both_balances', { current: (botOk ? 1 : 0) + (stableOk ? 1 : 0), target: 2 }, detail);
}
