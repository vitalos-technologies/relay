// POST /api/auth/backchannel-logout — OpenID Connect Back-Channel Logout 1.0 receiver (called by the IdP,
// not by browsers: no session/CSRF). The logout_token is verified (JWKS signature, iss, aud, iat, events,
// sid/sub, no nonce, single-use jti) and every app session bound to that IdP session is revoked.
import { NextResponse } from 'next/server';
import { AppError } from '@social-lite/core';
import { log } from '@social-lite/services';
import { handleBackchannelLogout } from '@social-lite/services/auth/oidc';
import { clientIp, enforceRateLimit } from '@social-lite/services/ratelimit';
import { publicRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = publicRoute(async ({ req, correlationId }) => {
  const headers = { 'cache-control': 'no-store' };
  try {
    await enforceRateLimit('authCallback', clientIp(req.headers));
    if (!(req.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded')) throw new AppError('validation_failed', 'Expected a form-encoded logout_token');
    const text = await req.text();
    if (text.length > 20_000) throw new AppError('payload_too_large', 'Logout token too large');
    const token = new URLSearchParams(text).get('logout_token');
    if (!token) throw new AppError('validation_failed', 'logout_token is required');
    const r = await handleBackchannelLogout(token);
    log.info('idp_backchannel_logout', { correlationId, revoked: r.revoked });
    return new NextResponse(null, { status: 200, headers });
  } catch (err) {
    log.warn('idp_backchannel_logout_rejected', { correlationId, code: err instanceof AppError ? err.code : 'error', reason: err instanceof AppError ? err.message.slice(0, 80) : undefined });
    return NextResponse.json({ error: 'invalid_request' }, { status: 400, headers });
  }
});
