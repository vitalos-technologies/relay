// PATCH  /api/comments/:id { body } — author edits (previous text kept in the edit history).
// DELETE /api/comments/:id — author (or brand manager) deletes; a tombstone stays in the thread.
import { z } from 'zod';
import { deleteComment, editComment } from '@social-lite/services';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ body: z.string().min(1).max(5000) }).strict();
export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => editComment(ctx, params.id, await parseJson(req, body)));
export const DELETE = route<{ id: string }>(async ({ ctx, params }) => deleteComment(ctx, params.id));
