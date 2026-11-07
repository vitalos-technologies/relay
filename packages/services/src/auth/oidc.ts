// OIDC login (authorization code + PKCE S256 + nonce) using openid-client v6.
//  - state: random, single-use, 10-minute expiry, only sha256(state) stored (oauth_states)
//  - PKCE verifier (and the optional invitation token) stored encrypted with encryptSecret(…, pkceAad)
//  - the attempt is bound to the initiating browser by a short-lived HttpOnly cookie whose
//    hash is inside the encrypted blob (prevents login CSRF / callback-URL injection)
//  - requires email_verified; users identified by (issuer, subject); see users.ts for binding rules
// V2 assurance: acr / amr / auth_time / sid are read ONLY from the ID token returned by the token endpoint,
// after verifying its signature against the IdP's JWKS (in addition to openid-client's claim checks).
//  - mfaVerified = acr "mfa" (LoA 2) AND amr contains a second factor.
//  - step-up (purpose step_up): acr_values=mfa + max_age=0 → updates the CURRENT session only when the
//    returned subject is the session's subject and auth_time is not older than the step-up request; token rotated.
//  - IdP actions (purpose idp_action): Keycloak application-initiated actions (kc_action) for the user's own
//    factors; assurance is re-read from the returned ID token and the session token rotated.
import { isIP } from 'node:net';
import * as oidc from 'openid-client';
import { AppError } from '@social-lite/core';
import { getPool, maybeOne, withTx, type Queryable } from '@social-lite/db';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { decryptSecret, encryptSecret, pkceAad, type EncryptedBlob } from '../crypto.js';
import { log } from '../log.js';
import { acceptInvitation } from './invitations.js';
import { idpFactors, type IdpAction } from './idp-admin.js';
import { jwksResolver, verifyJwt, type Jwk, type KeyResolver } from './jwt.js';
import { SECOND_FACTOR_AMR, createSession, randomToken, revokeSession, rotateSession, sha256, type SessionAssurance, type SessionRecord } from './session.js';
import { LoginError, resolveOidcUser } from './users.js';

export const LOGIN_STATE_TTL_MS = 10 * 60 * 1000;
export const LOGIN_BINDING_COOKIE = process.env.APP_ENV === 'production' ? '__Host-sl_login' : 'sl_login';
/** acr value (LoA 2) that the realm maps to "a second factor was used in this authentication". */
export const ACR_MFA = 'mfa';
const idTokenAad = 'session-id-token';

let cached: { key: string; promise: Promise<oidc.Configuration> } | undefined;
let keyResolver: { key: string; resolve: KeyResolver } | undefined;

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

