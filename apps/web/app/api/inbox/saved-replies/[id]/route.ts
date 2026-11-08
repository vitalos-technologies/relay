// PATCH /api/inbox/saved-replies/:id · DELETE (archive)
import { archiveSavedReply, saveSavedReply, savedReplySchema } from '@social-lite/services/inbox/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => saveSavedReply(ctx, await parseJson(req, savedReplySchema), params.id));
export const DELETE = route<{ id: string }>(async ({ ctx, params }) => { await archiveSavedReply(ctx, params.id); return { ok: true }; });
