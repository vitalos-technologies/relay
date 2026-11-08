// GET /api/content-hub?brand_id= → ContentHubOverviewDto (stored data only; no source calls).
import * as ch from '@social-lite/services/content-hub/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => {
  const brandId = req.nextUrl.searchParams.get('brand_id') ?? '';
  const [status, connections, items, recent_imports, snapshot_retention_days] = await Promise.all([
    ch.contentHubStatus(ctx), ch.listContentConnections(ctx, { brandId, includeDisconnected: true }), ch.listSourceItems(ctx, brandId), ch.listImports(ctx, brandId, 20),
    ch.getRetentionDays((await import('@social-lite/db')).getPool(), ctx.access.workspaceId),
  ]);
  const recent_exports = await ch.listExports(ctx, brandId, 20).catch(() => []);
  return { status, connections, items, recent_imports, recent_exports, snapshot_retention_days };
});