/** JWKS-backed key resolver for the configured issuer (ID tokens + logout tokens). */
export async function idpKeys(): Promise<KeyResolver> {
  const cfg = await oidcConfiguration();
  const meta = cfg.serverMetadata();
  const key = `${meta.issuer}|${meta.jwks_uri}`;
  if (!keyResolver || keyResolver.key !== key) {
    const uri = meta.jwks_uri;
    if (!uri) throw new AppError('provider_error', 'The identity provider does not publish signing keys.');
    keyResolver = { key, resolve: jwksResolver(async () => {
      const res = await fetch(uri, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new AppError('provider_error', 'Signing keys could not be fetched.');
      return (await res.json()) as { keys: Jwk[] };
    }) };
  }
  return keyResolver.resolve;
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
type Purpose = 'login' | 'step_up' | 'idp_action';

export interface LoginStart {
  authorizationUrl: string;
  /** Value for the LOGIN_BINDING_COOKIE (HttpOnly, 10 minutes). */
  binding: string;
}

async function startAuthorization(db: Queryable, p: {
  purpose: Purpose; returnTo?: string | null; invite?: string; sessionId?: string; userId?: string; idpAction?: string;
  extra?: Record<string, string>;
}): Promise<LoginStart> {
  const cfg = await oidcConfiguration();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const verifier = oidc.randomPKCECodeVerifier();
  const challenge = await oidc.calculatePKCECodeChallenge(verifier);
  const binding = randomToken(24);
  const secret: StateSecret = { v: verifier, b: sha256(binding).toString('base64url'), ...(p.invite ? { invite: p.invite } : {}) };
  await db.query(
    `INSERT INTO oauth_states(state_hash, purpose, provider, code_verifier_enc, nonce, redirect_after, invitation_token_hash, expires_at, session_id, user_id, idp_action)
     VALUES ($1,$2,'oidc',$3,$4,$5,$6,$7,$8,$9,$10)`,
    [sha256(state), p.purpose, JSON.stringify(encryptSecret(secret, pkceAad)), nonce, safeReturnTo(p.returnTo),
      p.invite ? sha256(p.invite) : null, new Date(Date.now() + LOGIN_STATE_TTL_MS), p.sessionId ?? null, p.userId ?? null, p.idpAction ?? null]);
  // Opportunistic cleanup of stale states.
  db.query(`DELETE FROM oauth_states WHERE purpose IN ('login','step_up','idp_action') AND expires_at < now() - interval '1 day'`).catch(() => undefined);
  const url = oidc.buildAuthorizationUrl(cfg, {
    redirect_uri: callbackUrl(),
    scope: 'openid email profile',
    response_type: 'code',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(p.extra ?? {}),
  });
  return { authorizationUrl: url.toString(), binding };
}

export async function startLogin(p: { returnTo?: string | null; invite?: string | null }, db: Queryable = getPool()): Promise<LoginStart> {
  const invite = p.invite && p.invite.length <= 200 ? p.invite : undefined;
  return startAuthorization(db, { purpose: 'login', returnTo: p.returnTo, invite });
}

export type StepUpMode = 'fresh' | 'mfa';

/**
 * Re-authentication for the current session. `fresh` (default): acr_values=mfa + max_age=0 + prompt=login — the user signs in
 * again with password and second factor, giving a new auth_time. `mfa`: acr_values=mfa only (second factor on top
 * of the existing IdP session; used right after login). Users without a second factor are sent to set one up.
 */
export async function startStepUp(session: SessionRecord, p: { returnTo?: string | null; mode?: StepUpMode; loginHint?: string | null }, db: Queryable = getPool()): Promise<LoginStart | { setupRequired: true }> {
  if (session.idpSubject) {
    const f = await idpFactors(session.idpSubject);
    if (f.available && !f.hasSecondFactor) return { setupRequired: true };
  }
  const extra: Record<string, string> = { acr_values: ACR_MFA };
  if ((p.mode ?? 'fresh') === 'fresh') { extra.max_age = '0'; extra.prompt = 'login'; }
  if (p.loginHint) extra.login_hint = p.loginHint;
  return startAuthorization(db, { purpose: 'step_up', returnTo: p.returnTo, sessionId: session.id, userId: session.userId, idpAction: p.mode ?? 'fresh', extra });
}

/** Keycloak application-initiated action for the user's OWN account (enrol / remove / regenerate factors). */
export async function startIdpAction(session: SessionRecord, action: IdpAction, p: { credentialId?: string | null; returnTo?: string | null }, db: Queryable = getPool()): Promise<LoginStart> {
  let kcAction: string = action;
  if (action === 'delete_credential') {
    if (!p.credentialId || !/^[0-9a-f-]{36}$/i.test(p.credentialId)) throw new AppError('validation_failed', 'Choose a sign-in method to remove');
    kcAction = `delete_credential:${p.credentialId}`;
  }
  return startAuthorization(db, { purpose: 'idp_action', returnTo: p.returnTo, sessionId: session.id, userId: session.userId, idpAction: kcAction, extra: { kc_action: kcAction } });
}

export interface LoginResult {
  purpose: Purpose;
  token: string;
  session: SessionRecord | { id: string };
  userId: string;
  redirectTo: string;
  invitation?: { accepted: boolean; workspaceId?: string; error?: string };
  /** Login only: the user has a second factor at the IdP but this sign-in did not use it → ask for it now. */
  needsSecondFactor?: boolean;
  /** idp_action only: outcome reported by the IdP (success | cancelled | error). */
  actionStatus?: string;
}

interface VerifiedTokens { claims: Record<string, unknown>; idToken: string; accessToken: string }

/** Assurance from VERIFIED ID-token claims (never from the client). */
export function assuranceFromClaims(claims: Record<string, unknown>): SessionAssurance & { sid: string | null } {
  const acr = typeof claims.acr === 'string' ? claims.acr.slice(0, 64) : null;
  const amr = Array.isArray(claims.amr) ? claims.amr.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 32)).slice(0, 10) : [];
  const authTime = typeof claims.auth_time === 'number' ? new Date(claims.auth_time * 1000) : null;
  const mfaVerified = acr === ACR_MFA && amr.some((m) => SECOND_FACTOR_AMR.has(m));
  return { acr, amr, authTime, mfaVerified, sid: typeof claims.sid === 'string' ? claims.sid.slice(0, 200) : null };
}

