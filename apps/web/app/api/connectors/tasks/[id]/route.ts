// GET /api/connectors/tasks/:id · PATCH (Relay edit → push; explicit conflict resolution) · DELETE (unlink; external task untouched)
import { getExternalTask, unlinkExternalTask, updateExternalTask, updateTaskSchema } from '@social-lite/services/integrations-v35/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => getExternalTask(ctx, params.id));
export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => updateExternalTask(ctx, params.id, await parseJson(req, updateTaskSchema)));
export const DELETE = route<{ id: string }>(async ({ ctx, params }) => { await unlinkExternalTask(ctx, params.id); return { ok: true }; });
