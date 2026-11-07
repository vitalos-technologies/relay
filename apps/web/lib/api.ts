// Route-handler wrapper used by EVERY /api route. Provides:
//  - session authentication (opaque HttpOnly cookie)
//  - CSRF protection for mutations: Origin check + X-CSRF-Token bound to the session
//  - active-workspace access resolution (role + brand grants) => Ctx
//  - uniform error envelope { error: { code, message, fieldErrors? }, correlation_id }
//  - JSON body size bound and zod parsing helper
import 'server-only';
import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { z, type ZodType } from 'zod';
import { AppError } from '@social-lite/core';
import {
  SESSION_COOKIE, config, csrfMatches, loadAccess, log, resolveSession,
  type Actor, type Ctx, type SessionRecord,
} from '@social-lite/services';
import { assertExpectedWorkspace } from '@social-lite/services/workspaces';
import { loadOperatorRole, type PlatformCtx } from '@social-lite/services/admin/platform';

const MAX_JSON_BYTES = 256 * 1024;

export interface RouteOptions {
  /** default true */
  auth?: boolean;
  /** default true when auth; requires an active workspace membership. */
  workspace?: boolean;
}

export interface RouteArgs<P> {
  req: NextRequest;
  params: P;
  ctx: Ctx;
  session: SessionRecord;
  correlationId: string;
}

export interface PublicRouteArgs<P> {
  req: NextRequest;
  params: P;
  correlationId: string;
}

type Handler<P> = (a: RouteArgs<P>) => Promise<Response | unknown>;
type PublicHandler<P> = (a: PublicRouteArgs<P>) => Promise<Response | unknown>;

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function errorResponse(err: unknown, correlationId: string): NextResponse {
  if (err instanceof AppError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message, fieldErrors: err.fieldErrors, details: err.details }, correlation_id: correlationId },
      { status: err.status, headers: { 'x-correlation-id': correlationId } },
    );
  }
  if (err instanceof z.ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const i of err.issues) fieldErrors[i.path.join('.') || '_'] = i.message;
    return NextResponse.json(
      { error: { code: 'validation_failed', message: 'Some fields are invalid', fieldErrors }, correlation_id: correlationId },
      { status: 422, headers: { 'x-correlation-id': correlationId } },
    );
  }
  log.error('unhandled_api_error', { correlationId, err: err as Error });
  return NextResponse.json(
    { error: { code: 'internal', message: 'Something went wrong. Quote the reference if you contact support.' }, correlation_id: correlationId },
    { status: 500, headers: { 'x-correlation-id': correlationId } },
  );
}

function toResponse(result: unknown, correlationId: string): Response {
  if (result instanceof Response) {
    result.headers.set('x-correlation-id', correlationId);
    return result;
  }
  return NextResponse.json(result ?? { ok: true }, { headers: { 'x-correlation-id': correlationId } });
}

/** Same-origin check for state-changing requests (defence in depth alongside the CSRF token). */
export function originAllowed(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  const allowed = new Set([new URL(config().APP_BASE_URL).origin]);
  if (config().APP_ENV !== 'production') {
    allowed.add(req.nextUrl.origin);
  }
  return allowed.has(origin);
}

export async function currentSession(): Promise<{ session: SessionRecord; actor: Actor } | null> {
  const jar = await cookies();
  return resolveSession(jar.get(SESSION_COOKIE)?.value);
}

