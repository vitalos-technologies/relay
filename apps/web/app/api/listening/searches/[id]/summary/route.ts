// GET /api/listening/searches/:id/summary?days=|from=&to=&dataset= — with coverage (sources, history, query version, denominators)
import { searchSummary } from '@social-lite/services/listening/index';
import { queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ req, ctx, params }) => searchSummary(ctx, params.id, queryOf(req)));
