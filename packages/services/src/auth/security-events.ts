// Follow-up to sensitive authentication events (spec §5): after a sign-in that used a RECOVERY CODE, or after the
// user changed a sign-in factor at the IdP (added/removed an authenticator app or passkey, generated/removed recovery
// codes), every OTHER session of that user is revoked, the event is audited and the user is told by email at their
// IdP-verified address. The current session (the one that just proved itself) is kept.
import { BRAND } from '@social-lite/core';
import { maybeOne, type Queryable } from '@social-lite/db';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { sendMail } from '../email.js';
import { revokeOtherSessions } from './session.js';

export type SensitiveAuthEvent = 'recovery_code' | 'factor_change';

const ACTION_TEXT: Record<string, string> = {
  CONFIGURE_TOTP: 'An authenticator app was added',
  'webauthn-register': 'A passkey was added',
  CONFIGURE_RECOVERY_AUTHN_CODES: 'New recovery codes were generated (old codes no longer work)',
  delete_credential: 'A sign-in method was removed',
};

export function securityChangeText(kind: SensitiveAuthEvent, action: string | null): string {
  if (kind === 'recovery_code') return 'A recovery code was used to sign in';
  return ACTION_TEXT[(action ?? '').split(':')[0]!] ?? 'Your sign-in methods changed';
}

export async function afterSensitiveAuthEvent(
  db: Queryable,
  p: { userId: string; keepSessionId: string; kind: SensitiveAuthEvent; action?: string | null; userAgent?: string | null },
): Promise<{ revoked: number; notified: boolean }> {
  const revoked = await revokeOtherSessions(db, p.userId, p.keepSessionId);
  const what = securityChangeText(p.kind, p.action ?? null);
  const u = await maybeOne<{ email: string; email_verified: boolean; name: string | null }>(db, `SELECT email, email_verified, name FROM users WHERE id=$1`, [p.userId]);
  let notified = false;
  if (u?.email_verified) {
    const url = `${config().APP_BASE_URL.replace(/\/$/, '')}/security`;
    notified = await sendMail({
      to: u.email,
      subject: `${BRAND.name} security alert: ${what.toLowerCase()}`,
      text: [
        `Hi${u.name ? ` ${u.name}` : ''},`,
        '',
        `${what} on your ${BRAND.name} account at ${new Date().toUTCString()}.`,
        revoked ? `For your safety we signed out your other ${revoked === 1 ? 'session' : `${revoked} sessions`}.` : 'You had no other active sessions.',
        '',
        `If this was you, no action is needed. If not, open ${url}, sign out every session and contact your workspace owner.`,
      ].join('\n'),
    });
  }
  await audit(db, {
    workspaceId: null, actorUserId: p.userId, action: p.kind === 'recovery_code' ? 'auth.recovery_code_used' : 'auth.factor_changed_followup',
    resourceType: 'user', resourceId: p.userId, diff: { action: p.action ?? null, sessions: revoked, status: notified ? 'notified' : 'not_notified' },
  });
  return { revoked, notified };
}
