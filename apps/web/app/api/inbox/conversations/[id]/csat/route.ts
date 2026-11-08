// GET  /api/inbox/conversations/:id/csat — satisfaction request state
// POST /api/inbox/conversations/:id/csat { idempotency_key } — send the request (a normal customer-facing send)
import { csatRequestSchema, csatState, requestCsat } from '@social-lite/services/inbox/index';
import { parseJson, route } from '@/lib/api';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route<{ id: string }>(async ({ ctx, params }) => csatState(ctx, params.id));
export const POST = route<{ id: string }>(async ({ req, ctx, params }) => requestCsat(ctx, params.id, await parseJson(req, csatRequestSchema)));
