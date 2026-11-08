// GET /api/inbox/csat/report?days=&brand_id= — sent, responses, response rate, average and distribution (with definitions).
import { csatReport } from '@social-lite/services/inbox/index';
import { queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => csatReport(ctx, queryOf(req)));
