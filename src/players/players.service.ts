import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  getPlayTotals,
  getPlayer,
  isPlayMode,
  listDailyCounters,
  listPlayers,
  listPlayerRuns,
  listSpLedger,
  type PlayMode,
  type PlayerSort,
} from '../supabase/game-players-store';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SORTS: readonly PlayerSort[] = ['last_played', 'sp', 'best_score', 'runs'];

/**
 * The operator's read model over Echo Arena play: who has played, what they played, and where every
 * Steady Point came from.
 *
 * Read-only. SP is credited by the game's submit path, which owns the daily caps and the
 * `(reason, source_id)` idempotency key that stops a retried submit double-crediting; writing SP
 * from here would sit outside both.
 */
@Injectable()
export class PlayersService {
  /** Page header totals — how much play and how much SP exists in total. */
  totals() {
    return getPlayTotals();
  }

  async list(query: Record<string, unknown>) {
    const sort = SORTS.includes(query.sort as PlayerSort) ? (query.sort as PlayerSort) : 'last_played';
    const { players, total } = await listPlayers({
      search: typeof query.search === 'string' ? query.search : undefined,
      sort,
      limit: toInt(query.limit, 50),
      offset: toInt(query.offset, 0),
    });
    return { players, total, sort };
  }

  /**
   * One wallet's full record: summary, run history (optionally filtered to a mode), SP ledger, and
   * the recent daily counters the SP cap was measured against.
   */
  async detail(address: string, query: Record<string, unknown>) {
    const wallet = requireAddress(address);
    const player = await getPlayer(wallet);
    if (!player) {
      throw new NotFoundException({
        ok: false,
        error: 'That wallet has no recorded Echo Arena play.',
      });
    }

    const mode = query.mode === undefined || query.mode === '' || query.mode === 'all'
      ? undefined
      : requireMode(query.mode);

    const [runs, ledger, daily] = await Promise.all([
      listPlayerRuns(wallet, { mode, limit: toInt(query.limit, 50), offset: toInt(query.offset, 0) }),
      listSpLedger(wallet, { limit: toInt(query.spLimit, 100) }),
      listDailyCounters(wallet),
    ]);

    return { player, mode: mode ?? 'all', runs, ledger, daily };
  }

  /** A wallet's run history on its own, for paging the table without refetching the rest. */
  async runs(address: string, query: Record<string, unknown>) {
    const wallet = requireAddress(address);
    const mode = query.mode === undefined || query.mode === '' || query.mode === 'all'
      ? undefined
      : requireMode(query.mode);
    return listPlayerRuns(wallet, {
      mode,
      limit: toInt(query.limit, 50),
      offset: toInt(query.offset, 0),
    });
  }

  /** A wallet's SP ledger on its own. */
  async ledger(address: string, query: Record<string, unknown>) {
    return listSpLedger(requireAddress(address), {
      limit: toInt(query.limit, 100),
      offset: toInt(query.offset, 0),
    });
  }
}

function requireAddress(address: string): string {
  const value = (address ?? '').trim();
  if (!ADDRESS.test(value)) {
    throw new BadRequestException({ ok: false, error: 'A 0x-prefixed 40-hex wallet address is required.' });
  }
  return value.toLowerCase();
}

function requireMode(value: unknown): PlayMode {
  if (!isPlayMode(value)) {
    throw new BadRequestException({
      ok: false,
      error: "mode must be one of 'ranked', 'open_verified', 'normal', or 'all'.",
    });
  }
  return value;
}

function toInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
