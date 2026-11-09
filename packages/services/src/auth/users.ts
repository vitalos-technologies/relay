// OIDC user resolution. Users are identified by (issuer, subject). Pre-provisioned users
// (seed/admin-created) have oidc_issuer='pending' and an email: the first VERIFIED login with that
// email binds them. A bound user is never re-bound to a different subject.
import { maybeOne, type Queryable } from '@social-lite/db';
import { log } from '../log.js';

export const PENDING_ISSUER = 'pending';

/** Login failures with a stable code used in the redirect (?error=<code>). Messages are user-safe. */
export class LoginError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'LoginError';
  }
}

export interface OidcIdentity {
  issuer: string;
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

interface UserRow { id: string; oidc_issuer: string; oidc_subject: string; email: string; name: string | null; disabled_at: Date | null }

/** Must run inside a transaction (uses row locks). */
export async function resolveOidcUser(tx: Queryable, id: OidcIdentity): Promise<{ userId: string; created: boolean; bound: boolean }> {
  if (!id.emailVerified) throw new LoginError('email_not_verified', 'Your identity provider has not verified your email address.');
  const email = id.email.trim();
  if (!email || email.length > 320 || !email.includes('@')) throw new LoginError('email_missing', 'Your identity provider did not share a valid email address.');
  const name = id.name?.trim().slice(0, 200) || null;

  const existing = await maybeOne<UserRow>(tx,
    `SELECT id, oidc_issuer, oidc_subject, email, name, disabled_at FROM users WHERE oidc_issuer=$1 AND oidc_subject=$2 FOR UPDATE`,
    [id.issuer, id.subject]);
  if (existing) {
    if (existing.disabled_at) throw new LoginError('account_disabled', 'This account has been disabled.');
    let newEmail = existing.email;
    if (existing.email.toLowerCase() !== email.toLowerCase()) {
      const clash = await maybeOne<{ id: string }>(tx, `SELECT id FROM users WHERE email=$1 AND id<>$2`, [email, existing.id]);
      if (clash) log.warn('oidc_email_change_conflict', { userId: existing.id });
      else newEmail = email;
    }
    await tx.query(`UPDATE users SET email=$2, email_verified=true, name=coalesce($3, name), last_login_at=now() WHERE id=$1`,
      [existing.id, newEmail, name]);
    return { userId: existing.id, created: false, bound: false };
  }

  const byEmail = await maybeOne<UserRow>(tx,
    `SELECT id, oidc_issuer, oidc_subject, email, name, disabled_at FROM users WHERE email=$1 FOR UPDATE`, [email]);
  if (byEmail) {
    if (byEmail.oidc_issuer !== PENDING_ISSUER) {
      // Same email, different identity: never re-bind (account takeover protection).
      throw new LoginError('account_conflict', 'This email address is already linked to a different sign-in account. Contact your workspace owner.');
    }
    if (byEmail.disabled_at) throw new LoginError('account_disabled', 'This account has been disabled.');
    await tx.query(
      `UPDATE users SET oidc_issuer=$2, oidc_subject=$3, email_verified=true, name=coalesce(name, $4), last_login_at=now() WHERE id=$1`,
      [byEmail.id, id.issuer, id.subject, name]);
    return { userId: byEmail.id, created: false, bound: true };
  }

  const created = await maybeOne<{ id: string }>(tx,
    `INSERT INTO users(oidc_issuer, oidc_subject, email, email_verified, name, last_login_at) VALUES ($1,$2,$3,true,$4,now())
     ON CONFLICT DO NOTHING RETURNING id`, [id.issuer, id.subject, email, name]);
  if (!created) throw new LoginError('account_conflict', 'Another sign-in was in progress. Try again.');
  return { userId: created.id, created: true, bound: false };
}
