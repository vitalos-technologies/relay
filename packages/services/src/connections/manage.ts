// Connection lifecycle: list, Telegram connect (AC-03), simulated connect, health checks (AC-04),
// pause, disconnect (AC-05), reconnect, provider status.
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  PROVIDER_LABEL,
  AppError, DISPATCHABLE_CONNECTION_STATUSES, PROVIDERS, TransportError, invalidState,
  type ConnectionHealth, type ConnectionStatus, type Provider,
} from '@social-lite/core';
import { MOCK_SCENARIOS, getAdapter, getTelegramConnector, type MockScenario } from '@social-lite/providers';
import { getPool, many, maybeOne, one, withTx } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { assertBrand, brandFilter, requireAction } from '../tenancy.js';
import { mockProvidersEnabled } from '../config.js';
import { audit } from '../audit.js';
import { writeOutbox } from '../outbox.js';
import { log } from '../log.js';
import { blockDeliveriesForConnection, onConnectionRestored, onScopePaused, onScopeResumed } from '../engine/hooks.js';
import { CredentialUnavailableError, getUsableCredentials, peekCredentials } from './credentials.js';
import { revokeXToken } from '@social-lite/providers/x/index';
import { oauthConnectorFor, startOAuth } from './oauth.js';
import { buildAdapterContext, isOAuthProvider, oauthRedirectUri, providerAppConfig, setupContext } from './runtime.js';
import {
  healthDetail, insertCredential, loadConnection, replaceCredential, toConnectionJson, toPublishConnection, upsertConnectionFromDestination,
  type ConnectionJson, type ConnectionRow,
} from './store.js';

const PROVIDER_NAME: Record<Provider, string> = PROVIDER_LABEL; // V3: covers every provider

// ------------------------------------------------------------------ provider status
export interface ProviderStatusJson {
  provider: Provider; configured: boolean; missing: string[]; callback_url: string | null;
  required_scopes: string[]; mock_available: boolean; notes: string;
}

export async function listProviderStatus(_ctx: Ctx): Promise<{ items: ProviderStatusJson[] }> {
  const mock = mockProvidersEnabled();
  const items: ProviderStatusJson[] = [];
  for (const provider of PROVIDERS) {
    if (provider === 'telegram') {
      items.push({
        provider, configured: true, missing: [], callback_url: null, required_scopes: [], mock_available: mock,
        notes: 'No app setup needed. Create a bot with @BotFather, add it to your channel as an administrator with "Post Messages", then connect with its token.',
      });
      continue;
    }
    const cfg = await providerAppConfig(provider);
    const connector = oauthConnectorFor(provider);
    const missing: string[] = [];
    if (provider === 'x') {
      if (!cfg.clientId) missing.push('X_CLIENT_ID');
    } else {
      if (!cfg.clientId) missing.push('META_APP_ID');
      if (!cfg.clientSecret) missing.push('META_APP_SECRET');
    }
    items.push({
      provider,
      configured: !!connector && connector.isConfigured(cfg) && missing.length === 0,
      missing: connector ? missing : [...missing, 'provider adapter not available in this build'],
      callback_url: oauthRedirectUri(provider),
      required_scopes: connector ? [...connector.requiredScopes] : [],
      mock_available: mock,
      notes: provider === 'x'
        ? 'Needs an X developer app with OAuth 2.0 enabled (Web App, Read and write), this callback URL registered, and pay-per-use credits. Set X_CLIENT_SECRET for confidential clients. Each post, media upload and read is billed by X.'
        : 'Needs a Meta app with Facebook Login for Business; register this callback URL as a Valid OAuth Redirect URI.',
    });
  }
  return { items };
}

// ------------------------------------------------------------------ list
export async function listConnections(ctx: Ctx, brandId: string): Promise<{ items: ConnectionJson[] }> {
  await assertBrand(ctx, brandId);
  const rows = await many<ConnectionRow>(getPool(),
    `SELECT * FROM connections WHERE workspace_id=$1 AND brand_id=$2 ORDER BY (disconnected_at IS NOT NULL), provider, created_at`,
    [ctx.access.workspaceId, brandId]);
  return { items: rows.map(toConnectionJson) };
}

