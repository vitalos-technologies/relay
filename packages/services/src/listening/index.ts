// V3.5 social listening (stream D). Contracts: @social-lite/core/contracts/v35-listening. Import as
// '@social-lite/services/listening/index'.
import { getPool } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { listeningBrands } from './shared.js';
import { BROAD_SOURCES, NOT_OFFERED, sourceStates } from './sources.js';

export * from './shared.js';
export * from './classify.js';
export * from './spike.js';
export * from './sources.js';
export * from './ingest.js';
export * from './searches.js';
export * from './query.js';
export * from './alerts.js';
export * from './actions.js';
export * from './dashboards.js';
export * from './admin.js';

/** Coverage registry for the Sources screen. */
export async function listeningSources(ctx: Ctx, q: { brand_id?: string | null } = {}) {
  const brands = await listeningBrands(ctx, q.brand_id);
  return { items: await sourceStates(ctx.access.workspaceId, brands, getPool()), not_offered: NOT_OFFERED, broad_total: BROAD_SOURCES.length };
}
