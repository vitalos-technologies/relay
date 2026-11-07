// Google OAuth 2.0 (web server flow, PKCE + client secret) for YouTube. Sources: docs/providers/youtube.md (Y9, Y12).
//  authorize: https://accounts.google.com/o/oauth2/v2/auth (access_type=offline, prompt=consent, include_granted_scopes)
//  token:     POST https://oauth2.googleapis.com/token ; revoke: POST https://oauth2.googleapis.com/revoke
//  Granular consent: users may deny individual scopes ⇒ the returned `scope` is checked.
import { TransportError, type AdapterContext, type DestinationCandidate, type FinalizedDestination, type OAuthConnector, type OAuthTokenSet, type ProviderAppConfig, type ProviderCredentials } from '@social-lite/core';
import { ProviderHttpError } from '../shared/http.js';
import { OAuthFlowError, standardFinalize, tokenSetFrom, type RawTokenResponse } from '../shared/oauth.js';
import { GOOGLE_AUTHORIZE_URL, ytCall } from './api.js';

const S = 'https://www.googleapis.com/auth/';
export const YT_SCOPE_UPLOAD = `${S}youtube.upload`;
export const YT_SCOPE_READONLY = `${S}youtube.readonly`;
export const YT_SCOPE_ANALYTICS = `${S}yt-analytics.readonly`;
/** Needed only for videos.update (cancel a native schedule). Without it native scheduling is disabled. */
export const YT_SCOPE_FORCE_SSL = `${S}youtube.force-ssl`;
export const YOUTUBE_SCOPES = [YT_SCOPE_UPLOAD, YT_SCOPE_READONLY, YT_SCOPE_ANALYTICS, YT_SCOPE_FORCE_SSL];
export const YOUTUBE_REQUIRED_SCOPES = [YT_SCOPE_UPLOAD, YT_SCOPE_READONLY];

function client(config: ProviderAppConfig): { client_id: string; client_secret: string } {
  if (!config.clientId || !config.clientSecret) throw new OAuthFlowError('youtube', 'not_configured', 'YouTube is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing).', true);
  return { client_id: config.clientId, client_secret: config.clientSecret };
}

async function tokenRequest(ctx: AdapterContext, form: Record<string, string | undefined>, op: string, fallbackScope?: string): Promise<OAuthTokenSet> {
  let raw: RawTokenResponse;
  try {
    raw = (await ytCall<RawTokenResponse>(ctx, { method: 'POST', base: 'oauth', path: '/token', form: { ...client(ctx.config), ...form }, op })).data;
  } catch (err) {
    if (err instanceof ProviderHttpError) {
      const permanent = err.status === 400 || err.status === 401 || err.status === 403;
      throw new OAuthFlowError('youtube', err.code ?? `http_${err.status}`, permanent
        ? 'Google refused the authorization (expired, revoked or already used). Connect the YouTube account again.'
        : `Google token endpoint error (${err.status}); try again shortly.`, permanent);
    }
    if (err instanceof TransportError) throw new OAuthFlowError('youtube', 'network', 'Could not reach Google to complete authorization; try again.', false);
    throw err;
  }
  if (!raw.access_token) throw new OAuthFlowError('youtube', 'no_access_token', 'Google did not return an access token.', false);
  return tokenSetFrom(raw, ctx.now().getTime(), /\s+/, fallbackScope);
}

