// POST /api/invitations/bulk 🔁 { rows: [...] } — per-row results; duplicates/members/pending reported.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { bulkInvite } from '@social-lite/services/auth/invitations';
import { enforceRateLimit } from '@social-lite/services/ratelimit';
import { idempotencyKey, parseJson, route } from '@/lib/api';
import { invitationBody } from '@/lib/invitation-schema';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const body = z.object({ rows: z.array(invitationBody).min(1).max(100) }).strict();

export const POST = route(async ({ req, ctx }) => {
  const input = await parseJson(req, body);
  await enforceRateLimit('invitationCreate', ctx.actor.userId);
  return NextResponse.json(await bulkInvite(ctx, input, idempotencyKey(req)), { headers: { 'cache-control': 'no-store' } });
});