/** All active connections the caller can see (e.g. for composer destination pickers). */
export async function listWorkspaceConnections(ctx: Ctx): Promise<ConnectionJson[]> {
  const f = brandFilter(ctx, 'brand_id', 2);
  const rows = await many<ConnectionRow>(getPool(),
    `SELECT * FROM connections WHERE workspace_id=$1 AND disconnected_at IS NULL AND ${f.sql} ORDER BY created_at`, [ctx.access.workspaceId, ...f.params]);
  return rows.map(toConnectionJson);
}

export async function getConnection(ctx: Ctx, id: string): Promise<ConnectionJson> {
  return toConnectionJson(await loadConnection(ctx, id));
}

// ------------------------------------------------------------------ Telegram (AC-03)
export const telegramConnectSchema = z.object({
  bot_token: z.string().trim().min(1, 'Paste the bot token from @BotFather').max(200),
  channel: z.string().trim().min(1, 'Enter the channel @username or numeric ID').max(200),
});

export async function connectTelegram(
  ctx: Ctx, brandId: string, body: unknown, opts: { reconnectConnectionId?: string | null } = {},
): Promise<ConnectionJson> {
  requireAction(ctx, 'connections.manage', 'Only owners and admins can connect accounts.');
  await assertBrand(ctx, brandId);
  const input = telegramConnectSchema.parse(body);
  let dest;
  try {
    // Verify bot identity, channel identity and posting rights BEFORE anything is stored (network, no tx).
    dest = await getTelegramConnector().verify(await setupContext('telegram'), { botToken: input.bot_token, channel: input.channel });
  } catch (err) {
    // Error classes are matched by name: they live in the provider package (no deep imports here).
    const e = err as Error & { code?: string; field?: string | null; status?: number };
    if (e.name === 'TelegramSetupError') {
      throw new AppError('validation_failed', e.message, e.field ? { [e.field]: e.message } : undefined, { code: e.code });
    }
    if (e.name === 'TelegramApiError' && e.status === 429) {
      throw new AppError('rate_limited', 'Telegram is rate limiting this bot. Wait a minute and try again.');
    }
    if (e.name === 'TelegramApiError' || err instanceof TransportError) {
      log.warn('telegram_verify_failed', { brandId, err: { name: e.name, message: e.message } });
      throw new AppError('provider_error', 'Could not verify the bot with Telegram right now. Try again in a minute.');
    }
    throw err;
  }
  const { row } = await withTx((tx) => upsertConnectionFromDestination(tx, {
    workspaceId: ctx.access.workspaceId, brandId, provider: 'telegram', actorUserId: ctx.actor.userId, correlationId: ctx.correlationId,
    dest, reconnectConnectionId: opts.reconnectConnectionId ?? null,
  })).catch((err) => {
    if ((err as { code?: string }).code === '23505') throw new AppError('conflict', 'This channel is already connected to this brand.');
    throw err;
  });
  return toConnectionJson(row);
}

// ------------------------------------------------------------------ simulated destinations
export const mockConnectSchema = z.object({
  provider: z.enum(PROVIDERS),
  display_name: z.string().trim().min(1).max(120),
  scenario: z.enum(MOCK_SCENARIOS as [MockScenario, ...MockScenario[]]).optional(),
});

function assertMockEnabled(): void {
  if (!mockProvidersEnabled()) throw new AppError('forbidden', 'Simulated destinations are disabled in this environment.');
}

