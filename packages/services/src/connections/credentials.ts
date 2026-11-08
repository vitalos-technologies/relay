// Credential access for the engine and health checks. Decrypts only here (narrow path, spec §14).
// Rotating refresh is SERIALIZED per connection with a session-level advisory lock held on a dedicated
// client that is NOT in a transaction; the provider call happens outside any transaction.
import {
  DISPATCHABLE_CONNECTION_STATUSES, TransportError,
  type ConnectionStatus, type ProviderCredentials, type PublishConnection,
} from '@social-lite/core';
import { getAdapter } from '@social-lite/providers';
import { getPool, maybeOne, withTx } from '@social-lite/db';
import { credentialAad, decryptSecret, encryptSecret, type EncryptedBlob } from '../crypto.js';
import { log } from '../log.js';
import { audit } from '../audit.js';
import { writeOutbox } from '../outbox.js';
import { blockDeliveriesForConnection } from '../engine/hooks.js';
import { buildAdapterContext } from './runtime.js';
import { toPublishConnection, type ConnectionRow } from './store.js';

/** Refresh when the access token expires within this window. */
export const REFRESH_SKEW_MS = 5 * 60_000;

export type CredentialUnavailableCode =
  | 'not_found' | 'disconnected' | 'no_credentials' | 'expired' | 'refresh_failed' | 'refresh_unavailable' | 'decrypt_failed';

/**
 * The connection cannot be used right now. retryable=false => the connection was marked
 * reconnect_required and its queued deliveries were blocked; retryable=true => transient (e.g. the
 * provider token endpoint was unreachable) and nothing was changed.
 */
export class CredentialUnavailableError extends Error {
  readonly blocking: 'reconnect' | 'permission' = 'reconnect';
  constructor(message: string, readonly code: CredentialUnavailableCode, readonly retryable: boolean) {
    super(message);
    this.name = 'CredentialUnavailableError';
  }
}

export type UsableConnection = PublishConnection & { status: ConnectionStatus; paused: boolean; workspaceId: string; brandId: string };

type CredRow = ConnectionRow & { encrypted_blob: EncryptedBlob | null; refresh_version: number | null; cred_expires_at: Date | null };

async function readRow(connectionId: string): Promise<CredRow | null> {
  return maybeOne<CredRow>(getPool(),
    `SELECT c.*, cr.encrypted_blob, cr.refresh_version, cr.expires_at AS cred_expires_at
       FROM connections c LEFT JOIN credentials cr ON cr.id = c.credential_id AND cr.workspace_id = c.workspace_id
      WHERE c.id = $1`, [connectionId]);
}

function usable(r: ConnectionRow): UsableConnection {
  return { ...toPublishConnection(r), status: r.status, paused: r.paused, workspaceId: r.workspace_id, brandId: r.brand_id };
}

function decrypt(r: { workspace_id: string; encrypted_blob: EncryptedBlob }): ProviderCredentials {
  try {
    return decryptSecret<ProviderCredentials>(r.encrypted_blob, credentialAad(r.workspace_id));
  } catch {
    throw new CredentialUnavailableError('Stored credentials could not be decrypted. Reconnect the account.', 'decrypt_failed', false);
  }
}

function expiryMs(creds: ProviderCredentials, row: { cred_expires_at: Date | null }): number | null {
  if (creds.kind === 'oauth2' && creds.expiresAt) return Date.parse(creds.expiresAt);
  return row.cred_expires_at ? row.cred_expires_at.getTime() : null;
}

/** Mark a connection reconnect_required and block its queued work (one short transaction). */
export async function markReconnectRequired(connectionId: string, message: string, actorService = 'connections'): Promise<void> {
  await withTx(async (tx) => {
    const cur = await maybeOne<{ workspace_id: string; brand_id: string; status: ConnectionStatus; disconnected_at: Date | null }>(tx,
      `SELECT workspace_id, brand_id, status, disconnected_at FROM connections WHERE id=$1 FOR UPDATE`, [connectionId]);
    if (!cur || cur.disconnected_at) return;
    await tx.query(
      `UPDATE connections SET status='reconnect_required', health_detail=$2, health_checked_at=now(), updated_at=now() WHERE id=$1`,
      [connectionId, JSON.stringify({ message })]);
    await blockDeliveriesForConnection(tx, connectionId, message);
    if (cur.status !== 'reconnect_required') {
      await writeOutbox(tx, { workspaceId: cur.workspace_id, aggregateType: 'connection', aggregateId: connectionId, eventType: 'connection.health_changed',
        payload: { from: cur.status, to: 'reconnect_required', wasDispatchable: DISPATCHABLE_CONNECTION_STATUSES.has(cur.status) } });
      await audit(tx, { workspaceId: cur.workspace_id, brandId: cur.brand_id, actorService, action: 'connection.health_changed', resourceType: 'connection',
        resourceId: connectionId, diff: { from: cur.status, to: 'reconnect_required' } });
    }
  });
}

/** Hook for tests: counts provider refresh calls actually made. */
export const refreshStats = { providerCalls: 0 };

