import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { NETWORK_ALLOCATIONS_DDL } from './network-allocations';
import { PLAN_ADMIN_CONTROLS_DDL } from './plan-admin-controls';
import { PLAN_EXECUTION_GATES_DDL } from './plan-execution-gates';
import { TOKEN_LIST_DDL } from './token-list';

export interface RuntimeSessionRecord {
  sessionKey?: string;
  run_period: Date;
  next_run: Date;
  isTimeAt: boolean;
  intervalMs?: number;
  chainIds?: number[];
  updatedAt: Date;
}

const RUNTIME_SESSION_KEY = 'runtime_session';

/**
 * One chain's execution economics over the whole run history. Costs in dollars, gas in units.
 * Every `*Samples` count says how many records the figure beside it is drawn from, so a caller can
 * tell a one-run chain from a thousand-run one without inferring it.
 */
export interface RunCostAggregateRow {
  chainId: number;
  /** Runs on this chain whose GasTank deduction actually landed — the ones with a real charge. */
  costSamples: number;
  costAvgUsd: number | null;
  costMaxUsd: number | null;
  costMinUsd: number | null;
  /** The most recent charge, by run time. */
  costLastUsd: number | null;
  /** Of those, the ones paid out of another network's tank, and what they averaged. */
  crossChainSamples: number;
  crossChainAvgUsd: number | null;
  sameChainSamples: number;
  sameChainAvgUsd: number | null;
  /** Runs whose two legs both ran here, so their gas totals are a fact about this chain. */
  gasSamples: number;
  gasUnitsMedian: number | null;
  /** The busy-day figure: nine runs in ten burned no more than this. */
  gasUnitsP90: number | null;
  gasUnitsMax: number | null;
  swapGasSamples: number;
  swapGasMedian: number | null;
  swapGasP90: number | null;
  /** The deduction leg on its own — the one the relayer has to price before it can measure it. */
  recordGasSamples: number;
  recordGasMedian: number | null;
  recordGasP90: number | null;
  firstAt: string | null;
  lastAt: string | null;
}

/**
 * A numeric column as a number, or null.
 *
 * pg hands `numeric` and `bigint` back as strings and an empty aggregate back as SQL NULL, so both
 * have to be handled. The null check is explicit rather than left to `Number()`: `Number(null)` is
 * `0`, and a `0` where a null belongs is not a harmless difference here — it reads as "this leg
 * burns no gas", which is a figure the relayer would go on to charge against.
 */
function numOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function intOrNull(value: unknown): number | null {
  const n = numOrNull(value);
  return n == null ? null : Math.round(n);
}

/**
 * One row of RUN_COST_AGGREGATE_SQL as the rest of the app reads it.
 *
 * Exported and pure so the aggregation can be exercised end to end against a real Postgres without
 * a second copy of this mapping being written to do it — and a second copy is exactly where the
 * `Number(null) === 0` trap gets reintroduced.
 */
export function mapRunCostAggregateRow(r: Record<string, unknown>): RunCostAggregateRow {
  return {
    chainId: Number(r.chain_id),
    costSamples: Number(r.cost_samples ?? 0),
    costAvgUsd: numOrNull(r.cost_avg),
    costMaxUsd: numOrNull(r.cost_max),
    costMinUsd: numOrNull(r.cost_min),
    costLastUsd: numOrNull(r.cost_last),
    crossChainSamples: Number(r.cross_samples ?? 0),
    crossChainAvgUsd: numOrNull(r.cross_avg),
    sameChainSamples: Number(r.same_samples ?? 0),
    sameChainAvgUsd: numOrNull(r.same_avg),
    gasSamples: Number(r.gas_samples ?? 0),
    gasUnitsMedian: intOrNull(r.gas_median),
    gasUnitsP90: intOrNull(r.gas_p90),
    gasUnitsMax: intOrNull(r.gas_max),
    swapGasSamples: Number(r.swap_gas_samples ?? 0),
    swapGasMedian: intOrNull(r.swap_gas_median),
    swapGasP90: intOrNull(r.swap_gas_p90),
    recordGasSamples: Number(r.record_gas_samples ?? 0),
    recordGasMedian: intOrNull(r.record_gas_median),
    recordGasP90: intOrNull(r.record_gas_p90),
    firstAt: r.first_at instanceof Date ? r.first_at.toISOString() : ((r.first_at as string) ?? null),
    lastAt: r.last_at instanceof Date ? r.last_at.toISOString() : ((r.last_at as string) ?? null),
  };
}

