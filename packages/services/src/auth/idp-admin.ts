// Read-only view of a user's sign-in factors at the identity provider (Keycloak Admin REST API), used by
// My Security and to decide whether a second-factor prompt can be requested. The app's confidential client
// uses its own service account, which holds ONLY realm-management/view-users: the app can list a user's
// credentials but cannot create, delete or reset them, and has no endpoint that removes another user's MFA.
// Factor changes happen through Keycloak application-initiated actions performed by the user themself.
import { AppError } from '@social-lite/core';
import { config } from '../config.js';
import { log } from '../log.js';

export interface IdpCredential { id: string; type: string; label: string | null; created_at: string | null }
export interface IdpFactors {
  available: boolean;
  totp: IdpCredential[];
  passkeys: IdpCredential[];
  recoveryCodes: IdpCredential | null;
  /** True when at least one second factor (TOTP, passkey/security key, recovery codes) is configured. */
  hasSecondFactor: boolean;
}

export const IDP_ACTIONS = ['CONFIGURE_TOTP', 'webauthn-register', 'CONFIGURE_RECOVERY_AUTHN_CODES', 'delete_credential'] as const;
export type IdpAction = (typeof IDP_ACTIONS)[number];

/** Keycloak realm issuer → admin base (https://host/realms/x → https://host/admin/realms/x). Null for other IdPs. */
export function keycloakAdminBase(issuer = config().OIDC_ISSUER): string | null {
  if (!issuer) return null;
  const m = /^(https?:\/\/.+)\/realms\/([^/]+)\/?$/.exec(issuer);
  return m ? `${m[1]}/admin/realms/${m[2]}` : null;
}

let token: { value: string; exp: number; key: string } | undefined;

async function adminToken(): Promise<string> {
  const c = config();
  const key = `${c.OIDC_ISSUER}|${c.OIDC_CLIENT_ID}`;
  if (token && token.key === key && token.exp > Date.now() + 15_000) return token.value;
  const res = await fetch(`${c.OIDC_ISSUER!.replace(/\/$/, '')}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${encodeURIComponent(c.OIDC_CLIENT_ID!)}:${encodeURIComponent(c.OIDC_CLIENT_SECRET!)}`).toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new AppError('provider_error', 'Couldn’t reach the sign-in provider. Try again.');
  const j = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000, key };
  return j.access_token;
}

/** The user's sign-in factors at the IdP, by IdP subject. Never returns secrets (Keycloak never exposes them). */
export async function idpFactors(subject: string): Promise<IdpFactors> {
  const base = keycloakAdminBase();
  const none: IdpFactors = { available: false, totp: [], passkeys: [], recoveryCodes: null, hasSecondFactor: false };
  if (!base || !/^[A-Za-z0-9._:-]{1,128}$/.test(subject)) return none;
  let res: Response;
  try {
    res = await fetch(`${base}/users/${encodeURIComponent(subject)}/credentials`, { headers: { authorization: `Bearer ${await adminToken()}` }, signal: AbortSignal.timeout(8000) });
  } catch (err) {
    log.warn('idp_factors_unavailable', { err: { name: (err as Error).name } });
    return none;
  }
  if (res.status === 404) return { ...none, available: true };
  if (!res.ok) {
    log.warn('idp_factors_failed', { status: res.status });
    return none;
  }
  const rows = (await res.json()) as Array<{ id: string; type: string; userLabel?: string; createdDate?: number }>;
  const view = (r: (typeof rows)[number]): IdpCredential => ({ id: r.id, type: r.type, label: r.userLabel ?? null, created_at: r.createdDate ? new Date(r.createdDate).toISOString() : null });
  const totp = rows.filter((r) => r.type === 'otp').map(view);
  const passkeys = rows.filter((r) => r.type === 'webauthn' || r.type === 'webauthn-passwordless').map(view);
  const rc = rows.find((r) => r.type === 'recovery-authn-codes');
  return { available: true, totp, passkeys, recoveryCodes: rc ? view(rc) : null, hasSecondFactor: totp.length > 0 || passkeys.length > 0 || !!rc };
}

/** Reset the cached admin token (tests / configuration change). */
export function resetIdpAdminCache(): void {
  token = undefined;
}
