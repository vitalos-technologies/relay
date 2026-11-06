// Server-side sessions: opaque random token in a Secure HttpOnly cookie; only its
// SHA-256 is stored. CSRF uses a per-session token sent in a header (X-CSRF-Token)
// plus Origin verification on every mutation.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getPool, maybeOne, type Queryable } from '@social-lite/db';
import type { Actor } from '../context.js';

export const SESSION_COOKIE = process.env.APP_ENV === 'production' ? '__Host-sl_session' : 'sl_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h absolute
const IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;      // 2h idle

export const sha256 = (s: string | Buffer): Buffer => createHash('sha256').update(s).digest();
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export interface SessionRecord {
  id: string;
  userId: string;
  csrfToken: string;
  activeWorkspaceId: string | null;
  expiresAt: Date;
}

export async function createSession(db: Queryable, userId: string, meta: { userAgent?: string | null; ip?: string | null; workspaceId?: string | null }): Promise<{ token: string; session: SessionRecord }> {
  const token = randomToken();
  const csrf = randomToken(24);
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  let workspaceId = meta.workspaceId ?? null;
  if (!workspaceId) {
    const ws = await maybeOne<{ workspace_id: string }>(db,
      `SELECT workspace_id FROM memberships WHERE user_id=$1 AND removed_at IS NULL ORDER BY created_at LIMIT 1`, [userId]);
    workspaceId = ws?.workspace_id ?? null;
  }
  const row = await maybeOne<{ id: string }>(db,
    `INSERT INTO sessions(user_id, token_hash, csrf_token, active_workspace_id, expires_at, user_agent, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [userId, sha256(token), csrf, workspaceId, expires, meta.userAgent?.slice(0, 300) ?? null, meta.ip ?? null]);
  return { token, session: { id: row!.id, userId, csrfToken: csrf, activeWorkspaceId: workspaceId, expiresAt: expires } };
}

export async function resolveSession(token: string | undefined | null): Promise<{ session: SessionRecord; actor: Actor } | null> {
  if (!token || token.length > 200) return null;
  const db = getPool();
  const r = await maybeOne<{
    id: string; user_id: string; csrf_token: string; active_workspace_id: string | null; expires_at: Date; last_seen_at: Date;
    email: string; name: string | null; disabled_at: Date | null;
  }>(db,
    `SELECT s.id, s.user_id, s.csrf_token, s.active_workspace_id, s.expires_at, s.last_seen_at, u.email, u.name, u.disabled_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`, [sha256(token)]);
  if (!r || r.disabled_at) return null;
  if (Date.now() - r.last_seen_at.getTime() > IDLE_TIMEOUT_MS) {
    await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [r.id]);
    return null;
  }
  if (Date.now() - r.last_seen_at.getTime() > 60_000) {
    await db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [r.id]);
  }
  return {
    session: { id: r.id, userId: r.user_id, csrfToken: r.csrf_token, activeWorkspaceId: r.active_workspace_id, expiresAt: r.expires_at },
    actor: { userId: r.user_id, email: r.email, name: r.name, sessionId: r.id },
  };
}

export async function revokeSession(db: Queryable, sessionId: string): Promise<void> {
  await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [sessionId]);
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