export async function connectMock(ctx: Ctx, brandId: string, body: unknown): Promise<ConnectionJson> {
  requireAction(ctx, 'connections.manage', 'Only owners and admins can connect accounts.');
  assertMockEnabled();
  await assertBrand(ctx, brandId);
  const input = mockConnectSchema.parse(body);
  const accountId = `mock_${input.provider}_${randomBytes(6).toString('hex')}`;
  const caps = getAdapter(input.provider).capabilities({
    id: '00000000-0000-0000-0000-000000000000', provider: input.provider, providerAccountId: accountId, displayName: input.display_name,
    username: null, metadata: {}, isMock: true,
  });
  const scenario = input.scenario ?? 'success';
  const row = await withTx(async (tx) => {
    const credentialId = await insertCredential(tx, ctx.access.workspaceId, { kind: 'mock', token: randomBytes(24).toString('base64url') }, { expiresAt: null, scopes: [] });
    const r = await one<ConnectionRow>(tx,
      `INSERT INTO connections(workspace_id, brand_id, provider, provider_account_id, display_name, username, status, is_mock, credential_id,
                               capabilities, health_detail, health_checked_at, metadata, created_by)
       VALUES ($1,$2,$3,$4,$5,NULL,'ready',true,$6,$7,$8,now(),$9,$10) RETURNING *`,
      [ctx.access.workspaceId, brandId, input.provider, accountId, input.display_name, credentialId, JSON.stringify(caps),
        JSON.stringify({ message: `Simulated ${PROVIDER_NAME[input.provider]} destination. Nothing is sent to ${PROVIDER_NAME[input.provider]}.` }),
        JSON.stringify({ mock_scenario: scenario, simulated: true }), ctx.actor.userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId, actorUserId: ctx.actor.userId, action: 'connection.created', resourceType: 'connection',
      resourceId: r.id, diff: { provider: input.provider, is_mock: true, scenario }, correlationId: ctx.correlationId });
    return r;
  });
  return toConnectionJson(row);
}

export const mockScenarioSchema = z.object({ scenario: z.enum(MOCK_SCENARIOS as [MockScenario, ...MockScenario[]]) });

export async function setMockScenario(ctx: Ctx, id: string, body: unknown): Promise<ConnectionJson> {
  requireAction(ctx, 'connections.manage');
  assertMockEnabled();
  const { scenario } = mockScenarioSchema.parse(body);
  const row = await withTx(async (tx) => {
    const c = await loadConnection(ctx, id, tx, true);
    if (!c.is_mock) throw invalidState('Only simulated destinations have a scenario.');
    const r = await one<ConnectionRow>(tx,
      `UPDATE connections SET metadata = metadata || jsonb_build_object('mock_scenario', $2::text), updated_at=now() WHERE id=$1 RETURNING *`, [id, scenario]);
    await audit(tx, { workspaceId: c.workspace_id, brandId: c.brand_id, actorUserId: ctx.actor.userId, action: 'connection.mock_scenario_changed',
      resourceType: 'connection', resourceId: id, diff: { scenario }, correlationId: ctx.correlationId });
    return r;
  });
  return toConnectionJson(row);
}

// ------------------------------------------------------------------ health (AC-04)
interface HealthActor { userId?: string | null; service?: string | null; correlationId?: string | null }

