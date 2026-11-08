// GET /api/listening/searches/:id/timeline?days=|from=&to=&dataset= — with coverage (sources, history, query version, denominators)
import { searchTimeline } from '@social-lite/services/listening/index';
import { queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ req, ctx, params }) => searchTimeline(ctx, params.id, queryOf(req)));
