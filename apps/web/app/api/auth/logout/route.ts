// POST /api/auth/logout — revokes the server-side session and clears the cookie.
import { NextResponse } from 'next/server';
import { getPool } from '@social-lite/db';
import { SESSION_COOKIE, config, revokeSession } from '@social-lite/services';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(async ({ session }) => {
  await revokeSession(getPool(), session.id);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure: config().APP_ENV === 'production', path: '/', maxAge: 0 });
  return res;
}, { workspace: false });
