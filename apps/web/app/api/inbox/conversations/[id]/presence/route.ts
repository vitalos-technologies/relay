// POST /api/inbox/conversations/:id/presence { state: viewing|composing } — heartbeat; returns others here (informational only).
import { z } from 'zod';
import { presenceHeartbeat } from '@social-lite/services/inbox/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ state: z.enum(['viewing', 'composing']) }).strict();
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => presenceHeartbeat(ctx, params.id, (await parseJson(req, body)).state));
