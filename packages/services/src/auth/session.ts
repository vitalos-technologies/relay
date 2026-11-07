// Server-side sessions: opaque random token in a Secure HttpOnly cookie; only its
// SHA-256 is stored. CSRF uses a per-session token sent in a header (X-CSRF-Token)
// plus Origin verification on every mutation.
// V2: 30-minute idle / 12-hour absolute lifetime; assurance (acr/amr/auth_time/mfa) is written ONLY from a
// verified ID token (oidc.ts); the token is rotated on login and on step-up; users can list and revoke sessions.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getPool, many, maybeOne, type Queryable } from '@social-lite/db';
import type { Actor } from '../context.js';

export const SESSION_COOKIE = process.env.APP_ENV === 'production' ? '__Host-sl_session' : 'sl_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;   // 12 h absolute (no silent extension; sign in again)
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;       // 30 min idle
const TOUCH_INTERVAL_MS = 60_000;

export const sha256 = (s: string | Buffer): Buffer => createHash('sha256').update(s).digest();
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** Second-factor amr values (RFC 8176 + Keycloak references configured in the realm: rc = recovery code). */
export const SECOND_FACTOR_AMR = new Set(['otp', 'hwk', 'swk', 'sms', 'rc', 'mfa']);

export interface SessionAssurance {
  mfaVerified: boolean;
  authTime: Date | null;
  acr: string | null;
  amr: string[];
}

export interface SessionRecord extends SessionAssurance {
  id: string;
  userId: string;
  csrfToken: string;
  activeWorkspaceId: string | null;
  expiresAt: Date;
  createdAt?: Date;
  idpSessionId?: string | null;
  idpSubject?: string | null;
}

export interface NewSessionMeta {
  userAgent?: string | null; ip?: string | null; workspaceId?: string | null;
  mfaVerified?: boolean; authTime?: Date | null; acr?: string | null; amr?: string[];
  idpSessionId?: string | null; idpSubject?: string | null; idTokenEnc?: unknown;
}

export async function createSession(db: Queryable, userId: string, meta: NewSessionMeta): Promise<{ token: string; session: SessionRecord }> {
  const token = randomToken();
  const csrf = randomToken(24);
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  let workspaceId = meta.workspaceId ?? null;
  if (!workspaceId) {
    const ws = await maybeOne<{ workspace_id: string }>(db,
      `SELECT workspace_id FROM memberships WHERE user_id=$1 AND removed_at IS NULL ORDER BY created_at LIMIT 1`, [userId]);
    workspaceId = ws?.workspace_id ?? null;
  }
  const row = await maybeOne<{ id: string; created_at: Date }>(db,
    `INSERT INTO sessions(user_id, token_hash, csrf_token, active_workspace_id, expires_at, user_agent, ip, mfa_verified, auth_time, acr, amr,
                          idp_session_id, idp_subject, id_token_enc)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id, created_at`,
    [userId, sha256(token), csrf, workspaceId, expires, meta.userAgent?.slice(0, 300) ?? null, meta.ip ?? null,
      !!meta.mfaVerified, meta.authTime ?? null, meta.acr ?? null, meta.amr ?? [], meta.idpSessionId ?? null, meta.idpSubject ?? null,
      meta.idTokenEnc ? JSON.stringify(meta.idTokenEnc) : null]);
  return {
    token,
    session: { id: row!.id, userId, csrfToken: csrf, activeWorkspaceId: workspaceId, expiresAt: expires, createdAt: row!.created_at,
      mfaVerified: !!meta.mfaVerified, authTime: meta.authTime ?? null, acr: meta.acr ?? null, amr: meta.amr ?? [],
      idpSessionId: meta.idpSessionId ?? null, idpSubject: meta.idpSubject ?? null },
  };
}

interface SessionJoinRow {
  id: string; user_id: string; csrf_token: string; active_workspace_id: string | null; expires_at: Date; last_seen_at: Date; created_at: Date;
  email: string; name: string | null; disabled_at: Date | null; mfa_verified: boolean; auth_time: Date | null; acr: string | null; amr: string[];
  idp_session_id: string | null; idp_subject: string | null;
}

const toRecord = (r: SessionJoinRow): SessionRecord => ({
  id: r.id, userId: r.user_id, csrfToken: r.csrf_token, activeWorkspaceId: r.active_workspace_id, expiresAt: r.expires_at, createdAt: r.created_at,
  mfaVerified: r.mfa_verified, authTime: r.auth_time, acr: r.acr, amr: r.amr ?? [], idpSessionId: r.idp_session_id, idpSubject: r.idp_subject,
});

