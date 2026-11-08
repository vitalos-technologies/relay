// GET /api/analytics?brand_id=&provider=&cursor=&limit= — published deliveries with their latest native
// metrics (provider-native names, period, observed_at, source). Never summed across networks.
import { listAnalytics } from '@social-lite/services/analytics/index';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => {
  const q = req.nextUrl.searchParams;
  return listAnalytics(ctx, { brand_id: q.get('brand_id'), provider: q.get('provider'), cursor: q.get('cursor'), limit: Number(q.get('limit') ?? 30) || 30 });
});
