// GET /api/connectors/:id/resources · PUT { resources: [{ resource_type, external_id, name, url?, selected }] } — explicit selection only
import { listResources, resourceSelectionSchema, selectResources } from '@social-lite/services/connectors/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => listResources(ctx, params.id));
export const PUT = route<{ id: string }>(async ({ req, ctx, params }) => selectResources(ctx, params.id, await parseJson(req, resourceSelectionSchema)));
