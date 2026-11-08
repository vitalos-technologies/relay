// GET /api/connectors/slack/routes?integration_id= · POST — channel alert preferences (categories, brands, quiet hours, rate)
import { listSlackRoutes, routeSchema, saveSlackRoute } from '@social-lite/services/integrations-v35/index';
import { parseJson, queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => listSlackRoutes(ctx, queryOf(req).integration_id ?? ''));
export const POST = route(async ({ req, ctx }) => saveSlackRoute(ctx, await parseJson(req, routeSchema)));
