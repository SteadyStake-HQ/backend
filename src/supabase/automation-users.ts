/**
 * Standalone Supabase access to the DCA automation-user registration list, for use
 * outside NestJS DI (the run-executor). Replaces the former Upstash KV set.
 * Reads SUPABASE_DB_URL directly and reuses a module-level pool.
 */
import { Pool } from 'pg';

let pool: Pool | null = null;

function getPool(): Pool | null {
  const connectionString = process.env.SUPABASE_DB_URL?.trim();
  if (!connectionString) return null;
  if (!pool) {
    pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 3 });
  }
  return pool;
}

export function isSupabaseConfigured(): boolean {
  return typeof process.env.SUPABASE_DB_URL === 'string' && process.env.SUPABASE_DB_URL.trim().length > 0;
}

/** Returns registered members as `${chainId}:${userAddress}` strings. Throws if unreachable. */
export async function getAutomationUsersFromSupabase(): Promise<string[]> {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  const { rows } = await p.query('SELECT member FROM automation_users');
  return rows.map((r) => r.member as string);
}
