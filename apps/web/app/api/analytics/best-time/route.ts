// GET /api/analytics/best-time?{filters} — observational heuristic; status 'insufficient_data' (hide it) below the sample threshold.
import { filtersFromQuery } from '@social-lite/services/analytics/api';
import { bestTime } from '@social-lite/services/analytics/query';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => bestTime(ctx, await filtersFromQuery(ctx, req.nextUrl.searchParams)));
