// OIDC login (authorization code + PKCE S256 + nonce) using openid-client v6.
//  - state: random, single-use, 10-minute expiry, only sha256(state) stored (oauth_states, purpose 'login')
//  - PKCE verifier (and the optional invitation token) stored encrypted with encryptSecret(…, pkceAad)
//  - the login attempt is bound to the initiating browser by a short-lived HttpOnly cookie whose
//    hash is inside the encrypted blob (prevents login CSRF / callback-URL injection)
//  - requires email_verified; users identified by (issuer, subject); see users.ts for binding rules
import { isIP } from 'node:net';
import * as oidc from 'openid-client';
import { AppError } from '@social-lite/core';
import { getPool, maybeOne, withTx, type Queryable } from '@social-lite/db';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { decryptSecret, encryptSecret, pkceAad, type EncryptedBlob } from '../crypto.js';
import { log } from '../log.js';
import { acceptInvitation } from './invitations.js';
import { createSession, randomToken, sha256, type SessionRecord } from './session.js';
import { LoginError, resolveOidcUser } from './users.js';

export const LOGIN_STATE_TTL_MS = 10 * 60 * 1000;
export const LOGIN_BINDING_COOKIE = process.env.APP_ENV === 'production' ? '__Host-sl_login' : 'sl_login';

let cached: { key: string; promise: Promise<oidc.Configuration> } | undefined;

export function oidcConfigured(): boolean {
  const c = config();
  return !!(c.OIDC_ISSUER && c.OIDC_CLIENT_ID && c.OIDC_CLIENT_SECRET);
}

export function insecureHttpAllowed(): boolean {
  const c = config();
  return c.OIDC_ALLOW_INSECURE_HTTP && c.APP_ENV !== 'production';
}

/** Discovered OIDC client configuration (cached per process; retried after failures). */
export async function oidcConfiguration(): Promise<oidc.Configuration> {
  const c = config();
  if (!oidcConfigured()) throw new AppError('provider_not_configured', 'Sign-in is not configured (OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET).');
  const key = [c.OIDC_ISSUER, c.OIDC_CLIENT_ID, c.OIDC_ALLOW_INSECURE_HTTP, c.APP_ENV].join('|');
  if (!cached || cached.key !== key) {
    const promise = oidc.discovery(new URL(c.OIDC_ISSUER!), c.OIDC_CLIENT_ID!, { redirect_uris: [callbackUrl()], response_types: ['code'] },
      oidc.ClientSecretBasic(c.OIDC_CLIENT_SECRET!),
      { execute: insecureHttpAllowed() ? [oidc.allowInsecureRequests] : [], timeout: 10 });
    cached = { key, promise };
    promise.catch(() => { if (cached?.promise === promise) cached = undefined; });
  }
  return cached.promise;
}

export function callbackUrl(): string {
  return `${config().APP_BASE_URL.replace(/\/$/, '')}/api/auth/callback`;
}

/** Only same-site relative paths are accepted as post-login destinations. */
export function safeReturnTo(raw: string | null | undefined): string {
  if (!raw || raw.length > 512) return '/';
  // eslint-disable-next-line no-control-regex
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\') || /[\u0000-\u001f\u007f\\]/.test(raw)) return '/';
  try {
    const base = new URL(config().APP_BASE_URL);
    const u = new URL(raw, base);
    if (u.origin !== base.origin) return '/';
    if (u.pathname.startsWith('/api/')) return '/';
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return '/';
  }
}

interface StateSecret { v: string; invite?: string; b: string }

export interface LoginStart {
  authorizationUrl: string;
  /** Value for the LOGIN_BINDING_COOKIE (HttpOnly, path /api/auth, 10 minutes). */
  binding: string;
}