export async function resolveSession(token: string | undefined | null, db: Queryable = getPool()): Promise<{ session: SessionRecord; actor: Actor } | null> {
  if (!token || token.length > 200) return null;
  const r = await maybeOne<SessionJoinRow>(db,
    `SELECT s.id, s.user_id, s.csrf_token, s.active_workspace_id, s.expires_at, s.last_seen_at, s.created_at, u.email, u.name, u.disabled_at,
            s.mfa_verified, s.auth_time, s.acr, s.amr, s.idp_session_id, s.idp_subject
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`, [sha256(token)]);
  if (!r || r.disabled_at) return null;
  if (Date.now() - r.last_seen_at.getTime() > IDLE_TIMEOUT_MS) {
    await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'idle_timeout' WHERE id = $1 AND revoked_at IS NULL`, [r.id]);
    return null;
  }
  if (Date.now() - r.last_seen_at.getTime() > TOUCH_INTERVAL_MS) {
    await db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [r.id]);
  }
  return { session: toRecord(r), actor: { userId: r.user_id, email: r.email, name: r.name, sessionId: r.id } };
}

export async function revokeSession(db: Queryable, sessionId: string, reason = 'signed_out'): Promise<void> {
  await db.query('UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL', [sessionId, reason]);
}

/**
 * Rotate the session token (new cookie value + new CSRF token) and record new server-trusted assurance.
 * Used after step-up / IdP actions: the old cookie value stops working immediately.
 */
export async function rotateSession(db: Queryable, sessionId: string, assurance: SessionAssurance & { idpSessionId?: string | null; idTokenEnc?: unknown }): Promise<{ token: string; csrfToken: string }> {
  const token = randomToken();
  const csrf = randomToken(24);
  const r = await db.query(
    `UPDATE sessions SET token_hash=$2, csrf_token=$3, mfa_verified=$4, auth_time=$5, acr=$6, amr=$7,
            idp_session_id=coalesce($8, idp_session_id), id_token_enc=coalesce($9::jsonb, id_token_enc), last_seen_at=now()
      WHERE id=$1 AND revoked_at IS NULL AND expires_at > now()`,
    [sessionId, sha256(token), csrf, assurance.mfaVerified, assurance.authTime, assurance.acr, assurance.amr,
      assurance.idpSessionId ?? null, assurance.idTokenEnc ? JSON.stringify(assurance.idTokenEnc) : null]);
  if (r.rowCount !== 1) throw new Error('session_not_active');
  return { token, csrfToken: csrf };
}

export async function setActiveWorkspace(db: Queryable, sessionId: string, workspaceId: string): Promise<void> {
  await db.query('UPDATE sessions SET active_workspace_id = $2 WHERE id = $1', [sessionId, workspaceId]);
}

export function csrfMatches(expected: string, provided: string | null | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ------------------------------------------------------------------ session management (My Security)

export interface SessionView {
  id: string; current: boolean; created_at: string; last_seen_at: string; expires_at: string;
  user_agent: string | null; mfa_verified: boolean; acr: string | null; amr: string[]; auth_time: string | null;
}

/** The caller's own live sessions. Location is intentionally not derived from IP addresses. */
export async function listUserSessions(db: Queryable, userId: string, currentSessionId: string): Promise<SessionView[]> {
  const rows = await many<{ id: string; created_at: Date; last_seen_at: Date; expires_at: Date; user_agent: string | null; mfa_verified: boolean; acr: string | null; amr: string[]; auth_time: Date | null }>(db,
    `SELECT id, created_at, last_seen_at, expires_at, user_agent, mfa_verified, acr, amr, auth_time FROM sessions
      WHERE user_id=$1 AND revoked_at IS NULL AND expires_at > now() AND last_seen_at > now() - make_interval(secs => $2)
      ORDER BY (id = $3) DESC, last_seen_at DESC LIMIT 50`, [userId, IDLE_TIMEOUT_MS / 1000, currentSessionId]);
  return rows.map((r) => ({ id: r.id, current: r.id === currentSessionId, created_at: r.created_at.toISOString(), last_seen_at: r.last_seen_at.toISOString(),
    expires_at: r.expires_at.toISOString(), user_agent: r.user_agent, mfa_verified: r.mfa_verified, acr: r.acr, amr: r.amr ?? [], auth_time: r.auth_time?.toISOString() ?? null }));
}

/** Revoke one of the caller's sessions (never another user's). Returns false when nothing matched. */
export async function revokeUserSession(db: Queryable, userId: string, sessionId: string, reason = 'revoked_by_user'): Promise<boolean> {
  const r = await db.query(`UPDATE sessions SET revoked_at=now(), revoked_reason=$3 WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`, [sessionId, userId, reason]);
  return r.rowCount === 1;
}

/** Revoke every other live session of the caller. Returns the number revoked. */
export async function revokeOtherSessions(db: Queryable, userId: string, keepSessionId: string): Promise<number> {
  const r = await db.query(`UPDATE sessions SET revoked_at=now(), revoked_reason='revoked_by_user' WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL`, [userId, keepSessionId]);
  return r.rowCount ?? 0;
}
