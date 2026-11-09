// TikTok Login Kit (web) OAuth 2.0 + destination discovery. Sources: docs/providers/tiktok.md (T8–T13).
//  authorize: https://www.tiktok.com/v2/auth/authorize/?client_key&response_type=code&scope(comma)&redirect_uri&state
//  token:     POST https://open.tiktokapis.com/v2/oauth/token/ (form; client_key + client_secret in the body)
//  Access tokens last 2 h; refresh tokens 180 d and ROTATE on use. PKCE is not listed for web apps.
import { TransportError, type AdapterContext, type DestinationCandidate, type FinalizedDestination, type OAuthConnector, type OAuthTokenSet, type ProviderAppConfig, type ProviderCredentials } from '@social-lite/core';
import { ProviderHttpError } from '../shared/http.js';
import { OAuthFlowError, standardFinalize, tokenSetFrom, type RawTokenResponse } from '../shared/oauth.js';
import { TIKTOK_AUTHORIZE_URL, TIKTOK_JSON, tiktokCall } from './api.js';

/** Requested scopes (T12). video.publish = Direct Post; video.upload = inbox draft; video.list = metrics. */
export const TIKTOK_SCOPES = ['user.info.basic', 'video.publish', 'video.upload', 'video.list'] as const;
/** Without either posting scope the connection is manual-handoff only. */
export const TIKTOK_REQUIRED_SCOPES = ['user.info.basic'] as const;

export type TikTokPublishMode = 'direct' | 'inbox' | 'manual';
export function publishModeFor(scopes: readonly string[]): TikTokPublishMode {
  if (!scopes.length || scopes.includes('video.publish')) return 'direct';
  if (scopes.includes('video.upload')) return 'inbox';
  return 'manual';
}

function clientCreds(config: ProviderAppConfig): { client_key: string; client_secret: string } {
  if (!config.clientId || !config.clientSecret) throw new OAuthFlowError('tiktok', 'not_configured', 'TikTok is not configured (TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET missing).', true);
  return { client_key: config.clientId, client_secret: config.clientSecret };
}

async function tokenRequest(ctx: AdapterContext, form: Record<string, string>, op: string, fallbackScope?: string): Promise<{ tokens: OAuthTokenSet; raw: RawTokenResponse }> {
  let raw: RawTokenResponse;
  try {
    raw = (await tiktokCall<RawTokenResponse>(ctx, { method: 'POST', path: '/v2/oauth/token/', form: { ...clientCreds(ctx.config), ...form }, op })).data;
  } catch (err) {
    if (err instanceof ProviderHttpError) {
      const permanent = err.status < 500 && err.status !== 429;
      throw new OAuthFlowError('tiktok', err.code ?? `http_${err.status}`, permanent
        ? 'TikTok refused the authorization (expired, revoked or already used). Connect the TikTok account again.'
        : `TikTok token endpoint error (${err.status}); try again shortly.`, permanent);
    }
    if (err instanceof TransportError) throw new OAuthFlowError('tiktok', 'network', 'Could not reach TikTok to complete authorization; try again.', false);
    throw err;
  }
  if (!raw.access_token) {
    // TikTok can answer 200 with {error, error_description}.
    throw new OAuthFlowError('tiktok', typeof raw.error === 'string' ? raw.error : 'no_access_token', 'TikTok did not return an access token. Connect the TikTok account again.', true);
  }
  return { tokens: { ...tokenSetFrom(raw, ctx.now().getTime(), /[\s,]+/, fallbackScope), raw: { open_id: raw.open_id, refresh_expires_in: raw.refresh_expires_in } }, raw };
}

