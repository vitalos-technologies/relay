// GET /api/listening/alerts?brand_id=&state=&search_id=
import { listAlerts } from '@social-lite/services/listening/index';
import { queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => listAlerts(ctx, queryOf(req)));