function authorizationUrl(config: ProviderAppConfig, p: { state: string; codeChallenge?: string; redirectUri: string }): string {
  if (!config.clientId) throw new OAuthFlowError('youtube', 'not_configured', 'YouTube is not configured (GOOGLE_CLIENT_ID missing).', true);
  const u = new URL(config.baseUrls?.googleAuthorize ?? GOOGLE_AUTHORIZE_URL);
  u.searchParams.set('client_id', config.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', YOUTUBE_SCOPES.join(' '));
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('state', p.state);
  if (p.codeChallenge) {
    u.searchParams.set('code_challenge', p.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
  }
  return u.toString();
}

async function exchangeCode(ctx: AdapterContext, p: { code: string; codeVerifier?: string; redirectUri: string }): Promise<OAuthTokenSet> {
  return tokenRequest(ctx, { code: p.code, code_verifier: p.codeVerifier, grant_type: 'authorization_code', redirect_uri: p.redirectUri }, 'youtube.oauth.token');
}

export interface YtChannel { id: string; snippet?: { title?: string; customUrl?: string; thumbnails?: { default?: { url?: string } } }; status?: { longUploadsStatus?: string; privacyStatus?: string } }

export async function myChannels(ctx: AdapterContext, token: string): Promise<YtChannel[]> {
  const r = await ytCall<{ items?: YtChannel[] }>(ctx, { method: 'GET', path: '/youtube/v3/channels', query: { part: 'snippet,status', mine: 'true' }, bearer: token, op: 'youtube.channels.mine' });
  return r.data.items ?? [];
}

async function listDestinations(ctx: AdapterContext, tokens: OAuthTokenSet): Promise<DestinationCandidate[]> {
  const missing = YOUTUBE_REQUIRED_SCOPES.filter((s) => tokens.scopes.length && !tokens.scopes.includes(s));
  if (missing.includes(YT_SCOPE_READONLY)) {
    return [{ provider: 'youtube', providerAccountId: 'unknown', displayName: 'YouTube channel', unavailableReason: 'Read access to your YouTube channel was not granted. Reconnect and allow it.', metadata: {} }];
  }
  const items = await myChannels(ctx, tokens.accessToken);
  return items.map((c) => ({
    provider: 'youtube' as const,
    providerAccountId: c.id,
    displayName: c.snippet?.title ?? c.id,
    username: c.snippet?.customUrl ?? null,
    unavailableReason: missing.includes(YT_SCOPE_UPLOAD) ? 'Upload permission (youtube.upload) was not granted. Reconnect and allow uploads.' : null,
    metadata: { profile_image_url: c.snippet?.thumbnails?.default?.url ?? null, long_uploads: c.status?.longUploadsStatus ?? null },
  }));
}

async function finalize(ctx: AdapterContext, tokens: OAuthTokenSet, candidate: DestinationCandidate): Promise<FinalizedDestination> {
  return standardFinalize({
    provider: 'youtube', label: 'YouTube', tokens, candidate, nowIso: ctx.now().toISOString(), required: YOUTUBE_REQUIRED_SCOPES,
    metadata: {
      profile_image_url: candidate.metadata.profile_image_url ?? null, long_uploads: candidate.metadata.long_uploads ?? null,
      granted_scopes: tokens.scopes, native_scheduling: !tokens.scopes.length || tokens.scopes.includes(YT_SCOPE_FORCE_SSL),
    },
  });
}

/** Google refresh tokens do not rotate; the stored refresh token is kept. */
export async function refreshYouTubeCredentials(ctx: AdapterContext, credentials: ProviderCredentials): Promise<{ credentials: ProviderCredentials; expiresAt: string | null; scopes?: string[] }> {
  if (credentials.kind !== 'oauth2' || !credentials.refreshToken) throw new OAuthFlowError('youtube', 'no_refresh_token', 'This YouTube authorization cannot be refreshed. Reconnect the YouTube account.', true);
  const t = await tokenRequest(ctx, { refresh_token: credentials.refreshToken, grant_type: 'refresh_token' }, 'youtube.oauth.refresh', credentials.scope);
  return {
    credentials: { kind: 'oauth2', accessToken: t.accessToken, refreshToken: t.refreshToken ?? credentials.refreshToken, expiresAt: t.expiresAt ?? null, scope: t.scopes.join(' ') },
    expiresAt: t.expiresAt ?? null,
    scopes: t.scopes,
  };
}

/** Best-effort revoke (refresh token preferred: it also revokes its access tokens). Never throws. */
export async function revokeYouTubeToken(ctx: AdapterContext, credentials: ProviderCredentials): Promise<boolean> {
  if (credentials.kind !== 'oauth2') return false;
  try {
    await ytCall(ctx, { method: 'POST', base: 'oauth', path: '/revoke', form: { token: credentials.refreshToken ?? credentials.accessToken }, op: 'youtube.oauth.revoke' });
    return true;
  } catch {
    return false;
  }
}

export const youtubeConnector: OAuthConnector = {
  provider: 'youtube',
  requiredScopes: YOUTUBE_SCOPES,
  usesPkce: true,
  isConfigured: (config) => !!config.clientId && !!config.clientSecret,
  authorizationUrl,
  exchangeCode,
  listDestinations,
  finalize,
};
