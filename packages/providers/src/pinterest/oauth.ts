// Pinterest OAuth 2.0 + board discovery. Sources: docs/providers/pinterest.md (P1, P2).
//  authorize: https://www.pinterest.com/oauth/?client_id&redirect_uri&response_type=code&scope(comma)&state
//  token:     POST https://api.pinterest.com/v5/oauth/token, Basic auth, form; continuous refresh tokens (60 d,
//             rotating). Destinations are BOARDS: each board the user explicitly picks becomes a connection.
import { TransportError, type AdapterContext, type DestinationCandidate, type FinalizedDestination, type OAuthConnector, type OAuthTokenSet, type ProviderAppConfig, type ProviderCredentials } from '@social-lite/core';
import { ProviderHttpError } from '../shared/http.js';
import { OAuthFlowError, standardFinalize, tokenSetFrom, type RawTokenResponse } from '../shared/oauth.js';
import { PINTEREST_AUTHORIZE_URL, pinCall } from './api.js';

export const PINTEREST_SCOPES = ['boards:read', 'pins:read', 'pins:write', 'user_accounts:read'];

function basic(config: ProviderAppConfig): { user: string; password: string } {
  if (!config.clientId || !config.clientSecret) throw new OAuthFlowError('pinterest', 'not_configured', 'Pinterest is not configured (PINTEREST_APP_ID / PINTEREST_APP_SECRET missing).', true);
  return { user: config.clientId, password: config.clientSecret };
}

async function tokenRequest(ctx: AdapterContext, form: Record<string, string>, op: string, fallbackScope?: string): Promise<{ tokens: OAuthTokenSet; raw: RawTokenResponse }> {
  let raw: RawTokenResponse;
  try {
    raw = (await pinCall<RawTokenResponse>(ctx, { method: 'POST', path: '/v5/oauth/token', basic: basic(ctx.config), form, op })).data;
  } catch (err) {
    if (err instanceof ProviderHttpError) {
      const permanent = err.status >= 400 && err.status < 500 && err.status !== 429;
      throw new OAuthFlowError('pinterest', err.code ?? `http_${err.status}`, permanent
        ? 'Pinterest refused the authorization (expired, revoked or already used). Connect the Pinterest account again.'
        : `Pinterest token endpoint error (${err.status}); try again shortly.`, permanent);
    }
    if (err instanceof TransportError) throw new OAuthFlowError('pinterest', 'network', 'Could not reach Pinterest to complete authorization; try again.', false);
    throw err;
  }
  if (!raw.access_token) throw new OAuthFlowError('pinterest', 'no_access_token', 'Pinterest did not return an access token.', false);
  return { tokens: tokenSetFrom(raw, ctx.now().getTime(), /[\s,]+/, fallbackScope), raw };
}

function authorizationUrl(config: ProviderAppConfig, p: { state: string; redirectUri: string }): string {
  if (!config.clientId) throw new OAuthFlowError('pinterest', 'not_configured', 'Pinterest is not configured (PINTEREST_APP_ID missing).', true);
  const u = new URL(config.baseUrls?.pinterestAuthorize ?? PINTEREST_AUTHORIZE_URL);
  u.searchParams.set('client_id', config.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', PINTEREST_SCOPES.join(','));
  u.searchParams.set('state', p.state);
  return u.toString();
}

async function exchangeCode(ctx: AdapterContext, p: { code: string; redirectUri: string }): Promise<OAuthTokenSet> {
  // continuous_refresh=true is required for apps created before 2025-09-25 and ignored for newer apps (P1).
  return (await tokenRequest(ctx, { grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, continuous_refresh: 'true' }, 'pinterest.oauth.token')).tokens;
}

interface Account { id?: string; username?: string; account_type?: string; profile_image?: string; business_name?: string | null }
interface Board { id: string; name?: string; privacy?: string; owner?: { username?: string } }

export async function userAccount(ctx: AdapterContext, token: string): Promise<Account> {
  return (await pinCall<Account>(ctx, { method: 'GET', path: '/v5/user_account', bearer: token, op: 'pinterest.user_account' })).data;
}

export async function listBoards(ctx: AdapterContext, token: string, max = 250): Promise<Board[]> {
  const out: Board[] = [];
  let bookmark: string | undefined;
  do {
    const r = await pinCall<{ items?: Board[]; bookmark?: string | null }>(ctx, { method: 'GET', path: '/v5/boards', query: { page_size: '100', bookmark }, bearer: token, op: 'pinterest.boards.list' });
    out.push(...(r.data.items ?? []));
    bookmark = r.data.bookmark ?? undefined;
  } while (bookmark && out.length < max);
  return out;
}

async function listDestinations(ctx: AdapterContext, tokens: OAuthTokenSet): Promise<DestinationCandidate[]> {
  const me = await userAccount(ctx, tokens.accessToken);
  const boards = await listBoards(ctx, tokens.accessToken);
  const canWrite = !tokens.scopes.length || tokens.scopes.includes('pins:write');
  return boards.map((b) => ({
    provider: 'pinterest' as const,
    providerAccountId: b.id,
    displayName: `${me.business_name || me.username || 'Pinterest'} · ${b.name ?? b.id}`,
    username: me.username ?? null,
    unavailableReason: !canWrite ? 'Pin creation (pins:write) was not granted. Reconnect and allow creating Pins.' : b.privacy === 'SECRET' ? 'Secret boards are not supported.' : null,
    metadata: { user_id: me.id ?? null, account_type: me.account_type ?? null, board_name: b.name ?? null, board_privacy: b.privacy ?? null, profile_image_url: me.profile_image ?? null },
  }));
}

async function finalize(ctx: AdapterContext, tokens: OAuthTokenSet, candidate: DestinationCandidate): Promise<FinalizedDestination> {
  return standardFinalize({
    provider: 'pinterest', label: 'Pinterest', tokens, candidate, nowIso: ctx.now().toISOString(), required: PINTEREST_SCOPES, scopeJoin: ',',
    metadata: { ...candidate.metadata, access_tier: ctx.config.features?.pinterest_access_tier === 'standard' ? 'standard' : 'trial' },
  });
}

/** Continuous refresh: returns a NEW refresh token every time (rotating). Callers serialize per connection. */
export async function refreshPinterestCredentials(ctx: AdapterContext, credentials: ProviderCredentials): Promise<{ credentials: ProviderCredentials; expiresAt: string | null; scopes?: string[] }> {
  if (credentials.kind !== 'oauth2' || !credentials.refreshToken) throw new OAuthFlowError('pinterest', 'no_refresh_token', 'This Pinterest authorization cannot be refreshed. Reconnect Pinterest.', true);
  const { tokens } = await tokenRequest(ctx, { grant_type: 'refresh_token', refresh_token: credentials.refreshToken }, 'pinterest.oauth.refresh', credentials.scope);
  return {
    credentials: { kind: 'oauth2', accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? credentials.refreshToken, expiresAt: tokens.expiresAt ?? null, scope: tokens.scopes.join(',') },
    expiresAt: tokens.expiresAt ?? null,
    scopes: tokens.scopes,
  };
}

export const pinterestConnector: OAuthConnector = {
  provider: 'pinterest',
  requiredScopes: PINTEREST_SCOPES,
  usesPkce: false,
  isConfigured: (config) => !!config.clientId && !!config.clientSecret,
  authorizationUrl,
  exchangeCode,
  listDestinations,
  finalize,
};
