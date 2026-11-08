// GET /api/connectors/gbp/metrics/:integrationId — stored location metrics
import { gbpLocationMetrics } from '@social-lite/services/integrations-v35/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => gbpLocationMetrics(ctx, params.id));
