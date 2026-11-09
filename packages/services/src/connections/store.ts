// Connection rows, JSON shape (docs/API.md "Connection") and the transactional upsert used by every
// connect / reconnect path. Credentials are envelope-encrypted and never leave the server.
import {
  CONNECTION_STATUS_LABEL, DISPATCHABLE_CONNECTION_STATUSES, notFound,
  type ConnectionHealth, type ConnectionStatus, type FinalizedDestination, type Provider, type ProviderCredentials, type PublishConnection,
} from '@social-lite/core';
import { getAdapter } from '@social-lite/providers';
import { getPool, maybeOne, one, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { assertUuid, brandAllowed } from '../tenancy.js';
import { credentialAad, encryptSecret } from '../crypto.js';
import { audit } from '../audit.js';
import { writeOutbox } from '../outbox.js';
import { assertCanConnectAccount } from '../entitlements/actions.js';
import { blockDeliveriesForConnection, onConnectionRestored } from '../engine/hooks.js';

export interface ConnectionRow {
  id: string;
  workspace_id: string;
  brand_id: string;
  provider: Provider;
  provider_account_id: string;
  display_name: string;
  username: string | null;
  status: ConnectionStatus;
  is_mock: boolean;
  credential_id: string | null;
  capabilities: Record<string, unknown>;
  health_detail: { message?: string; missing_permissions?: string[]; expires_at?: string | null };
  health_checked_at: Date | null;
  metadata: Record<string, unknown>;
  throttled_until: Date | null;
  paused: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  disconnected_at: Date | null;
}

export interface ConnectionJson {
  id: string;
  brand_id: string;
  provider: Provider;
  provider_account_id: string;
  display_name: string;
  username: string | null;
  status: ConnectionStatus;
  status_label: string;
  is_mock: boolean;
  capabilities: Record<string, unknown>;
  health: { message: string; checked_at: string | null; missing_permissions?: string[]; expires_at?: string | null };
  paused: boolean;
  throttled_until: string | null;
  mock_scenario?: string;
  created_at: string;
  disconnected_at: string | null;
}

/** Status shown to users: Disconnected > Paused > health status (AC-04). */
export function effectiveStatus(r: Pick<ConnectionRow, 'status' | 'paused' | 'disconnected_at'>): ConnectionStatus {
  if (r.disconnected_at || r.status === 'disconnected') return 'disconnected';
  if (r.paused) return 'paused';
  return r.status;
}

/**
 * The adapter's current capabilities for this connection (same source as MCP list_destinations and diagnostics, via
 * posts/shared capabilitiesFor), so a capability fix shows on connection cards without waiting for the next health
 * check (fix H7). Falls back to the stored record.
 */
function liveCapabilities(r: ConnectionRow): ConnectionJson['capabilities'] {
  try {
    return getAdapter(r.provider).capabilities(toPublishConnection(r)) as unknown as ConnectionJson['capabilities'];
  } catch {
    return r.capabilities ?? {};
  }
}

export function toConnectionJson(r: ConnectionRow): ConnectionJson {
  const status = effectiveStatus(r);
  const hd = r.health_detail ?? {};
  return {
    id: r.id,
    brand_id: r.brand_id,
    provider: r.provider,
    provider_account_id: r.provider_account_id,
    display_name: r.display_name,
    username: r.username,
    status,
    status_label: CONNECTION_STATUS_LABEL[status],
    is_mock: r.is_mock,
    capabilities: liveCapabilities(r),
    health: {
      message: hd.message ?? '',
      checked_at: r.health_checked_at ? r.health_checked_at.toISOString() : null,
      ...(hd.missing_permissions?.length ? { missing_permissions: hd.missing_permissions } : {}),
      ...(hd.expires_at !== undefined ? { expires_at: hd.expires_at } : {}),
    },
    paused: r.paused,
    throttled_until: r.throttled_until ? r.throttled_until.toISOString() : null,
    ...(r.is_mock ? { mock_scenario: typeof r.metadata?.mock_scenario === 'string' ? r.metadata.mock_scenario : 'success' } : {}),
    created_at: r.created_at.toISOString(),
    disconnected_at: r.disconnected_at ? r.disconnected_at.toISOString() : null,
  };
}

export function toPublishConnection(r: ConnectionRow): PublishConnection {
  return {
    id: r.id, provider: r.provider, providerAccountId: r.provider_account_id, displayName: r.display_name,
    username: r.username, metadata: r.metadata ?? {}, isMock: r.is_mock,
  };
}

export function healthDetail(h: ConnectionHealth): ConnectionRow['health_detail'] {
  return {
    message: h.message,
    ...(h.missingPermissions?.length ? { missing_permissions: h.missingPermissions } : {}),
    ...(h.expiresAt !== undefined ? { expires_at: h.expiresAt } : {}),
  };
}

/** Load a connection in the caller's workspace and permitted brands; otherwise not_found. */
export async function loadConnection(ctx: Ctx, id: string, db: Queryable = getPool(), forUpdate = false): Promise<ConnectionRow> {
  assertUuid(id, 'Connection');
  const r = await maybeOne<ConnectionRow>(db,
    `SELECT * FROM connections WHERE id=$1 AND workspace_id=$2${forUpdate ? ' FOR UPDATE' : ''}`, [id, ctx.access.workspaceId]);
  if (!r || !brandAllowed(ctx, r.brand_id)) throw notFound('Connection');
  return r;
}

export async function insertCredential(
  db: Queryable, workspaceId: string, credentials: ProviderCredentials, p: { expiresAt: string | null; scopes: string[]; refreshExpiresAt?: string | null },
): Promise<string> {
  const blob = encryptSecret(credentials, credentialAad(workspaceId));
  const r = await one<{ id: string }>(db,
    `INSERT INTO credentials(workspace_id, encrypted_blob, key_version, expires_at, refresh_expires_at, granted_scopes)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [workspaceId, JSON.stringify(blob), blob.kid, p.expiresAt, p.refreshExpiresAt ?? null, p.scopes]);
  return r.id;
}

export async function replaceCredential(
  db: Queryable, workspaceId: string, credentialId: string, credentials: ProviderCredentials,
  p: { expiresAt: string | null; scopes: string[]; refreshExpiresAt?: string | null },
): Promise<void> {
  const blob = encryptSecret(credentials, credentialAad(workspaceId));
  await db.query(
    `UPDATE credentials SET encrypted_blob=$3, key_version=$4, expires_at=$5, refresh_expires_at=$6, granted_scopes=$7,
            refresh_version=refresh_version+1, updated_at=now()
      WHERE id=$1 AND workspace_id=$2`,
    [credentialId, workspaceId, JSON.stringify(blob), blob.kid, p.expiresAt, p.refreshExpiresAt ?? null, p.scopes]);
}

export interface UpsertArgs {
  workspaceId: string;
  brandId: string;
  provider: Provider;
  actorUserId: string | null;
  correlationId: string;
  dest: FinalizedDestination;
  /** Connection the user asked to reconnect, if any (AC-05: a different identity never replaces it). */
  reconnectConnectionId?: string | null;
}

/**
 * Create or update the connection for a verified/authorized destination. MUST run inside a transaction.
 *  - Same provider identity already active in the brand => update its credential and health.
 *  - Explicit reconnect of a disconnected connection with the SAME identity => revive it.
 *  - Otherwise (incl. a different identity during reconnect) => a NEW connection; the old one is untouched.
 * Status always comes from the destination's health (AC-04: never Ready merely because a token was saved).
 */
export async function upsertConnectionFromDestination(tx: Queryable, a: UpsertArgs): Promise<{ row: ConnectionRow; created: boolean }> {
  const { dest } = a;
  const caps = getAdapter(a.provider).capabilities({
    id: '00000000-0000-0000-0000-000000000000', provider: a.provider, providerAccountId: dest.providerAccountId,
    displayName: dest.displayName, username: dest.username ?? null, metadata: dest.metadata, isMock: false,
  });
  const credMeta = { expiresAt: dest.expiresAt, scopes: dest.grantedScopes, refreshExpiresAt: dest.refreshExpiresAt ?? null };

  let existing = await maybeOne<ConnectionRow>(tx,
    `SELECT * FROM connections WHERE workspace_id=$1 AND brand_id=$2 AND provider=$3 AND provider_account_id=$4 AND disconnected_at IS NULL FOR UPDATE`,
    [a.workspaceId, a.brandId, a.provider, dest.providerAccountId]);
  if (!existing && a.reconnectConnectionId) {
    existing = await maybeOne<ConnectionRow>(tx,
      `SELECT * FROM connections WHERE id=$1 AND workspace_id=$2 AND brand_id=$3 AND provider=$4 AND provider_account_id=$5 AND NOT is_mock FOR UPDATE`,
      [a.reconnectConnectionId, a.workspaceId, a.brandId, a.provider, dest.providerAccountId]);
  }

  if (existing) {
    let credentialId = existing.credential_id;
    if (credentialId) await replaceCredential(tx, a.workspaceId, credentialId, dest.credentials, credMeta);
    else credentialId = await insertCredential(tx, a.workspaceId, dest.credentials, credMeta);
    const row = await one<ConnectionRow>(tx,
      `UPDATE connections SET display_name=$2, username=$3, status=$4, health_detail=$5, health_checked_at=$6, capabilities=$7,
              metadata = metadata || $8::jsonb, credential_id=$9, disconnected_at=NULL, throttled_until=NULL, updated_at=now()
        WHERE id=$1 RETURNING *`,
      [existing.id, dest.displayName, dest.username ?? null, dest.health.status, JSON.stringify(healthDetail(dest.health)), dest.health.checkedAt,
        JSON.stringify(caps), JSON.stringify(dest.metadata), credentialId]);
    const wasDispatchable = !existing.disconnected_at && DISPATCHABLE_CONNECTION_STATUSES.has(existing.status);
    if (DISPATCHABLE_CONNECTION_STATUSES.has(row.status)) {
      // Explicit reconnect of the same identity: queued work blocked on this connection resumes if still timely.
      await onConnectionRestored(tx, row.id);
    } else {
      await blockDeliveriesForConnection(tx, row.id, dest.health.message);
    }
    if (existing.status !== row.status || existing.disconnected_at) {
      await writeOutbox(tx, { workspaceId: a.workspaceId, aggregateType: 'connection', aggregateId: row.id, eventType: 'connection.health_changed',
        payload: { from: existing.disconnected_at ? 'disconnected' : existing.status, to: row.status, wasDispatchable } });
    }
    await audit(tx, {
      workspaceId: a.workspaceId, brandId: a.brandId, actorUserId: a.actorUserId, action: 'connection.reconnected', resourceType: 'connection',
      resourceId: row.id, diff: { provider: a.provider, provider_account_id: row.provider_account_id, status: row.status }, correlationId: a.correlationId,
    });
    return { row, created: false };
  }

  // V4 entitlements: a NEW account counts against the plan's connected-account allowance (race-free in this tx).
  await assertCanConnectAccount(tx, a.workspaceId);
  const credentialId = await insertCredential(tx, a.workspaceId, dest.credentials, credMeta);
  const row = await one<ConnectionRow>(tx,
    `INSERT INTO connections(workspace_id, brand_id, provider, provider_account_id, display_name, username, status, is_mock, credential_id,
                             capabilities, health_detail, health_checked_at, metadata, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,false,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [a.workspaceId, a.brandId, a.provider, dest.providerAccountId, dest.displayName, dest.username ?? null, dest.health.status, credentialId,
      JSON.stringify(caps), JSON.stringify(healthDetail(dest.health)), dest.health.checkedAt, JSON.stringify(dest.metadata), a.actorUserId]);
  await audit(tx, {
    workspaceId: a.workspaceId, brandId: a.brandId, actorUserId: a.actorUserId, action: 'connection.created', resourceType: 'connection',
    resourceId: row.id, diff: { provider: a.provider, provider_account_id: row.provider_account_id, status: row.status, reconnect_of: a.reconnectConnectionId ?? null },
    correlationId: a.correlationId,
  });
  return { row, created: true };
}
