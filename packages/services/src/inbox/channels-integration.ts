// V3.5 stream B — inbox channels backed by a business integration (integration_connections): WhatsApp (one channel per
// phone number) and Google Business Profile (one channel per selected location; the GBP connection itself, OAuth and
// location selection, belong to stream C's integration hub). Explicit opt-in per account; nothing is added by default.
// Simulated installations (mock_) expose simulated numbers/locations; real ones only what the provider/selection holds.
import { AppError } from '@social-lite/core';
import type { ChannelKind, InboxChannelJson } from '@social-lite/core/contracts/v35-inbox';
import { getInboxAdapter, INTEGRATION_CHANNEL } from '@social-lite/providers';
import { listWhatsAppNumbers } from '@social-lite/providers/whatsapp/inbox';
import { simulatedLocations } from '@social-lite/providers/google-business/inbox-fake';
import { isLocationName } from '@social-lite/providers/google-business/inbox';
import { getPool, many, maybeOne, one, withTx } from '@social-lite/db';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { brandAllowed, requireAction } from '../tenancy.js';
import { loadIntegration, type IntegrationRow } from '../connectors/store.js';
import { channelRuntime } from './channels-runtime.js';
import { toChannelJson } from './channels.js';
import type { ChannelRow } from './shared.js';

export interface IntegrationAccount { account_id: string; name: string; enabled_channel_id: string | null }

/** Channel status for an integration-backed channel (pure inputs; used on enable and by the health sweep). */
export function evaluateIntegration(i: IntegrationRow, kind: ChannelKind): { status: ChannelRow['status']; detail: string | null; missing: string[] } {
  if (i.disconnected_at || i.status === 'disconnected') return { status: 'disconnected', detail: 'The integration was disconnected.', missing: [] };
  if (i.status === 'reconnect_required') return { status: 'error', detail: i.health_message ?? 'Reconnect the integration.', missing: [] };
  const adapter = getInboxAdapter(kind)!;
  const missing = adapter.missingPermissions(i.granted_scopes, { id: i.id, provider: 'facebook', providerAccountId: i.external_account_id, displayName: i.display_name, metadata: {}, isMock: i.is_simulated });
  if (missing.length) return { status: 'needs_permission', detail: 'Grant the missing permissions and reconnect.', missing };
  if (i.paused) return { status: 'paused', detail: 'The integration is paused.', missing: [] };
  return { status: 'active', detail: null, missing: [] };
}

/** A transient row used to reach the provider before the channel exists (lists numbers). */
function probeRow(i: IntegrationRow, kind: ChannelKind): ChannelRow {
  return { id: '00000000-0000-0000-0000-000000000000', workspace_id: i.workspace_id, brand_id: i.brand_id ?? '00000000-0000-0000-0000-000000000000', kind, connection_id: null, integration_id: i.id, external_account_id: '', display_name: i.display_name, is_simulated: i.is_simulated, status: 'active', status_detail: null, missing_permissions: [], enabled_types: ['dm'], last_inbound_at: null, last_sync_at: null, created_by: null, created_at: new Date(), updated_at: new Date(), disconnected_at: null, settings: {} };
}

export async function integrationAccounts(ctx: Ctx, integrationId: string): Promise<{ kind: ChannelKind; items: IntegrationAccount[] }> {
  const i = await loadIntegration(ctx, integrationId, 'integrations.read');
  requireAction(ctx, 'inbox.manage', i.brand_id ? { brandId: i.brand_id } : undefined);
  const kind = INTEGRATION_CHANNEL[i.connector];
  if (!kind) throw new AppError('validation_failed', 'This integration has no inbox channel.');
  let accounts: Array<{ id: string; name: string }> = [];
  if (kind === 'whatsapp') {
    const rt = await channelRuntime(probeRow(i, kind));
    const r = await listWhatsAppNumbers(rt.ctx, rt.creds, i.external_account_id);
    if (!r.ok) throw new AppError('provider_error', r.message);
    accounts = r.items.map((x) => ({ id: x.id, name: x.name ? `${x.name} · ${x.display}` : x.display }));
  } else {
    // Locations come from the integration's explicit resource selection (stream C); simulated installations have two.
    accounts = i.is_simulated ? simulatedLocations(i.external_account_id).map((l) => ({ id: l.name, name: l.title }))
      : (await many<{ external_id: string; name: string }>(getPool(), `SELECT external_id, name FROM integration_resources WHERE integration_id=$1 AND resource_type='location' AND selected AND access_state='ok' ORDER BY name LIMIT 200`, [i.id])).filter((r) => isLocationName(r.external_id)).map((r) => ({ id: r.external_id, name: r.name }));
  }
  const enabled = await many<{ id: string; external_account_id: string }>(getPool(), `SELECT id, external_account_id FROM inbox_channels WHERE workspace_id=$1 AND kind=$2 AND integration_id=$3 AND disconnected_at IS NULL`, [ctx.access.workspaceId, kind, i.id]);
  const map = new Map(enabled.map((e) => [e.external_account_id, e.id]));
  return { kind, items: accounts.map((a) => ({ account_id: a.id, name: a.name, enabled_channel_id: map.get(a.id) ?? null })) };
}

