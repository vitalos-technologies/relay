// Runtime for business connectors: operator configuration, transport selection (a live installation NEVER gets a
// simulated transport; simulated installations only with mock providers enabled and never in production), credential
// decryption + serialized refresh, and provider-error → sync-outcome mapping (lost writes are "unknown", never retried
// blindly; revoked access marks the installation reconnect_required and its links unavailable).
import { AppError, type ProviderCredentials } from '@social-lite/core';
import type { RateLimitObservation, SyncOutcome } from '@social-lite/core/contracts/v35-connectors';
import type { HubConnector } from '@social-lite/core/contracts/v35-integrations';
import { getPool, maybeOne, type Queryable } from '@social-lite/db';
import { BizApiError, BizTransportError, LiveBizTransport, type BizTransport } from '@social-lite/providers/biz/transport';
import { SimulatedBizTransport, type SimScenario, SIM_SCENARIOS } from '@social-lite/providers/biz/sim';
import { config, mockProvidersEnabled } from '../../config.js';
import { credentialAad, decryptSecret, encryptSecret, type EncryptedBlob } from '../../crypto.js';
import { log } from '../../log.js';
import { getSetting, type SettingKey } from '../../settings.js';
import { disconnectIntegration, recordActivity, type IntegrationRow } from '../../connectors/store.js';
import { DbSimStore } from './sim-store.js';
import type { Conn, HubAdapter, OperatorConfig, StoredCreds } from './types.js';

const ADAPTERS = new Map<HubConnector, HubAdapter>();
export function registerHubAdapter(a: HubAdapter): void { ADAPTERS.set(a.connector, a); }
export function hubAdapter(c: string): HubAdapter {
  const a = ADAPTERS.get(c as HubConnector);
  if (!a) throw new AppError('not_found', 'Unknown integration.');
  return a;
}
export const hubAdapters = () => [...ADAPTERS.values()];

export const baseUrl = () => config().APP_BASE_URL.replace(/\/$/, '');
export const redirectUriFor = (connector: string) => `${baseUrl()}/api/connectors/oauth/${connector}/callback`;
export const webhookUrlFor = (connector: string, installationId?: string) => `${baseUrl()}/api/connectors/webhooks/${connector}${installationId ? `?i=${installationId}` : ''}`;

export async function operatorConfig(connector: HubConnector): Promise<OperatorConfig & { missing: SettingKey[] }> {
  const a = hubAdapter(connector);
  const values: OperatorConfig['values'] = {};
  for (const k of [...a.required, ...(a.optional ?? [])]) {
    const v = await getSetting(k).catch(() => undefined);
    if (v) values[k] = v;
  }
  return { values, redirectUri: redirectUriFor(connector), missing: a.required.filter((k) => !values[k]) };
}

export function simulationAllowed(): boolean {
  return config().APP_ENV !== 'production' && mockProvidersEnabled();
}

export function transportFor(a: HubAdapter, row: Pick<IntegrationRow, 'is_simulated' | 'external_account_id' | 'settings'>): BizTransport {
  if (row.is_simulated) {
    if (!simulationAllowed()) throw new AppError('forbidden', 'Simulated integrations are disabled in this environment.');
    const s = row.settings?.sim_scenario as SimScenario | undefined;
    return new SimulatedBizTransport({ connector: a.connector, accountId: row.external_account_id, store: new DbSimStore(), handler: a.sim, scenario: s && SIM_SCENARIOS.includes(s) ? s : 'success' });
  }
  const extra = a.connector === 'mailchimp' && typeof row.settings?.dc === 'string' && /^[a-z]{2}\d{1,3}$/.test(row.settings.dc) ? [`${row.settings.dc}.api.mailchimp.com`] : [];
  return new LiveBizTransport({ hosts: [...a.hosts, ...extra], onLog: (e) => log.info('integration_http', { connector: a.connector, ...e }) });
}

/** Transport for the OAuth exchange (before an installation exists). Simulation only via the explicit simulated flow. */
export function liveTransport(a: HubAdapter): BizTransport {
  return new LiveBizTransport({ hosts: a.hosts, onLog: (e) => log.info('integration_http', { connector: a.connector, ...e }) });
}

type CredRow = IntegrationRow & { encrypted_blob: EncryptedBlob | null };

export async function loadIntegrationRow(id: string, db: Queryable = getPool()): Promise<IntegrationRow | null> {
  return maybeOne<IntegrationRow>(db, `SELECT * FROM integration_connections WHERE id=$1`, [id]);
}

