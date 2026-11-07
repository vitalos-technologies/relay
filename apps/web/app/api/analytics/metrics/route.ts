// GET /api/analytics/metrics — the metric registry (dictionary) as MetricDefinitionDto[].
import { requireAction } from '@social-lite/services';
import { metricDictionary } from '@social-lite/services/analytics/query';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => { requireAction(ctx, 'analytics.read'); return { items: metricDictionary() }; });
