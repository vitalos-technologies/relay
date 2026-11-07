// GET /api/analytics/overview?{filters}&measure= — ≤4 KPIs, trend (+previous overlay), channel comparison, top content,
// calculated insights, data-health footer. Types: OverviewResponse (packages/core/src/contracts/analytics.ts).
import { filtersFromQuery } from '@social-lite/services/analytics/api';
import { overview } from '@social-lite/services/analytics/query';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => overview(ctx, await filtersFromQuery(ctx, req.nextUrl.searchParams), { measure: req.nextUrl.searchParams.get('measure') }));
