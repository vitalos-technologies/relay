// GET /api/connectors/slack/deliveries?integration_id= — delivery history
import { listSlackDeliveries } from '@social-lite/services/integrations-v35/index';
import { queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => listSlackDeliveries(ctx, queryOf(req).integration_id ?? ''));