export function route<P = Record<string, string>>(handler: Handler<P>, opts: RouteOptions = {}) {
  return async (req: NextRequest, segment: { params: Promise<P> }): Promise<Response> => {
    const correlationId = req.headers.get('x-correlation-id')?.slice(0, 64) || randomUUID();
    try {
      const resolved = await currentSession();
      if (!resolved) throw new AppError('unauthenticated', 'Please sign in again');
      if (MUTATING.has(req.method)) {
        if (!originAllowed(req)) throw new AppError('csrf_failed', 'Request origin not allowed');
        if (!csrfMatches(resolved.session.csrfToken, req.headers.get('x-csrf-token'))) {
          throw new AppError('csrf_failed', 'Your session token is out of date. Reload the page and try again.');
        }
      }
      const workspaceId = resolved.session.activeWorkspaceId;
      if (opts.workspace === false) {
        const ctx = { actor: resolved.actor, access: { workspaceId: workspaceId ?? '', role: 'viewer', brandIds: [], isDemo: false }, correlationId } as Ctx;
        return toResponse(await handler({ req, params: await segment.params, ctx, session: resolved.session, correlationId }), correlationId);
      }
      if (!workspaceId) throw new AppError('forbidden', 'You are not a member of any workspace yet');
      // A tab rendered for another workspace (switched elsewhere) must reload, never mix data (header is not authority).
      assertExpectedWorkspace(workspaceId, req.headers.get('x-workspace-id'));
      const access = await loadAccess(resolved.actor.userId, workspaceId, undefined,
        { mfaVerified: resolved.session.mfaVerified, authTime: resolved.session.authTime?.toISOString() ?? null });
      if (!access) throw new AppError('forbidden', 'You no longer have access to this workspace');
      const ctx: Ctx = { actor: resolved.actor, access, correlationId };
      return toResponse(await handler({ req, params: await segment.params, ctx, session: resolved.session, correlationId }), correlationId);
    } catch (err) {
      return errorResponse(err, correlationId);
    }
  };
}

/** Unauthenticated routes (OAuth callbacks, webhooks, health). Still uniform errors. */
export function publicRoute<P = Record<string, string>>(handler: PublicHandler<P>) {
  return async (req: NextRequest, segment: { params: Promise<P> }): Promise<Response> => {
    const correlationId = randomUUID();
    try {
      return toResponse(await handler({ req, params: await segment.params, correlationId }), correlationId);
    } catch (err) {
      return errorResponse(err, correlationId);
    }
  };
}

/** Parse a bounded JSON body with a zod schema. */
export async function parseJson<T>(req: NextRequest, schema: ZodType<T>): Promise<T> {
  const len = Number(req.headers.get('content-length') ?? '0');
  if (len > MAX_JSON_BYTES) throw new AppError('payload_too_large', 'Request body is too large');
  const text = await req.text();
  if (text.length > MAX_JSON_BYTES) throw new AppError('payload_too_large', 'Request body is too large');
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new AppError('validation_failed', 'Request body must be valid JSON');
  }
  return schema.parse(data);
}

export function idempotencyKey(req: NextRequest): string | null {
  return req.headers.get('idempotency-key');
}

// ------------------------------------------------------------------ V3.1 Admin: platform scope
export interface PlatformRouteArgs<P> { req: NextRequest; params: P; p: PlatformCtx; session: SessionRecord; correlationId: string }

/**
 * Platform-operator routes. Same session + CSRF + origin checks as route(); authority is the platform_operators row,
 * re-read from the database on every request (never the browser, never a workspace grant). Non-operators get 404 so the
 * platform surface isn't discoverable.
 */
export function platformRoute<P = Record<string, string>>(handler: (a: PlatformRouteArgs<P>) => Promise<Response | unknown>) {
  return async (req: NextRequest, segment: { params: Promise<P> }): Promise<Response> => {
    const correlationId = req.headers.get('x-correlation-id')?.slice(0, 64) || randomUUID();
    try {
      const resolved = await currentSession();
      if (!resolved) throw new AppError('unauthenticated', 'Please sign in again');
      if (MUTATING.has(req.method)) {
        if (!originAllowed(req)) throw new AppError('csrf_failed', 'Request origin not allowed');
        if (!csrfMatches(resolved.session.csrfToken, req.headers.get('x-csrf-token'))) {
          throw new AppError('csrf_failed', 'Your session token is out of date. Reload the page and try again.');
        }
      }
      const role = await loadOperatorRole(resolved.actor.userId);
      if (!role) throw new AppError('not_found', 'Not found');
      const p: PlatformCtx = { actor: resolved.actor, role, assurance: { mfaVerified: resolved.session.mfaVerified, authTime: resolved.session.authTime ?? null }, correlationId };
      return toResponse(await handler({ req, params: await segment.params, p, session: resolved.session, correlationId }), correlationId);
    } catch (err) {
      return errorResponse(err, correlationId);
    }
  };
}

/** Query string → plain object (for zod-parsed list filters). */
export function queryOf(req: NextRequest): Record<string, string> {
  return Object.fromEntries(req.nextUrl.searchParams.entries());
}