/** Apply a health result; blocks or restores queued work on transitions. */
export async function applyHealth(connectionId: string, h: ConnectionHealth, actor: HealthActor): Promise<ConnectionRow | null> {
  return withTx(async (tx) => {
    const cur = await maybeOne<ConnectionRow>(tx, `SELECT * FROM connections WHERE id=$1 FOR UPDATE`, [connectionId]);
    if (!cur || cur.disconnected_at) return cur;
    const meta = { ...(h.metadata ?? {}) };
    const displayName = typeof meta.display_name === 'string' && meta.display_name ? meta.display_name : null;
    const username = typeof meta.username === 'string' && meta.username ? meta.username : null;
    delete meta.display_name;
    delete meta.username;
    const caps = getAdapter(cur.provider).capabilities(toPublishConnection(cur));
    const row = await one<ConnectionRow>(tx,
      `UPDATE connections SET status=$2, health_detail=$3, health_checked_at=$4, capabilities=$5, metadata = metadata || $6::jsonb,
              display_name=coalesce($7, display_name), username=coalesce($8, username), updated_at=now()
        WHERE id=$1 RETURNING *`,
      [connectionId, h.status, JSON.stringify(healthDetail(h)), h.checkedAt, JSON.stringify(caps), JSON.stringify(meta), displayName, username]);
    const was = DISPATCHABLE_CONNECTION_STATUSES.has(cur.status);
    const now = DISPATCHABLE_CONNECTION_STATUSES.has(row.status);
    if (!now) await blockDeliveriesForConnection(tx, connectionId, h.message);
    else if (!was) await onConnectionRestored(tx, connectionId);
    if (cur.status !== row.status) {
      await writeOutbox(tx, { workspaceId: cur.workspace_id, aggregateType: 'connection', aggregateId: connectionId, eventType: 'connection.health_changed',
        payload: { from: cur.status, to: row.status, wasDispatchable: was } });
      await audit(tx, { workspaceId: cur.workspace_id, brandId: cur.brand_id, actorUserId: actor.userId ?? null, actorService: actor.service ?? null,
        action: 'connection.health_changed', resourceType: 'connection', resourceId: connectionId, diff: { from: cur.status, to: row.status },
        correlationId: actor.correlationId ?? null });
    }
    return row;
  });
}

async function noteHealthUnavailable(connectionId: string, provider: Provider, message?: string): Promise<void> {
  await getPool().query(
    `UPDATE connections SET health_detail = health_detail || $2::jsonb, health_checked_at=now(), updated_at=now() WHERE id=$1 AND disconnected_at IS NULL`,
    [connectionId, JSON.stringify({ message: message ?? `Could not reach ${PROVIDER_NAME[provider]} to check this account; the previous status is kept. Try again shortly.` })]);
}

/** Run the provider health check for one connection (no authorization: callers authorize). */
export async function performHealthCheck(connectionId: string, actor: HealthActor): Promise<'checked' | 'unavailable'> {
  let usable;
  try {
    usable = await getUsableCredentials(connectionId);
  } catch (err) {
    if (err instanceof CredentialUnavailableError) {
      if (err.retryable) {
        const row = await maybeOne<{ provider: Provider }>(getPool(), `SELECT provider FROM connections WHERE id=$1`, [connectionId]);
        if (row) await noteHealthUnavailable(connectionId, row.provider, err.message);
        return 'unavailable';
      }
      return 'checked'; // status already updated (reconnect_required) or connection gone
    }
    throw err;
  }
  const { connection, credentials } = usable;
  const adapter = getAdapter(connection.provider);
  let h: ConnectionHealth;
  try {
    h = await adapter.health(await buildAdapterContext(connection.provider, connection), connection, credentials);
  } catch (err) {
    log.warn('connection_health_unavailable', { connectionId, provider: connection.provider, err: { name: (err as Error).name, message: (err as Error).message } });
    await noteHealthUnavailable(connectionId, connection.provider);
    return 'unavailable';
  }
  await applyHealth(connectionId, h, actor);
  return 'checked';
}

export async function checkConnection(ctx: Ctx, id: string): Promise<ConnectionJson> {
  requireAction(ctx, 'connections.manage');
  const c = await loadConnection(ctx, id);
  if (c.disconnected_at) throw invalidState('This account is disconnected. Reconnect it instead.');
  await performHealthCheck(c.id, { userId: ctx.actor.userId, correlationId: ctx.correlationId });
  return toConnectionJson(await loadConnection(ctx, id));
}

/**
 * Worker: check connections not checked in 6 hours, and non-refreshable tokens nearing expiry.
 * X is excluded from the expiry rule: its 2-hour access tokens rotate on demand, and every health
 * check is a billable X user read.
 */