export const enableIntegrationChannelSchema = z.object({
  integration_id: z.string().uuid(),
  account_id: z.string().min(3).max(200),
  /** Required when the integration is workspace-wide (inbox channels always belong to one brand). */
  brand_id: z.string().uuid().optional(),
}).strict();

export async function enableIntegrationChannel(ctx: Ctx, input: z.infer<typeof enableIntegrationChannelSchema>): Promise<InboxChannelJson> {
  const i = await loadIntegration(ctx, input.integration_id, 'integrations.read');
  const brandId = i.brand_id ?? input.brand_id;
  if (!brandId) throw new AppError('validation_failed', 'Choose the brand this channel belongs to.', { brand_id: 'Required' });
  if (i.brand_id && input.brand_id && input.brand_id !== i.brand_id) throw new AppError('validation_failed', 'This integration belongs to another brand.');
  if (!brandAllowed(ctx, brandId)) throw new AppError('not_found', 'Brand not found');
  requireAction(ctx, 'inbox.manage', { brandId });
  const accounts = await integrationAccounts(ctx, i.id);
  const acc = accounts.items.find((a) => a.account_id === input.account_id);
  if (!acc) throw new AppError('validation_failed', 'That account is not available on this integration.', { account_id: 'Not available' });
  const kind = accounts.kind;
  const ev = evaluateIntegration(i, kind);
  if (ev.status === 'disconnected') throw new AppError('invalid_state', 'Reconnect the integration first.');
  const types = kind === 'whatsapp' ? ['dm'] : ['review'];
  return withTx(async (tx) => {
    const existing = await maybeOne<ChannelRow>(tx, `SELECT * FROM inbox_channels WHERE workspace_id=$1 AND kind=$2 AND external_account_id=$3 AND disconnected_at IS NULL FOR UPDATE`, [ctx.access.workspaceId, kind, acc.account_id]);
    if (existing && existing.integration_id !== i.id) throw new AppError('conflict', 'This account is already in the inbox through another installation.');
    const row = existing
      ? await one<ChannelRow>(tx, `UPDATE inbox_channels SET brand_id=$2, display_name=$3, status=$4, status_detail=$5, missing_permissions=$6, updated_at=now() WHERE id=$1 RETURNING *`, [existing.id, brandId, acc.name, ev.status, ev.detail, ev.missing])
      : await one<ChannelRow>(tx,
        `INSERT INTO inbox_channels(workspace_id, brand_id, kind, integration_id, external_account_id, display_name, is_simulated, status, status_detail, missing_permissions, enabled_types, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [ctx.access.workspaceId, brandId, kind, i.id, acc.account_id, acc.name, i.is_simulated, ev.status, ev.detail, ev.missing, types, ctx.actor.userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId, actorUserId: ctx.actor.userId, action: 'inbox.channel_enabled', resourceType: 'inbox_channel', resourceId: row.id, diff: { kind, integration_id: i.id, status: row.status }, correlationId: ctx.correlationId });
    return toChannelJson(row);
  });
}

/** Worker sweep: integration-backed channels follow their installation (revoked, paused, permissions). */
export async function refreshIntegrationChannels(limit = 100): Promise<number> {
  const rows = await many<ChannelRow & { i: IntegrationRow }>(getPool(),
    `SELECT ch.*, to_jsonb(i.*) AS i FROM inbox_channels ch JOIN integration_connections i ON i.id=ch.integration_id
      WHERE ch.disconnected_at IS NULL AND ch.status <> 'paused' AND i.updated_at > ch.updated_at LIMIT $1`, [limit]);
  for (const r of rows) {
    const i = { ...r.i, disconnected_at: r.i.disconnected_at ? new Date(r.i.disconnected_at as unknown as string) : null } as IntegrationRow;
    const ev = evaluateIntegration(i, r.kind);
    await getPool().query(`UPDATE inbox_channels SET status=$2, status_detail=$3, missing_permissions=$4, updated_at=now() WHERE id=$1`, [r.id, ev.status, ev.detail, ev.missing]);
  }
  return rows.length;
}
