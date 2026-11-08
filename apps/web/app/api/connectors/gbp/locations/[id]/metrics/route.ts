// POST /api/connectors/gbp/locations/:resourceId/metrics — refresh metrics for one location (explicit; stored)
import { refreshGbpMetrics } from '@social-lite/services/integrations-v35/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ ctx, params }) => refreshGbpMetrics(ctx, params.id));
