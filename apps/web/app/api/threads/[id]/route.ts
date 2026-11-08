// GET   /api/threads/:id — one thread with all replies (staff, or a guest for shared threads of a shared review).
// PATCH /api/threads/:id — { resolved } or { visibility, confirm_count } (explicit, audited visibility change).
import { z } from 'zod';
import { getThread, setThreadResolved, setThreadVisibility } from '@social-lite/services';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.union([
  z.object({ resolved: z.boolean() }).strict(),
  z.object({ visibility: z.enum(['internal', 'shared']), confirm_count: z.number().int().min(0).max(10_000).optional() }).strict(),
]);
export const GET = route<{ id: string }>(async ({ ctx, params }) => getThread(ctx, params.id));
export const PATCH = route<{ id: string }>(async ({ req, ctx, params }) => {
  const b = await parseJson(req, body);
  return 'resolved' in b ? setThreadResolved(ctx, params.id, b.resolved) : setThreadVisibility(ctx, params.id, b);
});
