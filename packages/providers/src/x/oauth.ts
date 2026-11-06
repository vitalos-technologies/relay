// X OAuth 2.0 Authorization Code with PKCE (user context). Sources: docs/providers/x.md.
//  authorize: https://x.com/i/oauth2/authorize  (code_challenge_method=S256)
//  token:     POST https://api.x.com/2/oauth2/token (x-www-form-urlencoded)
//             confidential client => Authorization: Basic base64(client_id:client_secret), no client_id in body
//             public client       => client_id in body
//  Access tokens last ~2h; refresh tokens are issued only with offline.access and ROTATE on use.
import type {
  AdapterContext, DestinationCandidate, FinalizedDestination, OAuthConnector, OAuthTokenSet, ProviderAppConfig, ProviderCredentials,
} from '@social-lite/core';
import { TransportError } from '@social-lite/core';
import { X_AUTHORIZE_URL, XApiError, xCall } from './api.js';

export const X_REQUIRED_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'offline.access', 'media.write'];

/** Setup/refresh failure with a safe message. permanent=true => re-authorization is required. */
export class XOAuthError extends Error {
  constructor(public readonly code: string, message: string, public readonly permanent: boolean) {
    super(message);
    this.name = 'XOAuthError';
  }
}

interface TokenResponse { token_type?: string; expires_in?: number; access_token?: string; refresh_token?: string; scope?: string }

function clientAuth(config: ProviderAppConfig): { basic?: { clientId: string; clientSecret: string }; clientIdInBody?: string } {
  if (!config.clientId) throw new XOAuthError('not_configured', 'X is not configured (X_CLIENT_ID missing).', true);
  return config.clientSecret ? { basic: { clientId: config.clientId, clientSecret: config.clientSecret } } : { clientIdInBody: config.clientId };
}

async function tokenRequest(ctx: AdapterContext, form: Record<string, string | undefined>, op: string, fallbackScope?: string): Promise<OAuthTokenSet> {
  const auth = clientAuth(ctx.config);
  let data: TokenResponse;
  try {
    const r = await xCall<TokenResponse>(ctx, {
      method: 'POST', path: '/2/oauth2/token', basic: auth.basic, form: { ...form, client_id: auth.clientIdInBody }, op,
    });
    data = r.data;
  } catch (err) {
    if (err instanceof XApiError) {
      const permanent = err.status === 400 || err.status === 401 || err.status === 403;
      throw new XOAuthError(err.oauthError ?? `http_${err.status}`, permanent
        ? 'X refused the authorization (expired, revoked or already used). Connect the X account again.'
        : `X token endpoint error (${err.status}); try again shortly.`, permanent);
    }
    if (err instanceof TransportError) throw new XOAuthError('network', 'Could not reach X to complete authorization; try again.', false);
    throw err;
  }
  if (!data.access_token) throw new XOAuthError('no_access_token', 'X did not return an access token.', false);
  const scope = data.scope ?? fallbackScope ?? '';
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: typeof data.expires_in === 'number' ? new Date(ctx.now().getTime() + data.expires_in * 1000).toISOString() : null,
    scopes: scope.split(/\s+/).filter(Boolean),
  };
}

function authorizationUrl(config: ProviderAppConfig, p: { state: string; codeChallenge?: string; redirectUri: string }): string {
  if (!config.clientId) throw new XOAuthError('not_configured', 'X is not configured (X_CLIENT_ID missing).', true);
  if (!p.codeChallenge) throw new XOAuthError('pkce_required', 'X authorization requires PKCE.', true);
  const u = new URL(config.baseUrls?.xAuthorize ?? X_AUTHORIZE_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', config.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('scope', X_REQUIRED_SCOPES.join(' '));
  u.searchParams.set('state', p.state);
  u.searchParams.set('code_challenge', p.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

async function exchangeCode(ctx: AdapterContext, p: { code: string; codeVerifier?: string; redirectUri: string }): Promise<OAuthTokenSet> {
  if (!p.codeVerifier) throw new XOAuthError('pkce_required', 'Missing PKCE verifier.', true);
  return tokenRequest(ctx, { code: p.code, grant_type: 'authorization_code', redirect_uri: p.redirectUri, code_verifier: p.codeVerifier }, 'x.oauth.token');
}

async function listDestinations(ctx: AdapterContext, tokens: OAuthTokenSet): Promise<DestinationCandidate[]> {
  const r = await xCall<{ data: { id: string; name?: string; username?: string; profile_image_url?: string } }>(ctx, {
    method: 'GET', path: '/2/users/me', query: { 'user.fields': 'name,username,profile_image_url' }, bearer: tokens.accessToken, op: 'x.users.me',
  });
  const me = r.data.data;
  const missing = X_REQUIRED_SCOPES.filter((s) => tokens.scopes.length && !tokens.scopes.includes(s));
  return [{
    provider: 'x',
    providerAccountId: String(me.id),
    displayName: me.name ?? `@${me.username ?? me.id}`,
    username: me.username ?? null,
    unavailableReason: missing.includes('tweet.write') ? 'Posting permission (tweet.write) was not granted. Reconnect and approve posting.' : null,
    metadata: { profile_image_url: me.profile_image_url ?? null, missing_scopes: missing },
  }];
}

async function finalize(ctx: AdapterContext, tokens: OAuthTokenSet, candidate: DestinationCandidate): Promise<FinalizedDestination> {
  const checkedAt = ctx.now().toISOString();
  const missing = X_REQUIRED_SCOPES.filter((s) => tokens.scopes.length && !tokens.scopes.includes(s));
  const credentials: ProviderCredentials = {
    kind: 'oauth2', accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? null, expiresAt: tokens.expiresAt ?? null, scope: tokens.scopes.join(' '),
  };
  return {
    providerAccountId: candidate.providerAccountId,
    displayName: candidate.displayName,
    username: candidate.username ?? null,
    credentials,
    grantedScopes: tokens.scopes,
    expiresAt: tokens.expiresAt ?? null,
    metadata: { profile_image_url: candidate.metadata.profile_image_url ?? null },
    health: missing.length
      ? { status: 'missing_permission', checkedAt, missingPermissions: missing, message: `X did not grant: ${missing.join(', ')}. Click Reconnect and approve all requested permissions.` }
      : { status: 'ready', checkedAt, message: `Connected as @${candidate.username ?? candidate.providerAccountId}.` },
  };
}

/** Rotating refresh. Callers MUST serialize per connection: the old refresh token stops working once used. */
export async function refreshXCredentials(ctx: AdapterContext, credentials: ProviderCredentials): Promise<{ credentials: ProviderCredentials; expiresAt: string | null; scopes?: string[] }> {
  if (credentials.kind !== 'oauth2' || !credentials.refreshToken) {
    throw new XOAuthError('no_refresh_token', 'This X authorization cannot be refreshed. Reconnect the X account.', true);
  }
  const t = await tokenRequest(ctx, { refresh_token: credentials.refreshToken, grant_type: 'refresh_token' }, 'x.oauth.refresh', credentials.scope);
  return {
    credentials: { kind: 'oauth2', accessToken: t.accessToken, refreshToken: t.refreshToken ?? credentials.refreshToken, expiresAt: t.expiresAt ?? null, scope: t.scopes.join(' ') },
    expiresAt: t.expiresAt ?? null,
    scopes: t.scopes,
  };
}

export const xConnector: OAuthConnector = {
  provider: 'x',
  requiredScopes: X_REQUIRED_SCOPES,
  usesPkce: true,
  isConfigured: (config) => !!config.clientId,
  authorizationUrl,
  exchangeCode,
  listDestinations,
  finalize,
};
