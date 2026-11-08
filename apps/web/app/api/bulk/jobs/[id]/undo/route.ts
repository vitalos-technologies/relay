// POST /api/bulk/jobs/:id/undo — start a job reversing each succeeded item (concurrency-checked). Idempotency-Key required.
import { undoBulk } from '@social-lite/services/data/bulk';
import { idempotencyKey, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ req, ctx, params }) => Response.json(await undoBulk(ctx, params.id, idempotencyKey(req)), { status: 202 }));
