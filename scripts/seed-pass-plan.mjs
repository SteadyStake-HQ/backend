#!/usr/bin/env node
/**
 * Configure a Game Pass plan on the deployed StablecoinGamePassCheckout of every testnet.
 *
 * Why this exists as a script rather than a forge broadcast: `forge script` SIGILLs on this machine
 * (see contracts/scripts/verify-deployed.mjs and DEPLOY_BOT_CHAIN.md), and the deploy script only
 * seeds plans at construction time anyway — an already-deployed checkout can only learn a new plan
 * through `setPlan`. Redeploying to add one would mint new addresses and orphan the live ones.
 *
 * The price is never typed in here. It is computed from `PASS_PLANS` with the same
 * `planAmountAtomic` the backend uses to build a purchase intent, against decimals read from the
 * chain's own stablecoin. That matters more than it looks: the indexer activates a pass only when
 * the `PassPaid` amount equals the intent's `expectedAmountAtomic` (pass-indexer.ts), so an on-chain
 * price that differs by one atomic unit takes the player's money and grants nothing.
 *
 *   # preview every chain, no key needed
 *   node --env-file=../contracts/.env scripts/seed-pass-plan.mjs --signer 0xYourAdmin
 *
 *   # send it
 *   node --env-file=../contracts/.env scripts/seed-pass-plan.mjs --broadcast
 *
 * Flags: --plan <id> (default 4)  --chain <id>  --broadcast  --signer <address>
 * Env:   PASS_ADMIN_PRIVATE_KEY or PRIVATE_KEY; optional <KEY>_RPC overrides per chain.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, http, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PASS_PLANS, getPassPlan, planAmountAtomic } from "../src/payments/pass-plans.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEPLOYED = path.resolve(HERE, "../../contracts/deployed-game-contracts.json");

/** Testnet RPCs, mirroring contracts/foundry.toml `[rpc_endpoints]`. Overridable per chain. */
const CHAINS = {
  84532: { name: "Base Sepolia", rpcEnv: "BASE_SEPOLIA_RPC", rpc: "https://sepolia.base.org" },
  // foundry.toml lists rpc.sepolia.org too; publicnode is the steadier of the pair.
  11155111: { name: "ETH Sepolia", rpcEnv: "ETH_SEPOLIA_RPC", rpc: "https://ethereum-sepolia-rpc.publicnode.com" },
  968: { name: "BOT testnet (Bohr)", rpcEnv: "BOT_TESTNET_RPC", rpc: "https://rpc.bohr.life" },
};

const CHECKOUT_ABI = [
  {
    type: "function",
    name: "setPlan",
    stateMutability: "nonpayable",
    inputs: [
      { name: "planId", type: "uint8" },
      { name: "durationSeconds", type: "uint32" },
      { name: "price", type: "uint256" },
      { name: "enabled", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "plans",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint8" }],
    outputs: [
      { name: "durationSeconds", type: "uint32" },
      { name: "price", type: "uint256" },
      { name: "enabled", type: "bool" },
    ],
  },
  { type: "function", name: "stablecoin", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "CONFIG_ROLE", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  {
    type: "function",
    name: "hasRole",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }, { type: "address" }],
    outputs: [{ type: "bool" }],
  },
];

const DECIMALS_ABI = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
];

function parseArgs(argv) {
  const args = { planId: 4, broadcast: false, chainId: null, signer: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--broadcast") args.broadcast = true;
    else if (flag === "--plan") args.planId = Number(argv[++i]);
    else if (flag === "--chain") args.chainId = Number(argv[++i]);
    else if (flag === "--signer") args.signer = argv[++i];
    else throw new Error(`Unknown argument "${flag}"`);
  }
  return args;
}

