// POST /api/analytics/:deliveryId/refresh — on-demand metrics refresh, throttled per delivery (429 with next_allowed_at).
// X reads consume the workspace x.read budget and are skipped when it is exhausted.
import { liveAnalyticsDeps, requestMetricsRefresh } from '@social-lite/services/analytics/index';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ deliveryId: string }>(async ({ ctx, params }) => requestMetricsRefresh(ctx, params.deliveryId, await liveAnalyticsDeps()));
