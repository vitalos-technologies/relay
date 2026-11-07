// POST /api/invitations 🔁 { email, role, brand_ids? } — creates an invitation and emails it.
// accept_url (token-bearing) is returned once; idempotent replays omit it.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createInvitation } from '@social-lite/services/auth/invitations';
import { enforceRateLimit } from '@social-lite/services/ratelimit';
import { idempotencyKey, parseJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({
  email: z.string().max(320),
  role: z.enum(['admin', 'editor', 'approver', 'viewer']),
  brand_ids: z.array(z.string().max(64)).max(200).optional(),
}).strict();

export const POST = route(async ({ req, ctx }) => {
  const input = await parseJson(req, body);
  await enforceRateLimit('invitationCreate', ctx.actor.userId);
  const r = await createInvitation(ctx, input, idempotencyKey(req));
  return NextResponse.json(r.body, { status: r.status, headers: { 'cache-control': 'no-store' } });
});