/** The aggregation itself, so a caller with a query runner can reuse it. */
export function runCostAggregateSql(): string {
  return RUN_COST_AGGREGATE_SQL;
}

/**
 * Every execution in `run_history`, unnested and rolled up per chain.
 *
 * Three stages, because each one can only be done once the one before it has happened:
 *
 *  - `task` flattens `data->'executedTasks'` — one row per executed plan rather than per sweep —
 *    and pulls the fields out as numbers. Text that is not a plain integer becomes NULL rather
 *    than erroring the whole query: these are JSON blobs written by several versions of the
 *    executor, and one malformed row must not cost the chain its statistics.
 *  - `scaled` turns a charge in the chain's own stablecoin base units into dollars, and decides
 *    which gas figures this chain may claim (see the method comment on cross-chain runs).
 *  - `clean` drops the implausible: a charge of thirty dollars is a units mistake and a total of
 *    nine gas is a mis-attributed receipt, and either one would sit in `max` forever.
 *
 * The WHERE clause of `task` is the predicate of `run_history_executed_at_idx` verbatim, so the
 * planner can walk the ~1% of rows that executed something instead of the whole table.
 */
const RUN_COST_AGGREGATE_SQL = `
WITH task AS (
  SELECT
    r.at AS at,
    (t->>'chainId')::int AS chain_id,
    CASE WHEN (t->>'gasDeductChainId') ~ '^[0-9]+$'
         THEN (t->>'gasDeductChainId')::int
         ELSE (t->>'chainId')::int
    END AS deduct_chain_id,
    -- Charged unless the record explicitly says the deduction did not land. Matches the treasury
    -- ledger's own rule (treasury.service.ts) exactly, so the average quoted in the gas tank is
    -- the average of the very column the ledger prints. The gasDeducted flag post-dates the
    -- earliest records, and treating its absence as "not charged" would silently drop them.
    (t->>'gasDeducted') IS DISTINCT FROM 'false' AS deducted,
    CASE WHEN (t->>'costUsdc6') ~ '^[0-9]+$' THEN (t->>'costUsdc6')::numeric END AS cost_raw,
    CASE WHEN (t->>'gasUsed') ~ '^[0-9]+$' THEN (t->>'gasUsed')::numeric END AS swap_gas,
    CASE WHEN (t->>'recordGasUsed') ~ '^[0-9]+$' THEN (t->>'recordGasUsed')::numeric END AS record_gas
  FROM run_history r
  CROSS JOIN LATERAL jsonb_array_elements(r.data->'executedTasks') AS tasks(t)
  WHERE jsonb_typeof(r.data->'executedTasks') = 'array'
    AND jsonb_array_length(r.data->'executedTasks') > 0
    AND jsonb_typeof(t) = 'object'
    AND (t->>'chainId') ~ '^[0-9]+$'
),
scaled AS (
  SELECT
    at,
    chain_id,
    (deduct_chain_id <> chain_id) AS cross_chain,
    CASE WHEN deducted AND cost_raw IS NOT NULL
         THEN cost_raw / power(10::numeric, COALESCE(($1::jsonb ->> chain_id::text)::int, 6))
    END AS cost_usd,
    CASE WHEN deduct_chain_id = chain_id AND swap_gas > 0 AND record_gas > 0
         THEN swap_gas + record_gas
    END AS total_gas,
    swap_gas,
    CASE WHEN deduct_chain_id = chain_id THEN record_gas END AS record_gas
  FROM task
),
clean AS (
  SELECT
    at,
    chain_id,
    cross_chain,
    CASE WHEN cost_usd > 0 AND cost_usd <= $2::numeric THEN cost_usd END AS cost_usd,
    CASE WHEN total_gas BETWEEN $3::numeric AND $4::numeric THEN total_gas END AS total_gas,
    CASE WHEN swap_gas BETWEEN $3::numeric AND $4::numeric THEN swap_gas END AS swap_gas,
    CASE WHEN record_gas BETWEEN $3::numeric AND $4::numeric THEN record_gas END AS record_gas
  FROM scaled
)
SELECT
  chain_id,
  count(cost_usd) AS cost_samples,
  avg(cost_usd) AS cost_avg,
  max(cost_usd) AS cost_max,
  min(cost_usd) AS cost_min,
  (array_agg(cost_usd ORDER BY at DESC) FILTER (WHERE cost_usd IS NOT NULL))[1] AS cost_last,
  count(cost_usd) FILTER (WHERE cross_chain) AS cross_samples,
  avg(cost_usd) FILTER (WHERE cross_chain) AS cross_avg,
  count(cost_usd) FILTER (WHERE NOT cross_chain) AS same_samples,
  avg(cost_usd) FILTER (WHERE NOT cross_chain) AS same_avg,
  count(total_gas) AS gas_samples,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY total_gas::double precision) AS gas_median,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY total_gas::double precision) AS gas_p90,
  max(total_gas) AS gas_max,
  count(swap_gas) AS swap_gas_samples,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY swap_gas::double precision) AS swap_gas_median,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY swap_gas::double precision) AS swap_gas_p90,
  count(record_gas) AS record_gas_samples,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY record_gas::double precision) AS record_gas_median,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY record_gas::double precision) AS record_gas_p90,
  min(at) AS first_at,
  max(at) AS last_at
FROM clean
GROUP BY chain_id
ORDER BY chain_id
`;

