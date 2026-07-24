# SteadyStake DCA Executor

Standalone backend that runs DCA execution: reads registered users from Supabase, finds ready schedules, gets 0x quotes, sends `executeSwap` from the relayer wallet, then deducts gas cost from the user's GasTank via `recordExecution`. Scheduler config, runtime state, run/gas/portfolio history, and the runtime session are persisted to Supabase Postgres (with local-JSON fallback when `SUPABASE_DB_URL` is unset).

## Setup

1. Copy `.env.example` to `.env` and set:
   - `RELAYER_PRIVATE_KEY` – wallet that sends txs (must be GasTank executor)
   - `SUPABASE_DB_URL` – Supabase Postgres (Session Pooler) connection string, shared with the frontend; stores DCA plans (`dca_plans`), the registered-user list, scheduler state/config, and history. Scheduler state/config/history fall back to local JSON files when unset, but **plans and members are database-only** — without it, `/api/plans` returns nothing and the executor has no members to run (see “DCA plans” below).
   - `ZERO_EX_API_KEY` (optional)
   - `GAS_COST_PER_EXECUTION_USDC` (optional): if set, use this fixed USD amount per execution; otherwise cost is derived from network gas + Coingecko native token price
   - `AUTOMATION_CHAIN_IDS` (optional): comma-separated chain IDs to run (e.g. `84532,11155111`). **Leave empty to run all chains that have a GasTank in `deployed-addresses.json`** (Base Sepolia, Ethereum Sepolia, etc.).
   - `PORT` (optional, default `3340`): HTTP server port for the scheduler dashboard

2. Add **GasTank** address per chain to `deployed-addresses.json` (deploy GasTank first; see contracts and frontend docs).

## Run

- **Start (recommended):** `npm start` – starts the HTTP server and runs the DCA executor on a **configurable period** (default: once per day). The backend stays on.
  - Open **http://localhost:3340** (or your `PORT`) for the **scheduler dashboard**: set run period (1 hour, 6h, 12h, 1 day, 1 week), trigger “Run now”, and see last/next run status. The dashboard also shows **run history** (each DCA run with executed tasks and errors), **gas tank balance history** (per user/chain, recorded after each execution), and **DCA plan history** (schedule IDs per user at each run).
- **One-off run:** `npm run run` – builds and runs the executor once, then exits.
- **Legacy loop (every 5 min):** `npm run build && npm run loop`.

Use pm2 or systemd in production to keep `npm start` running (the server process runs the executor on the configured interval).

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
