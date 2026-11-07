// POST /api/threads/:id/replies { body, client_key? } — reply (a retried client_key returns the original reply).
import { z } from 'zod';
import { replyToThread } from '@social-lite/services';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ body: z.string().min(1).max(5000), client_key: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).nullable().optional() }).strict();
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => replyToThread(ctx, params.id, await parseJson(req, body)));
