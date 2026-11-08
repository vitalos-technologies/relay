// GET /api/analytics/workflow?{filters} — see packages/core/src/contracts/analytics.ts.
import { filtersFromQuery } from '@social-lite/services/analytics/api';
import { workflow } from '@social-lite/services/analytics/query';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => workflow(ctx, await filtersFromQuery(ctx, req.nextUrl.searchParams)));
