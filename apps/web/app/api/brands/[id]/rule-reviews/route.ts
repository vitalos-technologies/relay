// V3.1 §12 — GET /api/brands/:id/rule-reviews?status=open|decided|all — drafts/schedules affected by rule changes.
import { listRuleReviews } from '@social-lite/services/gov/brand-rules';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ req, ctx, params }) => {
  const s = req.nextUrl.searchParams.get('status');
  return listRuleReviews(ctx, params.id, { status: s === 'decided' || s === 'all' ? s : 'open' });
});