function storedFrom(c: ProviderCredentials): StoredCreds {
  if (c.kind === 'oauth2') return { accessToken: c.accessToken, refreshToken: c.refreshToken ?? null, expiresAt: c.expiresAt ?? null };
  if (c.kind === 'mock') return { accessToken: c.token, refreshToken: null, expiresAt: null };
  throw new AppError('invalid_state', 'Unsupported credential type for this integration.');
}

const REFRESH_SKEW_MS = 5 * 60_000;

/**
 * Open an installation for provider calls. Throws AppError('invalid_state') when it cannot be used (disconnected,
 * reconnect required). Refresh is serialized per installation with an advisory lock; the provider call runs outside
 * any transaction.
 */
export async function openConn(integrationId: string, opts: { allowPaused?: boolean } = {}): Promise<Conn> {
  const row = await maybeOne<CredRow>(getPool(),
    `SELECT i.*, c.encrypted_blob FROM integration_connections i LEFT JOIN credentials c ON c.id=i.credential_id AND c.workspace_id=i.workspace_id WHERE i.id=$1`, [integrationId]);
  if (!row) throw new AppError('not_found', 'Integration not found.');
  if (row.disconnected_at) throw new AppError('invalid_state', 'This integration is disconnected.');
  if (row.status === 'reconnect_required' || !row.encrypted_blob) throw new AppError('invalid_state', 'Reconnect this integration first.', undefined, { reason: 'reconnect_required' });
  if (row.paused && !opts.allowPaused) throw new AppError('invalid_state', 'This integration is paused.', undefined, { reason: 'paused' });
  const a = hubAdapter(row.connector);
  const t = transportFor(a, row);
  let creds = storedFrom(decryptSecret<ProviderCredentials>(row.encrypted_blob, credentialAad(row.workspace_id)));
  const needsToken = a.connect === 'operator' || (creds.expiresAt && Date.parse(creds.expiresAt) - Date.now() < REFRESH_SKEW_MS);
  if (needsToken && a.refresh && !row.is_simulated) creds = await refreshSerialized(row, a, t, creds);
  return { integrationId: row.id, workspaceId: row.workspace_id, brandId: row.brand_id, connector: row.connector as HubConnector, externalAccountId: row.external_account_id,
    settings: row.settings ?? {}, simulated: row.is_simulated, t, token: creds.accessToken };
}

const lockKey = (id: string) => `integration-refresh:${id}`;

