/**
 * Deploys the SteadyStake stack to BNB Chain (56) and wires it, mirroring
 * contracts/script/Deploy.s.sol:DeployBNB exactly.
 *
 * Run from this directory (`node deploy-bsc.mjs`) — viem resolves out of backend/node_modules.
 * `forge script` SIGILLs on this machine (see contracts/DEPLOY_BOT_CHAIN.md), so this broadcasts
 * the creation txs directly from the compiled artifacts in contracts/out-bsc, then writes a
 * forge-compatible broadcast/Deploy.s.sol/56/run-latest.json so scripts/sync-chain.js works.
 *
 * Reads PRIVATE_KEY and RELAYER_ADDRESS from contracts/.env.
 */
import { createPublicClient, createWalletClient, http, encodeDeployData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACTS = join(HERE, "..", "contracts");
const OUT = join(CONTRACTS, "out-bsc");

const BNB_USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"; // Binance-Peg USDC, 18 decimals
const ALLOWANCE_HOLDER = "0x0000000000001fF3684f28c67538d4D072C22734"; // 0x Swap API v2
const GAS_COST_PER_RUN = 10n ** 16n; // $0.01 at 18 decimals

/** Minimal .env reader — contracts/.env is not this package's dotenv target. */
function readEnv(file) {
  const out = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = readEnv(join(CONTRACTS, ".env"));
const PRIVATE_KEY = env.PRIVATE_KEY;
const RELAYER = env.RELAYER_ADDRESS;
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY missing from contracts/.env");
// Deploy.s.sol treats a missing relayer as fatal for the same reason: a GasTank whose executor is
// unset reverts every recordExecution, so user gas is never deducted and nothing reports it.
if (!RELAYER || /^0x0+$/.test(RELAYER)) throw new Error("RELAYER_ADDRESS missing from contracts/.env");

const RPCS = [
  "https://bsc-dataseed.bnbchain.org",
  "https://bsc-rpc.publicnode.com",
  "https://bsc-dataseed.binance.org",
];

function artifact(rel) {
  const j = JSON.parse(readFileSync(join(OUT, rel), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

const A = {
  ZeroExAdapter: artifact("SwapHelper.sol/ZeroExAdapter.json"),
  DCAVault: artifact("DCAVault.sol/DCAVault.json"),
  DCAResolver: artifact("DCAResolver.sol/DCAResolver.json"),
  GasTank: artifact("GasTank.sol/GasTank.json"),
};

const account = privateKeyToAccount(PRIVATE_KEY);

let transport;
for (const url of RPCS) {
  try {
    const c = createPublicClient({ chain: bsc, transport: http(url, { timeout: 30000 }) });
    if ((await c.getChainId()) === 56) {
      transport = http(url, { timeout: 60000 });
      console.log("RPC:", url);
      break;
    }
  } catch {
    /* try the next endpoint */
  }
}
if (!transport) throw new Error("no working BSC RPC");

const pub = createPublicClient({ chain: bsc, transport });
const wallet = createWalletClient({ account, chain: bsc, transport });

// BSC's suggested price sits at its 0.05 gwei floor; bump so we are never rejected as underpriced.
const suggested = await pub.getGasPrice();
const gasPrice = suggested < 100000000n ? 100000000n : suggested;
console.log("deployer:", account.address);
console.log("relayer :", RELAYER);
console.log("balance :", Number(await pub.getBalance({ address: account.address })) / 1e18, "BNB");
console.log("gasPrice:", Number(gasPrice) / 1e9, "gwei\n");

async function deploy(name, args) {
  const { abi, bytecode } = A[name];
  const data = encodeDeployData({ abi, bytecode, args });
  const gas = await pub.estimateGas({ account, data });
  const hash = await wallet.sendTransaction({ data, gas: (gas * 130n) / 100n, gasPrice });
  const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 180000 });
  if (rcpt.status !== "success") throw new Error(`${name} deploy reverted: ${hash}`);
  console.log(`${name.padEnd(14)} ${rcpt.contractAddress}  gas=${rcpt.gasUsed}  tx=${hash}`);
  return rcpt.contractAddress;
}

async function send(address, abi, functionName, args) {
  const hash = await wallet.writeContract({ address, abi, functionName, args, gasPrice });
  const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 180000 });
  if (rcpt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
  console.log(`  ${functionName}(${args.join(", ")}) ok  tx=${hash}`);
}

const adapter = await deploy("ZeroExAdapter", [BNB_USDC, ALLOWANCE_HOLDER]);
const vault = await deploy("DCAVault", [adapter, BNB_USDC]);
const resolver = await deploy("DCAResolver", [vault]);
const gasTank = await deploy("GasTank", [BNB_USDC]);

console.log("\nwiring:");
await send(gasTank, A.GasTank.abi, "setGasCostPerExecution", [GAS_COST_PER_RUN]);
await send(gasTank, A.GasTank.abi, "setExecutor", [RELAYER]);
await send(vault, A.DCAVault.abi, "setGasTank", [gasTank]);

console.log("\nverifying wiring on-chain:");
const checks = [
  ["vault.usdc", await pub.readContract({ address: vault, abi: A.DCAVault.abi, functionName: "usdc" }), BNB_USDC],
  ["vault.swapRouter", await pub.readContract({ address: vault, abi: A.DCAVault.abi, functionName: "swapRouter" }), adapter],
  ["vault.gasTank", await pub.readContract({ address: vault, abi: A.DCAVault.abi, functionName: "gasTank" }), gasTank],
  ["gasTank.executor", await pub.readContract({ address: gasTank, abi: A.GasTank.abi, functionName: "executor" }), RELAYER],
];
let ok = true;
for (const [label, actual, expected] of checks) {
  const match = String(actual).toLowerCase() === String(expected).toLowerCase();
  if (!match) ok = false;
  console.log(`  ${match ? "OK  " : "FAIL"} ${label} = ${actual}`);
}
const maxDeposit = await pub.readContract({ address: vault, abi: A.DCAVault.abi, functionName: "maxTotalDeposit" });
const expectedMax = 10_000_000n * 10n ** 18n;
if (maxDeposit !== expectedMax) ok = false;
console.log(`  ${maxDeposit === expectedMax ? "OK  " : "FAIL"} vault.maxTotalDeposit = ${maxDeposit} (expect ${expectedMax})`);
const costPerRun = await pub.readContract({ address: gasTank, abi: A.GasTank.abi, functionName: "gasCostPerExecutionUsdc6" });
if (costPerRun !== GAS_COST_PER_RUN) ok = false;
console.log(`  ${costPerRun === GAS_COST_PER_RUN ? "OK  " : "FAIL"} gasTank.gasCostPerExecutionUsdc6 = ${costPerRun}`);

const dir = join(CONTRACTS, "broadcast", "Deploy.s.sol", "56");
mkdirSync(dir, { recursive: true });
const payload = {
  transactions: [
    { contractName: "ZeroExAdapter", contractAddress: adapter.toLowerCase() },
    { contractName: "DCAVault", contractAddress: vault.toLowerCase() },
    { contractName: "DCAResolver", contractAddress: resolver.toLowerCase() },
    { contractName: "GasTank", contractAddress: gasTank.toLowerCase() },
  ],
};
writeFileSync(join(dir, "run-latest.json"), JSON.stringify(payload, null, 2) + "\n");
writeFileSync(join(dir, `run-${Date.now()}.json`), JSON.stringify(payload, null, 2) + "\n");
console.log("\nwrote broadcast/Deploy.s.sol/56/run-latest.json");
console.log("remaining balance:", Number(await pub.getBalance({ address: account.address })) / 1e18, "BNB");
console.log("\nNext: cd ../contracts && node scripts/sync-chain.js 56");
if (!ok) {
  console.error("\nWIRING CHECK FAILED — do not sync these addresses until resolved.");
  process.exit(1);
}
