import { planner } from '@social-lite/services/readmodels';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => {
  const q = req.nextUrl.searchParams;
  return planner(ctx, { from: q.get('from') ?? undefined, to: q.get('to') ?? undefined, brand_id: q.get('brand_id') ?? undefined, connection_id: q.get('connection_id') ?? undefined, status: q.get('status') ?? undefined });
});