export async function runHealthChecks(limit = 25): Promise<{ checked: number; unavailable: number; failed: number }> {
  const rows = await many<{ id: string }>(getPool(),
    `SELECT c.id FROM connections c LEFT JOIN credentials cr ON cr.id=c.credential_id AND cr.workspace_id=c.workspace_id
      WHERE c.disconnected_at IS NULL AND c.status <> 'disconnected'
        AND ( c.health_checked_at IS NULL OR c.health_checked_at < now() - interval '6 hours'
              OR (c.provider <> 'x' AND cr.expires_at IS NOT NULL AND cr.expires_at < now() + interval '7 days'
                  AND c.health_checked_at < now() - interval '1 hour') )
      ORDER BY c.health_checked_at NULLS FIRST LIMIT $1`, [limit]);
  let checked = 0; let unavailable = 0; let failed = 0;
  for (const r of rows) {
    try {
      const res = await performHealthCheck(r.id, { service: 'worker:health' });
      if (res === 'checked') checked++; else unavailable++;
    } catch (err) {
      failed++;
      log.error('connection_health_check_error', { connectionId: r.id, err: err as Error });
    }
  }
  return { checked, unavailable, failed };
}

// ------------------------------------------------------------------ pause / disconnect / reconnect
export const pauseSchema = z.object({ paused: z.boolean() });

export async function setConnectionPaused(ctx: Ctx, id: string, body: unknown): Promise<ConnectionJson> {
  requireAction(ctx, 'connections.manage');
  const { paused } = pauseSchema.parse(body);
  const row = await withTx(async (tx) => {
    const c = await loadConnection(ctx, id, tx, true);
    if (c.disconnected_at) throw invalidState('This account is disconnected.');
    if (c.paused === paused) return c;
    const r = await one<ConnectionRow>(tx, `UPDATE connections SET paused=$2, updated_at=now() WHERE id=$1 RETURNING *`, [id, paused]);
    const scope = { workspaceId: c.workspace_id, connectionId: c.id };
    const effect = paused ? { paused: await onScopePaused(tx, scope) } : await onScopeResumed(tx, scope);
    await audit(tx, { workspaceId: c.workspace_id, brandId: c.brand_id, actorUserId: ctx.actor.userId, action: paused ? 'connection.paused' : 'connection.resumed',
      resourceType: 'connection', resourceId: id, diff: effect, correlationId: ctx.correlationId });
    return r;
  });
  return toConnectionJson(row);
}

/** AC-05: stop dispatch, block queued work, delete the credential immediately (spec §14). */
export async function disconnectConnection(ctx: Ctx, id: string): Promise<{ connection: ConnectionJson; blocked_deliveries: number }> {
  requireAction(ctx, 'connections.manage', 'Only owners and admins can disconnect accounts.');
  // X: revoke the grant at the provider first (network call outside the transaction, best effort).
  let revoked: boolean | null = null;
  const pre = await loadConnection(ctx, id);
  if (pre.provider === 'x' && !pre.is_mock && !pre.disconnected_at) {
    const peek = await peekCredentials(id);
    if (peek) revoked = await revokeXToken(await buildAdapterContext('x', peek.connection), peek.credentials);
  }
  return withTx(async (tx) => {
    const c = await loadConnection(ctx, id, tx, true);
    if (c.disconnected_at) return { connection: toConnectionJson(c), blocked_deliveries: 0 };
    const r = await one<ConnectionRow>(tx,
      `UPDATE connections SET status='disconnected', disconnected_at=now(), credential_id=NULL, throttled_until=NULL,
              health_detail=$2, updated_at=now() WHERE id=$1 RETURNING *`,
      [id, JSON.stringify({ message: 'Disconnected. Stored credentials were deleted.' })]);
    if (c.credential_id) await tx.query(`DELETE FROM credentials WHERE id=$1 AND workspace_id=$2`, [c.credential_id, c.workspace_id]);
    const blocked = await blockDeliveriesForConnection(tx, id, 'Account disconnected');
    await writeOutbox(tx, { workspaceId: c.workspace_id, aggregateType: 'connection', aggregateId: id, eventType: 'connection.health_changed',
      payload: { from: c.status, to: 'disconnected', blockedDeliveries: blocked } });
    await audit(tx, { workspaceId: c.workspace_id, brandId: c.brand_id, actorUserId: ctx.actor.userId, action: 'connection.disconnected',
      resourceType: 'connection', resourceId: id, diff: { provider: c.provider, provider_account_id: c.provider_account_id, blocked_deliveries: blocked, provider_token_revoked: revoked },
      correlationId: ctx.correlationId });
    return { connection: toConnectionJson(r), blocked_deliveries: blocked };
  });
}

