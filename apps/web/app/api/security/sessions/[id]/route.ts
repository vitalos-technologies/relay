// DELETE /api/security/sessions/:id — revoke one of the caller's own sessions (takes effect on its next request).
import { NextResponse } from 'next/server';
import { SESSION_COOKIE, config } from '@social-lite/services';
import { revokeMySession } from '@social-lite/services/security';
import { assertUuid } from '@social-lite/services';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const DELETE = route<{ id: string }>(async ({ params, session, ctx }) => {
  assertUuid(params.id, 'Session');
  const r = await revokeMySession(ctx.actor.userId, session, params.id);
  const res = NextResponse.json({ ok: true, current: r.current });
  if (r.current) res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure: config().APP_ENV === 'production', path: '/', maxAge: 0 });
  return res;
}, { workspace: false });