async function exchange(callbackParams: URLSearchParams, state: string, verifier: string, nonce: string, maxAge?: number): Promise<VerifiedTokens> {
  const cfg = await oidcConfiguration();
  const current = new URL(callbackUrl());
  current.search = callbackParams.toString();
  try {
    const tokens = await oidc.authorizationCodeGrant(cfg, current, {
      pkceCodeVerifier: verifier, expectedState: state, expectedNonce: nonce, idTokenExpected: true, ...(maxAge !== undefined ? { maxAge } : {}),
    });
    if (!tokens.id_token) throw new Error('no id_token');
    // Defence in depth: verify the ID token signature with the IdP's published keys before trusting acr/amr/auth_time.
    const c = config();
    const verified = await verifyJwt(tokens.id_token, { keys: await idpKeys(), issuer: cfg.serverMetadata().issuer, audience: c.OIDC_CLIENT_ID!, clockSkewS: 120 });
    if (verified.claims.nonce !== nonce) throw new Error('nonce mismatch');
    return { claims: verified.claims, idToken: tokens.id_token, accessToken: tokens.access_token };
  } catch (err) {
    log.warn('oidc_code_exchange_failed', { err: { name: (err as Error).name, code: (err as { code?: string }).code } });
    throw new LoginError('token_exchange_failed', 'Sign-in could not be completed. Please try again.');
  }
}

/**
 * Complete the callback (login, step-up or IdP action). `callbackParams` is the query string received at
 * /api/auth/callback; `currentSessionToken` is the browser's existing session cookie (if any).
 * Throws LoginError (stable code, user-safe message) when sign-in fails. An invitation that cannot be
 * accepted does NOT fail the login: the result's redirectTo points back to /invite/<token>?error=<code>.
 */
