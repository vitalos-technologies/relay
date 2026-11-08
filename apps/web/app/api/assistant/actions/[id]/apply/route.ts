// POST /api/assistant/actions/:id/apply [{reviewed_hash}] → applies a proposed action through the normal service
// (permission re-checked). V5 external actions (schedule / submit for approval / send reply) need the reviewed hash.
import { z } from 'zod';
import { applyAction } from '@social-lite/services/assistant/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ reviewed_hash: z.string().max(80).nullish() }).strict();

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => applyAction(ctx, params.id, await parseJson(req, body)));
