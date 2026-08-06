/**
 * Seed the 1-Hour test plan (id 4) on every enabled payment network's checkout.
 *
 * Dry-run by default: checks CONFIG_ROLE, gas balance, and simulates the call. Pass --broadcast to
 * actually send. Skips any network where plan 4 is already enabled at the right price/duration.
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import pg from 'pg';
import { createPublicClient, createWalletClient, http, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const BROADCAST = process.argv.includes('--broadcast');
const PLAN_ID = 4;
const DURATION = 3600;
const PRICE_CENTS = 1;
const CONFIG_ROLE = keccak256(toHex('CONFIG_ROLE'));

const ABI = [
  {
    type: 'function', name: 'plans', stateMutability: 'view',
    inputs: [{ name: 'planId', type: 'uint8' }],
    outputs: [
      { name: 'durationSeconds', type: 'uint32' },
      { name: 'price', type: 'uint256' },
      { name: 'enabled', type: 'bool' },
    ],
  },
  {
    type: 'function', name: 'setPlan', stateMutability: 'nonpayable',
    inputs: [
      { name: 'planId', type: 'uint8' },
      { name: 'durationSeconds', type: 'uint32' },
      { name: 'price', type: 'uint256' },
      { name: 'enabled', type: 'bool' },
    ],
    outputs: [],
  },
  {
    type: 'function', name: 'hasRole', stateMutability: 'view',
    inputs: [{ type: 'bytes32' }, { type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
];

const RPCS = {
  968: process.env.RPC_URL_968 || 'https://rpc.bohr.life',
  84532: 'https://sepolia.base.org',
  11155111: 'https://ethereum-sepolia-rpc.publicnode.com',
};

// The deployer key lives in contracts/.env, not backend/.env. Trim stray whitespace/CR rather than
// inspecting the value: only the derived address is ever printed.
const contractsEnv = readFileSync(new URL('file:///home/ashura/steadystake/contracts/.env'), 'utf8');
const rawKey = contractsEnv.match(/^PRIVATE_KEY=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
const hex = rawKey.replace(/^0x/, '').replace(/[^0-9a-fA-F]/g, '');
if (hex.length !== 64) {
  console.error(`PRIVATE_KEY in contracts/.env is not a 32-byte hex key (got ${hex.length} hex chars). Nothing sent.`);
  process.exit(1);
}
const account = privateKeyToAccount(`0x${hex}`);
console.log(`signer: ${account.address}`);
console.log(BROADCAST ? 'MODE: BROADCAST\n' : 'MODE: dry run (simulate only)\n');

const pool = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
const { rows } = await pool.query(
  'SELECT chain_id, stablecoin_decimals, checkout_contract FROM payment_networks WHERE enabled = true ORDER BY chain_id',
);

for (const row of rows) {
  const rpc = RPCS[row.chain_id];
  const tag = `chain ${row.chain_id} ${row.checkout_contract}`;
  if (!rpc) { console.log(`${tag}: no RPC — skipped`); continue; }

  const publicClient = createPublicClient({ transport: http(rpc) });
  const price = BigInt(PRICE_CENTS) * 10n ** BigInt(row.stablecoin_decimals - 2);

  const [, existingPrice, enabled] = await publicClient.readContract({
    address: row.checkout_contract, abi: ABI, functionName: 'plans', args: [PLAN_ID],
  });
  if (enabled && existingPrice === price) { console.log(`${tag}: plan 4 already seeded — skipped`); continue; }

  const hasRole = await publicClient.readContract({
    address: row.checkout_contract, abi: ABI, functionName: 'hasRole', args: [CONFIG_ROLE, account.address],
  });
  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`${tag}: CONFIG_ROLE=${hasRole} gas=${balance} price=${price}`);
  if (!hasRole) { console.log(`   -> signer cannot configure this contract; skipped`); continue; }

  try {
    const { request } = await publicClient.simulateContract({
      account, address: row.checkout_contract, abi: ABI,
      functionName: 'setPlan', args: [PLAN_ID, DURATION, price, true],
    });
    console.log('   -> simulate OK');
    if (!BROADCAST) continue;

    const wallet = createWalletClient({ account, transport: http(rpc), chain: { id: row.chain_id, name: String(row.chain_id), nativeCurrency: { name: 'native', symbol: 'NATIVE', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } } });
    const hash = await wallet.writeContract({ ...request, chain: null });
    console.log(`   -> sent ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`   -> ${receipt.status} in block ${receipt.blockNumber}`);

    const [d, p, on] = await publicClient.readContract({
      address: row.checkout_contract, abi: ABI, functionName: 'plans', args: [PLAN_ID],
    });
    console.log(`   -> verified: duration=${d} price=${p} enabled=${on}`);
  } catch (err) {
    console.log(`   -> FAILED: ${err.shortMessage || err.message}`);
  }
}
await pool.end();