async function refreshSerialized(row: CredRow, a: HubAdapter, t: BizTransport, creds: StoredCreds): Promise<StoredCreds> {
  const client = await getPool().connect();
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext($1))`, [lockKey(row.id)]);
    // Another process may have refreshed while we waited.
    const fresh = await client.query<{ encrypted_blob: EncryptedBlob | null }>(`SELECT c.encrypted_blob FROM integration_connections i JOIN credentials c ON c.id=i.credential_id WHERE i.id=$1`, [row.id]);
    const blob = fresh.rows[0]?.encrypted_blob;
    if (blob) {
      const cur = storedFrom(decryptSecret<ProviderCredentials>(blob, credentialAad(row.workspace_id)));
      if (a.connect !== 'operator' && cur.expiresAt && Date.parse(cur.expiresAt) - Date.now() >= REFRESH_SKEW_MS) return cur;
      creds = cur;
    }
    const cfg = await operatorConfig(row.connector as HubConnector);
    let next: StoredCreds | null;
    try {
      next = await a.refresh!(t, cfg, creds);
    } catch (err) {
      if (err instanceof BizApiError && (err.kind === 'auth' || err.code === 'invalid_grant' || err.status === 400)) {
        await markRevoked(row.id, row.workspace_id, 'refresh_refused');
        throw new AppError('invalid_state', 'Access was revoked at the provider. Reconnect to resume.', undefined, { reason: 'reconnect_required' });
      }
      throw err;
    }
    if (!next) return creds;
    if (a.connect === 'oauth') {
      const enc = encryptSecret({ kind: 'oauth2', accessToken: next.accessToken, refreshToken: next.refreshToken, expiresAt: next.expiresAt } satisfies ProviderCredentials, credentialAad(row.workspace_id));
      await client.query(`UPDATE credentials SET encrypted_blob=$2, key_version=$3, expires_at=$4, refresh_version=refresh_version+1, updated_at=now() WHERE id=$1`, [row.credential_id, JSON.stringify(enc), enc.kid, next.expiresAt]);
    }
    return next;
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [lockKey(row.id)]).catch(() => undefined);
    client.release();
  }
}

/** Provider says the grant is gone: keep Relay records, mark links unavailable, ask for a reconnect. */
export async function markRevoked(integrationId: string, workspaceId: string, code: string): Promise<void> {
  await disconnectIntegration(null, integrationId, { revokedByProvider: true, workspaceId });
  await recordActivity(getPool(), { workspaceId, integrationId, kind: 'auth', outcome: 'error', code, message: 'Access was revoked at the provider.' });
}

/** Map a provider/transport error to a sync outcome (and side effects for revocation). */
export async function outcomeFromError(err: unknown, c: Pick<Conn, 'integrationId' | 'workspaceId'>, mutating: boolean): Promise<SyncOutcome> {
  if (err instanceof BizTransportError) {
    if (mutating && err.mayHaveReached) return { kind: 'unknown', code: 'response_lost', message: 'The provider did not answer after the request was sent. Checking before retrying.' };
    return { kind: 'retry', code: `network_${err.kind}`, message: 'The provider could not be reached. Retrying.' };
  }
  if (err instanceof BizApiError) {
    switch (err.kind) {
      case 'auth':
        await markRevoked(c.integrationId, c.workspaceId, 'auth_revoked');
        return { kind: 'failed', code: 'reconnect_required', message: 'Access was revoked at the provider. Reconnect the integration.' };
      case 'forbidden': return { kind: 'failed', code: err.code ?? 'missing_permission', message: 'The connected account lacks permission for this action.' };
      case 'not_found': return { kind: 'failed', code: 'not_found', message: 'The external record or destination no longer exists or is not accessible.' };
      case 'rate_limited': {
        const rl: Omit<RateLimitObservation, 'observed_at'> = { remaining: 0, limit: null, reset_at: err.retryAfterMs ? new Date(Date.now() + err.retryAfterMs).toISOString() : null, source: err.retryAfterMs ? 'Retry-After' : 'HTTP 429' };
        return { kind: 'retry', code: 'rate_limited', message: 'The provider is rate limiting requests. Waiting before retrying.', retryAfterMs: err.retryAfterMs ?? 60_000, rateLimit: rl };
      }
      case 'unavailable': return { kind: 'retry', code: 'provider_unavailable', message: 'The provider is temporarily unavailable. Retrying.', retryAfterMs: err.retryAfterMs ?? undefined };
      case 'server': return mutating ? { kind: 'unknown', code: 'provider_error', message: 'The provider returned an error after the request was sent. Checking before retrying.' } : { kind: 'retry', code: 'provider_error', message: 'The provider returned an error. Retrying.' };
      default: return { kind: 'failed', code: err.code ?? 'rejected', message: err.message.slice(0, 200) };
    }
  }
  if (err instanceof AppError) return { kind: 'failed', code: err.code, message: err.message };
  return { kind: 'unknown', code: 'unexpected', message: 'The action stopped unexpectedly. Checking before retrying.' };
}

/** Errors in interactive (request-time) calls → safe AppError for the UI. */
export async function appErrorFrom(err: unknown, c: Pick<Conn, 'integrationId' | 'workspaceId'>): Promise<AppError> {
  if (err instanceof AppError) return err;
  const o = await outcomeFromError(err, c, false);
  if (o.kind === 'succeeded') return new AppError('internal', 'Unexpected state');
  const code = o.code === 'reconnect_required' ? 'invalid_state' : o.code === 'rate_limited' ? 'rate_limited' : 'provider_error';
  await recordActivity(getPool(), { workspaceId: c.workspaceId, integrationId: c.integrationId, kind: o.code === 'rate_limited' ? 'rate_limit' : 'health', outcome: o.kind === 'retry' ? 'retry' : 'error', code: o.code, message: o.message });
  return new AppError(code, o.message, undefined, { reason: o.code });
}

export async function saveRateLimit(integrationId: string, rl: Omit<RateLimitObservation, 'observed_at'> | null): Promise<void> {
  if (!rl) return;
  await getPool().query(`UPDATE integration_connections SET rate_limit=$2 WHERE id=$1`, [integrationId, JSON.stringify({ ...rl, observed_at: new Date().toISOString() })]);
}
