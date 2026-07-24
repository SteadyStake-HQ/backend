import { Injectable } from '@nestjs/common';
import { fetchAllPlans, type FetchAllPlansResult } from './fetch-plans';
import { indexAllPlans, type IndexPlansResult } from './index-plans';
import type { ProgressCallback } from '../run-executor';

@Injectable()
export class PlansService {
  /**
   * Fetch all DCA plans for all registered members (live contract state + Supabase overlay).
   * `onProgress` receives per-step messages; the SSE endpoint forwards them to the dashboard.
   */
  getAllPlans(chainIds?: number[], onProgress?: ProgressCallback): Promise<FetchAllPlansResult> {
    return fetchAllPlans(onProgress, chainIds && chainIds.length > 0 ? { chainIds } : undefined);
  }

  /** Force a re-scan of ScheduleCreated/Executed/Cancelled logs into the dca_plans table. */
  reindex(chainIds?: number[]): Promise<IndexPlansResult> {
    return indexAllPlans(undefined, chainIds && chainIds.length > 0 ? { chainIds } : undefined);
  }
}
