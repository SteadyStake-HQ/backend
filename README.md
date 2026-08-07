# SteadyStake DCA Executor

Standalone backend that runs DCA execution: reads registered users from Supabase, finds ready schedules, gets 0x quotes, sends `executeSwap` from the relayer wallet, then deducts gas cost from the user's GasTank via `recordExecution`. Scheduler config, runtime state, run/gas/portfolio history, and the runtime session are persisted to Supabase Postgres (with local-JSON fallback when `SUPABASE_DB_URL` is unset).

## Setup

1. Copy `.env.example` to `.env` and set:
   - `RELAYER_PRIVATE_KEY` – wallet that sends txs (must be GasTank executor)
   - `SUPABASE_DB_URL` – Supabase Postgres (Session Pooler) connection string, shared with the frontend; stores DCA plans (`dca_plans`), the registered-user list, scheduler state/config, and history. Scheduler state/config/history fall back to local JSON files when unset, but **plans and members are database-only** — without it, `/api/plans` returns nothing and the executor has no members to run (see “DCA plans” below).
   - `ZERO_EX_API_KEY` (optional)
   - `ADMIN_API_TOKEN` (required to use the operator controls): gates holding a plan and allocating networks. Unset, those endpoints refuse every request.
   - `PORT` (optional, default `3340`): HTTP server port for the scheduler dashboard

   There is no chain list to configure. The executor runs **every chain that has a GasTank in `deployed-addresses.json`**, minus the ones paused or removed under “Network allocation” below.

2. Add **GasTank** address per chain to `deployed-addresses.json` (deploy GasTank first; see contracts and frontend docs).

## Run

- **Start (recommended):** `npm start` – starts the HTTP server and runs the DCA executor on a **configurable period** (default: once per day). The backend stays on.
  - Open **http://localhost:3340** (or your `PORT`) for the **operations dashboard**. The root is a picker; see [Dashboard layout](#dashboard-layout) for what lives where. Its **Plan activity** page (`/steadystake/`) sets the run period (1 hour, 6h, 12h, 1 day, 1 week), triggers “Run now”, and shows last/next run status, plus **run history** (each DCA run with executed tasks and errors), **gas tank balance history** (per user/chain, recorded after each execution), and **DCA plan history** (schedule IDs per user at each run).
- **One-off run:** `npm run run` – builds and runs the executor once, then exits.
- **Legacy loop (every 5 min):** `npm run build && npm run loop`.

Use pm2 or systemd in production to keep `npm start` running (the server process runs the executor on the configured interval).

## Dashboard layout

Two products run on this backend, so `public/` is split one folder per product and each page carries
only its own product's nav. The header's project switcher moves between them; the root `/` is a
picker.

| | Pages | Serves |
| --- | --- | --- |
| **SteadyStake** — `public/steadystake/` | Plan activity (`/steadystake/`), Tokens, Relayer &amp; fees, Balances, Capacity | The DCA scheduler |
| **Echo Arena** — `public/echo-arena/` | Seasons, Players, Rewards | The game |
| **Shared** — `public/` | Networks (`/networks.html`) | Both — the chain registry carries the DCA contract addresses and the Echo Arena game contracts per chain |

Capacity sits under SteadyStake because it governs Auto Execution Plan slots, even though the bonus
it reads comes from Echo Arena reward cards.

The pre-split URLs (`/tokens.html`, `/seasons.html`, …) are kept as redirect stubs so old operator
bookmarks still land; `/deployments.html` likewise still forwards to Networks. A page added to
either product needs its nav block copied from a sibling page in the same folder — the nav is inline
HTML per page, not templated.

## What a run charges

Nobody sets a per-run price, and there is nothing to configure. A run is charged the gas it burned:

```
charge = swap receipt (gasUsed × effectiveGasPrice)      ← exact, from the chain
       + deduction leg (measured gas × gas price × 1.2)  ← estimated; its receipt does not exist yet
       × the native token's USD price
```

stated in the paying tank's stablecoin and **rounded up** at every step. Truncation would write
off a fraction of gas the relayer had already paid on the user's behalf; a rounding has to fall on
the side of whoever fronted the money.

The deduction leg is the only part that has to be predicted rather than read, because the amount
`recordExecution` debits is an argument to `recordExecution`. It is priced from the gas that
chain's own deduction transactions have really burned (`src/gas-profile.ts`), plus 20%.

Gas price and token price are read live per chain and **held for one sweep**, so two users whose
plans run in the same pass are charged against the same reading rather than against whichever block
happened to arrive between them. A run whose gas price or token price cannot be read is skipped,
not given away.

Balances are pooled, so a run on one network can be settled from another's tank. The deduction then
runs on the *paying* network at its gas price, in its token — so a cross-network run costs more,
and the app tells users that before it happens rather than after.

Every completed run is saved to `run_history`, and **every execution ever saved** — all plans, all
users, no window — is what the per-chain figures are aggregated from. One SQL statement does it
(`SupabaseService.getRunCostAggregatesByChain`), snapshotted by `src/run-cost-history.ts` and merged
into the profile by `src/gas-profile.ts`. `GET /api/gas-profile?chainId=<id>` serves the result:

