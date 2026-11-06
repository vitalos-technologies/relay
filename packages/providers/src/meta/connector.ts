// Facebook Login connectors for Facebook Pages and Instagram professional accounts (linked Page route).
//
//  authorizationUrl → https://www.facebook.com/<ver>/dialog/oauth?client_id&redirect_uri&state&response_type=code&scope
//  exchangeCode     → GET /<ver>/oauth/access_token?client_id&redirect_uri&client_secret&code      (short-lived user token)
//                   → GET /<ver>/oauth/access_token?grant_type=fb_exchange_token&client_id&client_secret&fb_exchange_token
//                     (long-lived user token, ~60 days)
//                   → GET /<ver>/me/permissions  (granted scopes only)
//  listDestinations → GET /<ver>/me/accounts?fields=id,name,tasks,instagram_business_account{id,username,name}
//  finalize         → GET /<ver>/<page-id>?fields=id,name,access_token,tasks,instagram_business_account{...}
//                     (Page token from a long-lived user token has no expiry date)
// PKCE is not used: Meta's manual-flow documentation authenticates the code exchange with client_secret
// and does not document code_challenge.
import {
  AppError, type AdapterContext, type ConnectionHealth, type DestinationCandidate, type FinalizedDestination,
  type OAuthConnector, type ProviderAppConfig, type PublishConnection,
} from '@social-lite/core';
import { FACEBOOK_SCOPES, INSTAGRAM_SCOPES, POSTING_TASKS, missingScopes } from './common.js';
import { normalizeGraphError, isTransportError } from './errors.js';
import { DIALOG_HOST, graph, graphVersion, str, type GraphResult } from './graph.js';
import { grantedFrom, grantedPermissions, metaHealth } from './health.js';

export const NO_IG_ACCOUNT_REASON = 'Link an Instagram professional account to this Page';
export const NO_POSTING_TASK_REASON = 'Your role on this Page cannot create posts. Ask a Page admin for full control or "Create content" access, then reconnect.';
const NO_PAGE_TOKEN_REASON = 'Facebook did not grant access to this Page. Reconnect and select this Page in the Facebook dialog.';

interface PageNode {
  id?: string;
  name?: string;
  access_token?: string;
  tasks?: string[];
  instagram_business_account?: { id?: string; username?: string; name?: string };
}

const PAGE_FIELDS = 'id,name,tasks,instagram_business_account{id,username,name}';

function providerError(message: string): AppError {
  return new AppError('provider_error', message);
}

async function safeGraph<T>(ctx: AdapterContext, call: Parameters<typeof graph>[1], failMessage: string): Promise<GraphResult<T>> {
  try {
    return await graph<T>(ctx, call);
  } catch (err) {
    if (isTransportError(err)) throw providerError(`${failMessage} Meta could not be reached; try again.`);
    throw err;
  }
}

function fail(r: Extract<GraphResult, { ok: false }>, what: string): never {
  const n = normalizeGraphError(r.error, r.headers);
  if (n.cls === 'reconnect') throw providerError(`${what} Meta rejected the login. Start the connection again.`);
  if (n.cls === 'permission') throw providerError(`${what} ${n.message}`);
  if (n.cls === 'rate_limit') throw providerError(`${what} Meta is rate-limiting requests; try again in a few minutes.`);
  throw providerError(`${what} Meta returned an error (${n.code}).`);
}

function canPost(tasks: string[] | undefined): boolean {
  if (!Array.isArray(tasks)) return true; // field absent: don't guess; publish-time errors will tell
  return tasks.some((t) => POSTING_TASKS.includes(t));
}

