// V3.5 integration installations (integration_connections, migration 028). Credentials live in the existing
// envelope-encrypted `credentials` vault (connections/store.ts insertCredential/replaceCredential) and never leave the
// server. Scope = workspace (brand_id NULL) or one brand. Resources are explicitly selected; nothing is imported by
// default. Disconnect/revocation preserves Relay records and marks external links unavailable (brief §3–4).
import { AppError, notFound, type ProviderCredentials } from '@social-lite/core';
import {
  PROTECTED_RELAY_FIELDS, type ConnectorKey, type ExternalLinkJson, type FieldMapping, type IntegrationActivityJson, type IntegrationConnectionJson,
  type IntegrationHealthJson, type IntegrationResourceJson, type IntegrationStatus, type RateLimitObservation, type RelayObjectType,
} from '@social-lite/core/contracts/v35-connectors';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { config, mockProvidersEnabled } from '../config.js';
import { assertUuid, brandAllowed, requireAction } from '../tenancy.js';
import { insertCredential, replaceCredential } from '../connections/store.js';
import { CONNECTORS, isConnectorKey } from './registry.js';

export interface IntegrationRow {
  id: string; workspace_id: string; brand_id: string | null; connector: ConnectorKey; external_account_id: string; display_name: string;
  status: IntegrationStatus; is_simulated: boolean; credential_id: string | null; granted_scopes: string[]; missing_scopes: string[];
  settings: Record<string, unknown>; health_message: string | null; health_checked_at: Date | null; last_success_at: Date | null;
  last_error_at: Date | null; last_error_code: string | null; rate_limit: RateLimitObservation | null; paused: boolean; paused_reason: string | null;
  created_by: string | null; created_at: Date; updated_at: Date; disconnected_at: Date | null;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function toIntegrationJson(r: IntegrationRow): IntegrationConnectionJson {
  const status: IntegrationStatus = r.disconnected_at ? 'disconnected' : r.paused ? 'paused' : r.status;
  return {
    id: r.id, connector: r.connector, brand_id: r.brand_id, external_account_id: r.external_account_id, display_name: r.display_name, status,
    is_simulated: r.is_simulated, granted_scopes: r.granted_scopes, missing_scopes: r.missing_scopes, paused: r.paused, paused_reason: r.paused_reason,
    health: { message: r.health_message ?? '', checked_at: iso(r.health_checked_at) }, last_success_at: iso(r.last_success_at),
    last_error: r.last_error_at ? { at: r.last_error_at.toISOString(), code: r.last_error_code } : null, rate_limit: r.rate_limit,
    created_at: r.created_at.toISOString(), disconnected_at: iso(r.disconnected_at),
  };
}

function scopeAllowed(ctx: Ctx, r: { brand_id: string | null }): boolean {
  return r.brand_id === null ? true : brandAllowed(ctx, r.brand_id);
}

/** Load an installation in the caller's workspace + scope, checking `perm` on its brand (or workspace). */
export async function loadIntegration(ctx: Ctx, id: string, perm: 'integrations.read' | 'integrations.manage', db: Queryable = getPool(), forUpdate = false): Promise<IntegrationRow> {
  assertUuid(id, 'Integration');
  const r = await maybeOne<IntegrationRow>(db, `SELECT * FROM integration_connections WHERE id=$1 AND workspace_id=$2${forUpdate ? ' FOR UPDATE' : ''}`, [id, ctx.access.workspaceId]);
  if (!r || !scopeAllowed(ctx, r)) throw notFound('Integration');
  requireAction(ctx, perm, r.brand_id ? { brandId: r.brand_id } : undefined);
  return r;
}

export async function listIntegrations(ctx: Ctx, q: { connector?: string | null } = {}): Promise<{ items: IntegrationConnectionJson[] }> {
  requireAction(ctx, 'integrations.read');
  const rows = await many<IntegrationRow>(getPool(),
    `SELECT * FROM integration_connections WHERE workspace_id=$1 AND ($2::text IS NULL OR connector=$2) ORDER BY disconnected_at NULLS FIRST, created_at DESC LIMIT 200`,
    [ctx.access.workspaceId, q.connector ?? null]);
  return { items: rows.filter((r) => scopeAllowed(ctx, r)).map(toIntegrationJson) };
}

// ------------------------------------------------------------------ connect (used by stream C OAuth callbacks)
export interface UpsertIntegrationArgs {
  workspaceId: string; brandId: string | null; connector: ConnectorKey; actorUserId: string | null; correlationId: string;
  externalAccountId: string; displayName: string; credentials: ProviderCredentials; grantedScopes: string[]; expiresAt: string | null;
  /** Health from a verification call made BEFORE this transaction (never "active" just because a token was saved). */
  health: { status: IntegrationStatus; message: string };
  settings?: Record<string, unknown>;
  reconnectId?: string | null;
}

/** Create or update an installation for a verified identity. MUST run inside a transaction. */
export async function upsertIntegrationConnection(tx: Queryable, a: UpsertIntegrationArgs): Promise<{ row: IntegrationRow; created: boolean }> {
  const missing = CONNECTORS[a.connector].scopes.filter((s) => !a.grantedScopes.includes(s));
  const credMeta = { expiresAt: a.expiresAt, scopes: a.grantedScopes };
  const existing = await maybeOne<IntegrationRow>(tx,
    `SELECT * FROM integration_connections WHERE workspace_id=$1 AND connector=$2 AND external_account_id=$3
        AND brand_id IS NOT DISTINCT FROM $4 AND (disconnected_at IS NULL OR id=$5) ORDER BY disconnected_at NULLS FIRST LIMIT 1 FOR UPDATE`,
    [a.workspaceId, a.connector, a.externalAccountId, a.brandId, a.reconnectId ?? null]);
  if (existing) {
    let credentialId = existing.credential_id;
    if (credentialId) await replaceCredential(tx, a.workspaceId, credentialId, a.credentials, credMeta);
    else credentialId = await insertCredential(tx, a.workspaceId, a.credentials, credMeta);
    const row = await one<IntegrationRow>(tx,
      `UPDATE integration_connections SET display_name=$2, status=$3, credential_id=$4, granted_scopes=$5, missing_scopes=$6, health_message=$7, health_checked_at=now(),
              settings = settings || $8::jsonb, disconnected_at=NULL, updated_at=now() WHERE id=$1 RETURNING *`,
      [existing.id, a.displayName, a.health.status, credentialId, a.grantedScopes, missing, a.health.message, JSON.stringify(a.settings ?? {})]);
    await tx.query(`UPDATE external_links SET status='linked', status_detail=NULL, updated_at=now() WHERE integration_id=$1 AND status='unavailable' AND status_detail='Access was revoked.'`, [row.id]);
    await audit(tx, { workspaceId: a.workspaceId, brandId: a.brandId, actorUserId: a.actorUserId, action: 'integration.reconnected', resourceType: 'integration', resourceId: row.id, diff: { connector: a.connector, status: row.status }, correlationId: a.correlationId });
    return { row, created: false };
  }
  const credentialId = await insertCredential(tx, a.workspaceId, a.credentials, credMeta);
  const row = await one<IntegrationRow>(tx,
    `INSERT INTO integration_connections(workspace_id, brand_id, connector, external_account_id, display_name, status, credential_id, granted_scopes, missing_scopes,
                                         health_message, health_checked_at, settings, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11,$12) RETURNING *`,
    [a.workspaceId, a.brandId, a.connector, a.externalAccountId, a.displayName, a.health.status, credentialId, a.grantedScopes, missing, a.health.message,
      JSON.stringify(a.settings ?? {}), a.actorUserId]);
  await audit(tx, { workspaceId: a.workspaceId, brandId: a.brandId, actorUserId: a.actorUserId, action: 'integration.connected', resourceType: 'integration', resourceId: row.id, diff: { connector: a.connector, status: row.status }, correlationId: a.correlationId });
  return { row, created: true };
}

export const simulatedIntegrationSchema = z.object({ connector: z.string().refine(isConnectorKey, 'Unknown connector'), brand_id: z.string().uuid().nullable().optional(), display_name: z.string().min(1).max(120).optional() }).strict();

/** Simulated installation (mock providers only; never in production). Labelled simulated everywhere. */
export async function createSimulatedIntegration(ctx: Ctx, input: z.infer<typeof simulatedIntegrationSchema>): Promise<IntegrationConnectionJson> {
  if (config().APP_ENV === 'production' || !mockProvidersEnabled()) throw new AppError('forbidden', 'Simulated integrations are disabled in this environment.');
  const connector = input.connector as ConnectorKey;
  requireAction(ctx, 'integrations.manage', input.brand_id ? { brandId: input.brand_id } : undefined);
  const row = await withTx(async (tx) => (await upsertIntegrationConnection(tx, {
    workspaceId: ctx.access.workspaceId, brandId: input.brand_id ?? null, connector, actorUserId: ctx.actor.userId, correlationId: ctx.correlationId,
    externalAccountId: `mock_${connector}_${ctx.access.workspaceId.slice(0, 8)}${input.brand_id ? `_${input.brand_id.slice(0, 8)}` : ''}`,
    displayName: input.display_name ?? `${CONNECTORS[connector].name} (simulated)`, credentials: { kind: 'mock', token: 'mock' },
    grantedScopes: [...CONNECTORS[connector].scopes], expiresAt: null, health: { status: 'active', message: 'Simulated connection.' },
  })).row);
  await getPool().query(`UPDATE integration_connections SET is_simulated=true WHERE id=$1`, [row.id]);
  return toIntegrationJson({ ...row, is_simulated: true });
}

// ------------------------------------------------------------------ pause / resume / disconnect
export async function setIntegrationPaused(ctx: Ctx, id: string, paused: boolean, reason?: string | null): Promise<IntegrationConnectionJson> {
  return withTx(async (tx) => {
    const r = await loadIntegration(ctx, id, 'integrations.manage', tx, true);
    if (r.disconnected_at) throw new AppError('invalid_state', 'This integration is disconnected.');
    const row = await one<IntegrationRow>(tx, `UPDATE integration_connections SET paused=$2, paused_reason=$3, updated_at=now() WHERE id=$1 RETURNING *`, [id, paused, paused ? (reason ?? null) : null]);
    await audit(tx, { workspaceId: r.workspace_id, brandId: r.brand_id, actorUserId: ctx.actor.userId, action: paused ? 'integration.paused' : 'integration.resumed', resourceType: 'integration', resourceId: id, correlationId: ctx.correlationId });
    return toIntegrationJson(row);
  });
}

/**
 * Disconnect: credentials deleted, queued jobs cancelled, links marked unavailable (Relay records are kept). Same path
 * runs when the provider reports revocation (`revokedByProvider`).
 */
export async function disconnectIntegration(ctx: Ctx | null, id: string, opts: { revokedByProvider?: boolean; workspaceId?: string } = {}): Promise<void> {
  await withTx(async (tx) => {
    const r = ctx ? await loadIntegration(ctx, id, 'integrations.manage', tx, true)
      : await one<IntegrationRow>(tx, `SELECT * FROM integration_connections WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [id, opts.workspaceId]);
    if (r.disconnected_at) return;
    await tx.query(`UPDATE integration_connections SET status=$2, disconnected_at=CASE WHEN $3 THEN now() ELSE disconnected_at END, credential_id=NULL, updated_at=now(),
                     health_message=$4 WHERE id=$1`,
      [id, opts.revokedByProvider ? 'reconnect_required' : 'disconnected', !opts.revokedByProvider, opts.revokedByProvider ? 'Access was revoked at the provider. Reconnect to resume.' : 'Disconnected.']);
    if (r.credential_id) await tx.query(`DELETE FROM credentials WHERE id=$1 AND workspace_id=$2`, [r.credential_id, r.workspace_id]);
    await tx.query(`UPDATE integration_sync_jobs SET state='cancelled', last_error_code='integration_disconnected', finished_at=now(), updated_at=now()
                     WHERE integration_id=$1 AND state IN ('queued','waiting_retry')`, [id]);
    await tx.query(`UPDATE external_links SET status='unavailable', status_detail='Access was revoked.', updated_at=now() WHERE integration_id=$1 AND status='linked'`, [id]);
    await audit(tx, { workspaceId: r.workspace_id, brandId: r.brand_id, actorUserId: ctx?.actor.userId ?? null, actorService: ctx ? null : 'integrations',
      action: opts.revokedByProvider ? 'integration.revoked' : 'integration.disconnected', resourceType: 'integration', resourceId: id, correlationId: ctx?.correlationId ?? null });
  });
}

// ------------------------------------------------------------------ resources (explicit selection)
export const resourceSelectionSchema = z.object({
  resources: z.array(z.object({ resource_type: z.string().min(1).max(40), external_id: z.string().min(1).max(200), name: z.string().min(1).max(200), url: z.string().url().max(500).nullable().optional(), selected: z.boolean() })).max(200),
}).strict();

export async function selectResources(ctx: Ctx, id: string, input: z.infer<typeof resourceSelectionSchema>): Promise<{ items: IntegrationResourceJson[] }> {
  await withTx(async (tx) => {
    const r = await loadIntegration(ctx, id, 'integrations.manage', tx, true);
    const allowed = new Set(CONNECTORS[r.connector].resourceTypes);
    for (const x of input.resources) {
      if (!allowed.has(x.resource_type)) throw new AppError('validation_failed', `${CONNECTORS[r.connector].name} has no resource type "${x.resource_type}".`);
      await tx.query(
        `INSERT INTO integration_resources(workspace_id, integration_id, resource_type, external_id, name, url, selected, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (integration_id, resource_type, external_id) DO UPDATE SET name=EXCLUDED.name, url=EXCLUDED.url, selected=EXCLUDED.selected, updated_at=now()`,
        [r.workspace_id, id, x.resource_type, x.external_id, x.name, x.url ?? null, x.selected, ctx.actor.userId]);
    }
    await audit(tx, { workspaceId: r.workspace_id, brandId: r.brand_id, actorUserId: ctx.actor.userId, action: 'integration.resources_selected', resourceType: 'integration', resourceId: id, diff: { count: input.resources.length }, correlationId: ctx.correlationId });
  });
  return listResources(ctx, id);
}

export async function listResources(ctx: Ctx, id: string): Promise<{ items: IntegrationResourceJson[] }> {
  await loadIntegration(ctx, id, 'integrations.read');
  const rows = await many<{ id: string; integration_id: string; resource_type: string; external_id: string; name: string; url: string | null; selected: boolean; access_state: 'ok' | 'unavailable' }>(getPool(),
    `SELECT id, integration_id, resource_type, external_id, name, url, selected, access_state FROM integration_resources WHERE integration_id=$1 ORDER BY resource_type, name LIMIT 500`, [id]);
  return { items: rows };
}

// ------------------------------------------------------------------ field mappings (synchronization contract)
export const fieldMappingSchema = z.object({
  resource_id: z.string().uuid().nullable().optional(), relay_object: z.string().min(1).max(40), relay_field: z.string().min(1).max(60), external_field: z.string().min(1).max(120),
  source_of_truth: z.enum(['relay', 'external']), direction: z.enum(['relay_to_external', 'external_to_relay', 'two_way']),
  conflict: z.enum(['source_wins', 'manual_review', 'skip']).default('manual_review'), on_delete: z.enum(['unlink', 'mark_unavailable', 'archive_relay', 'ignore']).default('mark_unavailable'),
  on_revoke: z.enum(['mark_unavailable', 'pause']).default('mark_unavailable'), enabled: z.boolean().default(true),
}).strict();

export function isProtectedField(field: string): boolean {
  return (PROTECTED_RELAY_FIELDS as readonly string[]).includes(field);
}

export async function setFieldMapping(ctx: Ctx, id: string, input: z.infer<typeof fieldMappingSchema>): Promise<FieldMapping> {
  const prot = isProtectedField(input.relay_field);
  if (prot && input.direction === 'two_way') throw new AppError('validation_failed', `"${input.relay_field}" is protected and cannot sync two-way.`, { direction: 'Choose one direction.' });
  if (prot && input.direction !== 'relay_to_external') throw new AppError('validation_failed', `"${input.relay_field}" is owned by Relay. External changes never update it.`, { direction: 'Use Relay → external.' });
  if (input.direction === 'two_way' && input.conflict === 'source_wins' && input.source_of_truth === 'external') {
    // allowed, but explicit: the source of truth decides; never last-write-wins
  }
  return withTx(async (tx) => {
    const r = await loadIntegration(ctx, id, 'integrations.manage', tx, true);
    const row = await one<FieldMapping & { created_at: Date }>(tx,
      `INSERT INTO integration_field_mappings(workspace_id, integration_id, resource_id, relay_object, relay_field, external_field, source_of_truth, direction, conflict, on_delete, on_revoke, protected, enabled, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (integration_id, coalesce(resource_id, '00000000-0000-0000-0000-000000000000'::uuid), relay_object, relay_field, external_field)
       DO UPDATE SET source_of_truth=EXCLUDED.source_of_truth, direction=EXCLUDED.direction, conflict=EXCLUDED.conflict, on_delete=EXCLUDED.on_delete,
                     on_revoke=EXCLUDED.on_revoke, protected=EXCLUDED.protected, enabled=EXCLUDED.enabled, version=integration_field_mappings.version+1, updated_at=now()
       RETURNING id, integration_id, resource_id, relay_object, relay_field, external_field, source_of_truth, direction, conflict, on_delete, on_revoke, protected, enabled, version, created_at`,
      [r.workspace_id, id, input.resource_id ?? null, input.relay_object, input.relay_field, input.external_field, input.source_of_truth, input.direction, input.conflict,
        input.on_delete, input.on_revoke, prot, input.enabled, ctx.actor.userId]);
    await audit(tx, { workspaceId: r.workspace_id, brandId: r.brand_id, actorUserId: ctx.actor.userId, action: 'integration.mapping_set', resourceType: 'integration', resourceId: id, diff: { field: input.relay_field, direction: input.direction }, correlationId: ctx.correlationId });
    const { created_at: _c, ...m } = row;
    return m;
  });
}

export async function listFieldMappings(ctx: Ctx, id: string): Promise<{ items: FieldMapping[] }> {
  await loadIntegration(ctx, id, 'integrations.read');
  return { items: await many<FieldMapping>(getPool(),
    `SELECT id, integration_id, resource_id, relay_object, relay_field, external_field, source_of_truth, direction, conflict, on_delete, on_revoke, protected, enabled, version
       FROM integration_field_mappings WHERE integration_id=$1 ORDER BY relay_object, relay_field`, [id]) };
}

// ------------------------------------------------------------------ external links
type LinkRow = { id: string; integration_id: string; connector: ConnectorKey; relay_type: RelayObjectType; relay_id: string; external_type: string; external_id: string; external_url: string | null; status: 'linked' | 'unavailable' | 'unlinked'; status_detail: string | null; last_synced_at: Date | null };
const linkJson = (r: LinkRow): ExternalLinkJson => ({ ...r, last_synced_at: iso(r.last_synced_at) });

/**
 * Idempotent link: the same Relay object + external type maps to one live external record. Returns the existing link
 * when one exists (so a repeated delivery never creates a duplicate external record).
 */
export async function upsertExternalLink(tx: Queryable, l: { workspaceId: string; brandId: string | null; integrationId: string; relayType: RelayObjectType; relayId: string; externalType: string; externalId: string; externalUrl?: string | null; actorUserId?: string | null }): Promise<{ id: string; created: boolean }> {
  const existing = await maybeOne<{ id: string; external_id: string }>(tx,
    `SELECT id, external_id FROM external_links WHERE integration_id=$1 AND relay_type=$2 AND relay_id=$3 AND external_type=$4 AND status <> 'unlinked' FOR UPDATE`,
    [l.integrationId, l.relayType, l.relayId, l.externalType]);
  if (existing) {
    if (existing.external_id !== l.externalId) throw new AppError('conflict', 'This item is already linked to a different external record. Unlink it first.', undefined, { reason: 'already_linked' });
    await tx.query(`UPDATE external_links SET last_synced_at=now(), updated_at=now(), external_url=coalesce($2, external_url), status='linked', status_detail=NULL WHERE id=$1`, [existing.id, l.externalUrl ?? null]);
    return { id: existing.id, created: false };
  }
  const r = await one<{ id: string }>(tx,
    `INSERT INTO external_links(workspace_id, brand_id, integration_id, relay_type, relay_id, external_type, external_id, external_url, last_synced_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),$9) RETURNING id`,
    [l.workspaceId, l.brandId, l.integrationId, l.relayType, l.relayId, l.externalType, l.externalId, l.externalUrl ?? null, l.actorUserId ?? null]);
  return { id: r.id, created: true };
}

export async function listExternalLinks(ctx: Ctx, relayType: RelayObjectType, relayId: string): Promise<{ items: ExternalLinkJson[] }> {
  requireAction(ctx, 'integrations.read');
  const rows = await many<LinkRow & { brand_id: string | null }>(getPool(),
    `SELECT l.id, l.integration_id, i.connector, l.relay_type, l.relay_id, l.external_type, l.external_id, l.external_url, l.status, l.status_detail, l.last_synced_at, l.brand_id
       FROM external_links l JOIN integration_connections i ON i.id=l.integration_id
      WHERE l.workspace_id=$1 AND l.relay_type=$2 AND l.relay_id=$3 AND l.status <> 'unlinked' ORDER BY l.created_at`, [ctx.access.workspaceId, relayType, relayId]);
  return { items: rows.filter((r) => !r.brand_id || brandAllowed(ctx, r.brand_id)).map(linkJson) };
}

/** Reversible + audited (incorrect links can be undone). */
export async function unlinkExternal(ctx: Ctx, linkId: string): Promise<void> {
  assertUuid(linkId, 'Link');
  await withTx(async (tx) => {
    const l = await maybeOne<{ id: string; integration_id: string; brand_id: string | null; relay_type: string; relay_id: string }>(tx,
      `SELECT id, integration_id, brand_id, relay_type, relay_id FROM external_links WHERE id=$1 AND workspace_id=$2 AND status <> 'unlinked' FOR UPDATE`, [linkId, ctx.access.workspaceId]);
    if (!l || (l.brand_id && !brandAllowed(ctx, l.brand_id))) throw notFound('Link');
    await loadIntegration(ctx, l.integration_id, 'integrations.manage', tx);
    await tx.query(`UPDATE external_links SET status='unlinked', unlinked_at=now(), unlinked_by=$2, updated_at=now() WHERE id=$1`, [linkId, ctx.actor.userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: l.brand_id, actorUserId: ctx.actor.userId, action: 'integration.unlinked', resourceType: l.relay_type, resourceId: l.relay_id, diff: { link_id: linkId }, correlationId: ctx.correlationId });
  });
}

// ------------------------------------------------------------------ activity + health
export async function recordActivity(db: Queryable, a: { workspaceId: string; integrationId?: string | null; channelId?: string | null; kind: IntegrationActivityJson['kind']; outcome: IntegrationActivityJson['outcome']; code?: string | null; message?: string | null; httpStatus?: number | null; jobId?: string | null }): Promise<void> {
  await db.query(
    `INSERT INTO integration_activity(workspace_id, integration_id, channel_id, kind, outcome, code, message, http_status, job_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [a.workspaceId, a.integrationId ?? null, a.channelId ?? null, a.kind, a.outcome, a.code?.slice(0, 80) ?? null, a.message?.slice(0, 300) ?? null, a.httpStatus ?? null, a.jobId ?? null]);
}

export async function integrationHealth(ctx: Ctx, id: string): Promise<IntegrationHealthJson> {
  const r = await loadIntegration(ctx, id, 'integrations.read');
  const db = getPool();
  const [ev, jobs, act] = await Promise.all([
    one<{ pending: number; failed: number; last: Date | null }>(db,
      `SELECT count(*) FILTER (WHERE state IN ('pending','processing'))::int pending, count(*) FILTER (WHERE state IN ('failed','dead') AND received_at > now() - interval '24 hours')::int failed, max(received_at) last
         FROM integration_events WHERE integration_id=$1`, [id]),
    one<{ queued: number; running: number; failed: number; unknown: number; oldest: number | null }>(db,
      `SELECT count(*) FILTER (WHERE state IN ('queued','waiting_retry'))::int queued, count(*) FILTER (WHERE state='running')::int running,
              count(*) FILTER (WHERE state='failed' AND finished_at > now() - interval '24 hours')::int failed, count(*) FILTER (WHERE state='unknown')::int unknown,
              extract(epoch FROM now() - min(created_at) FILTER (WHERE state IN ('queued','waiting_retry')))::float8 oldest
         FROM integration_sync_jobs WHERE integration_id=$1`, [id]),
    many<{ at: Date; kind: IntegrationActivityJson['kind']; outcome: IntegrationActivityJson['outcome']; code: string | null; message: string | null; http_status: number | null }>(db,
      `SELECT at, kind, outcome, code, message, http_status FROM integration_activity WHERE integration_id=$1 ORDER BY at DESC LIMIT 50`, [id]),
  ]);
  return {
    integration: toIntegrationJson(r),
    events: { pending: ev.pending, failed_24h: ev.failed, last_received_at: iso(ev.last) },
    jobs: { queued: jobs.queued, running: jobs.running, failed_24h: jobs.failed, unknown: jobs.unknown, oldest_queued_age_seconds: jobs.oldest === null ? null : Math.round(jobs.oldest) },
    activity: act.map((a) => ({ ...a, at: a.at.toISOString() })),
  };
}
