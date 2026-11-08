// V5 WID — route wrapper for /api/widget/** (marketing support widget). Public endpoints that resolve up to two identities:
//  * visitor: the widget cookie (HttpOnly, opaque) → widget_sessions;
//  * member:  the app session cookie (existing sign-in) → trusted account context.
// Mutations: Origin must be this site AND the X-Relay-Widget header must be present (forces a CORS preflight for any
// cross-site attempt). Each identity's CSRF token is checked separately (member: X-CSRF-Token, visitor: X-Widget-CSRF):
// an identity whose header is absent is ignored for that request; a wrong token fails the request (stale tab → reload).
// Responses are never cached.
import 'server-only';
import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { AppError } from '@social-lite/core';
import { csrfMatches } from '@social-lite/services';
import { clientIp } from '@social-lite/services/ratelimit';
import { browserFamily } from '@social-lite/services/support/shared';
import { resolveWidgetSession, WIDGET_COOKIE, widgetCookieOptions, type WidgetSession } from '@social-lite/services/support/widget-session';
import type { WidgetCaller } from '@social-lite/services/support/widget';
import { currentSession, errorResponse, originAllowed } from '@/lib/api';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Non-secret hint (readable by the launcher) that this browser has a widget session, so it can show unread replies. */
export const WIDGET_HINT_COOKIE = 'relay_widget_hint';

export interface WidgetResult { body: unknown; status?: number; setSession?: { token: string; session: WidgetSession } | null; clearSession?: boolean }

type Handler<P> = (a: { req: NextRequest; params: P; caller: WidgetCaller; correlationId: string }) => Promise<WidgetResult | Response>;

export function widgetRoute<P = Record<string, string>>(handler: Handler<P>) {
  return async (req: NextRequest, segment: { params: Promise<P> }): Promise<Response> => {
    const correlationId = randomUUID();
    try {
      const mutating = MUTATING.has(req.method);
      if (mutating && (!originAllowed(req) || req.headers.get('x-relay-widget') !== '1')) throw new AppError('csrf_failed', 'Request origin not allowed');
      const jar = await cookies();
      let visitor = await resolveWidgetSession(jar.get(WIDGET_COOKIE)?.value);
      if (visitor && mutating) {
        const h = req.headers.get('x-widget-csrf');
        if (!h) visitor = null;
        else if (!csrfMatches(visitor.csrfToken, h)) throw new AppError('csrf_failed', 'This chat is out of date. Reload the page and try again.');
      }
      const app = await currentSession();
      let member: WidgetCaller['member'] = app ? {
        actor: app.actor, csrfToken: app.session.csrfToken, activeWorkspaceId: app.session.activeWorkspaceId,
        assurance: { mfaVerified: app.session.mfaVerified, authTime: app.session.authTime?.toISOString() ?? null },
      } : null;
      if (member && mutating) {
        const h = req.headers.get('x-csrf-token');
        if (!h) member = null;
        else if (!csrfMatches(member.csrfToken, h)) throw new AppError('csrf_failed', 'Your session is out of date. Reload the page and try again.');
      }
      const caller: WidgetCaller = { visitor, member, ip: clientIp(req.headers), browser: browserFamily(req.headers.get('user-agent')) };
      const out = await handler({ req, params: await segment.params, caller, correlationId });
      if (out instanceof Response) { out.headers.set('x-correlation-id', correlationId); out.headers.set('cache-control', 'private, no-store'); return out; }
      const res = NextResponse.json(out.body ?? { ok: true }, { status: out.status ?? 200, headers: { 'x-correlation-id': correlationId, 'cache-control': 'private, no-store' } });
      if (out.setSession) {
        const opts = widgetCookieOptions(out.setSession.session.expiresAt);
        res.cookies.set(WIDGET_COOKIE, out.setSession.token, opts);
        res.cookies.set(WIDGET_HINT_COOKIE, '1', { ...opts, httpOnly: false });
      }
      if (out.clearSession) {
        res.cookies.set(WIDGET_COOKIE, '', { ...widgetCookieOptions(new Date(0)), maxAge: 0 });
        res.cookies.set(WIDGET_HINT_COOKIE, '', { ...widgetCookieOptions(new Date(0)), httpOnly: false, maxAge: 0 });
      }
      return res;
    } catch (err) {
      const r = errorResponse(err, correlationId);
      r.headers.set('cache-control', 'private, no-store');
      return r;
    }
  };
}

/** Bounded JSON body (widget payloads are small). */
export async function widgetJson(req: NextRequest): Promise<unknown> {
  const len = Number(req.headers.get('content-length') ?? '0');
  if (len > 64 * 1024) throw new AppError('payload_too_large', 'Message is too large');
  const text = await req.text();
  if (text.length > 64 * 1024) throw new AppError('payload_too_large', 'Message is too large');
  try { return text ? JSON.parse(text) : {}; } catch { throw new AppError('validation_failed', 'Request body must be valid JSON'); }
}