function clientsFor(chainId, account) {
  const meta = CHAINS[chainId];
  const url = process.env[meta.rpcEnv] || meta.rpc;
  const chain = defineChain({
    id: chainId,
    name: meta.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
  return {
    url,
    publicClient: createPublicClient({ chain, transport: http(url) }),
    walletClient: account ? createWalletClient({ account, chain, transport: http(url) }) : null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const plan = getPassPlan(args.planId);
  if (!plan) {
    throw new Error(`Plan ${args.planId} is not in PASS_PLANS. Add it to src/payments/pass-plans.ts first.`);
  }

  const key = process.env.PASS_ADMIN_PRIVATE_KEY || process.env.PRIVATE_KEY;
  const account = key ? privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`) : null;
  const signer = account?.address ?? args.signer;
  if (args.broadcast && !account) {
    throw new Error("--broadcast needs PASS_ADMIN_PRIVATE_KEY or PRIVATE_KEY (try --env-file=../contracts/.env)");
  }
  if (!signer) {
    throw new Error("Pass --signer <address> to preview, or set a key to check the admin role.");
  }

  const deployed = JSON.parse(fs.readFileSync(DEPLOYED, "utf8"));
  const chainIds = args.chainId ? [args.chainId] : Object.keys(CHAINS).map(Number);

  console.log(`Plan ${plan.id} "${plan.label}" — ${plan.durationSeconds}s, ${plan.priceCents}c`);
  console.log(`Signer: ${signer}`);
  console.log(args.broadcast ? "Mode:   BROADCAST\n" : "Mode:   dry run (add --broadcast to send)\n");

  let failures = 0;
  let sent = 0;

  for (const chainId of chainIds) {
    const meta = CHAINS[chainId];
    const label = `${meta?.name ?? chainId} (${chainId})`;
    const checkout = deployed[String(chainId)]?.StablecoinGamePassCheckout?.address;
    if (!meta || !checkout) {
      console.log(`✗ ${label}: no StablecoinGamePassCheckout in deployed-game-contracts.json`);
      failures += 1;
      continue;
    }

    try {
      const { publicClient, walletClient, url } = clientsFor(chainId, account);
      const contract = { address: checkout, abi: CHECKOUT_ABI };

      // Decimals come from the chain's own stablecoin, so the price is right per network rather
      // than assumed. Every testnet is 6dp today, but that is not a thing to hard-code.
      const stablecoin = await publicClient.readContract({ ...contract, functionName: "stablecoin" });
      const decimals = await publicClient.readContract({
        address: stablecoin,
        abi: DECIMALS_ABI,
        functionName: "decimals",
      });
      const price = planAmountAtomic(plan, Number(decimals));

      const [currentDuration, currentPrice, currentEnabled] = await publicClient.readContract({
        ...contract,
        functionName: "plans",
        args: [plan.id],
      });

      console.log(`— ${label}`);
      console.log(`  rpc        ${url}`);
      console.log(`  checkout   ${checkout}`);
      console.log(`  stablecoin ${stablecoin} (${decimals}dp)`);
      console.log(`  on-chain   ${currentEnabled ? "enabled" : "absent/disabled"}, ${currentDuration}s, ${currentPrice}`);
      console.log(`  target     enabled, ${plan.durationSeconds}s, ${price} (${formatUnits(price, Number(decimals))})`);

      if (currentEnabled && currentDuration === plan.durationSeconds && currentPrice === price) {
        console.log("  → already correct, skipping\n");
        continue;
      }

      const configRole = await publicClient.readContract({ ...contract, functionName: "CONFIG_ROLE" });
      const authorised = await publicClient.readContract({
        ...contract,
        functionName: "hasRole",
        args: [configRole, signer],
      });
      if (!authorised) {
        console.log(`  ✗ ${signer} does not hold CONFIG_ROLE here — setPlan would revert\n`);
        failures += 1;
        continue;
      }

      // Simulate first so a revert shows up before any gas is spent.
      const { request } = await publicClient.simulateContract({
        ...contract,
        functionName: "setPlan",
        args: [plan.id, plan.durationSeconds, price, true],
        account: account ?? signer,
      });

      if (!args.broadcast) {
        console.log("  ✓ simulated clean — not sent (dry run)\n");
        continue;
      }

      const hash = await walletClient.writeContract(request);
      console.log(`  tx ${hash}`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      console.log(`  ${receipt.status === "success" ? "✓ confirmed" : "✗ reverted"} in block ${receipt.blockNumber}\n`);
      if (receipt.status === "success") sent += 1;
      else failures += 1;
    } catch (error) {
      console.log(`  ✗ ${error.shortMessage ?? error.message}\n`);
      failures += 1;
    }
  }

  console.log(args.broadcast ? `Done: ${sent} sent, ${failures} failed.` : `Dry run complete: ${failures} chain(s) would fail.`);
  process.exitCode = failures ? 1 : 0;
}

// Listed for the operator's benefit: every plan the backend will offer, so a drift between this
// table and the chain is visible before it costs someone a purchase.
if (process.argv.includes("--list")) {
  for (const p of PASS_PLANS) console.log(`${p.id}\t${p.key}\t${p.durationSeconds}s\t${p.priceCents}c\t${p.label}`);
} else {
  main().catch((error) => {
    console.error(error.shortMessage ?? error.message);
    process.exitCode = 1;
  });
}
