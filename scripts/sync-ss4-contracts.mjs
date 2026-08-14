/**
 * Copy contracts/deployed-ss4-contracts.json into the backend repo.
 *
 * Same reason as sync-game-contracts.mjs: backend/ and contracts/ are separate git repos, so the
 * deploy script's output never reaches the Railway build on its own. The networks dashboard reads
 * this file at runtime and degrades to "not deployed" when it is absent — silently, because a chain
 * with no $SS4 deployment is a legitimate state everywhere except the one testnet it shipped to.
 *
 * Run this after any SS4 deploy, then commit backend/deployed-ss4-contracts.json.
 *
 * Usage: node scripts/sync-ss4-contracts.mjs [--check]
 *   --check  exit 1 if the backend copy is missing or stale, without writing (for CI).
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = process.env.SS4_CONTRACTS_FILE?.trim()
  || join(backendRoot, '..', 'contracts', 'deployed-ss4-contracts.json');
const dest = join(backendRoot, 'deployed-ss4-contracts.json');
const checkOnly = process.argv.includes('--check');

if (!existsSync(source)) {
  // Only the monorepo checkout has the sibling contracts/ repo. On a backend-only clone there is
  // nothing to sync from, and the committed copy is already the source of truth — not an error.
  console.error(`[sync-ss4-contracts] no source at ${source}; nothing to sync.`);
  process.exit(0);
}

const raw = readFileSync(source, 'utf8');
// Parse before writing: a half-written file mid-deploy must not overwrite a good committed copy.
let parsed;
try {
  parsed = JSON.parse(raw);
} catch (e) {
  console.error(`[sync-ss4-contracts] ${source} is not valid JSON: ${e.message}`);
  process.exit(1);
}

const chains = Object.keys(parsed);
if (!chains.length) {
  console.error(`[sync-ss4-contracts] ${source} records no chains; refusing to sync.`);
  process.exit(1);
}

const current = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
if (current === raw) {
  console.log(`[sync-ss4-contracts] up to date (${chains.length} chains: ${chains.join(', ')})`);
  process.exit(0);
}

if (checkOnly) {
  console.error('[sync-ss4-contracts] backend copy is stale. Run: node scripts/sync-ss4-contracts.mjs');
  process.exit(1);
}

writeFileSync(dest, raw);
console.log(`[sync-ss4-contracts] wrote ${dest} (${chains.length} chains: ${chains.join(', ')})`);