/**
 * Connect/query budgets. pg defaults connectionTimeoutMillis to 0 — wait forever — which turns an
 * unreachable pooler into a boot that never finishes, so the HTTP server never binds its port.
 * Every DB call here has a file or in-memory fallback, so failing fast costs nothing.
 */
const CONNECT_TIMEOUT_MS = 8_000;
const QUERY_TIMEOUT_MS = 15_000;
/** After a failed connect, hold off retrying so one boot isn't N sequential connect timeouts. */
const RETRY_COOLDOWN_MS = 30_000;

/**
 * Supabase Postgres persistence for scheduler runtime session, scheduler config,
 * scheduler runtime state, and run/gas/portfolio history.
 *
 * Configured via SUPABASE_DB_URL (Session Pooler connection string). When unset or
 * unreachable, callers fall back to local JSON files, so the scheduler keeps running.
 */
@Injectable()
export class SupabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SupabaseService.name);
  private pool: Pool | null = null;
  private bootstrapPromise: Promise<Pool | null> | null = null;
  private lastConnectFailureAt: number | null = null;

  onModuleInit(): void {
    if (!this.isConfigured()) return;
    // Warm the pool in the background rather than awaiting it. Nest runs every onModuleInit to
    // completion before app.listen(), so awaiting a DB round trip here puts the database in front
    // of the HTTP server: if it is slow or unreachable, nothing ever binds the port.
    void this.getPool().catch((error) => {
      this.logger.warn(`Supabase bootstrap failed: ${(error as Error).message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  isConfigured(): boolean {
    return typeof process.env.SUPABASE_DB_URL === 'string' && process.env.SUPABASE_DB_URL.trim().length > 0;
  }

  private runtimeSessionTable(): string {
    return process.env.SUPABASE_RUNTIME_SESSION_TABLE?.trim() || 'runtime_session';
  }

  private async getPool(): Promise<Pool | null> {
    if (this.pool) return this.pool;
    if (
      this.lastConnectFailureAt != null &&
      Date.now() - this.lastConnectFailureAt < RETRY_COOLDOWN_MS
    ) {
      // Still inside the cooldown: report "no pool" immediately instead of paying the connect
      // timeout again. Callers treat null the same as unconfigured and fall back.
      return null;
    }
    if (!this.bootstrapPromise) {
      this.bootstrapPromise = this.bootstrap();
    }
    return this.bootstrapPromise;
  }

  private async bootstrap(): Promise<Pool | null> {
    const connectionString = process.env.SUPABASE_DB_URL?.trim();
    if (!connectionString) return null;

    let pool: Pool | null = null;
    try {
      pool = new Pool({
        connectionString,
        ssl: { rejectUnauthorized: false },
        max: 5,
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
        statement_timeout: QUERY_TIMEOUT_MS,
        query_timeout: QUERY_TIMEOUT_MS,
      });
      // An idle pool emits 'error' on a dropped backend connection; unhandled, that takes the
      // whole process down and Railway just restarts into the same state.
      pool.on('error', (error) => {
        this.logger.warn(`Supabase pool error: ${error.message}`);
      });
      await this.ensureSchema(pool);
      this.pool = pool;
      this.lastConnectFailureAt = null;
      return pool;
    } catch (error) {
      const message = `Supabase connection failed: ${(error as Error).message}`;
      this.logger.warn(message);
      void pool?.end().catch(() => undefined);
      this.pool = null;
      this.bootstrapPromise = null;
      this.lastConnectFailureAt = Date.now();
      throw new Error(message);
    }
  }

  private async ensureSchema(pool: Pool): Promise<void> {
    const runtimeSessionTable = this.runtimeSessionTable();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${runtimeSessionTable} (
        session_key text PRIMARY KEY,
        run_period timestamptz,
        next_run timestamptz,
        is_time_at boolean NOT NULL DEFAULT false,
        interval_ms bigint,
        chain_ids integer[],
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS kv_store (
        key text PRIMARY KEY,
        value jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS automation_users (
        member text PRIMARY KEY,
        chain_id integer NOT NULL,
        user_addr text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS run_history (
        run_id text PRIMARY KEY,
        at timestamptz NOT NULL,
        data jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS run_history_at_idx ON run_history (at DESC);
      -- Runs that actually executed a plan, which is what every reader of this table wants. They
      -- are roughly 1% of the rows — the scheduler writes a row every few seconds whether or not
      -- anything was due — so without a partial index "the last N executions" means walking tens of
      -- thousands of idle sweeps. The predicate is repeated verbatim in getRunRecordsWithExecutions
      -- so the planner matches it; changing one without the other silently loses the index.
      CREATE INDEX IF NOT EXISTS run_history_executed_at_idx ON run_history (at DESC)
        WHERE jsonb_typeof(data->'executedTasks') = 'array'
          AND jsonb_array_length(data->'executedTasks') > 0;

      CREATE TABLE IF NOT EXISTS gas_history (
        id bigserial PRIMARY KEY,
        chain_id integer NOT NULL,
        user_addr text NOT NULL,
        at timestamptz NOT NULL,
        balance_usdc6 text NOT NULL
      );
      CREATE INDEX IF NOT EXISTS gas_history_lookup_idx ON gas_history (chain_id, user_addr, at DESC);

      CREATE TABLE IF NOT EXISTS portfolio_history (
        id bigserial PRIMARY KEY,
        chain_id integer NOT NULL,
        user_addr text NOT NULL,
        at timestamptz NOT NULL,
        value_usdc6 text NOT NULL
      );
      CREATE INDEX IF NOT EXISTS portfolio_history_lookup_idx ON portfolio_history (chain_id, user_addr, at DESC);

      CREATE TABLE IF NOT EXISTS scheduler_settings_history (
        id text PRIMARY KEY,
        at timestamptz NOT NULL,
        data jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS scheduler_settings_history_at_idx ON scheduler_settings_history (at DESC);

      CREATE TABLE IF NOT EXISTS execution_timing_history (
        id text PRIMARY KEY,
        at timestamptz NOT NULL,
        data jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS execution_timing_history_at_idx ON execution_timing_history (at DESC);

      -- Event-indexed DCA plan metadata (created/ended time, committed total, exact swapped,
      -- completed-vs-cancelled). Populated by index-plans.ts; DDL shared with dca-plans-store.ts.
      CREATE TABLE IF NOT EXISTS dca_plans (
        chain_id integer NOT NULL,
        user_addr text NOT NULL,
        schedule_id integer NOT NULL,
        target_token text,
        frequency smallint,
        amount_per_interval_usdc6 text,
        committed_usdc6 text,
        swapped_usdc6 text,
        executed_count integer NOT NULL DEFAULT 0,
        created_at timestamptz,
        last_execution_at timestamptz,
        ended_at timestamptz,
        status text NOT NULL DEFAULT 'active',
        returned_usdc6 text,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (chain_id, user_addr, schedule_id)
      );
      CREATE INDEX IF NOT EXISTS dca_plans_member_idx ON dca_plans (chain_id, user_addr);

      CREATE TABLE IF NOT EXISTS dca_index_cursor (
        chain_id integer PRIMARY KEY,
        last_block bigint NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      -- Admin holds that stop the relayer auto-executing one plan; DDL shared with
      -- plan-admin-controls.ts. A row exists only while a hold is in force.
      ${PLAN_ADMIN_CONTROLS_DDL}

      -- The wait a resumed plan still owes, so lifting a hold does not fire it immediately; DDL
      -- shared with plan-execution-gates.ts. A row matters only until its not_before passes.
      ${PLAN_EXECUTION_GATES_DDL}

      -- Which registered networks are currently enabled / paused / removed, and any operator
      -- override of their mainnet-vs-testnet classification. A row exists only where an operator
      -- has overridden the registry default; DDL shared with network-allocations.ts.
      ${NETWORK_ALLOCATIONS_DDL}

      -- Which tokens each network offers in the "new plan" list, where each one came from, and
      -- which ones an operator has removed; DDL shared with token-list.ts. This replaced a JSON
      -- file baked into the frontend bundle, so an empty table means the app has no tokens to
      -- offer until an operator imports them.
      ${TOKEN_LIST_DDL}
    `);
  }

  // -------- Generic JSON KV (scheduler config, scheduler runtime state) --------

  async kvGetJson<T>(key: string): Promise<T | null> {
    const pool = await this.getPool();
    if (!pool) throw new Error('Supabase is not configured or connection failed.');
    const { rows } = await pool.query('SELECT value FROM kv_store WHERE key = $1', [key]);
    if (rows.length === 0) return null;
    return rows[0].value as T;
  }

  async kvSetJson<T>(key: string, value: T): Promise<void> {
    const pool = await this.getPool();
    if (!pool) throw new Error('Supabase is not configured or connection failed.');
    await pool.query(
      `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }

  // -------- Automation users (DCA registration list; replaces the Upstash KV set) --------

  async getAutomationUsers(): Promise<string[]> {
    const pool = await this.getPool();
    if (!pool) throw new Error('Supabase is not configured or connection failed.');
    const { rows } = await pool.query('SELECT member FROM automation_users');
    return rows.map((r) => r.member as string);
  }

  async addAutomationUser(chainId: number, userAddress: string): Promise<string> {
    const pool = await this.getPool();
    if (!pool) throw new Error('Supabase is not configured or connection failed.');
    const member = `${chainId}:${userAddress.toLowerCase()}`;
    await pool.query(
      `INSERT INTO automation_users (member, chain_id, user_addr) VALUES ($1, $2, $3)
       ON CONFLICT (member) DO NOTHING`,
      [member, chainId, userAddress.toLowerCase()],
    );
    return member;
  }

  // -------- Runtime session (replaces MongoDB) --------

  async upsertLatestRuntimeSession(record: Omit<RuntimeSessionRecord, 'sessionKey'>): Promise<void> {
    const pool = await this.getPool();
    if (!pool) throw new Error('Supabase is not configured or connection failed.');
    const table = this.runtimeSessionTable();
    await pool.query(
      `INSERT INTO ${table} (session_key, run_period, next_run, is_time_at, interval_ms, chain_ids, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (session_key) DO UPDATE SET
         run_period = EXCLUDED.run_period,
         next_run = EXCLUDED.next_run,
         is_time_at = EXCLUDED.is_time_at,
         interval_ms = EXCLUDED.interval_ms,
         chain_ids = EXCLUDED.chain_ids,
         updated_at = EXCLUDED.updated_at`,
      [
        RUNTIME_SESSION_KEY,
        record.run_period,
        record.next_run,
        record.isTimeAt,
        record.intervalMs ?? null,
        Array.isArray(record.chainIds) ? record.chainIds : null,
        record.updatedAt,
      ],
    );
  }

  async getLatestRuntimeSession(): Promise<RuntimeSessionRecord | null> {
    const pool = await this.getPool();
    if (!pool) throw new Error('Supabase is not configured or connection failed.');
    const table = this.runtimeSessionTable();
    const { rows } = await pool.query(
      `SELECT session_key, run_period, next_run, is_time_at, interval_ms, chain_ids, updated_at
       FROM ${table} WHERE session_key = $1`,
      [RUNTIME_SESSION_KEY],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      sessionKey: row.session_key,
      run_period: row.run_period,
      next_run: row.next_run,
      isTimeAt: row.is_time_at === true,
      intervalMs: row.interval_ms == null ? undefined : Number(row.interval_ms),
      chainIds: Array.isArray(row.chain_ids) ? row.chain_ids.map((id: unknown) => Number(id)) : undefined,
      updatedAt: row.updated_at,
    };
  }

  // -------- Run history --------

  async saveRunRecord(runId: string, at: Date, data: unknown): Promise<void> {
    const pool = await this.getPool();
    if (!pool) throw new Error('Supabase is not configured or connection failed.');
    await pool.query(
      `INSERT INTO run_history (run_id, at, data) VALUES ($1, $2, $3)
       ON CONFLICT (run_id) DO UPDATE SET at = EXCLUDED.at, data = EXCLUDED.data`,
      [runId, at, JSON.stringify(data)],
    );
  }

  async getRunRecords(limit: number): Promise<unknown[]> {
    const pool = await this.getPool();
    if (!pool) throw new Error('Supabase is not configured or connection failed.');
    const { rows } = await pool.query('SELECT data FROM run_history ORDER BY at DESC LIMIT $1', [limit]);
    return rows.map((r) => r.data);
  }

  /**
   * The newest `limit` runs that executed at least one plan.
   *
   * The scheduler records every sweep, and nearly all of them find nothing due — around 99 idle
   * rows for each row that matters. So "the last 100 rows" is roughly the last ten minutes of
   * clock time and almost never contains an execution at all: an execution record is real and
   * saved, and still falls out of that window minutes after it happened. Anything asking for
   * execution history has to filter here rather than take a slice off the top.
   *
   * The WHERE clause is the predicate of run_history_executed_at_idx, verbatim.
   */
  async getRunRecordsWithExecutions(limit: number): Promise<unknown[]> {
    const pool = await this.getPool();
    if (!pool) throw new Error('Supabase is not configured or connection failed.');
    const { rows } = await pool.query(
      `SELECT data FROM run_history
       WHERE jsonb_typeof(data->'executedTasks') = 'array'
         AND jsonb_array_length(data->'executedTasks') > 0
       ORDER BY at DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => r.data);
  }

  /** How many runs in the table executed something. Cheap: index-only over the partial index. */
  async countRunRecordsWithExecutions(): Promise<number> {
    const pool = await this.getPool();
    if (!pool) throw new Error('Supabase is not configured or connection failed.');
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM run_history
       WHERE jsonb_typeof(data->'executedTasks') = 'array'
         AND jsonb_array_length(data->'executedTasks') > 0`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Drop idle sweeps older than `olderThanDays`, and nothing else.
   *
   * The table grows by ~17k rows and ~17MB a day, essentially all of it rows that recorded that
   * nothing was due. Left alone it exhausts the database, and the first casualty is the INSERT of
   * the next real execution — the history would stop saving for real, not just stop being visible.
   *
   * A row survives if it executed anything or if it recorded an error, so no execution record and
   * no failure is ever removed by this, at any age. Gas and portfolio series live in their own
   * tables and are untouched.
   */
  async pruneIdleRunHistory(olderThanDays: number): Promise<number> {
    const pool = await this.getPool();
    if (!pool) throw new Error('Supabase is not configured or connection failed.');
    const { rowCount } = await pool.query(
      `DELETE FROM run_history
       WHERE at < now() - ($1 || ' days')::interval
         AND coalesce(jsonb_array_length(
               CASE WHEN jsonb_typeof(data->'executedTasks') = 'array'
                    THEN data->'executedTasks' ELSE '[]'::jsonb END), 0) = 0
         AND coalesce(jsonb_array_length(
               CASE WHEN jsonb_typeof(data->'errors') = 'array'
                    THEN data->'errors' ELSE '[]'::jsonb END), 0) = 0`,
      [String(olderThanDays)],
    );
    return rowCount ?? 0;
  }

  /**
   * Keep only the newest `keep` scheduler-timing rows. One is written per run and the API never
   * reads more than 100, so the rest is pure growth — 48MB of it at the time this was added.
   */
  async pruneExecutionTimingHistory(keep: number): Promise<number> {
    const pool = await this.getPool();
    if (!pool) throw new Error('Supabase is not configured or connection failed.');
    const { rowCount } = await pool.query(
      `DELETE FROM execution_timing_history
       WHERE id IN (
         SELECT id FROM execution_timing_history ORDER BY at DESC OFFSET $1
       )`,
      [keep],
    );
    return rowCount ?? 0;
  }

  async getRunRecord(runId: string): Promise<unknown | null> {
    const pool = await this.getPool();
    if (!pool) throw new Error('Supabase is not configured or connection failed.');
    const { rows } = await pool.query('SELECT data FROM run_history WHERE run_id = $1', [runId]);
    return rows.length === 0 ? null : rows[0].data;
  }

  /**
   * What every recorded execution on each chain burned and was charged — the whole table, not a
   * window, and every user rather than whoever is looking.
   *
   * This exists because the relayer's own sample store (gas-profile.ts) is a process-local file:
   * it is written to the working directory or /tmp, so on a container that redeploys it starts
   * empty, and in production it has been empty every time anyone has asked. The consequence was
   * visible to users — the gas tank's "average run" and "most expensive run" simply never
   * appeared, and the live estimate beside them multiplied by a seeded gas figure instead of a
   * measured one. `run_history` has held every execution the whole time, and nothing prunes an
   * executed run, so this is both durable and complete.
   *
   * The aggregation runs in SQL rather than by pulling records into Node because "all records"
   * means the table, and shipping every execution's JSON across the wire to average one field of
   * it would put a limit back in by the back door.
   *
   * Costs come back in **dollars**, already divided by the settling chain's stablecoin decimals —
   * `stableDecimalsByChain` maps chainId to decimals (BSC settles in an 18-decimal token, everyone
   * else in a 6-decimal one), so a raw average across chains would otherwise be out by 10^12.
   * Gas comes back in units, and only from runs whose two legs ran on the same chain: a
   * cross-chain settlement burned its gas at two different gas prices, so its total is a fact
   * about neither chain. Those runs still count toward the *cost* statistics, where the premium
   * they pay is the whole point of publishing them separately.
   */
  async getRunCostAggregatesByChain(options: {
    stableDecimalsByChain: Record<number, number>;
    /** A charge above this in dollars is a units mistake, not a run. Excluded from every figure. */
    maxPlausibleCostUsd: number;
    minPlausibleGas: number;
    maxPlausibleGas: number;
  }): Promise<RunCostAggregateRow[]> {
    const pool = await this.getPool();
    if (!pool) throw new Error('Supabase is not configured or connection failed.');
    const { rows } = await pool.query(RUN_COST_AGGREGATE_SQL, [
      JSON.stringify(options.stableDecimalsByChain),
      options.maxPlausibleCostUsd,
      options.minPlausibleGas,
      options.maxPlausibleGas,
    ]);
    return rows.map(mapRunCostAggregateRow);
  }

  async appendGasHistory(
    entries: Array<{ chainId: number; user: string; at: Date; balanceUsdc6: string }>,
  ): Promise<void> {
    if (entries.length === 0) return;
    const pool = await this.getPool();
    if (!pool) throw new Error('Supabase is not configured or connection failed.');
    for (const e of entries) {
      await pool.query(
        'INSERT INTO gas_history (chain_id, user_addr, at, balance_usdc6) VALUES ($1, $2, $3, $4)',
        [e.chainId, e.user.toLowerCase(), e.at, e.balanceUsdc6],
      );
    }
  }

  async appendPortfolioHistory(
    entries: Array<{ chainId: number; user: string; at: Date; valueUsdc6: string }>,
  ): Promise<void> {
    if (entries.length === 0) return;
    const pool = await this.getPool();
    if (!pool) throw new Error('Supabase is not configured or connection failed.');
    for (const e of entries) {
      await pool.query(
        'INSERT INTO portfolio_history (chain_id, user_addr, at, value_usdc6) VALUES ($1, $2, $3, $4)',
        [e.chainId, e.user.toLowerCase(), e.at, e.valueUsdc6],
      );
    }
  }

  async getGasHistory(
    user?: string,
    chainId?: number,
  ): Promise<Array<{ at: string; chainId: number; user: string; balanceUsdc6: string }>> {
    const pool = await this.getPool();
    if (!pool) throw new Error('Supabase is not configured or connection failed.');
    if (user && chainId != null) {
      const { rows } = await pool.query(
        `SELECT at, chain_id, user_addr, balance_usdc6 FROM gas_history
         WHERE chain_id = $1 AND user_addr = $2 ORDER BY at DESC LIMIT 500`,
        [chainId, user.toLowerCase()],
      );
      return rows.map((r) => ({
        at: new Date(r.at).toISOString(),
        chainId: Number(r.chain_id),
        user: r.user_addr,
        balanceUsdc6: r.balance_usdc6,
      }));
    }
    const { rows } = await pool.query(
      'SELECT at, chain_id, user_addr, balance_usdc6 FROM gas_history ORDER BY at DESC LIMIT 500',
    );
    return rows.map((r) => ({
      at: new Date(r.at).toISOString(),
      chainId: Number(r.chain_id),
      user: r.user_addr,
      balanceUsdc6: r.balance_usdc6,
    }));
  }

  async getPortfolioHistory(
    user: string,
    chainId: number,
    limit: number,
  ): Promise<Array<{ at: string; valueUsdc6: string }>> {
    const pool = await this.getPool();
    if (!pool) throw new Error('Supabase is not configured or connection failed.');
    const { rows } = await pool.query(
      `SELECT at, value_usdc6 FROM portfolio_history
       WHERE chain_id = $1 AND user_addr = $2 ORDER BY at DESC LIMIT $3`,
      [chainId, user.toLowerCase(), limit],
    );
    return rows.map((r) => ({ at: new Date(r.at).toISOString(), valueUsdc6: r.value_usdc6 }));
  }

  // -------- Scheduler settings / execution timing history --------

  async saveSchedulerEvent(
    table: 'scheduler_settings_history' | 'execution_timing_history',
    id: string,
    at: Date,
    data: unknown,
  ): Promise<void> {
    const pool = await this.getPool();
    if (!pool) throw new Error('Supabase is not configured or connection failed.');
    await pool.query(
      `INSERT INTO ${table} (id, at, data) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET at = EXCLUDED.at, data = EXCLUDED.data`,
      [id, at, JSON.stringify(data)],
    );
  }

  async getSchedulerEvents(
    table: 'scheduler_settings_history' | 'execution_timing_history',
    limit: number,
  ): Promise<unknown[]> {
    const pool = await this.getPool();
    if (!pool) throw new Error('Supabase is not configured or connection failed.');
    const { rows } = await pool.query(`SELECT data FROM ${table} ORDER BY at DESC LIMIT $1`, [limit]);
    return rows.map((r) => r.data);
  }
}
