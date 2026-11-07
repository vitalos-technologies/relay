// POST /api/activity/export { ...same filters as GET /api/activity } → text/csv attachment.
// Needs audit.read + exports.create; rate-limited, budgeted (exports/month), audited, CSV-injection safe.
// POST (not GET) so a cross-site link can never trigger a budgeted, audited export.
import { z } from 'zod';
import { activityCsv } from '@social-lite/services/product/activity';
import { parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ req, ctx }) => {
  const { csv } = await activityCsv(ctx, await parseJson(req, z.unknown()));
  const name = `social-lite-activity-${new Date().toISOString().slice(0, 10)}.csv`;
  return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' } });
});
