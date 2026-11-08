// Inbox channels: an explicit opt-in per connected account ("Use this Page in the inbox"). Publishing access never
// implies messaging access: permissions are re-evaluated from the stored grant and missing ones are shown, never assumed.
// Simulated (mock_) connections become simulated channels; real connections always use the live transport.
import { AppError, notFound } from '@social-lite/core';
import type { ConversationKind, InboxChannelJson } from '@social-lite/core/contracts/v35-inbox';
import { getInboxAdapter, PROVIDER_CHANNEL } from '@social-lite/providers';
import { getPool, many, maybeOne, one, withTx } from '@social-lite/db';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { loadConnection, toPublishConnection, type ConnectionStoreRow } from '../connections/index.js';
import { assertUuid, authorizeCtx, brandAllowed, requireAction } from '../tenancy.js';
import { CHANNEL_CAPABILITIES } from './capabilities.js';
import { iso, type ChannelRow } from './shared.js';

export function toChannelJson(r: ChannelRow): InboxChannelJson {
  return {
    id: r.id, brand_id: r.brand_id, kind: r.kind, connection_id: r.connection_id, integration_id: r.integration_id, external_account_id: r.external_account_id,
    display_name: r.display_name, is_simulated: r.is_simulated, status: r.disconnected_at ? 'disconnected' : r.status, status_detail: r.status_detail,
    missing_permissions: r.missing_permissions, enabled_types: r.enabled_types, capability: CHANNEL_CAPABILITIES[r.kind],
    last_inbound_at: iso(r.last_inbound_at), last_sync_at: iso(r.last_sync_at),
  };
}

async function grantedScopes(conn: ConnectionStoreRow): Promise<string[] | null> {
  if (!conn.credential_id) return null;
  const r = await maybeOne<{ granted_scopes: string[] | null }>(getPool(), `SELECT granted_scopes FROM credentials WHERE id=$1 AND workspace_id=$2`, [conn.credential_id, conn.workspace_id]);
  return r?.granted_scopes ?? null;
}

/** Channel status from the connection + adapter permissions (pure inputs; used on enable and by the health sweep). */
export async function evaluateChannel(conn: ConnectionStoreRow): Promise<{ status: ChannelRow['status']; detail: string | null; missing: string[] }> {
  const kind = PROVIDER_CHANNEL[conn.provider];
  const adapter = kind ? getInboxAdapter(kind) : null;
  if (!adapter) return { status: 'error', detail: 'This network has no inbox support in Relay yet.', missing: [] };
  if (conn.disconnected_at || conn.status === 'disconnected') return { status: 'disconnected', detail: 'The account was disconnected.', missing: [] };
  if (conn.status === 'reconnect_required') return { status: 'error', detail: 'Reconnect the account to receive and send messages.', missing: [] };
  const missing = adapter.missingPermissions(await grantedScopes(conn), toPublishConnection(conn));
  if (missing.length) return { status: 'needs_permission', detail: 'Reconnect and grant the messaging permissions.', missing };
  return { status: 'active', detail: null, missing: [] };
}

export const enableChannelSchema = z.object({
  connection_id: z.string().uuid(),
  enabled_types: z.array(z.enum(['dm', 'comment', 'mention', 'review'])).min(1).max(4).optional(),
}).strict();