export async function startLogin(p: { returnTo?: string | null; invite?: string | null }, db: Queryable = getPool()): Promise<LoginStart> {
  const cfg = await oidcConfiguration();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const verifier = oidc.randomPKCECodeVerifier();
  const challenge = await oidc.calculatePKCECodeChallenge(verifier);
  const binding = randomToken(24);
  const invite = p.invite && p.invite.length <= 200 ? p.invite : undefined;
  const secret: StateSecret = { v: verifier, b: sha256(binding).toString('base64url'), ...(invite ? { invite } : {}) };
  await db.query(
    `INSERT INTO oauth_states(state_hash, purpose, provider, code_verifier_enc, nonce, redirect_after, invitation_token_hash, expires_at)
     VALUES ($1,'login','oidc',$2,$3,$4,$5,$6)`,
    [sha256(state), JSON.stringify(encryptSecret(secret, pkceAad)), nonce, safeReturnTo(p.returnTo),
      invite ? sha256(invite) : null, new Date(Date.now() + LOGIN_STATE_TTL_MS)]);
  // Opportunistic cleanup of stale login states.
  db.query(`DELETE FROM oauth_states WHERE purpose='login' AND expires_at < now() - interval '1 day'`).catch(() => undefined);
  const url = oidc.buildAuthorizationUrl(cfg, {
    redirect_uri: callbackUrl(),
    scope: 'openid email profile',
    response_type: 'code',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return { authorizationUrl: url.toString(), binding };
}

export interface LoginResult {
  token: string;
  session: SessionRecord;
  userId: string;
  redirectTo: string;
  invitation?: { accepted: boolean; workspaceId?: string; error?: string };
}

/**
 * Complete the callback. `callbackParams` is the query string received at /api/auth/callback.
 * Throws LoginError (stable code, user-safe message) when sign-in fails. An invitation that cannot be
 * accepted does NOT fail the login: the result's redirectTo points back to /invite/<token>?error=<code>.
 */
export async function completeLogin(
  callbackParams: URLSearchParams,
  p: { binding: string | null | undefined; userAgent?: string | null; ip?: string | null },
  db = getPool(),
): Promise<LoginResult> {
  if (callbackParams.get('error')) {
    throw new LoginError('idp_error', 'Sign-in was cancelled or refused by the identity provider.');
  }
  const state = callbackParams.get('state');
  if (!state || state.length > 200) throw new LoginError('invalid_state', 'Your sign-in link is invalid or expired. Please sign in again.');

  // Single use: consume atomically; expired or replayed states match nothing.
  const row = await maybeOne<{ id: string; code_verifier_enc: EncryptedBlob; nonce: string; redirect_after: string | null; invitation_token_hash: Buffer | null }>(db,
    `UPDATE oauth_states SET consumed_at=now()
      WHERE state_hash=$1 AND purpose='login' AND consumed_at IS NULL AND expires_at > now()
      RETURNING id, code_verifier_enc, nonce, redirect_after, invitation_token_hash`, [sha256(state)]);
  if (!row) throw new LoginError('invalid_state', 'Your sign-in link is invalid or expired. Please sign in again.');
  const secret = decryptSecret<StateSecret>(row.code_verifier_enc, pkceAad);
  if (!p.binding || sha256(p.binding).toString('base64url') !== secret.b) {
    throw new LoginError('invalid_state', 'Sign-in must be completed in the same browser that started it. Please sign in again.');
  }

  const cfg = await oidcConfiguration();
  const current = new URL(callbackUrl());
  current.search = callbackParams.toString();
  let claims: oidc.IDToken | undefined;
  let accessToken: string;
  try {
    const tokens = await oidc.authorizationCodeGrant(cfg, current, {
      pkceCodeVerifier: secret.v, expectedState: state, expectedNonce: row.nonce, idTokenExpected: true,
    });
    claims = tokens.claims();
    accessToken = tokens.access_token;
  } catch (err) {
    log.warn('oidc_code_exchange_failed', { err: { name: (err as Error).name, code: (err as { code?: string }).code } });
    throw new LoginError('token_exchange_failed', 'Sign-in could not be completed. Please try again.');
  }
  if (!claims?.sub) throw new LoginError('token_exchange_failed', 'Sign-in could not be completed. Please try again.');

  let email = typeof claims.email === 'string' ? claims.email : undefined;
  let verified = claims.email_verified === true;
  let name = typeof claims.name === 'string' ? claims.name : typeof claims.preferred_username === 'string' ? claims.preferred_username : null;
  if (!email || claims.email_verified === undefined) {
    try {
      const info = await oidc.fetchUserInfo(cfg, accessToken, claims.sub);
      email = typeof info.email === 'string' ? info.email : email;
      verified = info.email_verified === true;
      name = name ?? (typeof info.name === 'string' ? info.name : null);
    } catch {
      /* fall through: treated as unverified */
    }
  }
  const issuer = cfg.serverMetadata().issuer;

  const user = await withTx(async (tx) => {
    const r = await resolveOidcUser(tx, { issuer, subject: claims!.sub, email: email ?? '', emailVerified: verified, name });
    await audit(tx, { workspaceId: null, actorUserId: r.userId, action: r.created ? 'user.created' : r.bound ? 'user.bound' : 'user.login', resourceType: 'user', resourceId: r.userId });
    return r;
  }, db);
  // Invitations bind to the email VERIFIED by the identity provider in this login.
  const verifiedEmail = email ?? '';

  let invitation: LoginResult['invitation'];
  let workspaceId: string | null = null;
  if (row.invitation_token_hash) {
    try {
      const acc = await withTx((tx) => acceptInvitation(tx, row.invitation_token_hash!, { id: user.userId, email: verifiedEmail }), db);
      invitation = { accepted: true, workspaceId: acc.workspaceId };
      workspaceId = acc.workspaceId;
    } catch (err) {
      if (!(err instanceof LoginError)) throw err;
      invitation = { accepted: false, error: err.code };
    }
  }

  const { token, session } = await createSession(db, user.userId, { userAgent: p.userAgent, ip: normalizeIp(p.ip), workspaceId });
  let redirectTo = row.redirect_after ?? '/';
  if (invitation && !invitation.accepted && secret.invite) {
    redirectTo = `/invite/${encodeURIComponent(secret.invite)}?error=${encodeURIComponent(invitation.error ?? 'invitation_invalid')}`;
  }
  return { token, session, userId: user.userId, redirectTo, invitation };
}

function normalizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  // inet column: accept only well-formed addresses.
  return isIP(ip) ? ip : null;
}

/** Path for redirecting a failed login to a user-visible page. */
export function loginErrorRedirect(err: unknown): string {
  const code = err instanceof LoginError ? err.code : 'login_failed';
  return `/login?error=${encodeURIComponent(code)}`;
}
