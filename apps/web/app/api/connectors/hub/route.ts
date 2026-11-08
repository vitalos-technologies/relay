// GET /api/connectors/hub — Integrations hub: operator readiness ("needs app setup"), installations per connector.
import { hubOverview } from '@social-lite/services/integrations-v35/index';
import { route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ ctx }) => hubOverview(ctx));
