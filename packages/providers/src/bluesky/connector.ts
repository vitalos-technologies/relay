// Bluesky connection via an APP PASSWORD (clearly labelled option; atproto OAuth with PAR/DPoP is a documented
// next step — docs/providers/bluesky.md). The app password is stored encrypted with the credential so expired
// sessions can be re-created; the user can revoke it in Bluesky Settings at any time.
import { TransportError, type AdapterContext, type FinalizedDestination, type ProviderCredentials } from '@social-lite/core';
import { ProviderHttpError } from '../shared/http.js';
import { OAuthFlowError } from '../shared/oauth.js';
import { BSKY_ENTRYWAY, classifyBluesky, createSession, refreshSession } from './api.js';

/** Assumed app-password shape (xxxx-xxxx-xxxx-xxxx): refuse main account passwords. */
export const APP_PASSWORD_RE = /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i;

export interface BlueskyConnector {
  readonly provider: 'bluesky';
  readonly authMethod: 'app_password';
  verify(ctx: AdapterContext, p: { identifier: string; appPassword: string; service?: string }): Promise<FinalizedDestination>;
}

export const blueskyConnector: BlueskyConnector = {
  provider: 'bluesky',
  authMethod: 'app_password',
  async verify(ctx, p) {
    const identifier = p.identifier.trim().replace(/^@/, '');
    const service = (p.service ?? BSKY_ENTRYWAY).replace(/\/$/, '');
    if (!/^https:\/\//.test(service)) throw new OAuthFlowError('bluesky', 'invalid_service', 'The Bluesky server must be an https:// URL.', true);
    if (!identifier) throw new OAuthFlowError('bluesky', 'identifier_required', 'Enter your Bluesky handle (e.g. name.bsky.social).', true);
    if (!APP_PASSWORD_RE.test(p.appPassword.trim())) {
      throw new OAuthFlowError('bluesky', 'app_password_required', 'Use an app password (Bluesky Settings → Privacy and security → App passwords), not your account password.', true);
    }
    let s;
    try {
      s = await createSession(ctx, service, identifier, p.appPassword.trim());
    } catch (err) {
      if (err instanceof ProviderHttpError) {
        const c = classifyBluesky(err, ctx.now().getTime());
        throw new OAuthFlowError('bluesky', c.code, c.kind === 'reconnect' ? 'Bluesky did not accept this handle and app password. Check both and try again.' : c.message, c.kind !== 'rate_limited' && c.kind !== 'server');
      }
      if (err instanceof TransportError) throw new OAuthFlowError('bluesky', 'network', 'Could not reach Bluesky; try again.', false);
      throw err;
    }
    const checkedAt = ctx.now().toISOString();
    const credentials: ProviderCredentials = {
      kind: 'atproto_app_password', identifier, appPassword: p.appPassword.trim(), did: s.did, service, pdsUrl: s.pdsUrl,
      accessJwt: s.accessJwt, refreshJwt: s.refreshJwt, accessExpiresAt: s.accessExpiresAt,
    };
    return {
      providerAccountId: s.did,
      displayName: `@${s.handle}`,
      username: s.handle,
      credentials,
      grantedScopes: ['app_password'],
      expiresAt: s.accessExpiresAt,
      metadata: { handle: s.handle, pds_url: s.pdsUrl, auth_method: 'app_password' },
      health: { status: 'ready', checkedAt, message: `Connected as @${s.handle} with an app password.` },
    };
  },
};

/** Refresh: refreshSession (rotating refresh JWT); if that fails, a new app-password session. */
export async function refreshBlueskyCredentials(ctx: AdapterContext, credentials: ProviderCredentials): Promise<{ credentials: ProviderCredentials; expiresAt: string | null; scopes?: string[] }> {
  if (credentials.kind !== 'atproto_app_password') throw new OAuthFlowError('bluesky', 'unsupported', 'This Bluesky connection cannot be refreshed. Reconnect it.', true);
  let s;
  try {
    if (!credentials.refreshJwt) throw new Error('no refresh jwt');
    s = await refreshSession(ctx, credentials.pdsUrl, credentials.refreshJwt);
  } catch {
    try {
      s = await createSession(ctx, credentials.service, credentials.identifier, credentials.appPassword);
    } catch (err) {
      if (err instanceof ProviderHttpError) {
        const c = classifyBluesky(err, ctx.now().getTime());
        throw new OAuthFlowError('bluesky', c.code, c.message, c.kind === 'reconnect' || c.kind === 'permission');
      }
      throw new OAuthFlowError('bluesky', 'network', 'Could not reach Bluesky to renew the session.', false);
    }
  }
  return {
    credentials: { ...credentials, did: s.did, pdsUrl: s.pdsUrl, accessJwt: s.accessJwt, refreshJwt: s.refreshJwt, accessExpiresAt: s.accessExpiresAt },
    expiresAt: s.accessExpiresAt,
  };
}
