// Threads OAuth (its own app id/secret — never Facebook Login). Sources: docs/providers/threads.md (H1, H2, H7).
//  authorize: https://threads.com/oauth/authorize?client_id&redirect_uri&scope(comma)&response_type=code&state
//  code → POST https://graph.threads.com/oauth/access_token (short-lived, 1 h) → GET /access_token
//  (grant_type=th_exchange_token) → long-lived (60 d). Refresh: GET /refresh_access_token (th_refresh_token).
//  There is no separate refresh token: the long-lived token refreshes itself, so it is also stored as the
//  "refresh token" so the connection service schedules refreshes.
import { TransportError, type AdapterContext, type DestinationCandidate, type FinalizedDestination, type OAuthConnector, type OAuthTokenSet, type ProviderAppConfig, type ProviderCredentials } from '@social-lite/core';
import { ProviderHttpError } from '../shared/http.js';
import { OAuthFlowError, standardFinalize } from '../shared/oauth.js';
import { THREADS_AUTHORIZE_URL, THREADS_VERSION, threadsCall } from './api.js';

export const THREADS_SCOPES = ['threads_basic', 'threads_content_publish', 'threads_manage_insights'];
export const THREADS_REQUIRED_SCOPES = ['threads_basic', 'threads_content_publish'];

function client(config: ProviderAppConfig): { client_id: string; client_secret: string } {
  if (!config.clientId || !config.clientSecret) throw new OAuthFlowError('threads', 'not_configured', 'Threads is not configured (THREADS_APP_ID / THREADS_APP_SECRET missing).', true);
  return { client_id: config.clientId, client_secret: config.clientSecret };
}

function oauthError(err: unknown, what: string): never {
  if (err instanceof ProviderHttpError) {
    const permanent = err.status >= 400 && err.status < 500 && err.status !== 429;
    throw new OAuthFlowError('threads', err.code ?? `http_${err.status}`, permanent ? `Threads refused the ${what} (expired, revoked or already used). Connect the Threads account again.` : `Threads ${what} failed (${err.status}); try again shortly.`, permanent);
  }
  if (err instanceof TransportError) throw new OAuthFlowError('threads', 'network', 'Could not reach Threads; try again.', false);
  throw err;
}

interface TokenResp { access_token?: string; user_id?: string | number; expires_in?: number; token_type?: string }

function longLived(t: TokenResp, nowMs: number, scopes: string[]): OAuthTokenSet {
  if (!t.access_token) throw new OAuthFlowError('threads', 'no_access_token', 'Threads did not return an access token.', false);
  return {
    accessToken: t.access_token,
    refreshToken: t.access_token,
    expiresAt: typeof t.expires_in === 'number' ? new Date(nowMs + t.expires_in * 1000).toISOString() : null,
    scopes,
  };
}

function authorizationUrl(config: ProviderAppConfig, p: { state: string; redirectUri: string }): string {
  if (!config.clientId) throw new OAuthFlowError('threads', 'not_configured', 'Threads is not configured (THREADS_APP_ID missing).', true);
  const u = new URL(config.baseUrls?.threadsAuthorize ?? THREADS_AUTHORIZE_URL);
  u.searchParams.set('client_id', config.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('scope', THREADS_SCOPES.join(','));
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', p.state);
  return u.toString();
}

async function exchangeCode(ctx: AdapterContext, p: { code: string; redirectUri: string }): Promise<OAuthTokenSet> {
  let short: TokenResp;
  try {
    short = (await threadsCall<TokenResp>(ctx, { method: 'POST', path: '/oauth/access_token', params: { ...client(ctx.config), code: p.code, grant_type: 'authorization_code', redirect_uri: p.redirectUri }, op: 'threads.oauth.token' })).data;
  } catch (err) { oauthError(err, 'authorization'); }
  if (!short.access_token) throw new OAuthFlowError('threads', 'no_access_token', 'Threads did not return an access token.', false);
  let long: TokenResp;
  try {
    long = (await threadsCall<TokenResp>(ctx, { method: 'GET', path: '/access_token', params: { grant_type: 'th_exchange_token', client_secret: client(ctx.config).client_secret }, token: short.access_token, op: 'threads.oauth.exchange' })).data;
  } catch (err) { oauthError(err, 'long-lived token exchange'); }
  // Threads does not return the granted scopes; [] = unknown (never reported as missing).
  return { ...longLived(long, ctx.now().getTime(), []), raw: { user_id: short.user_id !== undefined ? String(short.user_id) : null } };
}

interface Me { id?: string; username?: string; name?: string; threads_profile_picture_url?: string }
export async function threadsMe(ctx: AdapterContext, token: string): Promise<Me> {
  return (await threadsCall<Me>(ctx, { method: 'GET', path: `/${THREADS_VERSION}/me`, params: { fields: 'id,username,name,threads_profile_picture_url' }, token, op: 'threads.me' })).data;
}

async function listDestinations(ctx: AdapterContext, tokens: OAuthTokenSet): Promise<DestinationCandidate[]> {
  const me = await threadsMe(ctx, tokens.accessToken);
  const id = String(me.id ?? tokens.raw?.user_id ?? '');
  return [{
    provider: 'threads', providerAccountId: id, displayName: me.name || (me.username ? `@${me.username}` : 'Threads profile'), username: me.username ?? null,
    unavailableReason: id ? null : 'Threads did not return the profile id. Try again.',
    metadata: { profile_image_url: me.threads_profile_picture_url ?? null },
  }];
}

async function finalize(ctx: AdapterContext, tokens: OAuthTokenSet, candidate: DestinationCandidate): Promise<FinalizedDestination> {
  return standardFinalize({ provider: 'threads', label: 'Threads', tokens, candidate, nowIso: ctx.now().toISOString(), required: THREADS_REQUIRED_SCOPES, metadata: { profile_image_url: candidate.metadata.profile_image_url ?? null } });
}

/** Refresh a long-lived token (must be ≥ 24 h old and unexpired, H2). */
export async function refreshThreadsCredentials(ctx: AdapterContext, credentials: ProviderCredentials): Promise<{ credentials: ProviderCredentials; expiresAt: string | null; scopes?: string[] }> {
  if (credentials.kind !== 'oauth2') throw new OAuthFlowError('threads', 'unsupported', 'This Threads authorization cannot be refreshed. Reconnect Threads.', true);
  let r: TokenResp;
  try {
    r = (await threadsCall<TokenResp>(ctx, { method: 'GET', path: '/refresh_access_token', params: { grant_type: 'th_refresh_token' }, token: credentials.accessToken, op: 'threads.oauth.refresh' })).data;
  } catch (err) { oauthError(err, 'token refresh'); }
  const t = longLived(r, ctx.now().getTime(), credentials.scope ? credentials.scope.split(/[\s,]+/).filter(Boolean) : []);
  return { credentials: { kind: 'oauth2', accessToken: t.accessToken, refreshToken: t.accessToken, expiresAt: t.expiresAt ?? null, scope: credentials.scope }, expiresAt: t.expiresAt ?? null };
}

export const threadsConnector: OAuthConnector = {
  provider: 'threads',
  requiredScopes: THREADS_SCOPES,
  usesPkce: false,
  isConfigured: (config) => !!config.clientId && !!config.clientSecret,
  authorizationUrl,
  exchangeCode,
  listDestinations,
  finalize,
};
