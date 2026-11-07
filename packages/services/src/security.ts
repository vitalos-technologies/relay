// My Security: the signed-in user's own assurance, sign-in factors (read from the IdP), sessions and recent
// security events. Factor changes are Keycloak application-initiated actions performed by the user; removing or
// regenerating a factor requires a fresh, MFA-verified session (step-up). No endpoint lets anyone change
// ANOTHER user's factors.
import { AppError, requiresMfa } from '@social-lite/core';
import { getPool, many, maybeOne, type Queryable } from '@social-lite/db';
import { audit } from './audit.js';
import { loadUserAuthz } from './authz.js';
import { idpFactors, IDP_ACTIONS, type IdpAction, type IdpFactors } from './auth/idp-admin.js';
import { startIdpAction } from './auth/oidc.js';
import { listUserSessions, revokeOtherSessions, revokeUserSession, type SessionRecord, type SessionView } from './auth/session.js';

export const DEFAULT_STEP_UP_SECONDS = 300;

export interface SecurityOverview {
  assurance: { mfa_verified: boolean; acr: string | null; amr: string[]; auth_time: string | null; fresh_until: string | null };
  mfa_required: boolean;
  factors: { available: boolean; totp: IdpFactors['totp']; passkeys: IdpFactors['passkeys']; recovery_codes: IdpFactors['recoveryCodes'] };
  sessions: SessionView[];
  events: Array<{ id: string; action: string; at: string; detail: Record<string, unknown> }>;
}

async function stepUpSeconds(session: SessionRecord, db: Queryable): Promise<number> {
  if (!session.activeWorkspaceId) return DEFAULT_STEP_UP_SECONDS;
  const w = await maybeOne<{ s: number | null }>(db, `SELECT (security_policy->>'step_up_seconds')::int AS s FROM workspaces WHERE id=$1`, [session.activeWorkspaceId]);
  return w?.s ?? DEFAULT_STEP_UP_SECONDS;
}

/** True when the session verified MFA and authenticated within the step-up window. */
export async function sessionIsFresh(session: SessionRecord, db: Queryable = getPool()): Promise<boolean> {
  if (!session.mfaVerified || !session.authTime) return false;
  return Date.now() - session.authTime.getTime() <= (await stepUpSeconds(session, db)) * 1000;
}

const SECURITY_EVENT_KINDS = ['auth', 'session', 'user'];

export async function securityOverview(userId: string, session: SessionRecord, db: Queryable = getPool()): Promise<SecurityOverview> {
  const user = await maybeOne<{ oidc_subject: string; oidc_issuer: string }>(db, `SELECT oidc_subject, oidc_issuer FROM users WHERE id=$1`, [userId]);
  const factors = user && user.oidc_issuer !== 'pending' ? await idpFactors(session.idpSubject ?? user.oidc_subject) : null;
  let mfaRequired = false;
  if (session.activeWorkspaceId) {
    const a = await loadUserAuthz(userId, session.activeWorkspaceId, { mfaVerified: session.mfaVerified, authTime: session.authTime?.toISOString() ?? null }, db);
    mfaRequired = a.subject.status === 'active' && requiresMfa(a.subject, a.policy, new Date());
  }
  const window = await stepUpSeconds(session, db);
  const events = await many<{ id: string; action: string; created_at: Date; diff: Record<string, unknown> }>(db,
    `SELECT id::text, action, created_at, diff FROM audit_events
      WHERE (actor_user_id = $1 AND split_part(action, '.', 1) = ANY($2::text[]))
         OR (actor_user_id IS NULL AND resource_type = 'user' AND resource_id = $1::text AND split_part(action, '.', 1) = 'session')
      ORDER BY created_at DESC, id DESC LIMIT 20`, [userId, SECURITY_EVENT_KINDS]);
  return {
    assurance: {
      mfa_verified: session.mfaVerified, acr: session.acr, amr: session.amr, auth_time: session.authTime?.toISOString() ?? null,
      fresh_until: session.mfaVerified && session.authTime ? new Date(session.authTime.getTime() + window * 1000).toISOString() : null,
    },
    mfa_required: mfaRequired,
    factors: { available: !!factors?.available, totp: factors?.totp ?? [], passkeys: factors?.passkeys ?? [], recovery_codes: factors?.recoveryCodes ?? null },
    sessions: await listUserSessions(db, userId, session.id),
    events: events.map((e) => ({ id: e.id, action: e.action, at: e.created_at.toISOString(), detail: safeDetail(e.diff) })),
  };
}

function safeDetail(d: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ['acr', 'amr', 'mfa', 'action', 'status', 'sessions', 'count']) if (k in d) out[k] = d[k];
  return out;
}

export async function revokeMySession(userId: string, current: SessionRecord, sessionId: string, db: Queryable = getPool()): Promise<{ current: boolean }> {
  const ok = await revokeUserSession(db, userId, sessionId);
  if (!ok) throw new AppError('not_found', 'Session not found');
  await audit(db, { workspaceId: null, actorUserId: userId, action: 'session.revoked', resourceType: 'session', resourceId: sessionId, diff: { current: sessionId === current.id } });
  return { current: sessionId === current.id };
}

export async function revokeMyOtherSessions(userId: string, current: SessionRecord, db: Queryable = getPool()): Promise<{ revoked: number }> {
  const n = await revokeOtherSessions(db, userId, current.id);
  await audit(db, { workspaceId: null, actorUserId: userId, action: 'session.revoked_others', resourceType: 'session', resourceId: current.id, diff: { count: n } });
  return { revoked: n };
}

/**
 * Start a factor action at the IdP for the CURRENT user. Adding a first factor needs no step-up (the IdP itself
 * re-authenticates for the action); removing a factor, regenerating recovery codes or adding/replacing a factor
 * when one already exists requires a fresh MFA-verified session (401 step_up_required otherwise).
 */
export async function startFactorAction(userId: string, session: SessionRecord, input: { action: string; credential_id?: string | null }, returnTo = '/security', db: Queryable = getPool()) {
  if (!(IDP_ACTIONS as readonly string[]).includes(input.action)) throw new AppError('validation_failed', 'Unknown action', { action: 'Unsupported' });
  const action = input.action as IdpAction;
  const user = await maybeOne<{ oidc_subject: string; oidc_issuer: string }>(db, `SELECT oidc_subject, oidc_issuer FROM users WHERE id=$1`, [userId]);
  if (!user || user.oidc_issuer === 'pending') throw new AppError('invalid_state', 'Sign in again first');
  const factors = await idpFactors(session.idpSubject ?? user.oidc_subject);
  if (!factors.available) throw new AppError('provider_error', 'Sign-in methods are unavailable right now. Try again.');
  const sensitive = action === 'delete_credential' || (action === 'CONFIGURE_RECOVERY_AUTHN_CODES' && !!factors.recoveryCodes) || factors.hasSecondFactor;
  if (sensitive && !(await sessionIsFresh(session, db))) {
    throw new AppError('step_up_required', 'Confirm it’s you to change sign-in methods.', undefined, { reason: 'step_up_required' });
  }
  if (action === 'delete_credential') {
    const owned = [...factors.totp, ...factors.passkeys, ...(factors.recoveryCodes ? [factors.recoveryCodes] : [])].some((c) => c.id === input.credential_id);
    if (!owned) throw new AppError('not_found', 'Sign-in method not found');
  }
  const started = await startIdpAction(session, action, { credentialId: input.credential_id ?? null, returnTo }, db);
  await audit(db, { workspaceId: null, actorUserId: userId, action: 'auth.factor_action_started', resourceType: 'session', resourceId: session.id, diff: { action } });
  return started;
}