async function refreshSerialized(row: CredRow, observedVersion: number, force: boolean): Promise<ProviderCredentials> {
  const adapter = getAdapter(row.provider);
  const client = await getPool().connect();
  const lockKey = `connection-refresh:${row.id}`;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
    try {
      const cur = await maybeOne<{ workspace_id: string; encrypted_blob: EncryptedBlob; refresh_version: number; credential_id: string; disconnected_at: Date | null; cred_expires_at: Date | null }>(client,
        `SELECT c.workspace_id, c.disconnected_at, c.credential_id, cr.encrypted_blob, cr.refresh_version, cr.expires_at AS cred_expires_at
           FROM connections c JOIN credentials cr ON cr.id = c.credential_id AND cr.workspace_id = c.workspace_id
          WHERE c.id = $1`, [row.id]);
      if (!cur || cur.disconnected_at) throw new CredentialUnavailableError('The account was disconnected.', 'disconnected', false);
      const creds = decrypt(cur);
      // Another worker refreshed (or the user reconnected) while we waited for the lock.
      if (cur.refresh_version !== observedVersion) return creds;
      const exp = expiryMs(creds, cur);
      if (!force && exp !== null && exp - Date.now() > REFRESH_SKEW_MS) return creds;

      const ctx = await buildAdapterContext(row.provider, toPublishConnection(row));
      let res: Awaited<ReturnType<NonNullable<typeof adapter.refreshCredentials>>>;
      try {
        refreshStats.providerCalls++;
        res = await adapter.refreshCredentials!(ctx, creds); // network: no transaction is open
      } catch (err) {
        const permanent = !(err instanceof TransportError) && (err as { permanent?: unknown }).permanent === true;
        log.warn('credential_refresh_failed', { connectionId: row.id, provider: row.provider, permanent, err: { name: (err as Error).name, message: (err as Error).message } });
        if (permanent) {
          const msg = `${providerName(row.provider)} no longer accepts this authorization (refresh failed). Reconnect the account.`;
          await markReconnectRequired(row.id, msg);
          throw new CredentialUnavailableError(msg, 'refresh_failed', false);
        }
        throw new CredentialUnavailableError(`Could not refresh the ${providerName(row.provider)} authorization right now; will retry.`, 'refresh_unavailable', true);
      }
      const blob = encryptSecret(res.credentials, credentialAad(cur.workspace_id));
      const upd = await client.query(
        `UPDATE credentials SET encrypted_blob=$2, key_version=$3, expires_at=$4, granted_scopes=coalesce($5, granted_scopes),
                refresh_version=refresh_version+1, updated_at=now()
          WHERE id=$1 AND refresh_version=$6`,
        [cur.credential_id, JSON.stringify(blob), blob.kid, res.expiresAt, res.scopes ?? null, observedVersion]);
      if (!upd.rowCount) log.warn('credential_refresh_lost_race', { connectionId: row.id });
      return res.credentials;
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

const providerName = (p: string) => ({ facebook: 'Facebook', instagram: 'Instagram', telegram: 'Telegram', x: 'X' } as Record<string, string>)[p] ?? p;

/**
 * Decrypted credentials plus the connection, for the engine. Refreshes rotating tokens that expire
 * within 5 minutes (or when forceRefresh, e.g. after a 401), serialized per connection.
 * Throws CredentialUnavailableError when the connection cannot be used.
 */
export async function getUsableCredentials(
  connectionId: string, opts: { forceRefresh?: boolean } = {},
): Promise<{ credentials: ProviderCredentials; connection: UsableConnection }> {
  const row = await readRow(connectionId);
  if (!row) throw new CredentialUnavailableError('Connection not found.', 'not_found', false);
  if (row.disconnected_at || row.status === 'disconnected') throw new CredentialUnavailableError('The account was disconnected. Reconnect it to publish.', 'disconnected', false);
  if (!row.encrypted_blob || row.refresh_version === null) throw new CredentialUnavailableError('No stored credentials. Reconnect the account.', 'no_credentials', false);

  let creds = decrypt({ workspace_id: row.workspace_id, encrypted_blob: row.encrypted_blob });
  const adapter = getAdapter(row.provider);
  const canRefresh = typeof adapter.refreshCredentials === 'function' && !(creds.kind === 'oauth2' && !creds.refreshToken) && creds.kind !== 'mock';
  const exp = expiryMs(creds, row);
  const expiringSoon = exp !== null && exp - Date.now() <= REFRESH_SKEW_MS;

  if (canRefresh && (opts.forceRefresh || expiringSoon)) {
    creds = await refreshSerialized(row, row.refresh_version, !!opts.forceRefresh);
  } else if (exp !== null && exp <= Date.now() && !canRefresh && creds.kind !== 'mock') {
    const msg = `The ${providerName(row.provider)} authorization expired. Reconnect the account.`;
    await markReconnectRequired(row.id, msg);
    throw new CredentialUnavailableError(msg, 'expired', false);
  }
  return { credentials: creds, connection: usable(row) };
}

/** Decrypt stored credentials WITHOUT refreshing (used for best-effort revocation on disconnect). */
export async function peekCredentials(connectionId: string): Promise<{ credentials: ProviderCredentials; connection: UsableConnection } | null> {
  const row = await readRow(connectionId);
  if (!row || !row.encrypted_blob) return null;
  try { return { credentials: decrypt(row as never), connection: usable(row as never) }; } catch { return null; }
}
