// GET /api/listening/dashboards?brand_id= · POST { brand_id, name, widgets, shared }
import { createDashboard, dashboardSchema, listDashboards } from '@social-lite/services/listening/index';
import { parseJson, queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => listDashboards(ctx, queryOf(req)));
export const POST = route(async ({ req, ctx }) => createDashboard(ctx, await parseJson(req, dashboardSchema)));
