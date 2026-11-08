// V4 Relay support — POST /api/support/requests/:ref/messages { body, attachment_ids? } (Idempotency-Key): customer reply.
import { z } from 'zod';
import { replyTicket } from '@social-lite/services/support/tickets';
import { idempotencyKey, parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ ref: string }>(async ({ req, ctx, params }) => replyTicket(ctx, params.ref, await parseJson(req, z.unknown()), idempotencyKey(req)));
