// OAuth connection flow (AC-01, AC-02):
//  start    -> oauth_states row (purpose 'connect'): sha256(state) only, single-use, 10-min expiry, bound to
//              user + workspace + brand; PKCE verifier encrypted (encryptSecret(.., pkceAad)).
//  callback -> state consumed atomically (and only by the initiating user's session); code exchanged and
//              destinations listed OUTSIDE any transaction; encrypted tokens + candidates stored in
//              connection_flows (15-min expiry); redirect to /accounts/select?flow=<id>.
//  select   -> only explicitly chosen destinations become connections; status from health.
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  AppError, can, notFound,
  type DestinationCandidate, type FinalizedDestination, type OAuthConnector, type OAuthTokenSet, type Provider,
} from '@social-lite/core';
import { getOAuthConnector } from '@social-lite/providers';
import { getPool, many, maybeOne, one, withTx } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { assertBrand, assertUuid, brandAllowed, loadAccess, requireAction } from '../tenancy.js';
import { credentialAad, decryptSecret, encryptSecret, pkceAad, type EncryptedBlob } from '../crypto.js';
import { audit } from '../audit.js';
import { log } from '../log.js';
import { isOAuthProvider, oauthRedirectUri, providerAppConfig, setupContext, type OAuthProvider } from './runtime.js';
import { toConnectionJson, upsertConnectionFromDestination, type ConnectionJson } from './store.js';

export const OAUTH_STATE_TTL_MS = 10 * 60_000;
export const CONNECTION_FLOW_TTL_MS = 15 * 60_000;

const sha256 = (s: string) => createHash('sha256').update(s).digest();
const b64url = (b: Buffer) => b.toString('base64url');

interface StateSecret { v: string | null; reconnect: string | null }
interface FlowSecret { tokens: OAuthTokenSet; candidates: DestinationCandidate[] }

/** Connector for an OAuth provider, or null when that provider's adapter is not available. */
export function oauthConnectorFor(provider: Provider): OAuthConnector | null {
  const c = getOAuthConnector(provider) as OAuthConnector | null;
  return c && typeof c.isConfigured === 'function' && typeof c.authorizationUrl === 'function' ? c : null;
}

export async function startOAuth(
  ctx: Ctx, brandId: string, provider: string, opts: { reconnectConnectionId?: string | null } = {},
): Promise<{ authorization_url: string }> {
  requireAction(ctx, 'connections.manage', 'Only owners and admins can connect accounts.');
  await assertBrand(ctx, brandId);
  if (!isOAuthProvider(provider)) throw new AppError('validation_failed', 'Use facebook, instagram or x here. Telegram connects with a bot token.', { provider: 'Unsupported provider' });
  const connector = oauthConnectorFor(provider);
  const cfg = await providerAppConfig(provider);
  if (!connector || !connector.isConfigured(cfg)) {
    throw new AppError('provider_not_configured', `${provider === 'x' ? 'X' : 'Meta'} is not configured yet. An owner can add the app credentials on the Setup page.`, undefined, { provider });
  }
  const state = randomBytes(32).toString('base64url');
  const verifier = connector.usesPkce ? randomBytes(48).toString('base64url') : null;
  const challenge = verifier ? b64url(sha256(verifier)) : undefined;
  const secret: StateSecret = { v: verifier, reconnect: opts.reconnectConnectionId ?? null };
  await getPool().query(
    `INSERT INTO oauth_states(state_hash, purpose, provider, user_id, workspace_id, brand_id, code_verifier_enc, expires_at)
     VALUES ($1,'connect',$2,$3,$4,$5,$6,$7)`,
    [sha256(state), provider, ctx.actor.userId, ctx.access.workspaceId, brandId, JSON.stringify(encryptSecret(secret, pkceAad)),
      new Date(Date.now() + OAUTH_STATE_TTL_MS)]);
  // Opportunistic cleanup of old connect states / flows.
  getPool().query(`DELETE FROM oauth_states WHERE purpose='connect' AND expires_at < now() - interval '1 day'`).catch(() => undefined);
  getPool().query(`DELETE FROM connection_flows WHERE expires_at < now() - interval '1 day'`).catch(() => undefined);
  const url = connector.authorizationUrl(cfg, { state, codeChallenge: challenge, redirectUri: oauthRedirectUri(provider) });
  return { authorization_url: url };
}

export type OAuthCallbackError =
  | 'invalid_provider' | 'invalid_state' | 'session_required' | 'session_mismatch' | 'access_denied' | 'authorization_failed'
  | 'forbidden' | 'provider_not_configured' | 'token_exchange_failed' | 'destinations_failed' | 'no_destinations';

/**
 * Finish the provider redirect. sessionUserId is the CURRENT session's user: the state is only consumed
 * by the user who started the flow. Returns a relative redirect location; never echoes provider text.
 */
