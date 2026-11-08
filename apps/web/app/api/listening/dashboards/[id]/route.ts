// GET/PATCH/DELETE /api/listening/dashboards/:id
import { archiveDashboard, getDashboard, updateDashboard, updateDashboardSchema } from '@social-lite/services/listening/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => getDashboard(ctx, params.id));
export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => updateDashboard(ctx, params.id, await parseJson(req, updateDashboardSchema)));
export const DELETE = route<{ id: string }>(async ({ ctx, params }) => archiveDashboard(ctx, params.id));
