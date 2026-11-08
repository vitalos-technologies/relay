import { historyCsv } from '@social-lite/services/readmodels';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => {
  const q = req.nextUrl.searchParams;
  const csv = await historyCsv(ctx, { brand_id: q.get('brand_id') ?? undefined, provider: q.get('provider') ?? undefined, state: q.get('state') ?? undefined, from: q.get('from') ?? undefined, to: q.get('to') ?? undefined });
  const name = `social-lite-history-${new Date().toISOString().slice(0, 10)}.csv`;
  return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' } });
});