export async function handleOAuthCallback(p: { provider: string; params: URLSearchParams; sessionUserId: string | null }): Promise<{ location: string; error?: OAuthCallbackError }> {
  const fail = (error: OAuthCallbackError) => ({ location: `/accounts?error=${error}`, error });
  if (!isOAuthProvider(p.provider)) return fail('invalid_provider');
  const provider: OAuthProvider = p.provider;
  const state = p.params.get('state');
  if (!state || state.length > 512) return fail('invalid_state');
  if (!p.sessionUserId) return fail('session_required');

  const row = await maybeOne<{ user_id: string; workspace_id: string; brand_id: string; code_verifier_enc: EncryptedBlob | null }>(getPool(),
    `UPDATE oauth_states SET consumed_at = now()
      WHERE state_hash=$1 AND purpose='connect' AND provider=$2 AND user_id=$3 AND consumed_at IS NULL AND expires_at > now()
      RETURNING user_id, workspace_id, brand_id, code_verifier_enc`, [sha256(state), provider, p.sessionUserId]);
  if (!row) {
    const other = await maybeOne(getPool(),
      `SELECT 1 FROM oauth_states WHERE state_hash=$1 AND purpose='connect' AND user_id IS DISTINCT FROM $2`, [sha256(state), p.sessionUserId]);
    return fail(other ? 'session_mismatch' : 'invalid_state');
  }
  if (p.params.get('error')) return fail(p.params.get('error') === 'access_denied' ? 'access_denied' : 'authorization_failed');
  const code = p.params.get('code');
  if (!code || code.length > 2048) return fail('authorization_failed');

  // The initiating user must still be allowed to manage connections for this brand.
  const access = await loadAccess(row.user_id, row.workspace_id);
  if (!access || !can(access.role, 'connections.manage') || (access.brandIds !== null && !access.brandIds.includes(row.brand_id))) return fail('forbidden');
  const brand = await maybeOne(getPool(), `SELECT 1 FROM brands WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL`, [row.brand_id, row.workspace_id]);
  if (!brand) return fail('forbidden');

  const connector = oauthConnectorFor(provider);
  const cfg = await providerAppConfig(provider);
  if (!connector || !connector.isConfigured(cfg)) return fail('provider_not_configured');
  const secret = row.code_verifier_enc ? decryptSecret<StateSecret>(row.code_verifier_enc, pkceAad) : { v: null, reconnect: null };

  const actx = await setupContext(provider);
  let tokens: OAuthTokenSet;
  try {
    tokens = await connector.exchangeCode(actx, { code, codeVerifier: secret.v ?? undefined, redirectUri: oauthRedirectUri(provider) });
  } catch (err) {
    log.warn('oauth_code_exchange_failed', { provider, err: { name: (err as Error).name, message: (err as Error).message } });
    return fail('token_exchange_failed');
  }
  // Meta: record the app-scoped user id so deauthorize / data-deletion callbacks can find this grant.
  if (provider === 'facebook' || provider === 'instagram') {
    const metaUserId = await fetchMetaUserId(actx, tokens.accessToken, cfg.apiVersion);
    if (metaUserId) tokens = { ...tokens, raw: { ...(tokens.raw ?? {}), meta_user_id: metaUserId } };
  }
  let candidates: DestinationCandidate[];
  try {
    candidates = await connector.listDestinations(actx, tokens);
  } catch (err) {
    log.warn('oauth_list_destinations_failed', { provider, err: { name: (err as Error).name, message: (err as Error).message } });
    return fail('destinations_failed');
  }
  if (!candidates.length) return fail('no_destinations');

  const flowSecret: FlowSecret = { tokens, candidates };
  const flow = await one<{ id: string }>(getPool(),
    `INSERT INTO connection_flows(workspace_id, brand_id, user_id, provider, reconnect_connection_id, tokens_enc, candidates, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [row.workspace_id, row.brand_id, row.user_id, provider, secret.reconnect, JSON.stringify(encryptSecret(flowSecret, credentialAad(row.workspace_id))),
      JSON.stringify(candidates.map(publicCandidate)), new Date(Date.now() + CONNECTION_FLOW_TTL_MS)]);
  return { location: `/accounts/select?flow=${flow.id}` };
}

/** Non-secret projection of a candidate (stored in clear for display). */
function publicCandidate(c: DestinationCandidate) {
  const pic = c.metadata?.profile_image_url ?? c.metadata?.picture_url;
  return {
    provider_account_id: c.providerAccountId,
    display_name: c.displayName,
    username: c.username ?? null,
    unavailable_reason: c.unavailableReason ?? null,
    picture_url: typeof pic === 'string' && pic.startsWith('https://') ? pic : null,
  };
}

interface FlowRow {
  id: string; workspace_id: string; brand_id: string; user_id: string; provider: OAuthProvider; reconnect_connection_id: string | null;
  tokens_enc: EncryptedBlob; candidates: Array<ReturnType<typeof publicCandidate>>; expires_at: Date;
}

async function loadFlow(ctx: Ctx, flowId: string): Promise<FlowRow> {
  assertUuid(flowId, 'Connection flow');
  const f = await maybeOne<FlowRow>(getPool(),
    `SELECT * FROM connection_flows WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND consumed_at IS NULL AND expires_at > now()`,
    [flowId, ctx.access.workspaceId, ctx.actor.userId]);
  if (!f || !brandAllowed(ctx, f.brand_id)) throw notFound('Connection flow');
  return f;
}

export async function getConnectionFlow(ctx: Ctx, flowId: string) {
  requireAction(ctx, 'connections.manage');
  const f = await loadFlow(ctx, flowId);
  await assertBrand(ctx, f.brand_id);
  const active = new Set((await many<{ provider_account_id: string }>(getPool(),
    `SELECT provider_account_id FROM connections WHERE workspace_id=$1 AND brand_id=$2 AND provider=$3 AND disconnected_at IS NULL`,
    [f.workspace_id, f.brand_id, f.provider])).map((r) => r.provider_account_id));
  return {
    id: f.id,
    provider: f.provider,
    brand_id: f.brand_id,
    reconnect_connection_id: f.reconnect_connection_id,
    candidates: f.candidates.map((c) => ({ ...c, already_connected: active.has(c.provider_account_id) })),
    expires_at: f.expires_at.toISOString(),
  };
}

export const selectFlowSchema = z.object({ provider_account_ids: z.array(z.string().min(1).max(64)).min(1).max(50) });

/** AC-02: create connections ONLY for the destinations the user explicitly chose. */
export async function selectConnectionFlow(ctx: Ctx, flowId: string, body: unknown): Promise<{ items: ConnectionJson[] }> {
  requireAction(ctx, 'connections.manage', 'Only owners and admins can connect accounts.');
  const { provider_account_ids } = selectFlowSchema.parse(body);
  const ids = [...new Set(provider_account_ids)];
  const f = await loadFlow(ctx, flowId);
  await assertBrand(ctx, f.brand_id);
  const connector = oauthConnectorFor(f.provider);
  if (!connector) throw new AppError('provider_not_configured', 'This provider is not available.');
  const secret = decryptSecret<FlowSecret>(f.tokens_enc, credentialAad(f.workspace_id));

  const chosen: DestinationCandidate[] = [];
  for (const id of ids) {
    const c = secret.candidates.find((x) => x.providerAccountId === id);
    if (!c) throw new AppError('validation_failed', 'One of the selected destinations is not part of this authorization.', { provider_account_ids: 'Unknown destination' });
    if (c.unavailableReason) throw new AppError('validation_failed', `${c.displayName}: ${c.unavailableReason}`, { provider_account_ids: c.unavailableReason });
    chosen.push(c);
  }

  // Network (finalize may exchange page tokens etc.) happens before the transaction.
  const actx = await setupContext(f.provider);
  const finalized: FinalizedDestination[] = [];
  for (const c of chosen) {
    try {
      const fin = await connector.finalize(actx, secret.tokens, c);
      const metaUserId = secret.tokens.raw?.meta_user_id;
      if (typeof metaUserId === 'string') fin.metadata = { ...fin.metadata, meta_user_id: metaUserId };
      finalized.push(fin);
    } catch (err) {
      log.warn('oauth_finalize_failed', { provider: f.provider, err: { name: (err as Error).name, message: (err as Error).message } });
      throw new AppError('provider_error', `Could not finish connecting ${c.displayName}. Start the connection again.`);
    }
  }

  const rows = await withTx(async (tx) => {
    const consumed = await tx.query(
      `UPDATE connection_flows SET consumed_at=now() WHERE id=$1 AND consumed_at IS NULL AND expires_at > now()`, [f.id]);
    if (!consumed.rowCount) throw new AppError('conflict', 'This connection was already completed or has expired. Start again.');
    const out = [];
    for (const dest of finalized) {
      const { row } = await upsertConnectionFromDestination(tx, {
        workspaceId: f.workspace_id, brandId: f.brand_id, provider: f.provider, actorUserId: ctx.actor.userId,
        correlationId: ctx.correlationId, dest, reconnectConnectionId: f.reconnect_connection_id,
      });
      out.push(row);
    }
    await audit(tx, {
      workspaceId: f.workspace_id, brandId: f.brand_id, actorUserId: ctx.actor.userId, action: 'connection.flow_completed', resourceType: 'connection_flow',
      resourceId: f.id, diff: { provider: f.provider, selected: ids.length, offered: secret.candidates.length }, correlationId: ctx.correlationId,
    });
    return out;
  });
  return { items: rows.map(toConnectionJson) };
}

/** GET /me?fields=id with the user token (Authorization header; never in a logged URL). Best effort. */
async function fetchMetaUserId(actx: Awaited<ReturnType<typeof setupContext>>, accessToken: string, version?: string): Promise<string | null> {
  try {
    const r = await actx.transport.send({ method: 'GET', url: `https://graph.facebook.com/${version ?? 'v26.0'}/me?fields=id`, headers: { authorization: `Bearer ${accessToken}` }, op: 'meta.me', timeoutMs: 10_000 });
    if (r.status !== 200) return null;
    const id = (JSON.parse(r.body) as { id?: unknown }).id;
    return typeof id === 'string' && /^\d{1,32}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
