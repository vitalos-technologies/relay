// PATCH  /api/inbox/channels/:id { paused } · DELETE /api/inbox/channels/:id (history kept; queued replies cancelled)
import { z } from 'zod';
import { removeChannel, setChannelPaused } from '@social-lite/services/inbox/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ paused: z.boolean() }).strict();
export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => setChannelPaused(ctx, params.id, (await parseJson(req, body)).paused));
export const DELETE = route<{ id: string }>(async ({ ctx, params }) => { await removeChannel(ctx, params.id); return { ok: true }; });
