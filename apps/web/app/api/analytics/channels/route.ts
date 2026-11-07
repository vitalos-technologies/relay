// GET /api/analytics/channels?{filters} — see packages/core/src/contracts/analytics.ts.
import { filtersFromQuery } from '@social-lite/services/analytics/api';
import { channels } from '@social-lite/services/analytics/query';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => channels(ctx, await filtersFromQuery(ctx, req.nextUrl.searchParams), { measure: req.nextUrl.searchParams.get('measure') }));
