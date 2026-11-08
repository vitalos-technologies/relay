// GET   /api/inbox/conversations/:id?before= — detail + timeline (messages, internal notes, pending/failed sends, events)
// PATCH /api/inbox/conversations/:id — status (open|waiting|snoozed|resolved|spam), snoozed_until, priority, labels, language
import { getConversation, updateConversation, updateConversationSchema } from '@social-lite/services/inbox/index';
import { parseJson, queryOf, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ req, ctx, params }) => getConversation(ctx, params.id, queryOf(req)));
export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => updateConversation(ctx, params.id, await parseJson(req, updateConversationSchema)));
