// POST /api/invitations/:id/resend — rotates the token (old link stops working) and restarts the expiry.
import { NextResponse } from 'next/server';
import { resendInvitation } from '@social-lite/services/auth/invitations';
import { enforceRateLimit } from '@social-lite/services/ratelimit';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route<{ id: string }>(async ({ ctx, params }) => {
  await enforceRateLimit('invitationCreate', ctx.actor.userId);
  return NextResponse.json(await resendInvitation(ctx, params.id), { headers: { 'cache-control': 'no-store' } });
});
