// GET /api/inbox/report?days=30&brand_id= — first response, resolution, backlog, breaches, reopened (with definitions)
import { careReport } from '@social-lite/services/inbox/index';
import { queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => careReport(ctx, queryOf(req)));
