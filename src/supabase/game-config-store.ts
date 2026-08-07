/**
 * Echo Arena's editable catalogue and rule set: the Store shelf, the SP economy, the arena
 * constants, the anti-cheat bounds, the feature flags and the daily quests.
 *
 * These are the tables behind the dashboard's Store and Settings pages. The game reads the merged
 * result over HTTP (`GET /api/game/config`) rather than from here, because the two apps are separate
 * deployments and only one of them owns this data — this one.
 *
 * Three tables, one concern:
 *
 * - `echo_store_catalog` — one row per sellable cosmetic. `(kind, item_id)` is the key a player's
 *   locker row points at, so it is unique and never rewritten by an edit.
 * - `echo_game_settings` — one row per settings *section*, holding that section's JSON. Sectioned
 *   rather than one blob so two operators editing different pages cannot clobber each other, and
 *   rather than one row per leaf so a section always reads back internally consistent.
 * - `echo_game_quests` — one row per daily quest.
 *
 * DI-free (SUPABASE_DB_URL) and on the shared pool, matching the other stores in this folder.
 */
import type { Pool } from 'pg';
import { getSharedPool } from './pg-pool';
import {
  DEFAULT_CATALOG,
  DEFAULT_QUESTS,
  type CatalogItem,
  type CosmeticKind,
  type CosmeticRequirement,
  type QuestDefinition,
  type QuestMetric,
} from '../game-config/game-defaults';

function getPool(): Pool | null {
  return getSharedPool();
}

function requirePool(): Pool {
  const p = getPool();
  if (!p) throw new Error('SUPABASE_DB_URL is not configured.');
  return p;
}

export const GAME_CONFIG_DDL = `
  CREATE TABLE IF NOT EXISTS echo_store_catalog (
    id bigserial PRIMARY KEY,
    kind text NOT NULL,
    item_id text NOT NULL,
    art text NOT NULL,
    name text NOT NULL,
    eyebrow text NOT NULL DEFAULT '',
    blurb text NOT NULL DEFAULT '',
    requires text NOT NULL DEFAULT 'pass',
    sp_required integer NOT NULL DEFAULT 0,
    ink text NOT NULL,
    accent text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    sort_order integer NOT NULL DEFAULT 100,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS echo_store_catalog_kind_item_uq
    ON echo_store_catalog (kind, item_id);

  CREATE TABLE IF NOT EXISTS echo_game_settings (
    section text PRIMARY KEY,
    value jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS echo_game_quests (
    key text PRIMARY KEY,
    label text NOT NULL,
    metric text NOT NULL,
    target integer NOT NULL,
    reward integer NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    sort_order integer NOT NULL DEFAULT 100,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
`;

/**
 * The settings section that records the seed already ran.
 *
 * Without it, an operator who deliberately empties the Store would find it fully restocked by the
 * next deploy, because "no rows" and "never seeded" look identical. This makes them different.
 */
const SEED_MARKER_SECTION = '_seeded';

export async function ensureGameConfigSchema(): Promise<void> {
  const p = requirePool();
  await p.query(GAME_CONFIG_DDL);
}

/**
 * Create the tables and, the first time only, fill them with the shipped catalogue and quests.
 *
 * Safe to call on every boot: the seed is skipped once the marker is present, and the marker is
 * written in the same transaction as the rows so a crash halfway cannot leave a half-stocked Store.
 */
