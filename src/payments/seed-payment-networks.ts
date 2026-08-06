/**
 * Boot seed for `payment_networks` from the deployed checkout addresses
 * (contracts/deployed-game-contracts.json). Seed-once per chain: a chain already present in the DB
 * is left untouched, so a later admin edit is never clobbered on the next boot.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getPaymentNetwork, upsertPaymentNetwork } from '../supabase/payment-networks';

interface DeployedEntry {
  chainId: number;
  key?: string;
  StablecoinGamePassCheckout?: { address?: string; stablecoin?: string; decimals?: number; skipped?: string };
}

/** Testnet reorg holdback; deliberately conservative on public RPCs. */
const DEFAULT_CONFIRMATIONS = 2;

function findDeployedFile(): string | null {
  const candidates = [
    join(process.cwd(), '..', 'contracts', 'deployed-game-contracts.json'),
    join(process.cwd(), 'contracts', 'deployed-game-contracts.json'),
    join(__dirname, '..', '..', '..', 'contracts', 'deployed-game-contracts.json'),
    process.env.GAME_CONTRACTS_FILE?.trim() ?? '',
  ].filter(Boolean);
  return candidates.find((c) => existsSync(c)) ?? null;
}

export async function seedPaymentNetworks(logger?: { log: (m: string) => void; warn: (m: string) => void }): Promise<void> {
  const file = findDeployedFile();
  if (!file) {
    logger?.warn('[payments] deployed-game-contracts.json not found; payment_networks not seeded.');
    return;
  }

  const treasury = process.env.RELAYER_ADDRESS?.trim();
  let data: Record<string, DeployedEntry>;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    logger?.warn(`[payments] could not parse ${file}: ${(e as Error).message}`);
    return;
  }

  for (const entry of Object.values(data)) {
    const co = entry.StablecoinGamePassCheckout;
    if (!co?.address || !co.stablecoin || typeof co.decimals !== 'number') continue;
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
