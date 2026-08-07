/**
 * Copy contracts/deployed-game-contracts.json into the backend repo.
 *
 * backend/ and contracts/ are separate git repos, so the deploy script's output never reaches the
 * Railway build on its own. Every game-contract consumer in the backend (networks dashboard,
 * balances page, capacity permit signer, payment_networks boot seed) resolves the file at runtime
 * and degrades to "not deployed" when it is absent — silently, because a missing deployment file is
 * a legitimate state on a chain nothing has shipped to yet.
 *
 * Run this after any game deploy, then commit backend/deployed-game-contracts.json.
 *
 * Usage: node scripts/sync-game-contracts.mjs [--check]
 *   --check  exit 1 if the backend copy is missing or stale, without writing (for CI).
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = process.env.GAME_CONTRACTS_FILE?.trim()
  || join(backendRoot, '..', 'contracts', 'deployed-game-contracts.json');
const dest = join(backendRoot, 'deployed-game-contracts.json');
const checkOnly = process.argv.includes('--check');

if (!existsSync(source)) {
  // Only the monorepo checkout has the sibling contracts/ repo. On a backend-only clone there is
  // nothing to sync from, and the committed copy is already the source of truth — not an error.
  console.error(`[sync-game-contracts] no source at ${source}; nothing to sync.`);
  process.exit(checkOnly ? 0 : 0);
}

const raw = readFileSync(source, 'utf8');
// Parse before writing: a half-written file mid-deploy must not overwrite a good committed copy.
let parsed;
try {
  parsed = JSON.parse(raw);
} catch (e) {
  console.error(`[sync-game-contracts] ${source} is not valid JSON: ${e.message}`);
  process.exit(1);
}

const chains = Object.keys(parsed);
if (!chains.length) {
  console.error(`[sync-game-contracts] ${source} records no chains; refusing to sync.`);
  process.exit(1);
}

const current = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
if (current === raw) {
  console.log(`[sync-game-contracts] up to date (${chains.length} chains: ${chains.join(', ')})`);
  process.exit(0);
}

if (checkOnly) {
  console.error('[sync-game-contracts] backend copy is stale. Run: node scripts/sync-game-contracts.mjs');
  process.exit(1);
}

writeFileSync(dest, raw);
console.log(`[sync-game-contracts] wrote ${dest} (${chains.length} chains: ${chains.join(', ')})`);
