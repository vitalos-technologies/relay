// GET /api/analytics/content/:deliveryId?tz= — drilldown: media, caption, source metrics, as-of history, observed changes, coverage.
import { contentDetail } from '@social-lite/services/analytics/query';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ deliveryId: string }>(async ({ req, ctx, params }) => contentDetail(ctx, params.deliveryId, { timezone: req.nextUrl.searchParams.get('tz') }));
