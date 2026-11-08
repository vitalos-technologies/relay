// POST /api/connectors/tasks/preview — exactly what would leave Relay (shown before creating)
import { createTaskSchema, previewTask } from '@social-lite/services/integrations-v35/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ req, ctx }) => previewTask(ctx, await parseJson(req, createTaskSchema)));
