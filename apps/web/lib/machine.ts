// Route wrapper for MACHINE endpoints (/api/v1/*) authenticated with service-account API keys:
//   Authorization: Bearer sl_live_<prefix>_<secret>
// No cookies, no CSRF (keys are never sent automatically by browsers). The key is resolved against the database
// on every request (revoked/expired keys and disabled accounts fail immediately) and the request runs with a
// service-account AuthzState from the central policy. Keys are never logged (only the non-secret prefix).
import 'server-only';
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { AppError } from '@social-lite/core';
import type { Ctx } from '@social-lite/services';
import { authenticateApiKey, serviceAccountCtx, type ApiKeyPrincipal } from '@social-lite/services/service-accounts';
import { clientIp, enforceRateLimit } from '@social-lite/services/ratelimit';
import { errorResponse } from '@/lib/api';

export interface MachineArgs<P> { req: NextRequest; params: P; ctx: Ctx; principal: ApiKeyPrincipal; correlationId: string }

const API_LIMIT = { capacity: 60, refillPerSecond: 1 };

export function machineRoute<P = Record<string, string>>(handler: (a: MachineArgs<P>) => Promise<unknown>) {
  return async (req: NextRequest, segment: { params: Promise<P> }): Promise<Response> => {
    const correlationId = randomUUID();
    try {
      await enforceRateLimit('apiKeyIp', clientIp(req.headers), API_LIMIT);
      const principal = await authenticateApiKey(req.headers.get('authorization'));
      if (!principal) {
        const res = errorResponse(new AppError('unauthenticated', 'Invalid, expired or revoked API key'), correlationId);
        res.headers.set('www-authenticate', 'Bearer realm="social-lite"');
        return res;
      }
      await enforceRateLimit('apiKey', principal.prefix, API_LIMIT);
      const ctx = await serviceAccountCtx(principal, correlationId);
      const out = await handler({ req, params: await segment.params, ctx, principal, correlationId });
      if (out instanceof Response) return out;
      return NextResponse.json(out ?? { ok: true }, { headers: { 'x-correlation-id': correlationId, 'cache-control': 'no-store' } });
    } catch (err) {
      return errorResponse(err, correlationId);
    }
  };
}
