// Content Hub connections (Google Drive/Docs content, Notion): OAuth (oauth_states pattern: sha256(state), single use,
// 10-min expiry, bound to the initiating user/workspace/brand, PKCE verifier encrypted), encrypted token storage
// (AAD binds the ciphertext to workspace + connection), serialized refresh, revocation and disconnect.
// Separate from sign-in (OIDC) and from social destinations (YouTube) — different rows, tokens and scopes.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppError, notFound } from '@social-lite/core';
import type { ContentConnectionDto, ContentHubSourceStatus, ContentSource } from '@social-lite/core/contracts/content-hub';
import { getPool, many, maybeOne, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { authorize } from '../authz.js';
import { config } from '../config.js';
import { decryptSecret, encryptSecret, pkceAad, type EncryptedBlob } from '../crypto.js';
import { log } from '../log.js';
import { assertBrand, assertUuid, authorizeCtx, brandAllowed, isUuid, loadAccess, requireAction } from '../tenancy.js';
import {
  contentRedirectUri, GOOGLE_CONTENT_SCOPES, googleContentConfig, NOTION_VERSION, notionConfig, testSourcesEnabled,
} from './config.js';
import {
  exchangeGoogleCode, googleAuthorizationUrl, googleUserInfo, refreshGoogleToken, revokeGoogleToken, stopChannel, type GoogleSession,
} from './google.js';
import {
  exchangeNotionCode, notionAuthorizationUrl, notionBotInfo, refreshNotionToken, revokeNotionToken, type NotionSession,
} from './notion.js';
import { SourceAccessError, sourceTransport, type SourceTransport } from './transport.js';

export const CONTENT_STATE_TTL_MS = 10 * 60_000;
const REFRESH_SKEW_MS = 5 * 60_000;
const sha256 = (s: string) => createHash('sha256').update(s).digest();

export interface ContentConnectionRow {
  id: string; workspace_id: string; brand_id: string | null; source: ContentSource; auth_mode: 'oauth' | 'internal_token' | 'test';
  external_account_id: string; account_label: string; external_workspace_id: string | null; granted_scopes: string[];
  credentials_enc: EncryptedBlob | null; token_expires_at: Date | null; refresh_version: number; status: 'active' | 'reconnect_required' | 'disconnected';
  status_detail: string | null; writeback_enabled: boolean; authorized_by: string | null; last_used_at: Date | null; created_at: Date; updated_at: Date;
  disconnected_at: Date | null;
}

type StoredCreds =
  | { kind: 'google'; accessToken: string; refreshToken: string | null; expiresAt: string | null; scopes: string[] }
  | { kind: 'notion'; accessToken: string; refreshToken: string | null; botId: string; workspaceId: string | null }
  | { kind: 'test' };

export const contentCredAad = (workspaceId: string, connectionId: string) => `content-connection:${workspaceId}:${connectionId}`;

// ------------------------------------------------------------------ status / listing
export async function contentHubStatus(ctx: Ctx): Promise<ContentHubSourceStatus[]> {
  requireAction(ctx, 'connections.read');
  const g = await googleContentConfig();
  const n = await notionConfig();
  const gMissing = [
    ...(!g.clientId ? ['GOOGLE_CONTENT_CLIENT_ID'] : []), ...(!g.clientSecret ? ['GOOGLE_CONTENT_CLIENT_SECRET'] : []),
    ...(!g.pickerApiKey ? ['GOOGLE_PICKER_API_KEY'] : []), ...(!g.pickerAppId ? ['GOOGLE_PICKER_APP_ID'] : []),
  ];
  const nMissing = [...(!n.clientId ? ['NOTION_CLIENT_ID'] : []), ...(!n.clientSecret ? ['NOTION_CLIENT_SECRET'] : [])];
  return [
    { source: 'google', configured: !!g.clientId && !!g.clientSecret, missing: gMissing, redirect_uri: contentRedirectUri('google'),
      scopes: [...GOOGLE_CONTENT_SCOPES], picker_configured: !!g.pickerApiKey && !!g.pickerAppId, test_mode_available: testSourcesEnabled() },
    { source: 'notion', configured: !!n.clientId && !!n.clientSecret, missing: nMissing, redirect_uri: contentRedirectUri('notion'),
      scopes: [], api_version: NOTION_VERSION, internal_token_available: !!n.internalToken, test_mode_available: testSourcesEnabled() },
  ];
}

function canManage(ctx: Ctx, brandId: string | null): boolean {
  return authorizeCtx(ctx, 'connections.manage', { brandId }).allowed;
}

/** Visible when brand-scoped to a brand the caller can see, or workspace-wide (any connections.read). */
function connectionVisible(ctx: Ctx, row: Pick<ContentConnectionRow, 'brand_id'>): boolean {
  if (row.brand_id) return brandAllowed(ctx, row.brand_id);
  return true;
}

export function toConnectionDto(ctx: Ctx, r: ContentConnectionRow & { item_count?: number; authorized_by_email?: string | null }): ContentConnectionDto {
  return {
    id: r.id, source: r.source, scope: r.brand_id ? 'brand' : 'workspace', brand_id: r.brand_id, account_label: r.account_label,
    auth_mode: r.auth_mode, is_test: r.auth_mode === 'test', status: r.status, status_detail: r.status_detail, granted_scopes: r.granted_scopes,
    writeback_enabled: r.writeback_enabled, authorized_by: r.authorized_by_email ?? null, created_at: r.created_at.toISOString(),
    last_used_at: r.last_used_at?.toISOString() ?? null, disconnected_at: r.disconnected_at?.toISOString() ?? null,
    item_count: Number(r.item_count ?? 0), can_manage: canManage(ctx, r.brand_id),
  };
}

export async function listContentConnections(ctx: Ctx, opts: { brandId?: string | null; includeDisconnected?: boolean } = {}): Promise<ContentConnectionDto[]> {
  requireAction(ctx, 'connections.read');
  if (opts.brandId) await assertBrand(ctx, opts.brandId);
  const rows = await many<ContentConnectionRow & { item_count: number; authorized_by_email: string | null }>(getPool(),
    `SELECT c.*, u.email AS authorized_by_email,
            (SELECT count(*)::int FROM source_items i WHERE i.connection_id = c.id) AS item_count
       FROM content_connections c LEFT JOIN users u ON u.id = c.authorized_by
      WHERE c.workspace_id = $1 AND ($2::uuid IS NULL OR c.brand_id IS NULL OR c.brand_id = $2) AND ($3 OR c.disconnected_at IS NULL)
      ORDER BY (c.disconnected_at IS NOT NULL), c.source, c.created_at`,
    [ctx.access.workspaceId, opts.brandId ?? null, !!opts.includeDisconnected]);
  return rows.filter((r) => connectionVisible(ctx, r)).map((r) => toConnectionDto(ctx, r));
}

/** Load a connection the caller can see (workspace + brand scope), else not_found. */
export async function loadContentConnection(ctx: Ctx, connectionId: string, db: Queryable = getPool(), lock = false): Promise<ContentConnectionRow> {
  assertUuid(connectionId, 'Connection');
  const r = await maybeOne<ContentConnectionRow>(db, `SELECT * FROM content_connections WHERE id=$1 AND workspace_id=$2 ${lock ? 'FOR UPDATE' : ''}`,
    [connectionId, ctx.access.workspaceId]);
  if (!r || !connectionVisible(ctx, r)) throw notFound('Connection');
  return r;
}

/**
 * Authorize USING a connection for work on `brandId` (import/export/refresh): the connection must be in the caller's
 * workspace, active, and scoped to that brand or workspace-wide; the caller needs `perm` on the brand.
 */
export async function connectionForBrand(ctx: Ctx, connectionId: string, brandId: string, perm: 'content.create' | 'content.read' | 'exports.create' | 'connections.manage' | 'assets.upload'): Promise<ContentConnectionRow> {
  requireAction(ctx, perm, { brandId });
  await assertBrand(ctx, brandId);
  const c = await loadContentConnection(ctx, connectionId);
  if (c.brand_id && c.brand_id !== brandId) throw notFound('Connection');
  if (c.disconnected_at || c.status === 'disconnected') throw new AppError('invalid_state', 'This source connection was disconnected. Connect it again to continue.');
  if (c.status === 'reconnect_required') throw new AppError('invalid_state', 'This source connection needs to be reconnected.', undefined, { reason: 'reconnect_required' });
  return c;
}

// ------------------------------------------------------------------ OAuth start / callback
interface StateSecret { v: string; reconnect: string | null }

export async function startContentOAuth(ctx: Ctx, input: { source: string; brand_id?: string | null; reconnect_connection_id?: string | null }): Promise<{ authorization_url: string }> {
  const source = input.source;
  if (source !== 'google' && source !== 'notion') throw new AppError('validation_failed', 'Unknown source', { source: 'Use google or notion' });
  const brandId = input.brand_id ?? null;
  if (brandId) {
    requireAction(ctx, 'connections.manage', { brandId, message: 'Only people who manage connections can connect sources.' });
    await assertBrand(ctx, brandId);
  } else {
    // Workspace-wide connection: workspace-scope authority required.
    requireAction(ctx, 'connections.manage', { brandId: null, message: 'Workspace-wide sources need workspace connection rights. Choose a brand instead.' });
  }
  let loginHint: string | null = null;
  if (input.reconnect_connection_id) {
    const c = await loadContentConnection(ctx, input.reconnect_connection_id);
    if (c.source !== source || (c.brand_id ?? null) !== brandId) throw new AppError('validation_failed', 'Reconnect must use the same source and scope.');
    loginHint = c.source === 'google' && c.account_label.includes('@') ? c.account_label : null;
  }
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  let url: string;
  if (source === 'google') {
    const cfg = await googleContentConfig();
    if (!cfg.clientId || !cfg.clientSecret) throw new AppError('provider_not_configured', 'Google Drive & Docs is not configured yet. An owner can add it in Setup.');
    url = googleAuthorizationUrl(cfg, { state, codeChallenge: createHash('sha256').update(verifier).digest('base64url'), loginHint });
  } else {
    const cfg = await notionConfig();
    if (!cfg.clientId || !cfg.clientSecret) throw new AppError('provider_not_configured', 'Notion is not configured yet. An owner can add it in Setup.');
    url = notionAuthorizationUrl(cfg, state);
  }
  const secret: StateSecret = { v: verifier, reconnect: input.reconnect_connection_id ?? null };
  await getPool().query(
    `INSERT INTO oauth_states(state_hash, purpose, provider, user_id, workspace_id, brand_id, code_verifier_enc, expires_at)
     VALUES ($1,'connect',$2,$3,$4,$5,$6,$7)`,
    [sha256(state), `content:${source}`, ctx.actor.userId, ctx.access.workspaceId, brandId, JSON.stringify(encryptSecret(secret, pkceAad)),
      new Date(Date.now() + CONTENT_STATE_TTL_MS)]);
  return { authorization_url: url };
}

export type ContentCallbackError = 'invalid_source' | 'invalid_state' | 'session_required' | 'session_mismatch' | 'access_denied' | 'authorization_failed'
  | 'forbidden' | 'not_configured' | 'token_exchange_failed' | 'scope_denied' | 'account_mismatch';

const RETURN_PATH = '/settings?tab=sources';

/** Finish the redirect. The state is consumed ONLY by the user who started the flow; provider text is never echoed. */
export async function handleContentOAuthCallback(p: { source: string; params: URLSearchParams; sessionUserId: string | null }): Promise<{ location: string; error?: ContentCallbackError; connectionId?: string }> {
  const fail = (error: ContentCallbackError) => ({ location: `${RETURN_PATH}&error=${error}`, error });
  if (p.source !== 'google' && p.source !== 'notion') return fail('invalid_source');
  const source: ContentSource = p.source;
  const state = p.params.get('state');
  if (!state || state.length > 512) return fail('invalid_state');
  if (!p.sessionUserId) return fail('session_required');
  const row = await maybeOne<{ user_id: string; workspace_id: string; brand_id: string | null; code_verifier_enc: EncryptedBlob }>(getPool(),
    `UPDATE oauth_states SET consumed_at = now()
      WHERE state_hash=$1 AND purpose='connect' AND provider=$2 AND user_id=$3 AND consumed_at IS NULL AND expires_at > now()
      RETURNING user_id, workspace_id, brand_id, code_verifier_enc`, [sha256(state), `content:${source}`, p.sessionUserId]);
  if (!row) {
    const other = await maybeOne(getPool(), `SELECT 1 FROM oauth_states WHERE state_hash=$1 AND provider=$2 AND user_id IS DISTINCT FROM $3`, [sha256(state), `content:${source}`, p.sessionUserId]);
    return fail(other ? 'session_mismatch' : 'invalid_state');
  }
  if (p.params.get('error')) return fail(p.params.get('error') === 'access_denied' ? 'access_denied' : 'authorization_failed');
  const code = p.params.get('code');
  if (!code || code.length > 2048) return fail('authorization_failed');

  // Re-check authority NOW (grants may have changed since the flow started; MFA was enforced at start).
  const access = await loadAccess(row.user_id, row.workspace_id);
  if (!access?.authz) return fail('forbidden');
  const state0 = { ...access.authz, subject: { ...access.authz.subject, assurance: null } };
  if (!authorize(state0, 'connections.manage', { brandId: row.brand_id }).allowed) return fail('forbidden');
  if (row.brand_id && !(await maybeOne(getPool(), `SELECT 1 FROM brands WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL`, [row.brand_id, row.workspace_id]))) return fail('forbidden');
  const secret = decryptSecret<StateSecret>(row.code_verifier_enc, pkceAad);
  const transport = sourceTransport({ source, connectionId: null, authMode: 'oauth' });

  let identity: { externalId: string; label: string; externalWorkspaceId: string | null; scopes: string[]; creds: StoredCreds; expiresAt: string | null };
  try {
    if (source === 'google') {
      const cfg = await googleContentConfig();
      if (!cfg.clientId || !cfg.clientSecret) return fail('not_configured');
      const tok = await exchangeGoogleCode(transport, cfg, { code, codeVerifier: secret.v });
      // Granular consent: the user may decline drive.file. Without it nothing works — refuse clearly.
      if (!tok.scopes.includes('https://www.googleapis.com/auth/drive.file')) {
        await revokeGoogleToken(transport, tok.refreshToken ?? tok.accessToken).catch(() => false);
        return fail('scope_denied');
      }
      const me = await googleUserInfo({ transport, accessToken: tok.accessToken });
      identity = { externalId: me.sub, label: me.email ?? me.sub, externalWorkspaceId: null, scopes: tok.scopes, expiresAt: tok.expiresAt,
        creds: { kind: 'google', accessToken: tok.accessToken, refreshToken: tok.refreshToken, expiresAt: tok.expiresAt, scopes: tok.scopes } };
    } else {
      const cfg = await notionConfig();
      if (!cfg.clientId || !cfg.clientSecret) return fail('not_configured');
      const tok = await exchangeNotionCode(transport, cfg, code);
      identity = { externalId: tok.botId, label: tok.workspaceName ?? 'Notion workspace', externalWorkspaceId: tok.workspaceId, scopes: [], expiresAt: null,
        creds: { kind: 'notion', accessToken: tok.accessToken, refreshToken: tok.refreshToken, botId: tok.botId, workspaceId: tok.workspaceId } };
    }
  } catch (err) {
    log.warn('content_oauth_exchange_failed', { source, err: { name: (err as Error).name, message: (err as Error).message } });
    return fail('token_exchange_failed');
  }
  const connectionId = await saveConnection({
    workspaceId: row.workspace_id, brandId: row.brand_id, source, authMode: 'oauth', actorUserId: row.user_id, reconnectId: secret.reconnect, ...identity,
  }).catch((err: unknown) => {
    if (err instanceof AppError && err.code === 'validation_failed') return null;
    throw err;
  });
  if (!connectionId) return fail('account_mismatch');
  return { location: `${RETURN_PATH}&connected=${connectionId}`, connectionId };
}

/** Insert or refresh a connection for an external account (same account + scope ⇒ same row, credentials replaced). */
async function saveConnection(p: {
  workspaceId: string; brandId: string | null; source: ContentSource; authMode: 'oauth' | 'internal_token' | 'test'; actorUserId: string;
  reconnectId?: string | null; externalId: string; label: string; externalWorkspaceId: string | null; scopes: string[]; creds: StoredCreds; expiresAt: string | null;
}): Promise<string> {
  return withTx(async (tx) => {
    let existing = await maybeOne<{ id: string }>(tx,
      `SELECT id FROM content_connections WHERE workspace_id=$1 AND brand_id IS NOT DISTINCT FROM $2 AND source=$3 AND external_account_id=$4 AND disconnected_at IS NULL FOR UPDATE`,
      [p.workspaceId, p.brandId, p.source, p.externalId]);
    if (p.reconnectId) {
      const r = await maybeOne<{ id: string; external_account_id: string }>(tx, `SELECT id, external_account_id FROM content_connections WHERE id=$1 AND workspace_id=$2 AND disconnected_at IS NULL FOR UPDATE`, [p.reconnectId, p.workspaceId]);
      // A reconnect must authorise the SAME external account (never silently re-point linked items at another account).
      if (r && r.external_account_id !== p.externalId) throw new AppError('validation_failed', 'Reconnect with the same account.');
      if (r) existing = { id: r.id };
    }
    const id = existing?.id ?? randomUUID();
    const blob = JSON.stringify(encryptSecret(p.creds, contentCredAad(p.workspaceId, id)));
    if (existing) {
      await tx.query(
        `UPDATE content_connections SET credentials_enc=$2, token_expires_at=$3, granted_scopes=$4, status='active', status_detail=NULL, account_label=$5,
                refresh_version=refresh_version+1, authorized_by=$6, updated_at=now() WHERE id=$1`,
        [id, blob, p.expiresAt, p.scopes, p.label.slice(0, 200), p.actorUserId]);
      // Items that lost access only because of the connection come back on the next refresh; nothing is auto-imported.
    } else {
      await tx.query(
        `INSERT INTO content_connections(id, workspace_id, brand_id, source, auth_mode, external_account_id, account_label, external_workspace_id,
                granted_scopes, credentials_enc, token_expires_at, authorized_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, p.workspaceId, p.brandId, p.source, p.authMode, p.externalId, p.label.slice(0, 200), p.externalWorkspaceId, p.scopes, blob, p.expiresAt, p.actorUserId]);
    }
    await audit(tx, { workspaceId: p.workspaceId, brandId: p.brandId, actorUserId: p.actorUserId, action: existing ? 'content_connection.reauthorized' : 'content_connection.created',
      resourceType: 'content_connection', resourceId: id, diff: { source: p.source, auth_mode: p.authMode, scope: p.brandId ? 'brand' : 'workspace', scopes: p.scopes } });
    return id;
  });
}

/** Explicit internal Notion connection for an internal TEST installation (never production). */
export async function connectNotionInternal(ctx: Ctx, input: { brand_id?: string | null }): Promise<ContentConnectionDto> {
  if (config().APP_ENV === 'production') throw new AppError('invalid_state', 'Internal Notion connections are for test installations only. Use public OAuth.');
  const brandId = input.brand_id ?? null;
  requireAction(ctx, 'connections.manage', { brandId });
  if (brandId) await assertBrand(ctx, brandId);
  const cfg = await notionConfig();
  if (!cfg.internalToken) throw new AppError('provider_not_configured', 'NOTION_INTERNAL_TOKEN is not configured.');
  const transport = sourceTransport({ source: 'notion', connectionId: null, authMode: 'internal_token' });
  const me = await notionBotInfo({ transport, accessToken: cfg.internalToken }).catch(() => {
    throw new AppError('provider_error', 'Notion did not accept the internal token.');
  });
  const id = await saveConnection({ workspaceId: ctx.access.workspaceId, brandId, source: 'notion', authMode: 'internal_token', actorUserId: ctx.actor.userId,
    externalId: me.botId, label: me.workspaceName ?? 'Notion (internal)', externalWorkspaceId: me.workspaceId, scopes: [], expiresAt: null,
    creds: { kind: 'notion', accessToken: cfg.internalToken, refreshToken: null, botId: me.botId, workspaceId: me.workspaceId } });
  return toConnectionDto(ctx, await loadContentConnection(ctx, id));
}

/** Labelled TEST connection backed by in-process demo data (development/test only; never live). */
export async function connectTestSource(ctx: Ctx, input: { source: string; brand_id?: string | null }): Promise<ContentConnectionDto> {
  if (!testSourcesEnabled()) throw new AppError('invalid_state', 'Test sources are disabled.');
  if (input.source !== 'google' && input.source !== 'notion') throw new AppError('validation_failed', 'Unknown source', { source: 'Use google or notion' });
  const brandId = input.brand_id ?? null;
  requireAction(ctx, 'connections.manage', { brandId });
  if (brandId) await assertBrand(ctx, brandId);
  const id = await saveConnection({ workspaceId: ctx.access.workspaceId, brandId, source: input.source, authMode: 'test', actorUserId: ctx.actor.userId,
    externalId: `test-${input.source}`, label: input.source === 'google' ? 'test-drive@relay.test (test data)' : 'Relay demo Notion (test data)',
    externalWorkspaceId: input.source === 'notion' ? 'test-notion-workspace' : null, scopes: input.source === 'google' ? [...GOOGLE_CONTENT_SCOPES] : [], expiresAt: null,
    creds: { kind: 'test' } });
  return toConnectionDto(ctx, await loadContentConnection(ctx, id));
}

// ------------------------------------------------------------------ disconnect / settings
/**
 * Disconnect: revoke at the provider (best effort), delete stored tokens, stop watch channels, cancel queued imports,
 * exports and writebacks, mark linked items 'disconnected' and clear their cached previews. Explicitly imported
 * snapshots and drafts stay (workspace retention; delete/hold workflow on the item).
 */
export async function disconnectContentConnection(ctx: Ctx, connectionId: string): Promise<ContentConnectionDto> {
  const c = await loadContentConnection(ctx, connectionId);
  requireAction(ctx, 'connections.manage', { brandId: c.brand_id, message: 'Only people who manage connections can disconnect sources.' });
  if (c.brand_id) await assertBrand(ctx, c.brand_id);
  if (c.disconnected_at) return toConnectionDto(ctx, c);
  // Network (revoke, channel stop) happens outside the transaction.
  const channels = await many<{ channel_id: string; channel_resource_id: string }>(getPool(),
    `SELECT channel_id, channel_resource_id FROM sync_checkpoints WHERE connection_id=$1 AND channel_id IS NOT NULL AND stopped_at IS NULL`, [c.id]);
  let revoked = false;
  if (c.credentials_enc && c.auth_mode !== 'test') {
    try {
      const creds = decryptSecret<StoredCreds>(c.credentials_enc, contentCredAad(c.workspace_id, c.id));
      const transport = sourceTransport({ source: c.source, connectionId: c.id, authMode: c.auth_mode });
      if (creds.kind === 'google') {
        for (const ch of channels) await stopChannel({ transport, accessToken: creds.accessToken }, ch.channel_id, ch.channel_resource_id).catch(() => undefined);
        revoked = await revokeGoogleToken(transport, creds.refreshToken ?? creds.accessToken).catch(() => false);
      } else if (creds.kind === 'notion' && c.auth_mode === 'oauth') {
        revoked = await revokeNotionToken(transport, await notionConfig(), creds.accessToken);
      }
    } catch (err) {
      log.warn('content_disconnect_revoke_failed', { connectionId: c.id, err: { name: (err as Error).name } });
    }
  }
  await withTx(async (tx) => {
    await tx.query(
      `UPDATE content_connections SET status='disconnected', credentials_enc=NULL, token_expires_at=NULL, disconnected_at=now(), disconnected_by=$2,
              writeback_enabled=false, updated_at=now() WHERE id=$1 AND disconnected_at IS NULL`, [c.id, ctx.actor.userId]);
    await stopConnectionWork(tx, c.id, 'disconnected', 'The source connection was disconnected.');
    await audit(tx, { workspaceId: c.workspace_id, brandId: c.brand_id, actorUserId: ctx.actor.userId, action: 'content_connection.disconnected',
      resourceType: 'content_connection', resourceId: c.id, diff: { source: c.source, revoked_at_provider: revoked }, correlationId: ctx.correlationId });
  });
  return toConnectionDto(ctx, await loadContentConnection(ctx, c.id));
}

/** Stop everything that reads from or writes to the source for this connection (disconnect / access loss). */
export async function stopConnectionWork(tx: Queryable, connectionId: string, itemState: 'disconnected' | 'access_lost', detail: string): Promise<void> {
  await tx.query(
    `UPDATE source_items SET state=$2, state_detail=$3, preview=NULL, external_url=NULL, updated_at=now()
      WHERE connection_id=$1 AND state='linked'`, [connectionId, itemState, detail]);
  await tx.query(`UPDATE imports SET status='cancelled', error_code='source_unavailable', error_message=$2, completed_at=now() WHERE connection_id=$1 AND status IN ('queued')`, [connectionId, detail]);
  await tx.query(`UPDATE export_jobs SET status='cancelled', error_code='source_unavailable', error_message=$2, completed_at=now() WHERE connection_id=$1 AND status='queued'`, [connectionId, detail]);
  await tx.query(`UPDATE writeback_jobs SET status='cancelled', error_message=$2, updated_at=now(), completed_at=now() WHERE connection_id=$1 AND status IN ('pending','conflict')`, [connectionId, detail]);
  await tx.query(`UPDATE sync_checkpoints SET stopped_at=now(), updated_at=now() WHERE connection_id=$1 AND stopped_at IS NULL`, [connectionId]);
}

export async function setConnectionWriteback(ctx: Ctx, connectionId: string, enabled: boolean): Promise<ContentConnectionDto> {
  const c = await loadContentConnection(ctx, connectionId);
  requireAction(ctx, 'connections.manage', { brandId: c.brand_id });
  if (c.disconnected_at) throw new AppError('invalid_state', 'This source connection was disconnected.');
  if (c.source !== 'notion') throw new AppError('validation_failed', 'Writeback is available for Notion only.');
  await withTx(async (tx) => {
    await tx.query(`UPDATE content_connections SET writeback_enabled=$2, updated_at=now() WHERE id=$1`, [c.id, enabled]);
    if (!enabled) await tx.query(`UPDATE writeback_jobs SET status='cancelled', error_message='Writeback turned off', updated_at=now(), completed_at=now() WHERE connection_id=$1 AND status IN ('pending','conflict')`, [c.id]);
    await audit(tx, { workspaceId: c.workspace_id, brandId: c.brand_id, actorUserId: ctx.actor.userId, action: enabled ? 'content_connection.writeback_enabled' : 'content_connection.writeback_disabled',
      resourceType: 'content_connection', resourceId: c.id, correlationId: ctx.correlationId });
  });
  return toConnectionDto(ctx, await loadContentConnection(ctx, c.id));
}

// ------------------------------------------------------------------ credentials (decrypt only here)
export interface SourceSessions { transport: SourceTransport; google?: GoogleSession; notion?: NotionSession; isTest: boolean }

async function markReconnect(connectionId: string, detail: string): Promise<void> {
  await withTx(async (tx) => {
    const c = await maybeOne<{ workspace_id: string; brand_id: string | null; status: string }>(tx,
      `SELECT workspace_id, brand_id, status FROM content_connections WHERE id=$1 AND disconnected_at IS NULL FOR UPDATE`, [connectionId]);
    if (!c || c.status === 'reconnect_required') return;
    await tx.query(`UPDATE content_connections SET status='reconnect_required', status_detail=$2, updated_at=now() WHERE id=$1`, [connectionId, detail]);
    // Access loss stops background reads/writes; linked previews are hidden until reconnected and refreshed.
    await stopConnectionWork(tx, connectionId, 'access_lost', detail);
    await audit(tx, { workspaceId: c.workspace_id, brandId: c.brand_id, actorService: 'content-hub', action: 'content_connection.access_lost',
      resourceType: 'content_connection', resourceId: connectionId, diff: { detail } });
  });
}

async function refreshSerialized(c: ContentConnectionRow, force: boolean): Promise<StoredCreds> {
  const client = await getPool().connect();
  const lockKey = `content-connection-refresh:${c.id}`;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
    try {
      const cur = await maybeOne<ContentConnectionRow>(client, `SELECT * FROM content_connections WHERE id=$1`, [c.id]);
      if (!cur || cur.disconnected_at || !cur.credentials_enc) throw new SourceAccessError('connection disconnected', 'auth');
      const creds = decryptSecret<StoredCreds>(cur.credentials_enc, contentCredAad(cur.workspace_id, cur.id));
      if (cur.refresh_version !== c.refresh_version) return creds; // someone refreshed meanwhile
      if (creds.kind === 'test') return creds;
      const transport = sourceTransport({ source: c.source, connectionId: c.id, authMode: c.auth_mode });
      let next: StoredCreds;
      let expiresAt: string | null = null;
      if (creds.kind === 'google') {
        const exp = creds.expiresAt ? Date.parse(creds.expiresAt) : null;
        if (!force && exp !== null && exp - Date.now() > REFRESH_SKEW_MS) return creds;
        if (!creds.refreshToken) throw new SourceAccessError('no refresh token', 'auth');
        const t = await refreshGoogleToken(transport, await googleContentConfig(), creds.refreshToken);
        next = { kind: 'google', accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt, scopes: t.scopes.length ? t.scopes : creds.scopes };
        expiresAt = t.expiresAt;
      } else {
        if (!creds.refreshToken || c.auth_mode !== 'oauth') throw new SourceAccessError('Notion token cannot be refreshed', 'auth');
        const t = await refreshNotionToken(transport, await notionConfig(), creds.refreshToken);
        next = { ...creds, accessToken: t.accessToken, refreshToken: t.refreshToken };
      }
      await client.query(
        `UPDATE content_connections SET credentials_enc=$2, token_expires_at=$3, refresh_version=refresh_version+1, updated_at=now() WHERE id=$1 AND refresh_version=$4`,
        [c.id, JSON.stringify(encryptSecret(next, contentCredAad(c.workspace_id, c.id))), expiresAt, c.refresh_version]);
      return next;
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

async function sessionsFor(c: ContentConnectionRow, force = false): Promise<SourceSessions> {
  if (c.disconnected_at || !c.credentials_enc) throw new AppError('invalid_state', 'This source connection was disconnected.');
  const transport = sourceTransport({ source: c.source, connectionId: c.id, authMode: c.auth_mode });
  let creds: StoredCreds;
  try {
    creds = decryptSecret<StoredCreds>(c.credentials_enc, contentCredAad(c.workspace_id, c.id));
  } catch {
    await markReconnect(c.id, 'Stored credentials could not be read. Reconnect the source.');
    throw new AppError('invalid_state', 'Stored credentials could not be read. Reconnect the source.');
  }
  if (creds.kind === 'test') {
    return { transport, isTest: true, google: c.source === 'google' ? { transport, accessToken: 'test-token' } : undefined, notion: c.source === 'notion' ? { transport, accessToken: 'test-token' } : undefined };
  }
  const expiring = creds.kind === 'google' && (!creds.expiresAt || Date.parse(creds.expiresAt) - Date.now() <= REFRESH_SKEW_MS);
  if (force || expiring) {
    try {
      creds = await refreshSerialized(c, force);
    } catch (err) {
      if (err instanceof SourceAccessError && err.kind === 'auth') {
        await markReconnect(c.id, `${c.source === 'google' ? 'Google' : 'Notion'} no longer accepts this authorization. Reconnect the source.`);
        throw new AppError('invalid_state', 'The source authorization was revoked or expired. Reconnect it.', undefined, { reason: 'reconnect_required' });
      }
      throw err;
    }
  }
  if (creds.kind === 'test') return { transport, isTest: true };
  return creds.kind === 'google'
    ? { transport, isTest: false, google: { transport, accessToken: creds.accessToken } }
    : { transport, isTest: false, notion: { transport, accessToken: creds.accessToken } };
}

/**
 * Run source calls with the connection's credentials. On a 401: one forced refresh + retry; a second 401 (or a failed
 * refresh) marks the connection reconnect_required and stops background work. Other errors propagate unchanged.
 */
export async function withSource<T>(c: ContentConnectionRow, fn: (s: SourceSessions) => Promise<T>): Promise<T> {
  let s = await sessionsFor(c);
  try {
    const out = await fn(s);
    getPool().query(`UPDATE content_connections SET last_used_at=now() WHERE id=$1`, [c.id]).catch(() => undefined);
    return out;
  } catch (err) {
    if (!(err instanceof SourceAccessError) || err.kind !== 'auth' || s.isTest) throw err;
    const fresh = await maybeOne<ContentConnectionRow>(getPool(), `SELECT * FROM content_connections WHERE id=$1`, [c.id]);
    if (!fresh) throw err;
    const canRefresh = c.source === 'google' || c.auth_mode === 'oauth';
    if (canRefresh) {
      s = await sessionsFor(fresh, true);
      try {
        return await fn(s);
      } catch (e2) {
        if (!(e2 instanceof SourceAccessError) || e2.kind !== 'auth') throw e2;
      }
    }
    await markReconnect(c.id, `${c.source === 'google' ? 'Google' : 'Notion'} rejected the stored authorization. Reconnect the source.`);
    throw new AppError('invalid_state', 'The source authorization was revoked or expired. Reconnect it.', undefined, { reason: 'reconnect_required' });
  }
}

/** Picker configuration for the browser (no tokens: the browser obtains its own short-lived drive.file token). */
export async function pickerConfig(ctx: Ctx, connectionId: string, brandId: string) {
  const c = await connectionForBrand(ctx, connectionId, brandId, 'content.create');
  if (c.source !== 'google') throw new AppError('validation_failed', 'Not a Google connection.');
  const cfg = await googleContentConfig();
  if (c.auth_mode === 'test') return { client_id: 'test', api_key: 'test', app_id: 'test', scope: 'https://www.googleapis.com/auth/drive.file', login_hint: c.account_label, test: true };
  if (!cfg.clientId || !cfg.pickerApiKey || !cfg.pickerAppId) throw new AppError('provider_not_configured', 'The Google Picker is not configured yet (API key and project number).');
  return { client_id: cfg.clientId, api_key: cfg.pickerApiKey, app_id: cfg.pickerAppId, scope: 'https://www.googleapis.com/auth/drive.file', login_hint: c.account_label, test: false };
}

export { isUuid };
