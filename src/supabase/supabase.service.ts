import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { PLAN_ADMIN_CONTROLS_DDL } from './plan-admin-controls';

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

  async onModuleInit(): Promise<void> {
    if (this.isConfigured()) {
      try {
        await this.getPool();
      } catch (error) {
        this.logger.warn(`Supabase bootstrap failed: ${(error as Error).message}`);
      }
    }
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
    if (!this.bootstrapPromise) {
      this.bootstrapPromise = this.bootstrap();
    }
    return this.bootstrapPromise;
  }

  private async bootstrap(): Promise<Pool | null> {
    const connectionString = process.env.SUPABASE_DB_URL?.trim();
    if (!connectionString) return null;

    try {
      const pool = new Pool({
        connectionString,
        ssl: { rejectUnauthorized: false },
        max: 5,
      });
      await this.ensureSchema(pool);
      this.pool = pool;
      return pool;
    } catch (error) {
      const message = `Supabase connection failed: ${(error as Error).message}`;
      this.logger.warn(message);
      this.pool = null;
      this.bootstrapPromise = null;
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

  async getRunRecord(runId: string): Promise<unknown | null> {
    const pool = await this.getPool();
    if (!pool) throw new Error('Supabase is not configured or connection failed.');
    const { rows } = await pool.query('SELECT data FROM run_history WHERE run_id = $1', [runId]);
    return rows.length === 0 ? null : rows[0].data;
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