export async function ensureGameConfigSeeded(): Promise<{ seeded: boolean }> {
  const p = requirePool();
  await p.query(GAME_CONFIG_DDL);

  const { rows } = await p.query('SELECT 1 FROM echo_game_settings WHERE section = $1', [
    SEED_MARKER_SECTION,
  ]);
  if (rows.length) return { seeded: false };

  const client = await p.connect();
  try {
    await client.query('BEGIN');
    for (const item of DEFAULT_CATALOG) {
      await client.query(
        `INSERT INTO echo_store_catalog
           (kind, item_id, art, name, eyebrow, blurb, requires, sp_required, ink, accent, enabled, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (kind, item_id) DO NOTHING`,
        [
          item.kind,
          item.itemId,
          item.art,
          item.name,
          item.eyebrow,
          item.blurb,
          item.requires,
          item.spRequired,
          item.ink,
          item.accent,
          item.enabled,
          item.sortOrder,
        ],
      );
    }
    for (const quest of DEFAULT_QUESTS) {
      await client.query(
        `INSERT INTO echo_game_quests (key, label, metric, target, reward, enabled, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (key) DO NOTHING`,
        [quest.key, quest.label, quest.metric, quest.target, quest.reward, quest.enabled, quest.sortOrder],
      );
    }
    await client.query(
      `INSERT INTO echo_game_settings (section, value) VALUES ($1, $2)
       ON CONFLICT (section) DO NOTHING`,
      [SEED_MARKER_SECTION, JSON.stringify({ at: new Date().toISOString() })],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return { seeded: true };
}

/* ------------------------------------------------------------------------------------------------
 * Catalogue
 * --------------------------------------------------------------------------------------------- */

export interface CatalogRow extends CatalogItem {
  id: number;
  createdAt: Date;
  updatedAt: Date;
}

function mapCatalogRow(r: Record<string, unknown>): CatalogRow {
  return {
    id: Number(r.id),
    kind: String(r.kind) as CosmeticKind,
    itemId: String(r.item_id),
    art: String(r.art),
    name: String(r.name),
    eyebrow: String(r.eyebrow ?? ''),
    blurb: String(r.blurb ?? ''),
    requires: String(r.requires) as CosmeticRequirement,
    spRequired: Number(r.sp_required ?? 0),
    ink: String(r.ink),
    accent: String(r.accent),
    enabled: Boolean(r.enabled),
    sortOrder: Number(r.sort_order ?? 100),
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}

/** Every catalogue row, shelf order. `enabledOnly` is what the game is served. */
export async function listCatalog(enabledOnly = false): Promise<CatalogRow[]> {
  const p = getPool();
  if (!p) return [];
  const { rows } = await p.query(
    `SELECT * FROM echo_store_catalog
      ${enabledOnly ? 'WHERE enabled = true' : ''}
      ORDER BY kind, sort_order, item_id`,
  );
  return rows.map(mapCatalogRow);
}

export async function getCatalogItem(id: number): Promise<CatalogRow | null> {
  const p = getPool();
  if (!p) return null;
  const { rows } = await p.query('SELECT * FROM echo_store_catalog WHERE id = $1', [id]);
  return rows.length ? mapCatalogRow(rows[0]) : null;
}

export async function createCatalogItem(item: CatalogItem): Promise<CatalogRow> {
  const p = requirePool();
  const { rows } = await p.query(
    `INSERT INTO echo_store_catalog
       (kind, item_id, art, name, eyebrow, blurb, requires, sp_required, ink, accent, enabled, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      item.kind,
      item.itemId,
      item.art,
      item.name,
      item.eyebrow,
      item.blurb,
      item.requires,
      item.spRequired,
      item.ink,
      item.accent,
      item.enabled,
      item.sortOrder,
    ],
  );
  return mapCatalogRow(rows[0]);
}

/**
 * Update the mutable columns of one item.
 *
 * `item_id` and `kind` are deliberately not among them: a locker row stores `(kind, item_id)`, so
 * changing either would silently un-equip every wallet flying it. Retire the item and add a new one
 * instead — the pilots keep their old row and simply fall back until they pick again.
 */
export async function updateCatalogItem(
  id: number,
  patch: Partial<Omit<CatalogItem, 'kind' | 'itemId'>>,
): Promise<CatalogRow | null> {
  const p = requirePool();
  const columns: Record<string, string> = {
    art: 'art',
    name: 'name',
    eyebrow: 'eyebrow',
    blurb: 'blurb',
    requires: 'requires',
    spRequired: 'sp_required',
    ink: 'ink',
    accent: 'accent',
    enabled: 'enabled',
    sortOrder: 'sort_order',
  };

  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const [key, column] of Object.entries(columns)) {
    const value = (patch as Record<string, unknown>)[key];
    if (value === undefined) continue;
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  if (!sets.length) return getCatalogItem(id);

  const { rows } = await p.query(
    `UPDATE echo_store_catalog SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    params,
  );
  return rows.length ? mapCatalogRow(rows[0]) : null;
}

export async function deleteCatalogItem(id: number): Promise<CatalogRow | null> {
  const p = requirePool();
  const { rows } = await p.query('DELETE FROM echo_store_catalog WHERE id = $1 RETURNING *', [id]);
  return rows.length ? mapCatalogRow(rows[0]) : null;
}

/** Rewrite the shelf order of one kind in one statement, so no intermediate order is ever served. */
export async function reorderCatalog(kind: CosmeticKind, orderedIds: number[]): Promise<void> {
  if (!orderedIds.length) return;
  const p = requirePool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    for (let index = 0; index < orderedIds.length; index += 1) {
      await client.query(
        'UPDATE echo_store_catalog SET sort_order = $3, updated_at = now() WHERE id = $1 AND kind = $2',
        [orderedIds[index], kind, (index + 1) * 10],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Restore the shipped catalogue: every default item is put back as it ships, and anything the
 * operator added on top is left alone. Added items are theirs — a reset is "undo my edits", not
 * "delete my work".
 */
export async function resetCatalogToDefaults(): Promise<number> {
  const p = requirePool();
  const client = await p.connect();
  let touched = 0;
  try {
    await client.query('BEGIN');
    for (const item of DEFAULT_CATALOG) {
      const { rowCount } = await client.query(
        `INSERT INTO echo_store_catalog
           (kind, item_id, art, name, eyebrow, blurb, requires, sp_required, ink, accent, enabled, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (kind, item_id) DO UPDATE SET
           art = EXCLUDED.art, name = EXCLUDED.name, eyebrow = EXCLUDED.eyebrow,
           blurb = EXCLUDED.blurb, requires = EXCLUDED.requires,
           sp_required = EXCLUDED.sp_required, ink = EXCLUDED.ink, accent = EXCLUDED.accent,
           enabled = EXCLUDED.enabled, sort_order = EXCLUDED.sort_order, updated_at = now()`,
        [
          item.kind,
          item.itemId,
          item.art,
          item.name,
          item.eyebrow,
          item.blurb,
          item.requires,
          item.spRequired,
          item.ink,
          item.accent,
          item.enabled,
          item.sortOrder,
        ],
      );
      touched += rowCount ?? 0;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return touched;
}

/* ------------------------------------------------------------------------------------------------
 * Settings
 * --------------------------------------------------------------------------------------------- */

/** Stored section JSON, keyed by section name. Sections never written are simply absent. */
export async function readSettingSections(): Promise<Record<string, Record<string, unknown>>> {
  const p = getPool();
  if (!p) return {};
  const { rows } = await p.query(
    'SELECT section, value FROM echo_game_settings WHERE section <> $1',
    [SEED_MARKER_SECTION],
  );
  const out: Record<string, Record<string, unknown>> = {};
  for (const row of rows) {
    out[String(row.section)] = (row.value ?? {}) as Record<string, unknown>;
  }
  return out;
}

/** Replace one section's stored JSON. The service validates and merges before calling this. */
export async function writeSettingSection(
  section: string,
  value: Record<string, unknown>,
): Promise<void> {
  const p = requirePool();
  await p.query(
    `INSERT INTO echo_game_settings (section, value) VALUES ($1, $2)
     ON CONFLICT (section) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [section, JSON.stringify(value)],
  );
}

/** Drop a section's overrides so it falls all the way back to the shipped defaults. */
export async function clearSettingSection(section: string): Promise<void> {
  const p = requirePool();
  await p.query('DELETE FROM echo_game_settings WHERE section = $1', [section]);
}

/** When the settings were last touched, for the dashboard's "saved" line and the game's cache. */
export async function settingsUpdatedAt(): Promise<Date | null> {
  const p = getPool();
  if (!p) return null;
  const { rows } = await p.query(
    `SELECT max(t) AS at FROM (
       SELECT max(updated_at) AS t FROM echo_game_settings
       UNION ALL SELECT max(updated_at) FROM echo_store_catalog
       UNION ALL SELECT max(updated_at) FROM echo_game_quests
     ) s`,
  );
  const at = rows[0]?.at;
  return at ? new Date(at as string) : null;
}

/* ------------------------------------------------------------------------------------------------
 * Quests
 * --------------------------------------------------------------------------------------------- */

function mapQuestRow(r: Record<string, unknown>): QuestDefinition {
  return {
    key: String(r.key),
    label: String(r.label),
    metric: String(r.metric) as QuestMetric,
    target: Number(r.target),
    reward: Number(r.reward),
    enabled: Boolean(r.enabled),
    sortOrder: Number(r.sort_order ?? 100),
  };
}

export async function listQuests(enabledOnly = false): Promise<QuestDefinition[]> {
  const p = getPool();
  if (!p) return [];
  const { rows } = await p.query(
    `SELECT * FROM echo_game_quests ${enabledOnly ? 'WHERE enabled = true' : ''} ORDER BY sort_order, key`,
  );
  return rows.map(mapQuestRow);
}

export async function upsertQuest(quest: QuestDefinition): Promise<QuestDefinition> {
  const p = requirePool();
  const { rows } = await p.query(
    `INSERT INTO echo_game_quests (key, label, metric, target, reward, enabled, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (key) DO UPDATE SET
       label = EXCLUDED.label, metric = EXCLUDED.metric, target = EXCLUDED.target,
       reward = EXCLUDED.reward, enabled = EXCLUDED.enabled, sort_order = EXCLUDED.sort_order,
       updated_at = now()
     RETURNING *`,
    [quest.key, quest.label, quest.metric, quest.target, quest.reward, quest.enabled, quest.sortOrder],
  );
  return mapQuestRow(rows[0]);
}

export async function deleteQuest(key: string): Promise<boolean> {
  const p = requirePool();
  const { rowCount } = await p.query('DELETE FROM echo_game_quests WHERE key = $1', [key]);
  return (rowCount ?? 0) > 0;
}

export async function resetQuestsToDefaults(): Promise<void> {
  const p = requirePool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    for (const quest of DEFAULT_QUESTS) {
      await client.query(
        `INSERT INTO echo_game_quests (key, label, metric, target, reward, enabled, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (key) DO UPDATE SET
           label = EXCLUDED.label, metric = EXCLUDED.metric, target = EXCLUDED.target,
           reward = EXCLUDED.reward, enabled = EXCLUDED.enabled, sort_order = EXCLUDED.sort_order,
           updated_at = now()`,
        [quest.key, quest.label, quest.metric, quest.target, quest.reward, quest.enabled, quest.sortOrder],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
