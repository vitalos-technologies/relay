// POST /api/posts/:id/threads/read { thread_ids? } — mark threads read for the caller (unread indicators).
import { z } from 'zod';
import { markThreadsRead } from '@social-lite/services';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ thread_ids: z.array(z.string().uuid()).max(100).optional() }).strict();
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => markThreadsRead(ctx, params.id, (await parseJson(req, body)).thread_ids));