function makeConnector(provider: 'facebook' | 'instagram'): OAuthConnector {
  const requiredScopes = [...(provider === 'facebook' ? FACEBOOK_SCOPES : INSTAGRAM_SCOPES)];

  const connector: OAuthConnector = {
    provider,
    requiredScopes,
    usesPkce: false,

    isConfigured(config: ProviderAppConfig) {
      return Boolean(config.clientId && config.clientSecret);
    },

    authorizationUrl(config, p) {
      if (!config.clientId) throw new AppError('provider_not_configured', 'Meta is not configured (META_APP_ID missing).');
      const u = new URL(`${(config.baseUrls?.dialog ?? DIALOG_HOST).replace(/\/+$/, '')}/${graphVersion(config)}/dialog/oauth`);
      u.searchParams.set('client_id', config.clientId);
      u.searchParams.set('redirect_uri', p.redirectUri);
      u.searchParams.set('state', p.state);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('scope', requiredScopes.join(','));
      return u.toString();
    },

    async exchangeCode(ctx, p) {
      const { clientId, clientSecret } = ctx.config;
      if (!clientId || !clientSecret) throw new AppError('provider_not_configured', 'Meta is not configured (app id / secret missing).');
      const short = await safeGraph<{ access_token?: string; expires_in?: number }>(ctx, {
        method: 'GET', path: 'oauth/access_token', op: 'meta.oauth.exchange_code', noProof: true,
        params: { client_id: clientId, redirect_uri: p.redirectUri, client_secret: clientSecret, code: p.code },
      }, 'Could not complete the Facebook login.');
      if (!short.ok) fail(short, 'Could not complete the Facebook login.');
      const shortToken = str(short.data.access_token);
      if (!shortToken) throw providerError('Could not complete the Facebook login: no access token was returned.');

      const long = await safeGraph<{ access_token?: string; expires_in?: number }>(ctx, {
        method: 'GET', path: 'oauth/access_token', op: 'meta.oauth.long_lived', noProof: true,
        params: { grant_type: 'fb_exchange_token', client_id: clientId, client_secret: clientSecret, fb_exchange_token: shortToken },
      }, 'Could not obtain a long-lived Facebook token.');
      if (!long.ok) fail(long, 'Could not obtain a long-lived Facebook token.');
      const accessToken = str(long.data.access_token);
      if (!accessToken) throw providerError('Could not obtain a long-lived Facebook token.');
      const expiresIn = Number(long.data.expires_in);
      const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(ctx.now().getTime() + expiresIn * 1000).toISOString() : null;

      const perms = await safeGraph<{ data?: Array<{ permission?: string; status?: string }> }>(ctx, { method: 'GET', path: 'me/permissions', token: accessToken, op: 'meta.permissions' }, 'Could not read granted permissions.');
      if (!perms.ok) fail(perms, 'Could not read granted permissions.');
      return { accessToken, refreshToken: null, expiresAt, scopes: grantedFrom(perms.data), raw: { token_type: 'bearer' } };
    },

    async listDestinations(ctx, tokens) {
      const pages: PageNode[] = [];
      let after: string | undefined;
      for (let i = 0; i < 5; i++) {
        const r = await safeGraph<{ data?: PageNode[]; paging?: { cursors?: { after?: string }; next?: string } }>(ctx, {
          method: 'GET', path: 'me/accounts', token: tokens.accessToken, op: 'meta.accounts',
          params: { fields: PAGE_FIELDS, limit: 100, after },
        }, 'Could not list your Facebook Pages.');
        if (!r.ok) fail(r, 'Could not list your Facebook Pages.');
        pages.push(...(r.data.data ?? []));
        after = r.data.paging?.next ? r.data.paging?.cursors?.after : undefined;
        if (!after) break;
      }
      const version = graphVersion(ctx.config);
      const out: DestinationCandidate[] = [];
      for (const p of pages) {
        const pageId = str(p.id);
        if (!pageId) continue;
        const pageName = str(p.name) ?? 'Facebook Page';
        const postable = canPost(p.tasks);
        if (provider === 'facebook') {
          out.push({
            provider, providerAccountId: pageId, displayName: pageName, username: null,
            unavailableReason: postable ? null : NO_POSTING_TASK_REASON,
            metadata: { page_id: pageId, page_name: pageName, tasks: p.tasks ?? null, graph_version: version },
          });
        } else {
          const ig = p.instagram_business_account;
          const igId = str(ig?.id);
          out.push({
            provider,
            providerAccountId: igId ?? pageId,
            displayName: igId ? (str(ig?.name) ?? str(ig?.username) ?? 'Instagram account') : pageName,
            username: igId ? str(ig?.username) : null,
            unavailableReason: !igId ? NO_IG_ACCOUNT_REASON : postable ? null : NO_POSTING_TASK_REASON,
            metadata: {
              page_id: pageId, page_name: pageName, ig_user_id: igId, ig_username: str(ig?.username), tasks: p.tasks ?? null, graph_version: version,
            },
          });
        }
      }
      return out;
    },

    async finalize(ctx, tokens, candidate): Promise<FinalizedDestination> {
      if (candidate.provider !== provider) throw new AppError('validation_failed', 'That destination belongs to a different provider.');
      if (candidate.unavailableReason) throw new AppError('validation_failed', candidate.unavailableReason);
      const pageId = typeof candidate.metadata.page_id === 'string' ? candidate.metadata.page_id : candidate.providerAccountId;
      const r = await safeGraph<PageNode>(ctx, {
        method: 'GET', path: pageId, token: tokens.accessToken, op: 'meta.facebook.page_token',
        params: { fields: `id,name,access_token,tasks,instagram_business_account{id,username,name}` },
      }, 'Could not access the selected Page.');
      if (!r.ok) fail(r, 'Could not access the selected Page.');
      const page = r.data;
      const pageAccessToken = str(page.access_token);
      if (!pageAccessToken) throw providerError(NO_PAGE_TOKEN_REASON);
      if (!canPost(page.tasks)) throw new AppError('validation_failed', NO_POSTING_TASK_REASON);
      const pageName = str(page.name) ?? (typeof candidate.metadata.page_name === 'string' ? candidate.metadata.page_name : 'Facebook Page');
      const version = graphVersion(ctx.config);

      let metadata: Record<string, unknown>;
      let displayName: string;
      let username: string | null = null;
      if (provider === 'instagram') {
        const igId = str(page.instagram_business_account?.id);
        if (!igId) throw new AppError('validation_failed', NO_IG_ACCOUNT_REASON);
        if (igId !== candidate.providerAccountId) throw new AppError('validation_failed', 'The Instagram account linked to this Page changed. Start the connection again.');
        username = str(page.instagram_business_account?.username);
        displayName = str(page.instagram_business_account?.name) ?? username ?? candidate.displayName;
        metadata = { page_id: pageId, page_name: pageName, ig_user_id: igId, ig_username: username, graph_version: version };
      } else {
        displayName = pageName;
        metadata = { page_id: pageId, page_name: pageName, graph_version: version };
      }

      const credentials = { kind: 'meta_page' as const, pageAccessToken, userAccessToken: tokens.accessToken, userTokenExpiresAt: tokens.expiresAt ?? null };
      const connection: PublishConnection = {
        id: 'pending', provider, providerAccountId: candidate.providerAccountId, displayName, username, metadata, isMock: false,
      };
      const health: ConnectionHealth = await metaHealth(ctx, provider, connection, credentials).catch((): ConnectionHealth => {
        // Health endpoint unreachable right now: fall back to the scopes granted at login.
        const missing = missingScopes(requiredScopes, tokens.scopes);
        return missing.length
          ? { status: 'missing_permission', checkedAt: ctx.now().toISOString(), missingPermissions: missing, message: `Meta permissions missing: ${missing.join(', ')}. Reconnect and allow every requested permission.` }
          : { status: 'ready', checkedAt: ctx.now().toISOString(), message: 'Connected. A full health check will run shortly.' };
      });
      return {
        providerAccountId: candidate.providerAccountId,
        displayName,
        username,
        credentials,
        grantedScopes: tokens.scopes,
        // Page tokens derived from a long-lived user token have no expiry date.
        expiresAt: null,
        metadata: { ...metadata, ...(health.metadata ?? {}) },
        health,
      };
    },
  };
  return connector;
}

export const facebookConnector: OAuthConnector = makeConnector('facebook');
export const instagramConnector: OAuthConnector = makeConnector('instagram');
