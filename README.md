# SteadyStake DCA Executor

Standalone backend that runs DCA execution: reads registered users from Supabase, finds ready schedules, gets 0x quotes, sends `executeSwap` from the relayer wallet, then deducts gas cost from the user's GasTank via `recordExecution`. Scheduler config, runtime state, run/gas/portfolio history, and the runtime session are persisted to Supabase Postgres (with local-JSON fallback when `SUPABASE_DB_URL` is unset).

## Setup

1. Copy `.env.example` to `.env` and set:
   - `RELAYER_PRIVATE_KEY` – wallet that sends txs (must be GasTank executor)
   - `SUPABASE_DB_URL` – Supabase Postgres (Session Pooler) connection string, shared with the frontend; stores DCA plans (`dca_plans`), the registered-user list, scheduler state/config, and history. Scheduler state/config/history fall back to local JSON files when unset, but **plans and members are database-only** — without it, `/api/plans` returns nothing and the executor has no members to run (see “DCA plans” below).
   - `ZERO_EX_API_KEY` (optional)
   - `GAS_COST_PER_EXECUTION_USDC` (optional): last-resort fixed USD amount per execution. An operator price set on the **Run price** dashboard page, and then the GasTank's own `gasCostPerExecutionUsdc6`, both outrank it (see “Per-run price” below); with none of the three set, cost is derived from network gas + native token price.
   - `ADMIN_API_TOKEN` (required to use the operator controls): gates changing the per-run price, holding a plan, and allocating networks. Unset, those endpoints refuse every request.
   - `PORT` (optional, default `3340`): HTTP server port for the scheduler dashboard

   There is no chain list to configure. The executor runs **every chain that has a GasTank in `deployed-addresses.json`**, minus the ones paused or removed under “Network allocation” below.

2. Add **GasTank** address per chain to `deployed-addresses.json` (deploy GasTank first; see contracts and frontend docs).

## Run

- **Start (recommended):** `npm start` – starts the HTTP server and runs the DCA executor on a **configurable period** (default: once per day). The backend stays on.
  - Open **http://localhost:3340** (or your `PORT`) for the **scheduler dashboard**: set run period (1 hour, 6h, 12h, 1 day, 1 week), trigger “Run now”, and see last/next run status. The dashboard also shows **run history** (each DCA run with executed tasks and errors), **gas tank balance history** (per user/chain, recorded after each execution), and **DCA plan history** (schedule IDs per user at each run).
- **One-off run:** `npm run run` – builds and runs the executor once, then exits.
- **Legacy loop (every 5 min):** `npm run build && npm run loop`.

Use pm2 or systemd in production to keep `npm start` running (the server process runs the executor on the configured interval).

## Per-run price

What one scheduled run charges a user's gas tank is resolved in one order, by this executor and by
the app alike — a number the UI quotes and the relayer does not debit is what lets a fully funded
plan run its tank dry mid-way:

1. **Operator price**, set per network on the **Run price** dashboard page (`/run-price.html`) and
   stored by `src/run-price.ts` — Supabase `kv_store`, or `run-price.json` when `SUPABASE_DB_URL`
   is unset. Changeable in seconds without a transaction, which is why it wins.
2. **`gasCostPerExecutionUsdc6`** on that chain's GasTank, changed only by an owner transaction
   (`scripts/set-gas-cost.js`).
3. **`GAS_COST_PER_EXECUTION_USDC`** for a chain where neither is set.
4. Otherwise each run is charged what it measured, so the amount moves with gas.

The dashboard page shows each network's flat rate beside what a run costs the relayer right now —
live gas price × gas measured from real runs (`src/gas-profile.ts`) × native token price — so a
rate is set against the live cost rather than guessed, and a rate that has drifted far from it is
called out. `GET /api/run-price` is open (it is the same figure every user is already shown);
`POST` needs `ADMIN_API_TOKEN`. A change reaches the executor within ~30s and the app within about
two minutes of caching.

## Network allocation

Which networks the app offers and this executor serves is an operator decision, changed from the
**Networks** dashboard page (`/networks.html`) without a redeploy on either side. Two layers:

