// GET /api/analytics/video?{filters} — see packages/core/src/contracts/analytics.ts.
import { filtersFromQuery } from '@social-lite/services/analytics/api';
import { video } from '@social-lite/services/analytics/query';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => video(ctx, await filtersFromQuery(ctx, req.nextUrl.searchParams)));
