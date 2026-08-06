/**
 * Boot seed for `payment_networks` from the deployed checkout addresses
 * (contracts/deployed-game-contracts.json). Seed-once per chain: a chain already present in the DB
 * is left untouched, so a later admin edit is never clobbered on the next boot.
 */
import { findGameContractsFile, loadGameContracts } from '../game-contracts';
import { getPaymentNetwork, upsertPaymentNetwork } from '../supabase/payment-networks';

/** Testnet reorg holdback; deliberately conservative on public RPCs. */
const DEFAULT_CONFIRMATIONS = 2;

export async function seedPaymentNetworks(logger?: { log: (m: string) => void; warn: (m: string) => void }): Promise<void> {
  if (!findGameContractsFile()) {
    logger?.warn('[payments] deployed-game-contracts.json not found; payment_networks not seeded.');
    return;
  }

  const treasury = process.env.RELAYER_ADDRESS?.trim();
  const deployments = Object.values(loadGameContracts());
  if (!deployments.length) {
    logger?.warn('[payments] deployed-game-contracts.json has no usable entries; payment_networks not seeded.');
    return;
  }

  for (const entry of deployments) {
    const co = entry.checkout;
    if (!co) continue;
    if (await getPaymentNetwork(entry.chainId)) continue; // seed-once

    await upsertPaymentNetwork({
      chainId: entry.chainId,
      stablecoinSymbol: 'USDC',
      stablecoinAddress: co.stablecoin,
      stablecoinDecimals: co.decimals,
      checkoutContract: co.address,
      treasuryAddress: treasury && treasury.length ? treasury : co.address,
      requiredConfirmations: DEFAULT_CONFIRMATIONS,
      enabled: true,
      configVersion: 1,
    });
    logger?.log(`[payments] seeded payment_networks for ${entry.key ?? entry.chainId} (checkout ${co.address})`);
  }
}
