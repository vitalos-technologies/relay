// GET  /api/posts/:id/presence — who is viewing / editing (informational only).
// POST /api/posts/:id/presence { client_id, state: viewing|editing|left } — heartbeat; returns the current list.
import { z } from 'zod';
import { getPresence, presenceHeartbeat } from '@social-lite/services';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ client_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/), state: z.enum(['viewing', 'editing', 'left']) }).strict();
export const GET = route<{ id: string }>(async ({ ctx, params }) => getPresence(ctx, params.id));
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => presenceHeartbeat(ctx, params.id, await parseJson(req, body)));