```
{ gasUnitsPerRun, swapGasUnits, recordGasUnits, recordBufferBps, gasUnitsP90,
  samples, source, basis, firstRunAt, lastRunAt,
  cost: { samples, avgUsd, maxUsd, minUsd, lastUsd,
          crossChainSamples, crossChainAvgUsd, sameChainAvgUsd } }
```

`avgUsd` and `maxUsd` are what the gas tank modal shows users: a charge that follows gas has a
spread, and the average alone would let someone fund a plan for a calm week and have it stall on a
busy one. `basis` says which record they came from — `history` for the durable one above,
`relayer` for this process's own samples, `seed` when nothing has run there. Omit `chainId` for
every chain at once.

The two gas legs are published separately, with `recordBufferBps`, so a caller can reproduce what
the relayer will actually charge — `swapGasUnits + recordGasUnits × recordBufferBps/10000` — rather
than multiplying the bare total and quoting under the debit.

`src/gas-profile.ts` still keeps its own samples in a local JSON file, capped at 1,000 per chain,
but only as the fallback for a deployment with no database. That file lives in the working
directory or `/tmp`, so a host that redeploys comes back with none: in production it was empty
every time it was asked, which is why the modal's average and maximum never appeared and why the
live estimate beside them was multiplying a build-time seed.

The GasTank's `gasCostPerExecutionUsdc6` still exists on chain and nothing reads it —
`recordExecution` debits the amount the relayer passes, which is the receipt's cost.

`src/run-cost.ts` is the operator-facing view of the same arithmetic, and resolves the gas figure
best-first:

1. **simulated** — a real plan on that network is picked, the exact calldata the relayer would send
   is built for it (a live 0x quote included, on aggregator chains), and both transactions —
   `executeSwap` and `recordExecution` — are put through `eth_estimateGas` from the relayer's own
   address. Only a plan past its cooldown can be simulated: `executeSwap` on one still inside its
   interval reverts, and a reverting call cannot be estimated.
2. **measured** — the median of what recent completed runs on that chain really used
   (`src/gas-profile.ts`).
3. **seed** — the pre-measurement constant for that chain's swap path.

Native token prices (`src/native-price.ts`) come from CoinGecko in a single batched request, with
Coinbase and Binance behind it and BOT Chain's own DEX in front of it for BOT. A price that was
good a minute ago is served (flagged as such) rather than discarded when every feed is failing,
and `NATIVE_PRICE_USD_<chainId>` overrides the lot.

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

## Token list

Which tokens a plan can buy on each network is operator state, edited on the **Tokens** dashboard
page (`/steadystake/tokens.html`). It replaced a JSON file compiled into the frontend bundle, so adding or
removing a token no longer needs a redeploy of either side.

The list lives in `token_list` (or `token-list.json` when `SUPABASE_DB_URL` is unset), one row per
`(chain_id, address)`, and is served to the app by `GET /api/tokens?chainId=…`. The frontend reads
it through its own `/api/tokens` route and falls back to its build-time list if this backend cannot
be reached — a token list is a menu, not a permission, so a stale menu beats no menu. Every token is
still verified on-chain at plan-creation time.

An initial list is **imported** from four providers, merged by address with the best rank winning:

| Provider | Needs a key | What it contributes |
| --- | --- | --- |
| CoinGecko | no | identity (symbol, name, decimals, logo) and market-cap rank |
| GeckoTerminal | no | the chain's highest-volume pools — i.e. what can actually be swapped |
| CoinMarketCap | `CMC_API_KEY` | a second market-cap opinion; skipped silently without the key |
| DEX list | no | the chain's own router list (PancakeSwap on BNB, QuickSwap on Polygon) |

No single provider answers the question on its own: market cap alone offers tokens with no pool on
the chain, which is a plan that fails every run. Each provider fails soft — a rate-limited one costs
tokens, never the import — and the response reports what each one returned and why.

Two rules survive an import, both so a re-import cannot undo an operator's decision:

- a **removed** token stays removed (the row is flagged, not deleted);
- a **manually added** token keeps its source and its place at the top of the list.

`replace: true` empties the chain first and therefore discards both — that is what it is for, and
why it is not the default. The chain's settlement stablecoin is never imported: plans spend it, so
they cannot buy it.

Endpoints — `GET /api/tokens` is open; everything under `/api/admin/tokens` needs `ADMIN_API_TOKEN`:

```
GET  /api/tokens?chainId=56             # live tokens, in display order — what the app asks for
GET  /api/admin/tokens/summary          # every network: counts and the providers available for it
GET  /api/admin/tokens?chainId=56       # one chain, removed tokens included
POST /api/admin/tokens/import           # { chainId, sources?, limit?, replace?, updatedBy? }
POST /api/admin/tokens/add              # { chainId, address, symbol?, name?, decimals?, logoUrl? }
POST /api/admin/tokens/remove           # { chainId, address, purge? }  purge deletes the row
POST /api/admin/tokens/restore          # { chainId, address }
```

`add` reads symbol, name and decimals off the chain rather than trusting the request: decimals
decide what a plan spends, and a token stored at 18 that is really 6 misprices every buy by a
factor of a trillion. The optional fields are overrides for a contract that answers badly, and a
decimals override is logged.

Removing a token only takes it out of the picker. Plans already buying it keep running, keep their
holdings, and can still be cancelled and withdrawn — nothing here touches a balance.

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
