// V4 Relay support — GET /api/support/requests?scope=mine|workspace&status=open|resolved|all&q=&cursor= (requests the caller may see);
// POST { category, subject, message, attachment_ids?, diagnostics? } (Idempotency-Key) creates a request from trusted context.
import { z } from 'zod';
import { createTicket, listTickets } from '@social-lite/services/support/tickets';
import { browserFamily } from '@social-lite/services/support/shared';
import { idempotencyKey, parseJson, queryOf, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async ({ req, ctx }) => listTickets(ctx, queryOf(req)));
export const POST = route(async ({ req, ctx }) => {
  const r = await createTicket(ctx, await parseJson(req, z.unknown()), idempotencyKey(req), { userAgentFamily: browserFamily(req.headers.get('user-agent')) });
  return Response.json(r, { status: 201 });
});