function authorizationUrl(config: ProviderAppConfig, p: { state: string; codeChallenge?: string; redirectUri: string }): string {
  if (!config.clientId) throw new OAuthFlowError('tiktok', 'not_configured', 'TikTok is not configured (TIKTOK_CLIENT_KEY missing).', true);
  const u = new URL(config.baseUrls?.tiktokAuthorize ?? TIKTOK_AUTHORIZE_URL);
  u.searchParams.set('client_key', config.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', TIKTOK_SCOPES.join(','));
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('state', p.state);
  return u.toString();
}

async function exchangeCode(ctx: AdapterContext, p: { code: string; redirectUri: string }): Promise<OAuthTokenSet> {
  return (await tokenRequest(ctx, { code: p.code, grant_type: 'authorization_code', redirect_uri: p.redirectUri }, 'tiktok.oauth.token')).tokens;
}

interface UserInfo { open_id?: string; union_id?: string; avatar_url?: string; display_name?: string }
/** POST /v2/post/publish/creator_info/query/ data (TikTok: call it when rendering the post page; 20 req/min per token). */
export interface CreatorInfo { creator_username?: string; creator_nickname?: string; privacy_level_options?: string[]; comment_disabled?: boolean; duet_disabled?: boolean; stitch_disabled?: boolean; max_video_post_duration_sec?: number }

export async function fetchUserInfo(ctx: AdapterContext, token: string): Promise<UserInfo> {
  const r = await tiktokCall<{ data?: { user?: UserInfo } }>(ctx, { method: 'GET', path: '/v2/user/info/', query: { fields: 'open_id,union_id,avatar_url,display_name' }, bearer: token, op: 'tiktok.user.info' });
  return r.data.data?.user ?? {};
}

export async function queryCreatorInfo(ctx: AdapterContext, token: string): Promise<CreatorInfo> {
  const r = await tiktokCall<{ data?: CreatorInfo }>(ctx, {
    method: 'POST', path: '/v2/post/publish/creator_info/query/', bearer: token, headers: { 'content-type': TIKTOK_JSON }, json: {}, op: 'tiktok.creator_info',
  });
  return r.data.data ?? {};
}

async function listDestinations(ctx: AdapterContext, tokens: OAuthTokenSet): Promise<DestinationCandidate[]> {
  const me = await fetchUserInfo(ctx, tokens.accessToken);
  const mode = publishModeFor(tokens.scopes);
  let creator: CreatorInfo = {};
  if (mode === 'direct') {
    try { creator = await queryCreatorInfo(ctx, tokens.accessToken); } catch { /* best effort: re-queried at post time */ }
  }
  const openId = String(me.open_id ?? tokens.raw?.open_id ?? '');
  return [{
    provider: 'tiktok',
    providerAccountId: openId,
    displayName: creator.creator_nickname ?? me.display_name ?? 'TikTok account',
    username: creator.creator_username ?? null,
    unavailableReason: openId ? null : 'TikTok did not return the account identifier. Try again.',
    metadata: { profile_image_url: me.avatar_url ?? null, publish_mode: mode, privacy_level_options: creator.privacy_level_options ?? null },
  }];
}

async function finalize(ctx: AdapterContext, tokens: OAuthTokenSet, candidate: DestinationCandidate): Promise<FinalizedDestination> {
  const mode = publishModeFor(tokens.scopes);
  const fin = standardFinalize({
    provider: 'tiktok', label: 'TikTok', tokens, candidate, nowIso: ctx.now().toISOString(), required: TIKTOK_REQUIRED_SCOPES, scopeJoin: ',',
    refreshExpiresAt: typeof tokens.raw?.refresh_expires_in === 'number' ? new Date(ctx.now().getTime() + tokens.raw.refresh_expires_in * 1000).toISOString() : null,
    metadata: {
      profile_image_url: candidate.metadata.profile_image_url ?? null, publish_mode: mode, granted_scopes: tokens.scopes,
      direct_post_audited: ctx.config.features?.tiktok_direct_post_audited === true,
    },
  });
  if (fin.health.status === 'ready' && mode !== 'direct') {
    fin.health = { ...fin.health, message: mode === 'inbox'
      ? 'Connected for draft upload only: videos go to the creator\'s TikTok inbox and must be finished in the app (manual handoff).'
      : 'Connected without posting permission: TikTok posts are manual handoff only (download and post in the app).' };
  }
  return fin;
}

/** Rotating refresh. Callers serialize per connection. */
export async function refreshTikTokCredentials(ctx: AdapterContext, credentials: ProviderCredentials): Promise<{ credentials: ProviderCredentials; expiresAt: string | null; scopes?: string[] }> {
  if (credentials.kind !== 'oauth2' || !credentials.refreshToken) throw new OAuthFlowError('tiktok', 'no_refresh_token', 'This TikTok authorization cannot be refreshed. Reconnect the TikTok account.', true);
  const { tokens } = await tokenRequest(ctx, { grant_type: 'refresh_token', refresh_token: credentials.refreshToken }, 'tiktok.oauth.refresh', credentials.scope);
  return {
    credentials: { kind: 'oauth2', accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? credentials.refreshToken, expiresAt: tokens.expiresAt ?? null, scope: tokens.scopes.join(',') },
    expiresAt: tokens.expiresAt ?? null,
    scopes: tokens.scopes,
  };
}

/** Best-effort revoke (POST /v2/oauth/revoke/). Never throws. */
export async function revokeTikTokToken(ctx: AdapterContext, credentials: ProviderCredentials): Promise<boolean> {
  if (credentials.kind !== 'oauth2') return false;
  try {
    await tiktokCall(ctx, { method: 'POST', path: '/v2/oauth/revoke/', form: { ...clientCreds(ctx.config), token: credentials.accessToken }, op: 'tiktok.oauth.revoke' });
    return true;
  } catch {
    return false;
  }
}

export const tiktokConnector: OAuthConnector = {
  provider: 'tiktok',
  requiredScopes: [...TIKTOK_SCOPES],
  usesPkce: false,
  isConfigured: (config) => !!config.clientId && !!config.clientSecret,
  authorizationUrl,
  exchangeCode,
  listDestinations,
  finalize,
};
