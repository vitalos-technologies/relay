// LinkedIn 3-legged OAuth + destination discovery (member and, when approved, organizations).
// Sources: docs/providers/linkedin.md (L7–L10).
//  authorize: https://www.linkedin.com/oauth/v2/authorization (space-delimited scopes; all-or-nothing consent)
//  token:     POST https://www.linkedin.com/oauth/v2/accessToken (form, client_id + client_secret in body); 60-day tokens.
//  Organization scopes are requested only when the operator enabled them (Community Management API approved):
//  requesting scopes the app lacks fails the authorization with "Invalid scope".
import { TransportError, type AdapterContext, type DestinationCandidate, type FinalizedDestination, type OAuthConnector, type OAuthTokenSet, type ProviderAppConfig, type ProviderCredentials } from '@social-lite/core';
import { ProviderHttpError } from '../shared/http.js';
import { OAuthFlowError, standardFinalize, tokenSetFrom, type RawTokenResponse } from '../shared/oauth.js';
import { LI_API, LI_OAUTH, liCall, liRest } from './api.js';

export const LI_MEMBER_SCOPES = ['openid', 'profile', 'w_member_social'];
export const LI_ORG_SCOPES = ['w_organization_social', 'r_organization_social', 'rw_organization_admin', 'r_member_postAnalytics'];
export const LI_POSTING_ROLES = new Set(['ADMINISTRATOR', 'DIRECT_SPONSORED_CONTENT_POSTER', 'CONTENT_ADMIN', 'CONTENT_ADMINISTRATOR']);

export const orgAccessEnabled = (config: ProviderAppConfig): boolean => config.features?.linkedin_organizations === true;
export const linkedinScopes = (config: ProviderAppConfig): string[] => (orgAccessEnabled(config) ? [...LI_MEMBER_SCOPES, ...LI_ORG_SCOPES] : [...LI_MEMBER_SCOPES]);

function client(config: ProviderAppConfig): { client_id: string; client_secret: string } {
  if (!config.clientId || !config.clientSecret) throw new OAuthFlowError('linkedin', 'not_configured', 'LinkedIn is not configured (LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET missing).', true);
  return { client_id: config.clientId, client_secret: config.clientSecret };
}

async function tokenRequest(ctx: AdapterContext, form: Record<string, string>, op: string, fallbackScope?: string): Promise<OAuthTokenSet> {
  let raw: RawTokenResponse;
  try {
    raw = (await liCall<RawTokenResponse>(ctx, { method: 'POST', url: `${ctx.config.baseUrls?.linkedinOAuth ?? LI_OAUTH}/accessToken`, form: { ...form, ...client(ctx.config) }, op })).data;
  } catch (err) {
    if (err instanceof ProviderHttpError) {
      const permanent = err.status === 400 || err.status === 401;
      throw new OAuthFlowError('linkedin', err.code ?? `http_${err.status}`, permanent
        ? 'LinkedIn refused the authorization (expired, revoked or already used). Connect the LinkedIn account again.'
        : `LinkedIn token endpoint error (${err.status}); try again shortly.`, permanent);
    }
    if (err instanceof TransportError) throw new OAuthFlowError('linkedin', 'network', 'Could not reach LinkedIn to complete authorization; try again.', false);
    throw err;
  }
  if (!raw.access_token) throw new OAuthFlowError('linkedin', 'no_access_token', 'LinkedIn did not return an access token.', false);
  return tokenSetFrom(raw, ctx.now().getTime(), /[\s,]+/, fallbackScope);
}

