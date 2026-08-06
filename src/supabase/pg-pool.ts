import { Pool } from 'pg';

/**
 * One process-wide pg Pool shared by every DI-free store module in this folder.
 *
 * Why this exists: each store used to open `new Pool({ max: 3 })` at module load, so the ~14 of them
 * collectively held up to ~42 server connections against the Supabase pooler. In session mode the
 * pooler caps a project at `pool_size` (15 on our plan), so under any concurrency the app hit
 * `EMAXCONNSESSION: max clients reached in session mode`. Funnelling every store through a single
 * pool makes it impossible to exceed `max` connections no matter how many modules query at once.
 *
 * DI-free on purpose: the standalone relayer (`npm run run`) reads these stores without booting
 * Nest, so the pool can't live inside SupabaseService. SupabaseService keeps its own small pool
 * (max 5) for the runtime-session / schema-bootstrap path; that plus this pool's `max` stays well
 * under the 15-connection ceiling.
 *
 * `max: 8` is the shared ceiling — 8 (stores) + 5 (SupabaseService) = 13 < 15, leaving headroom.
 */
let pool: Pool | null = null;

export function getSharedPool(): Pool | null {
  const connectionString = process.env.SUPABASE_DB_URL?.trim();
  if (!connectionString) return null;
  if (!pool) {
    pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 8 });
    // The Supabase pooler drops idle connections; an unhandled 'error' event on an idle client
    // would take the whole process down. Swallow it — pg re-acquires on the next query.
    pool.on('error', () => {});
  }
  return pool;
}
