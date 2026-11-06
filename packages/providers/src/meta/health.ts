// Connection health for Facebook Pages and Instagram professional accounts.
import type { AdapterContext, ConnectionHealth, ProviderCredentials, PublishConnection } from '@social-lite/core';
import { FACEBOOK_SCOPES, INSTAGRAM_SCOPES, igUserIdOf, missingScopes, pageIdOf } from './common.js';
import { normalizeGraphError } from './errors.js';
import { graph, pageToken, str, userToken, type GraphResult } from './graph.js';

export class MetaHealthUnavailableError extends Error {
  constructor(message = 'Meta could not be reached to check this connection. The previous status is kept; try again shortly.') {
    super(message);
    this.name = 'MetaHealthUnavailableError';
  }
}

/** GET /me/permissions → granted permission names. null when the token cannot be used. */
export async function grantedPermissions(ctx: AdapterContext, token: string): Promise<GraphResult<{ data?: Array<{ permission?: string; status?: string }> }>> {
  return graph(ctx, { method: 'GET', path: 'me/permissions', token, op: 'meta.permissions' });
}

export function grantedFrom(data: { data?: Array<{ permission?: string; status?: string }> }): string[] {
  return (data.data ?? []).filter((p) => p.status === 'granted' && typeof p.permission === 'string').map((p) => p.permission!);
}

/**
 * Health check:
 *  1. Look up the destination object with the Page token (authoritative for reconnect:
 *     long-lived Page tokens do not expire even when the user token does).
 *  2. Check granted permissions with the user token (fallback: Page token).
 * Transient failures throw MetaHealthUnavailableError so callers keep the last known status.
 */
export async function metaHealth(
  ctx: AdapterContext, provider: 'facebook' | 'instagram', connection: PublishConnection, credentials: ProviderCredentials,
): Promise<ConnectionHealth> {
  const checkedAt = ctx.now().toISOString();
  const token = pageToken(credentials);
  if (!token) {
    return { status: 'reconnect_required', checkedAt, message: 'This connection has no usable Meta credentials. Reconnect the account in Settings → Connections.' };
  }
  const objectId = provider === 'facebook' ? pageIdOf(connection) : igUserIdOf(connection);
  const fields = provider === 'facebook' ? 'id,name' : 'id,username,name';
  let lookup;
  try {
    lookup = await graph<{ id?: string; name?: string; username?: string }>(ctx, { method: 'GET', path: objectId, token, params: { fields }, op: provider === 'facebook' ? 'meta.facebook.page_lookup' : 'meta.instagram.account_lookup' });
  } catch {
    throw new MetaHealthUnavailableError();
  }
  if (!lookup.ok) {
    const n = normalizeGraphError(lookup.error, lookup.headers);
    if (n.cls === 'reconnect') return { status: 'reconnect_required', checkedAt, message: n.message };
    if (n.cls === 'permission' || n.cls === 'policy') return { status: 'missing_permission', checkedAt, message: n.message };
    throw new MetaHealthUnavailableError();
  }
  const metadata: Record<string, unknown> = {};
  if (provider === 'facebook' && str(lookup.data.name)) metadata.page_name = lookup.data.name;
  if (provider === 'instagram') {
    if (str(lookup.data.username)) metadata.ig_username = lookup.data.username;
    if (str(lookup.data.name)) metadata.ig_name = lookup.data.name;
  }

  const required = provider === 'facebook' ? FACEBOOK_SCOPES : INSTAGRAM_SCOPES;
  const permToken = userToken(credentials) ?? token;
  try {
    const perms = await grantedPermissions(ctx, permToken);
    if (perms.ok) {
      const missing = missingScopes(required, grantedFrom(perms.data));
      if (missing.length) {
        return {
          status: 'missing_permission', checkedAt, missingPermissions: missing, metadata,
          message: `Meta permissions missing: ${missing.join(', ')}. Reconnect and allow every requested permission.`,
        };
      }
    }
    // A failed permission read with the (60-day) user token does not invalidate the Page token.
  } catch {
    /* permission listing is advisory; the object lookup already proved the token works */
  }
  const label = provider === 'facebook' ? 'Facebook Page' : 'Instagram account';
  return { status: 'ready', checkedAt, message: `${label} is connected and can publish.`, metadata };
}