function authorizationUrl(config: ProviderAppConfig, p: { state: string; redirectUri: string }): string {
  if (!config.clientId) throw new OAuthFlowError('linkedin', 'not_configured', 'LinkedIn is not configured (LINKEDIN_CLIENT_ID missing).', true);
  const u = new URL(`${config.baseUrls?.linkedinOAuth ?? LI_OAUTH}/authorization`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', config.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('state', p.state);
  u.searchParams.set('scope', linkedinScopes(config).join(' '));
  return u.toString();
}

async function exchangeCode(ctx: AdapterContext, p: { code: string; redirectUri: string }): Promise<OAuthTokenSet> {
  return tokenRequest(ctx, { grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri }, 'linkedin.oauth.token');
}

export interface LiUserInfo { sub?: string; name?: string; picture?: string }
export async function userInfo(ctx: AdapterContext, token: string): Promise<LiUserInfo> {
  return (await liCall<LiUserInfo>(ctx, { method: 'GET', url: `${ctx.config.baseUrls?.linkedin ?? LI_API}/v2/userinfo`, bearer: token, op: 'linkedin.userinfo' })).data;
}

interface Acl { role?: string; state?: string; organization?: string; organizationTarget?: string }
export async function postingAcls(ctx: AdapterContext, token: string): Promise<Map<string, string[]>> {
  const r = await liRest<{ elements?: Acl[] }>(ctx, { method: 'GET', path: '/rest/organizationAcls', rawQuery: 'q=roleAssignee&state=APPROVED&count=100', bearer: token, op: 'linkedin.org.acls' });
  const byOrg = new Map<string, string[]>();
  for (const a of r.data.elements ?? []) {
    const org = a.organization ?? a.organizationTarget;
    if (!org || a.state !== 'APPROVED' || !a.role) continue;
    byOrg.set(org, [...(byOrg.get(org) ?? []), a.role]);
  }
  return byOrg;
}

async function orgName(ctx: AdapterContext, token: string, urn: string): Promise<string | null> {
  try {
    const id = urn.split(':').pop()!;
    const r = await liRest<{ localizedName?: string }>(ctx, { method: 'GET', path: `/rest/organizations/${encodeURIComponent(id)}`, bearer: token, op: 'linkedin.org.lookup' });
    return r.data.localizedName ?? null;
  } catch {
    return null;
  }
}

async function listDestinations(ctx: AdapterContext, tokens: OAuthTokenSet): Promise<DestinationCandidate[]> {
  const me = await userInfo(ctx, tokens.accessToken);
  if (!me.sub) throw new OAuthFlowError('linkedin', 'no_member_id', 'LinkedIn did not return the member identifier.', false);
  const out: DestinationCandidate[] = [{
    provider: 'linkedin', providerAccountId: `urn:li:person:${me.sub}`, displayName: me.name ?? 'LinkedIn member', username: null,
    unavailableReason: tokens.scopes.length && !tokens.scopes.includes('w_member_social') ? 'Posting permission (w_member_social) was not granted.' : null,
    metadata: { account_type: 'member', profile_image_url: me.picture ?? null },
  }];
  if (tokens.scopes.includes('w_organization_social')) {
    const acls = await postingAcls(ctx, tokens.accessToken);
    for (const [urn, roles] of acls) {
      const canPost = roles.some((r) => LI_POSTING_ROLES.has(r));
      out.push({
        provider: 'linkedin', providerAccountId: urn, displayName: (await orgName(ctx, tokens.accessToken, urn)) ?? `Organization ${urn.split(':').pop()}`, username: null,
        unavailableReason: canPost ? null : 'Your Page role cannot post. Ask a Page admin for the Content admin or Administrator role.',
        metadata: { account_type: 'organization', roles, member_urn: `urn:li:person:${me.sub}` },
      });
    }
  }
  return out;
}

async function finalize(ctx: AdapterContext, tokens: OAuthTokenSet, candidate: DestinationCandidate): Promise<FinalizedDestination> {
  const isOrg = candidate.metadata.account_type === 'organization';
  return standardFinalize({
    provider: 'linkedin', label: 'LinkedIn', tokens, candidate, nowIso: ctx.now().toISOString(),
    required: isOrg ? ['w_organization_social'] : ['w_member_social'],
    metadata: { ...candidate.metadata, granted_scopes: tokens.scopes },
  });
}

/** Programmatic refresh (only for partners LinkedIn enabled it for; L8). Without a refresh token ⇒ reconnect. */
export async function refreshLinkedInCredentials(ctx: AdapterContext, credentials: ProviderCredentials): Promise<{ credentials: ProviderCredentials; expiresAt: string | null; scopes?: string[] }> {
  if (credentials.kind !== 'oauth2' || !credentials.refreshToken) throw new OAuthFlowError('linkedin', 'no_refresh_token', 'LinkedIn access expires after 60 days and this app has no refresh token. Reconnect the LinkedIn account.', true);
  const t = await tokenRequest(ctx, { grant_type: 'refresh_token', refresh_token: credentials.refreshToken }, 'linkedin.oauth.refresh', credentials.scope);
  return {
    credentials: { kind: 'oauth2', accessToken: t.accessToken, refreshToken: t.refreshToken ?? credentials.refreshToken, expiresAt: t.expiresAt ?? null, scope: t.scopes.join(' ') },
    expiresAt: t.expiresAt ?? null,
    scopes: t.scopes,
  };
}

export const linkedinConnector: OAuthConnector = {
  provider: 'linkedin',
  requiredScopes: LI_MEMBER_SCOPES,
  usesPkce: false,
  isConfigured: (config) => !!config.clientId && !!config.clientSecret,
  authorizationUrl,
  exchangeCode,
  listDestinations,
  finalize,
};