export async function completeLogin(
  callbackParams: URLSearchParams,
  p: { binding: string | null | undefined; userAgent?: string | null; ip?: string | null; currentSession?: SessionRecord | null },
  db = getPool(),
): Promise<LoginResult> {
  const state = callbackParams.get('state');
  if (!state || state.length > 200) throw new LoginError('invalid_state', 'Your sign-in link is invalid or expired. Please sign in again.');

  // Single use: consume atomically; expired or replayed states match nothing.
  const row = await maybeOne<{ id: string; purpose: Purpose; code_verifier_enc: EncryptedBlob; nonce: string; redirect_after: string | null; invitation_token_hash: Buffer | null;
    session_id: string | null; user_id: string | null; idp_action: string | null; created_at: Date }>(db,
    `UPDATE oauth_states SET consumed_at=now()
      WHERE state_hash=$1 AND purpose IN ('login','step_up','idp_action') AND consumed_at IS NULL AND expires_at > now()
      RETURNING id, purpose, code_verifier_enc, nonce, redirect_after, invitation_token_hash, session_id, user_id, idp_action, created_at`, [sha256(state)]);
  if (!row) throw new LoginError('invalid_state', 'Your sign-in link is invalid or expired. Please sign in again.');
  const secret = decryptSecret<StateSecret>(row.code_verifier_enc, pkceAad);
  if (!p.binding || sha256(p.binding).toString('base64url') !== secret.b) {
    throw new LoginError('invalid_state', 'Sign-in must be completed in the same browser that started it. Please sign in again.');
  }
  const actionStatus = callbackParams.get('kc_action_status') ?? undefined;
  if (row.purpose !== 'login') return completeSessionUpgrade(callbackParams, state, row, secret, p.currentSession ?? null, actionStatus, db);

  if (callbackParams.get('error')) throw new LoginError('idp_error', 'Sign-in was cancelled or refused by the identity provider.');
  const { claims, idToken, accessToken } = await exchange(callbackParams, state, secret.v, row.nonce);
  const sub = typeof claims.sub === 'string' ? claims.sub : null;
  if (!sub) throw new LoginError('token_exchange_failed', 'Sign-in could not be completed. Please try again.');
  const cfg = await oidcConfiguration();

  let email = typeof claims.email === 'string' ? claims.email : undefined;
  let verified = claims.email_verified === true;
  let name = typeof claims.name === 'string' ? claims.name : typeof claims.preferred_username === 'string' ? claims.preferred_username : null;
  if (!email || claims.email_verified === undefined) {
    try {
      const info = await oidc.fetchUserInfo(cfg, accessToken, sub);
      email = typeof info.email === 'string' ? info.email : email;
      verified = info.email_verified === true;
      name = name ?? (typeof info.name === 'string' ? info.name : null);
    } catch {
      /* fall through: treated as unverified */
    }
  }
  const issuer = cfg.serverMetadata().issuer;
  const assurance = assuranceFromClaims(claims);

  const user = await withTx(async (tx) => {
    const r = await resolveOidcUser(tx, { issuer, subject: sub, email: email ?? '', emailVerified: verified, name });
    await audit(tx, { workspaceId: null, actorUserId: r.userId, action: r.created ? 'user.created' : r.bound ? 'user.bound' : 'user.login', resourceType: 'user', resourceId: r.userId,
      diff: { acr: assurance.acr, amr: assurance.amr, mfa: assurance.mfaVerified } });
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

  // Session fixation / rotation: a session cookie the browser already carried is revoked on every login.
  if (p.currentSession) await revokeSession(db, p.currentSession.id, 'replaced_by_login');
  const { token, session } = await createSession(db, user.userId, {
    userAgent: p.userAgent, ip: normalizeIp(p.ip), workspaceId, ...assurance, idpSessionId: assurance.sid, idpSubject: sub,
    idTokenEnc: encryptSecret(idToken, idTokenAad),
  });
  let redirectTo = row.redirect_after ?? '/';
  if (invitation && !invitation.accepted && secret.invite) {
    redirectTo = `/invite/${encodeURIComponent(secret.invite)}?error=${encodeURIComponent(invitation.error ?? 'invitation_invalid')}`;
  }
  let needsSecondFactor = false;
  if (!assurance.mfaVerified) {
    const f = await idpFactors(sub).catch(() => null);
    needsSecondFactor = !!f?.hasSecondFactor;
  }
  return { purpose: 'login', token, session, userId: user.userId, redirectTo, invitation, needsSecondFactor };
}

async function completeSessionUpgrade(
  callbackParams: URLSearchParams, state: string,
  row: { purpose: Purpose; nonce: string; redirect_after: string | null; session_id: string | null; user_id: string | null; idp_action: string | null; created_at: Date },
  secret: StateSecret, current: SessionRecord | null, actionStatus: string | undefined, db: Queryable,
): Promise<LoginResult> {
  // Must return to the same live session that started the step-up / action.
  if (!current || current.id !== row.session_id || current.userId !== row.user_id) {
    throw new LoginError('session_mismatch', 'Your session changed while you were verifying. Please sign in again.');
  }
  const redirectTo = row.redirect_after ?? '/security';
  const auditBase = { workspaceId: null, actorUserId: current.userId, resourceType: 'session', resourceId: current.id };
  if (callbackParams.get('error') || !callbackParams.get('code')) {
    // Cancelled step-up or action: nothing changes (the session keeps its previous assurance).
    const what = row.purpose === 'step_up' ? 'auth.step_up_cancelled' : 'auth.factor_action_cancelled';
    await audit(db, { ...auditBase, action: what, diff: { action: row.idp_action, status: actionStatus ?? callbackParams.get('error') ?? 'cancelled' } });
    return { purpose: row.purpose, token: '', session: { id: current.id }, userId: current.userId, redirectTo: withStatus(redirectTo, 'cancelled'), actionStatus: actionStatus ?? 'cancelled' };
  }
  const fresh = row.purpose === 'step_up' && row.idp_action === 'fresh';
  const { claims, idToken } = await exchange(callbackParams, state, secret.v, row.nonce, fresh ? 0 : undefined);
  const user = await maybeOne<{ oidc_issuer: string; oidc_subject: string }>(db, `SELECT oidc_issuer, oidc_subject FROM users WHERE id=$1`, [current.userId]);
  const cfg = await oidcConfiguration();
  if (!user || claims.sub !== user.oidc_subject || user.oidc_issuer !== cfg.serverMetadata().issuer) {
    await audit(db, { ...auditBase, action: 'auth.step_up_subject_mismatch', diff: { purpose: row.purpose } });
    throw new LoginError('account_mismatch', 'You verified as a different account. Sign in again as yourself.');
  }
  const a = assuranceFromClaims(claims);
  if (fresh && (!a.authTime || a.authTime.getTime() < row.created_at.getTime() - 5_000)) {
    throw new LoginError('step_up_not_fresh', 'The identity provider did not re-authenticate you. Please try again.');
  }
  let assurance: SessionAssurance = { acr: a.acr, amr: a.amr, authTime: a.authTime, mfaVerified: a.mfaVerified };
  if (row.purpose === 'idp_action') {
    // A removed factor must not leave the session looking MFA-verified: re-check what the user still has.
    const f = await idpFactors(String(claims.sub)).catch(() => null);
    if (f?.available && !f.hasSecondFactor) assurance = { ...assurance, mfaVerified: false };
    // Never let an action round-trip extend freshness beyond what the IdP reports.
  }
  const { token } = await rotateSession(db, current.id, { ...assurance, idpSessionId: a.sid, idTokenEnc: encryptSecret(idToken, idTokenAad) });
  const action = row.purpose === 'step_up' ? 'auth.step_up' : `auth.factor_action`;
  await audit(db, { ...auditBase, action, diff: { action: row.idp_action, status: actionStatus ?? 'success', acr: a.acr, amr: a.amr, mfa: assurance.mfaVerified } });
  return { purpose: row.purpose, token, session: { id: current.id }, userId: current.userId, redirectTo: withStatus(redirectTo, actionStatus ?? 'success'), actionStatus: actionStatus ?? 'success' };
}

function withStatus(path: string, status: string): string {
  const u = new URL(path, 'http://x');
  u.searchParams.set('verified', status === 'success' ? '1' : '0');
  return `${u.pathname}${u.search}${u.hash}`;
}

/** RP-initiated logout URL (ends the IdP session too). Null when the IdP has no end_session_endpoint. */
export async function idpLogoutUrl(sessionId: string, db: Queryable = getPool()): Promise<string | null> {
  try {
    const cfg = await oidcConfiguration();
    const end = cfg.serverMetadata().end_session_endpoint;
    if (!end) return null;
    const r = await maybeOne<{ id_token_enc: EncryptedBlob | null }>(db, `SELECT id_token_enc FROM sessions WHERE id=$1`, [sessionId]);
    const u = new URL(end);
    u.searchParams.set('client_id', config().OIDC_CLIENT_ID!);
    u.searchParams.set('post_logout_redirect_uri', `${config().APP_BASE_URL.replace(/\/$/, '')}/login`);
    if (r?.id_token_enc) u.searchParams.set('id_token_hint', decryptSecret<string>(r.id_token_enc, idTokenAad));
    return u.toString();
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ back-channel logout (OIDC Back-Channel Logout 1.0)

const BCL_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

/**
 * Verify a logout_token (signature via JWKS, iss, aud, iat, events, sid/sub, no nonce, single-use jti) and revoke
 * every app session bound to that IdP session (sid) — or, without sid, every session of that subject.
 */
export async function handleBackchannelLogout(logoutToken: string, db: Queryable = getPool(), opts: { keys?: KeyResolver; issuer?: string; audience?: string } = {}): Promise<{ revoked: number }> {
  const issuer = opts.issuer ?? (await oidcConfiguration()).serverMetadata().issuer;
  const audience = opts.audience ?? config().OIDC_CLIENT_ID!;
  let claims: Record<string, unknown>;
  try {
    ({ claims } = await verifyJwt(logoutToken, { keys: opts.keys ?? await idpKeys(), issuer, audience, maxAgeS: 300 }));
  } catch (err) {
    throw new AppError('validation_failed', `Invalid logout token (${(err as Error).message})`);
  }
  const events = claims.events as Record<string, unknown> | undefined;
  if (!events || typeof events !== 'object' || !(BCL_EVENT in events)) throw new AppError('validation_failed', 'Invalid logout token (events)');
  if ('nonce' in claims) throw new AppError('validation_failed', 'Invalid logout token (nonce)');
  const sid = typeof claims.sid === 'string' ? claims.sid : null;
  const sub = typeof claims.sub === 'string' ? claims.sub : null;
  if (!sid && !sub) throw new AppError('validation_failed', 'Invalid logout token (sid/sub)');
  const jti = typeof claims.jti === 'string' ? claims.jti.slice(0, 200) : null;
  if (!jti) throw new AppError('validation_failed', 'Invalid logout token (jti)');
  const fresh = await maybeOne(db, `INSERT INTO idp_logout_tokens(jti, sid) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING jti`, [jti, sid]);
  if (!fresh) throw new AppError('validation_failed', 'Invalid logout token (replayed)');
  db.query(`DELETE FROM idp_logout_tokens WHERE received_at < now() - interval '1 day'`).catch(() => undefined);
  const r = sid
    ? await db.query(`UPDATE sessions s SET revoked_at=now(), revoked_reason='idp_logout'
         WHERE s.idp_session_id=$1 AND s.revoked_at IS NULL
           AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM users u WHERE u.id=s.user_id AND u.oidc_issuer=$3 AND u.oidc_subject=$2))
       RETURNING s.user_id`, [sid, sub, issuer])
    : await db.query(`UPDATE sessions s SET revoked_at=now(), revoked_reason='idp_logout' FROM users u
         WHERE u.id=s.user_id AND u.oidc_issuer=$1 AND u.oidc_subject=$2 AND s.revoked_at IS NULL RETURNING s.user_id`, [issuer, sub]);
  const users = [...new Set(r.rows.map((x: { user_id: string }) => x.user_id))];
  for (const u of users) await audit(db, { workspaceId: null, actorUserId: null, actorService: 'identity_provider', action: 'session.idp_logout', resourceType: 'user', resourceId: u, diff: { sessions: r.rowCount } });
  return { revoked: r.rowCount ?? 0 };
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