- **The registry** (`src/networks/network-registry.ts`) — code. One entry per chain: name, explorer,
  default RPC, native symbol, and whether it is a `mainnet` or a `testnet`. This is also the single
  source of `CHAIN_NAMES`, the explorer table, and RPC resolution. **Adding a genuinely new network
  means adding an entry here and deploying the contracts to it**; the admin API can only allocate
  chains the registry already describes, so it can never point the relayer at a chain whose vault,
  RPC, and stablecoin nobody has verified.
- **The allocation** (`network_allocations` table, or `network-allocations.json` when
  `SUPABASE_DB_URL` is unset) — runtime. Per chain: status and an optional override of the
  mainnet/testnet classification. A row exists only where an operator has overridden a default, so
  **no row means enabled with the registry's own classification** — a database that has never been
  written to behaves exactly as before, and a newly deployed chain is live rather than invisible.

Three statuses:

| Status | Shown to users | New plans | Relayer executes |
| --- | --- | --- | --- |
| `enabled` | yes | yes | yes |
| `paused` | yes, badged | no | no |
| `disabled` ("removed") | no | no | no |

**Prefer `paused` over `disabled` for a chain that still holds user money.** Pausing keeps the
network reachable so users can see their plans, cancel, withdraw, and reclaim their gas tank
balance; removing it hides the network, and with it their route to their own plans. Neither touches
anything on-chain — the vault, the plans, and every deposit and gas tank balance come back exactly
as they were.

The allocation is applied **last and subtractively** inside the executor, after the deployed-chain
list and a targeted "run now" have had their say. A pause either could override would not be a
pause. A failed read aborts the run rather than falling back to the unfiltered set, for the same
reason admin plan holds do.

Endpoints — `GET /api/networks` is open (`?type=mainnet|testnet`, `?include=all` for removed ones);
everything under `/api/admin/networks` needs `ADMIN_API_TOKEN`:

```
GET  /api/networks?type=mainnet        # what the frontend asks for its list
GET  /api/admin/networks               # every network, removed included
POST /api/admin/networks/add           # { chainId, note?, updatedBy? }
POST /api/admin/networks/pause         # { chainId, note?, updatedBy? }  note is shown to users
POST /api/admin/networks/resume        # { chainId, updatedBy? }
POST /api/admin/networks/remove        # { chainId, note?, updatedBy? }
POST /api/admin/networks/type          # { chainId, type: "mainnet"|"testnet"|null }
POST /api/admin/networks/reset         # { chainId } — back to the registry default
```

The frontend picks its list with `NETWORK_TYPE` (`mainnet` | `testnet` | `all`) in its own `.env`,
then narrows it by what this API reports. `/api/admin/networks/type` decides which of the two lists
a network appears in — presentation only, not a claim about the chain. The frontend needs
`SCHEDULER_API_URL` pointing here to read allocation at all; without it, it shows its build-time
list and treats every network as live, and this executor still enforces pauses on its own side.

## DCA plans

`dca_plans` is the system of record for plans, and nothing on the read or execute path scans block
logs. Rows are written through as plans change:

- **created** – the frontend calls `POST /api/plans/record` with the confirmed tx hash; the route
  reads the receipt and stores the plan (and registers the user for automation).
- **executed** – the executor records each swap as it makes it.
- **cancelled** – recorded from the cancel tx's receipt.

Members come from `dca_plans` unioned with `automation_users`, so the plans table is also the
member list. Reads (`GET /api/plans`) serve stored state plus a bounded set of `eth_call`s for live
values on active plans (remaining balance, ready/enrolled). Anything never recorded is reported as
null and rendered as **“Not recorded”** rather than guessed at.

**Backfill (manual only):** `POST /api/plans/reindex` — or `npm run index-plans` — scans
`ScheduleCreated`/`Executed`/`Cancelled` logs to recover plans created outside the recording path
(e.g. before write-through existed). This scans block logs and can take minutes per chain, which is
why nothing calls it automatically. Tune with `DCA_INDEX_LOOKBACK_BLOCKS`,
`DCA_INDEX_LOG_CHUNK_BLOCKS` (public RPCs cap ranges — `sepolia.base.org` allows ~1000),
`DCA_INDEX_CONCURRENCY`.
