import { history } from '@social-lite/services/readmodels';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => {
  const q = req.nextUrl.searchParams;
  return history(ctx, { brand_id: q.get('brand_id') ?? undefined, provider: q.get('provider') ?? undefined, state: q.get('state') ?? undefined,
    from: q.get('from') ?? undefined, to: q.get('to') ?? undefined, cursor: q.get('cursor') ?? undefined, limit: Number(q.get('limit')) || undefined });
});
