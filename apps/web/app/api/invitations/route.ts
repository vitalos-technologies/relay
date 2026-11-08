// GET /api/invitations — open invitations · POST 🔁 { email, role?, brand_ids?, grants?, team_ids?, access_expires_at? }
// Scoped grants are validated against the inviter's delegation ceiling. accept_url (token-bearing) is
// returned once; idempotent replays omit it. Default expiry: workspace policy (72 h).
import { NextResponse } from 'next/server';
import { createInvitation, listInvitations } from '@social-lite/services/auth/invitations';
import { enforceRateLimit } from '@social-lite/services/ratelimit';
import { idempotencyKey, parseJson, route } from '@/lib/api';
import { invitationBody } from '@/lib/invitation-schema';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';


export const GET = route(async ({ ctx }) => ({ items: await listInvitations(ctx) }));
export const POST = route(async ({ req, ctx }) => {
  const input = await parseJson(req, invitationBody);
  await enforceRateLimit('invitationCreate', ctx.actor.userId);
  const r = await createInvitation(ctx, input, idempotencyKey(req));
  return NextResponse.json(r.body, { status: r.status, headers: { 'cache-control': 'no-store' } });
});
