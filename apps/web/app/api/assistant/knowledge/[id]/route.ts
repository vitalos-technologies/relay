// PATCH /api/assistant/knowledge/:id {topics?, review_by?} · DELETE (revoke)
import { knowledgePatchSchema, revokeKnowledge, updateKnowledge } from '@social-lite/services/assistant/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => updateKnowledge(ctx, params.id, await parseJson(req, knowledgePatchSchema)));
export const DELETE = route<{ id: string }>(async ({ ctx, params }) => { await revokeKnowledge(ctx, params.id); return { ok: true }; });
