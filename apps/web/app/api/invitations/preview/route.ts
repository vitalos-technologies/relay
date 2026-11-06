// GET /api/invitations/preview?token= (public) — { workspace_name, email_hint, role, expires_at, status }
import { NextResponse } from 'next/server';
import { previewInvitation } from '@social-lite/services/auth/invitations';
import { clientIp, enforceRateLimit } from '@social-lite/services/ratelimit';
import { publicRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = publicRoute(async ({ req }) => {
  enforceRateLimit('invitationPreview', clientIp(req.headers));
  const preview = await previewInvitation(req.nextUrl.searchParams.get('token') ?? '');
  return NextResponse.json(preview, { headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
});
