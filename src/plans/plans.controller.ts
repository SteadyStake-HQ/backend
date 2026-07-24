import { Controller, Get, MessageEvent, Post, Query, Sse } from '@nestjs/common';
import { Observable } from 'rxjs';
import { PlansService } from './plans.service';

@Controller('api')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  /**
   * GET /api/plans — all DCA plans, read from the `dca_plans` table and enriched with live
   * contract state for active plans. Optional ?chainIds=8453,84532 to restrict which chains
   * are read.
   */
  @Get('plans')
  getAllPlans(@Query('chainIds') chainIds?: string) {
    return this.plans.getAllPlans(parseChainIds(chainIds));
  }

  /**
   * GET /api/plans/stream — same read as GET /api/plans, but streams each step as an SSE `log`
   * event and finishes with a `result` (or `error`) event, so a slow RPC or an unreachable
   * database is visible as a step rather than as a request that hangs.
   */
  @Sse('plans/stream')
  streamPlans(@Query('chainIds') chainIds?: string): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      const startedAt = Date.now();
      let cancelled = false;
      const emit = (type: string, data: Record<string, unknown>) => {
        if (cancelled) return;
        subscriber.next({ type, data: { ...data, elapsedMs: Date.now() - startedAt } });
      };

      emit('log', { message: 'Starting plan read…' });
      this.plans
        .getAllPlans(parseChainIds(chainIds), (message) => emit('log', { message }))
        .then((result) => {
          emit('result', { result });
          if (!cancelled) subscriber.complete();
        })
        .catch((err: Error) => {
          emit('error', { message: err.message });
          if (!cancelled) subscriber.complete();
        });

      // The read keeps running if the client disconnects; just stop emitting to a dead stream.
      return () => {
        cancelled = true;
      };
    });
  }

  /**
   * POST /api/plans/reindex — manual backfill: scan DCA plan events into `dca_plans` to recover
   * plans created outside the recording path (e.g. before write-through recording existed).
   * Optional ?chainIds=8453,84532 to restrict which chains are indexed.
   *
   * This scans block logs and can take minutes per chain. Nothing calls it automatically — the
   * read and execute paths are database-only by design.
   */
  @Post('plans/reindex')
  reindex(@Query('chainIds') chainIds?: string) {
    return this.plans.reindex(parseChainIds(chainIds));
  }
}

function parseChainIds(chainIds?: string): number[] | undefined {
  return chainIds
    ?.split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n > 0);
}