export const reconnectSchema = z.object({ bot_token: z.string().trim().min(1).max(200).optional() }).passthrough();

/**
 * Reconnect: OAuth providers => { authorization_url } (the flow updates the same identity, or creates a
 * new connection for a different identity); Telegram => re-verify with { bot_token }; simulated => fresh token.
 */
export async function reconnectConnection(ctx: Ctx, id: string, body: unknown): Promise<ConnectionJson | { authorization_url: string }> {
  requireAction(ctx, 'connections.manage', 'Only owners and admins can reconnect accounts.');
  const input = reconnectSchema.parse(body ?? {});
  const c = await loadConnection(ctx, id);
  if (c.is_mock) return reconnectMock(ctx, c);
  if (c.provider === 'telegram') {
    if (!input.bot_token) throw new AppError('validation_failed', 'Paste the bot token to reconnect.', { bot_token: 'Required' });
    return connectTelegram(ctx, c.brand_id, { bot_token: input.bot_token, channel: c.provider_account_id }, { reconnectConnectionId: c.id });
  }
  if (isOAuthProvider(c.provider)) return startOAuth(ctx, c.brand_id, c.provider, { reconnectConnectionId: c.id });
  throw invalidState('This account type cannot be reconnected.');
}

async function reconnectMock(ctx: Ctx, c: ConnectionRow): Promise<ConnectionJson> {
  assertMockEnabled();
  const row = await withTx(async (tx) => {
    const cur = await loadConnection(ctx, c.id, tx, true);
    if (cur.disconnected_at) {
      const dup = await maybeOne(tx, `SELECT 1 FROM connections WHERE brand_id=$1 AND provider=$2 AND provider_account_id=$3 AND disconnected_at IS NULL`,
        [cur.brand_id, cur.provider, cur.provider_account_id]);
      if (dup) throw new AppError('conflict', 'This simulated destination is already connected.');
    }
    const creds = { kind: 'mock' as const, token: randomBytes(24).toString('base64url') };
    let credentialId = cur.credential_id;
    if (credentialId) await replaceCredential(tx, cur.workspace_id, credentialId, creds, { expiresAt: null, scopes: [] });
    else credentialId = await insertCredential(tx, cur.workspace_id, creds, { expiresAt: null, scopes: [] });
    const r = await one<ConnectionRow>(tx,
      `UPDATE connections SET status='ready', credential_id=$2, disconnected_at=NULL, health_checked_at=now(), health_detail=$3, updated_at=now()
        WHERE id=$1 RETURNING *`,
      [cur.id, credentialId, JSON.stringify({ message: `Simulated ${PROVIDER_NAME[cur.provider]} destination reconnected.` })]);
    await onConnectionRestored(tx, cur.id);
    if (cur.status !== 'ready' || cur.disconnected_at) {
      await writeOutbox(tx, { workspaceId: cur.workspace_id, aggregateType: 'connection', aggregateId: cur.id, eventType: 'connection.health_changed',
        payload: { from: cur.disconnected_at ? 'disconnected' : cur.status, to: 'ready' } });
    }
    await audit(tx, { workspaceId: cur.workspace_id, brandId: cur.brand_id, actorUserId: ctx.actor.userId, action: 'connection.reconnected',
      resourceType: 'connection', resourceId: cur.id, diff: { is_mock: true }, correlationId: ctx.correlationId });
    return r;
  });
  return toConnectionJson(row);
}

export type { ConnectionStatus };
