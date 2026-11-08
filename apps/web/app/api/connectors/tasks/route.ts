// GET /api/connectors/tasks?relay_type=&relay_id= — external tasks linked to a Relay item · POST — create (Asana task / monday item; durable job)
import { createExternalTask, createTaskSchema, listExternalTasks } from '@social-lite/services/integrations-v35/index';
import { parseJson, queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => { const q = queryOf(req); return listExternalTasks(ctx, q.relay_type ?? '', q.relay_id ?? ''); });
export const POST = route(async ({ req, ctx }) => createExternalTask(ctx, await parseJson(req, createTaskSchema)));
