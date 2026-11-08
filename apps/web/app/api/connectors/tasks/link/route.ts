// POST /api/connectors/tasks/link { integration_id, relay_type, relay_id, resource_id, external_ref } — link an existing task (URL or id)
import { linkExistingTask, linkTaskSchema } from '@social-lite/services/integrations-v35/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ req, ctx }) => linkExistingTask(ctx, await parseJson(req, linkTaskSchema)));