export async function enableChannel(ctx: Ctx, input: z.infer<typeof enableChannelSchema>): Promise<InboxChannelJson> {
  const conn = await loadConnection(ctx, input.connection_id);
  requireAction(ctx, 'inbox.manage', { brandId: conn.brand_id });
  const kind = PROVIDER_CHANNEL[conn.provider];
  if (!kind || !getInboxAdapter(kind)) throw new AppError('invalid_state', 'This network has no inbox support in Relay yet.');
  const ev = await evaluateChannel(conn);
  if (ev.status === 'disconnected') throw new AppError('invalid_state', 'Reconnect the account first.');
  const supported = Object.entries(CHANNEL_CAPABILITIES[kind].conversationTypes).filter(([, v]) => v && v.read !== 'not_available' && v.read !== 'not_implemented').map(([k]) => k as ConversationKind);
  const types = (input.enabled_types ?? supported).filter((t) => supported.includes(t));
  if (!types.length) throw new AppError('validation_failed', 'Choose at least one supported conversation type.');
  return withTx(async (tx) => {
    const existing = await maybeOne<ChannelRow>(tx, `SELECT * FROM inbox_channels WHERE workspace_id=$1 AND kind=$2 AND external_account_id=$3 AND disconnected_at IS NULL FOR UPDATE`,
      [ctx.access.workspaceId, kind, conn.provider_account_id]);
    const row = existing
      ? await one<ChannelRow>(tx, `UPDATE inbox_channels SET connection_id=$2, brand_id=$3, display_name=$4, status=$5, status_detail=$6, missing_permissions=$7, enabled_types=$8, updated_at=now() WHERE id=$1 RETURNING *`,
        [existing.id, conn.id, conn.brand_id, conn.display_name, ev.status, ev.detail, ev.missing, types])
      : await one<ChannelRow>(tx,
        `INSERT INTO inbox_channels(workspace_id, brand_id, kind, connection_id, external_account_id, display_name, is_simulated, status, status_detail, missing_permissions, enabled_types, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [ctx.access.workspaceId, conn.brand_id, kind, conn.id, conn.provider_account_id, conn.display_name, conn.is_mock, ev.status, ev.detail, ev.missing, types, ctx.actor.userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: conn.brand_id, actorUserId: ctx.actor.userId, action: 'inbox.channel_enabled', resourceType: 'inbox_channel', resourceId: row.id, diff: { kind, status: row.status, types }, correlationId: ctx.correlationId });
    return toChannelJson(row);
  });
}

export async function listChannels(ctx: Ctx): Promise<{ items: InboxChannelJson[] }> {
  requireAction(ctx, 'inbox.read');
  const rows = await many<ChannelRow>(getPool(), `SELECT * FROM inbox_channels WHERE workspace_id=$1 AND disconnected_at IS NULL ORDER BY created_at`, [ctx.access.workspaceId]);
  return { items: rows.filter((r) => brandAllowed(ctx, r.brand_id) && authorizeCtx(ctx, 'inbox.read', { brandId: r.brand_id }).allowed).map(toChannelJson) };
}

async function loadChannelFor(ctx: Ctx, id: string, perm: 'inbox.read' | 'inbox.manage', forUpdate = false, db = getPool() as Parameters<typeof maybeOne>[0]): Promise<ChannelRow> {
  assertUuid(id, 'Channel');
  const r = await maybeOne<ChannelRow>(db, `SELECT * FROM inbox_channels WHERE id=$1 AND workspace_id=$2${forUpdate ? ' FOR UPDATE' : ''}`, [id, ctx.access.workspaceId]);
  if (!r || !brandAllowed(ctx, r.brand_id) || !authorizeCtx(ctx, 'inbox.read', { brandId: r.brand_id }).allowed) throw notFound('Channel');
  requireAction(ctx, perm, { brandId: r.brand_id });
  return r;
}
export { loadChannelFor };

export async function setChannelPaused(ctx: Ctx, id: string, paused: boolean): Promise<InboxChannelJson> {
  return withTx(async (tx) => {
    const r = await loadChannelFor(ctx, id, 'inbox.manage', true, tx);
    if (r.disconnected_at) throw new AppError('invalid_state', 'This channel was removed.');
    let status: ChannelRow['status'] = 'paused';
    let detail: string | null = 'Paused. New messages are still stored; replies are held.';
    let missing = r.missing_permissions;
    if (!paused) {
      const conn = r.connection_id ? await maybeOne<ConnectionStoreRow>(tx, `SELECT * FROM connections WHERE id=$1`, [r.connection_id]) : null;
      const ev = conn ? await evaluateChannel(conn) : { status: 'error' as const, detail: 'The account is no longer connected.', missing: [] };
      status = ev.status; detail = ev.detail; missing = ev.missing;
    }
    const row = await one<ChannelRow>(tx, `UPDATE inbox_channels SET status=$2, status_detail=$3, missing_permissions=$4, updated_at=now() WHERE id=$1 RETURNING *`, [id, status, detail, missing]);
    await audit(tx, { workspaceId: r.workspace_id, brandId: r.brand_id, actorUserId: ctx.actor.userId, action: paused ? 'inbox.channel_paused' : 'inbox.channel_resumed', resourceType: 'inbox_channel', resourceId: id, correlationId: ctx.correlationId });
    return toChannelJson(row);
  });
}

/** Remove a channel from the inbox. Conversations and history are kept (read-only); no new messages are routed to it. */
export async function removeChannel(ctx: Ctx, id: string): Promise<void> {
  await withTx(async (tx) => {
    const r = await loadChannelFor(ctx, id, 'inbox.manage', true, tx);
    await tx.query(`UPDATE inbox_channels SET disconnected_at=now(), status='disconnected', updated_at=now() WHERE id=$1`, [id]);
    await tx.query(`UPDATE inbox_reply_attempts SET state='cancelled', error_code='channel_removed', error_message='The channel was removed before sending.', finished_at=now(), updated_at=now() WHERE channel_id=$1 AND state='queued'`, [id]);
    await audit(tx, { workspaceId: r.workspace_id, brandId: r.brand_id, actorUserId: ctx.actor.userId, action: 'inbox.channel_removed', resourceType: 'inbox_channel', resourceId: id, correlationId: ctx.correlationId });
  });
}

/** Worker sweep: re-evaluate channels whose connection changed (reconnect required, disconnected, permissions). */
export async function refreshChannelHealth(limit = 100): Promise<number> {
  const rows = await many<ChannelRow & { conn: ConnectionStoreRow | null }>(getPool(),
    `SELECT ch.*, to_jsonb(c.*) AS conn FROM inbox_channels ch LEFT JOIN connections c ON c.id=ch.connection_id
      WHERE ch.disconnected_at IS NULL AND ch.status <> 'paused' AND ch.connection_id IS NOT NULL AND (c.updated_at > ch.updated_at OR c.id IS NULL) LIMIT $1`, [limit]);
  let n = 0;
  for (const r of rows) {
    const conn = r.conn ? { ...r.conn, disconnected_at: r.conn.disconnected_at ? new Date(r.conn.disconnected_at as unknown as string) : null } as ConnectionStoreRow : null;
    const ev = conn ? await evaluateChannel(conn) : { status: 'error' as const, detail: 'The account is no longer connected.', missing: [] };
    await getPool().query(`UPDATE inbox_channels SET status=$2, status_detail=$3, missing_permissions=$4, updated_at=now() WHERE id=$1`, [r.id, ev.status, ev.detail, ev.missing]);
    n++;
  }
  return n;
}
