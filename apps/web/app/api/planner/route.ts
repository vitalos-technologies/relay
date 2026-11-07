import { planner } from '@social-lite/services/readmodels';
import { decoratePlannerItems } from '@social-lite/services';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => {
  const q = req.nextUrl.searchParams;
  const r = await planner(ctx, { from: q.get('from') ?? undefined, to: q.get('to') ?? undefined, brand_id: q.get('brand_id') ?? undefined, connection_id: q.get('connection_id') ?? undefined, status: q.get('status') ?? undefined });
  // V2 calendar ownership (stream C): team, assignee, campaign and review state for items already in scope.
  return { ...r, items: await decoratePlannerItems(ctx, r.items) };
});
