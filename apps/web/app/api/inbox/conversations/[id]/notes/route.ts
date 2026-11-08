// POST /api/inbox/conversations/:id/notes { body, mentions? } — INTERNAL note. Never sent to the customer.
import { addNote, noteSchema } from '@social-lite/services/inbox/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => addNote(ctx, params.id, await parseJson(req, noteSchema)));
