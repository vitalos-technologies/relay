// Integrations hub (V3.5 stream C): operator readiness, OAuth connect / reconnect (oauth_states: sha256(state), single
// use, 10-minute expiry, bound to the initiating user + workspace + brand, PKCE verifier encrypted), operator-credential
// connect (Cloud Translation), simulated installs (dev/demo only), diagnose, resource discovery for explicit selection,
// disconnect with provider-side revocation where the provider offers it.
import { createHash, randomBytes } from 'node:crypto';
import { AppError, notFound } from '@social-lite/core';
import { CONNECTOR_SLUG, HUB_CONNECTORS, type AvailableResourceJson, type ConnectorSetupJson, type HubConnector, type HubOverviewJson, type InstallationDetailJson } from '@social-lite/core/contracts/v35-integrations';
import type { IntegrationStatus } from '@social-lite/core/contracts/v35-connectors';
import { getPool, maybeOne, withTx } from '@social-lite/db';
import type { SimScenario } from '@social-lite/providers/biz/sim';
import { SIM_SCENARIOS } from '@social-lite/providers/biz/sim';
import type { Ctx } from '../../context.js';
import { audit } from '../../audit.js';
import { authorize } from '../../authz.js';
import { decryptSecret, encryptSecret, pkceAad, type EncryptedBlob } from '../../crypto.js';
import { log } from '../../log.js';
import { assertBrand, authorizeCtx, loadAccess, requireAction } from '../../tenancy.js';
import {
  CONNECTORS, createSimulatedIntegration, disconnectIntegration, listIntegrations, listResources, loadIntegration, recordActivity, toIntegrationJson, upsertIntegrationConnection,
  type IntegrationRow,
} from '../../connectors/index.js';
import { appErrorFrom, hubAdapter, liveTransport, openConn, operatorConfig, simulationAllowed, transportFor, webhookUrlFor } from './runtime.js';

const STATE_TTL_MS = 10 * 60_000;
/** Official docs re-checked by stream C (docs/v3-5/INTEGRATIONS.md → Sources). */
const STREAM_C_VERIFIED: Partial<Record<HubConnector, string>> = { asana: '2026-11-08', monday: '2026-11-08', hubspot: '2026-11-08', google_business_profile: '2026-11-08', google_translate: '2026-11-08', mailchimp: '2026-11-08' };
const sha256 = (s: string) => createHash('sha256').update(s).digest();

export async function connectorSetup(connector: HubConnector): Promise<ConnectorSetupJson> {
  const a = hubAdapter(connector);
  const def = CONNECTORS[connector];
  const cfg = await operatorConfig(connector);
  return {
    connector, name: def.name, configured: cfg.missing.length === 0, missing_settings: cfg.missing,
    redirect_uri: a.connect === 'oauth' ? cfg.redirectUri : null,
    webhook_url: a.webhook === 'global' ? webhookUrlFor(connector) : a.webhook === 'per_installation' ? `${webhookUrlFor(connector)}?i=<installation>` : null,
    scopes: [...def.scopes], prerequisites: [...def.prerequisites], docs_url: def.docsUrl, verified_on: STREAM_C_VERIFIED[connector] ?? def.verifiedOn,
    simulation_available: simulationAllowed(), capabilities: [...a.capabilities],
  };
}

export async function hubOverview(ctx: Ctx): Promise<HubOverviewJson> {
  requireAction(ctx, 'integrations.read');
  const { items } = await listIntegrations(ctx);
  const connectors = await Promise.all(HUB_CONNECTORS.map(async (c) => ({ ...(await connectorSetup(c)), installations: items.filter((i) => i.connector === c) })));
  return { connectors, can_manage: authorizeCtx(ctx, 'integrations.manage', { brandId: null }).allowed || (ctx.access.brandIds ?? []).some((b) => authorizeCtx(ctx, 'integrations.manage', { brandId: b }).allowed) };
}

export async function installationDetail(ctx: Ctx, id: string): Promise<InstallationDetailJson> {
  const r = await loadIntegration(ctx, id, 'integrations.read');
  const { items } = await listResources(ctx, id);
  return { integration: toIntegrationJson(r), setup: await connectorSetup(r.connector as HubConnector), resources: items,
    can_manage: authorizeCtx(ctx, 'integrations.manage', { brandId: r.brand_id }).allowed };
}

function requireManage(ctx: Ctx, brandId: string | null): void {
  requireAction(ctx, 'integrations.manage', { brandId, message: brandId ? 'Only people who manage integrations can connect them.' : 'Workspace-wide integrations need workspace integration rights. Choose a brand instead.' });
}

// ------------------------------------------------------------------ OAuth
interface StateSecret { v: string; reconnect: string | null }

export async function startIntegrationOAuth(ctx: Ctx, input: { connector: string; brand_id?: string | null; reconnect_id?: string | null }): Promise<{ authorization_url: string }> {
  if (!(HUB_CONNECTORS as readonly string[]).includes(input.connector)) throw new AppError('validation_failed', 'Unknown integration');
  const connector = input.connector as HubConnector;
  const a = hubAdapter(connector);
  if (a.connect !== 'oauth' || !a.authorizeUrl) throw new AppError('invalid_state', `${CONNECTORS[connector].name} connects with operator credentials, not a sign-in.`);
  const brandId = input.brand_id ?? null;
  requireManage(ctx, brandId);
  if (brandId) await assertBrand(ctx, brandId);
  if (input.reconnect_id) {
    const r = await loadIntegration(ctx, input.reconnect_id, 'integrations.manage');
    if (r.connector !== connector || (r.brand_id ?? null) !== brandId) throw new AppError('validation_failed', 'Reconnect must use the same integration and scope.');
    if (r.is_simulated) throw new AppError('invalid_state', 'Simulated integrations do not sign in. Remove it and connect a real account.');
  }
  const cfg = await operatorConfig(connector);
  if (cfg.missing.length) throw new AppError('provider_not_configured', `${CONNECTORS[connector].name} needs app setup first. An owner can add it in Setup.`, undefined, { missing: cfg.missing });
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const url = a.authorizeUrl(cfg, { state, codeChallenge: createHash('sha256').update(verifier).digest('base64url') });
  await getPool().query(
    `INSERT INTO oauth_states(state_hash, purpose, provider, user_id, workspace_id, brand_id, code_verifier_enc, expires_at) VALUES ($1,'connect',$2,$3,$4,$5,$6,$7)`,
    [sha256(state), `integration:${connector}`, ctx.actor.userId, ctx.access.workspaceId, brandId, JSON.stringify(encryptSecret({ v: verifier, reconnect: input.reconnect_id ?? null } satisfies StateSecret, pkceAad)),
      new Date(Date.now() + STATE_TTL_MS)]);
  return { authorization_url: url };
}

export const integrationReturnPath = (connector: string) => `/integrations/${CONNECTOR_SLUG[connector as HubConnector] ?? ''}`.replace(/\/$/, '');

export type IntegrationCallbackError = 'invalid_connector' | 'invalid_state' | 'session_required' | 'session_mismatch' | 'access_denied' | 'authorization_failed'
  | 'forbidden' | 'not_configured' | 'token_exchange_failed' | 'account_mismatch';

/** Finish the redirect. State consumed only by the user who started; authority re-checked now; provider text never echoed. */
export async function handleIntegrationOAuthCallback(p: { connector: string; params: URLSearchParams; sessionUserId: string | null }): Promise<{ location: string; error?: IntegrationCallbackError; integrationId?: string }> {
  const fail = (error: IntegrationCallbackError) => ({ location: `${integrationReturnPath(p.connector) || '/integrations'}?error=${error}`, error });
  if (!(HUB_CONNECTORS as readonly string[]).includes(p.connector)) return fail('invalid_connector');
  const connector = p.connector as HubConnector;
  const a = hubAdapter(connector);
  const state = p.params.get('state');
  if (!state || state.length > 512) return fail('invalid_state');
  if (!p.sessionUserId) return fail('session_required');
  const row = await maybeOne<{ user_id: string; workspace_id: string; brand_id: string | null; code_verifier_enc: EncryptedBlob }>(getPool(),
    `UPDATE oauth_states SET consumed_at=now() WHERE state_hash=$1 AND purpose='connect' AND provider=$2 AND user_id=$3 AND consumed_at IS NULL AND expires_at > now()
      RETURNING user_id, workspace_id, brand_id, code_verifier_enc`, [sha256(state), `integration:${connector}`, p.sessionUserId]);
  if (!row) {
    const other = await maybeOne(getPool(), `SELECT 1 FROM oauth_states WHERE state_hash=$1 AND provider=$2 AND user_id IS DISTINCT FROM $3`, [sha256(state), `integration:${connector}`, p.sessionUserId]);
    return fail(other ? 'session_mismatch' : 'invalid_state');
  }
  if (p.params.get('error')) return fail(p.params.get('error') === 'access_denied' ? 'access_denied' : 'authorization_failed');
  const code = p.params.get('code');
  if (!code || code.length > 4096) return fail('authorization_failed');
  const access = await loadAccess(row.user_id, row.workspace_id);
  if (!access?.authz) return fail('forbidden');
  const state0 = { ...access.authz, subject: { ...access.authz.subject, assurance: null } };
  if (!authorize(state0, 'integrations.manage', { brandId: row.brand_id }).allowed) return fail('forbidden');
  if (row.brand_id && !(await maybeOne(getPool(), `SELECT 1 FROM brands WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL`, [row.brand_id, row.workspace_id]))) return fail('forbidden');
  const secret = decryptSecret<StateSecret>(row.code_verifier_enc, pkceAad);
  const cfg = await operatorConfig(connector);
  if (cfg.missing.length || !a.exchange) return fail('not_configured');
  let identity;
  try {
    identity = await a.exchange(liveTransport(a), cfg, { code, codeVerifier: secret.v });
  } catch (err) {
    log.warn('integration_oauth_exchange_failed', { connector, err: { name: (err as Error).name, message: (err as Error).message } });
    return fail('token_exchange_failed');
  }
  try {
    const out = await withTx(async (tx) => {
      if (secret.reconnect) {
        const prev = await maybeOne<{ external_account_id: string }>(tx, `SELECT external_account_id FROM integration_connections WHERE id=$1 AND workspace_id=$2`, [secret.reconnect, row.workspace_id]);
        // A reconnect must authorise the SAME external account (links are never silently re-pointed).
        if (prev && prev.external_account_id !== identity.externalAccountId) throw new AppError('validation_failed', 'Reconnect with the same account.');
      }
      return upsertIntegrationConnection(tx, {
        workspaceId: row.workspace_id, brandId: row.brand_id, connector, actorUserId: row.user_id, correlationId: `oauth:${connector}`,
        externalAccountId: identity.externalAccountId, displayName: identity.displayName.slice(0, 120),
        credentials: { kind: 'oauth2', accessToken: identity.creds.accessToken, refreshToken: identity.creds.refreshToken, expiresAt: identity.creds.expiresAt },
        grantedScopes: identity.grantedScopes, expiresAt: identity.creds.expiresAt, health: identity.health, settings: identity.settings, reconnectId: secret.reconnect,
      });
    });
    await recordActivity(getPool(), { workspaceId: row.workspace_id, integrationId: out.row.id, kind: 'auth', outcome: 'ok', code: out.created ? 'connected' : 'reconnected' });
    return { location: `${integrationReturnPath(connector)}?connected=${out.row.id}`, integrationId: out.row.id };
  } catch (err) {
    if (err instanceof AppError && err.code === 'validation_failed') return fail('account_mismatch');
    throw err;
  }
}

/** Operator-credential connect (Cloud Translation): a workspace admin installs it using the operator's project. */
export async function connectWithOperatorCredentials(ctx: Ctx, input: { connector: string }) {
  const connector = input.connector as HubConnector;
  const a = hubAdapter(connector);
  if (a.connect !== 'operator' || !a.operatorConnect) throw new AppError('invalid_state', 'This integration connects through its provider sign-in.');
  requireManage(ctx, null);
  const cfg = await operatorConfig(connector);
  if (cfg.missing.length) throw new AppError('provider_not_configured', `${CONNECTORS[connector].name} needs app setup first. An owner can add it in Setup.`, undefined, { missing: cfg.missing });
  let identity;
  try { identity = await a.operatorConnect(liveTransport(a), cfg); } catch (err) { throw await appErrorFromNoInstall(err); }
  const out = await withTx((tx) => upsertIntegrationConnection(tx, {
    workspaceId: ctx.access.workspaceId, brandId: null, connector, actorUserId: ctx.actor.userId, correlationId: ctx.correlationId,
    externalAccountId: identity.externalAccountId, displayName: identity.displayName, credentials: { kind: 'oauth2', accessToken: identity.creds.accessToken, refreshToken: null, expiresAt: identity.creds.expiresAt },
    grantedScopes: identity.grantedScopes, expiresAt: null, health: identity.health, settings: identity.settings,
  }));
  return toIntegrationJson(out.row);
}

async function appErrorFromNoInstall(err: unknown): Promise<AppError> {
  if (err instanceof AppError) return err;
  log.warn('integration_operator_connect_failed', { err: { name: (err as Error).name, message: (err as Error).message } });
  return new AppError('provider_error', 'The provider refused the operator credentials. Check the Setup values.');
}

/** Simulated installation (mock providers only; never production). Labelled simulated everywhere. */
export async function createSimulatedHubInstallation(ctx: Ctx, input: { connector: string; brand_id?: string | null }) {
  if (!simulationAllowed()) throw new AppError('forbidden', 'Simulated integrations are disabled in this environment.');
  const connector = input.connector as HubConnector;
  const a = hubAdapter(connector);
  const j = await createSimulatedIntegration(ctx, { connector, brand_id: input.brand_id ?? null, display_name: `${CONNECTORS[connector].name} (simulated)` });
  if (a.simSettings) await getPool().query(`UPDATE integration_connections SET settings = settings || $2::jsonb WHERE id=$1`, [j.id, JSON.stringify(a.simSettings)]);
  return j;
}

export async function setSimScenario(ctx: Ctx, id: string, scenario: string) {
  const r = await loadIntegration(ctx, id, 'integrations.manage');
  if (!r.is_simulated) throw new AppError('invalid_state', 'Scenarios apply to simulated integrations only.');
  if (!SIM_SCENARIOS.includes(scenario as SimScenario)) throw new AppError('validation_failed', 'Unknown scenario');
  await getPool().query(`UPDATE integration_connections SET settings = settings || jsonb_build_object('sim_scenario', $2::text), updated_at=now() WHERE id=$1`, [id, scenario]);
  return { ok: true };
}

// ------------------------------------------------------------------ diagnose / discover / disconnect
export async function diagnoseIntegration(ctx: Ctx, id: string) {
  const r = await loadIntegration(ctx, id, 'integrations.read');
  const a = hubAdapter(r.connector);
  let result: { status: IntegrationStatus; message: string };
  try {
    const c = await openConn(id, { allowPaused: true });
    result = await a.verify(c);
  } catch (err) {
    const e = await appErrorFrom(err, { integrationId: id, workspaceId: r.workspace_id });
    result = { status: (e.details?.reason === 'reconnect_required' ? 'reconnect_required' : 'needs_attention'), message: e.message };
  }
  const fresh = await loadIntegrationRowStatus(id);
  const status: IntegrationStatus = fresh === 'reconnect_required' ? 'reconnect_required' : result.status;
  await getPool().query(`UPDATE integration_connections SET status=CASE WHEN disconnected_at IS NULL THEN $2 ELSE status END, health_message=$3, health_checked_at=now(), updated_at=now() WHERE id=$1`, [id, status, result.message.slice(0, 300)]);
  await recordActivity(getPool(), { workspaceId: r.workspace_id, integrationId: id, kind: 'health', outcome: status === 'active' ? 'ok' : 'error', code: status, message: result.message });
  return { status, message: result.message, checked_at: new Date().toISOString() };
}

async function loadIntegrationRowStatus(id: string): Promise<string | null> {
  return (await maybeOne<{ status: string }>(getPool(), `SELECT status FROM integration_connections WHERE id=$1`, [id]))?.status ?? null;
}

export async function discoverResources(ctx: Ctx, id: string, q: { type?: string | null; parent?: string | null }): Promise<{ items: AvailableResourceJson[] }> {
  const r = await loadIntegration(ctx, id, 'integrations.manage');
  const a = hubAdapter(r.connector);
  const selected = new Map((await listResources(ctx, id)).items.map((x) => [`${x.resource_type}:${x.external_id}`, x.selected]));
  try {
    const c = await openConn(id, { allowPaused: true });
    const items = await a.discover(c, q);
    return { items: items.map((x) => ({ ...x, selected: selected.get(`${x.resource_type}:${x.external_id}`) ?? false })) };
  } catch (err) {
    throw await appErrorFrom(err, { integrationId: id, workspaceId: r.workspace_id });
  }
}

export async function disconnectHubIntegration(ctx: Ctx, id: string): Promise<{ ok: true; provider_revoked: boolean | null }> {
  const r: IntegrationRow = await loadIntegration(ctx, id, 'integrations.manage');
  const a = hubAdapter(r.connector);
  let revoked: boolean | null = null;
  if (a.revoke && !r.disconnected_at && r.credential_id) {
    try { await a.revoke(await openConn(id, { allowPaused: true })); revoked = true; } catch { revoked = false; }
  }
  await disconnectIntegration(ctx, id);
  if (revoked === false) await recordActivity(getPool(), { workspaceId: r.workspace_id, integrationId: id, kind: 'auth', outcome: 'error', code: 'revoke_failed', message: 'Relay deleted its copy of the credentials; revoke the app at the provider too.' });
  await audit(getPool(), { workspaceId: r.workspace_id, brandId: r.brand_id, actorUserId: ctx.actor.userId, action: 'integration.provider_revoke', resourceType: 'integration', resourceId: id, diff: { revoked }, correlationId: ctx.correlationId });
  return { ok: true, provider_revoked: revoked };
}

export { transportFor };

/** Recent sync jobs for one installation (history: state, attempts, error; never payload content). */
export async function listIntegrationJobs(ctx: Ctx, id: string) {
  await loadIntegration(ctx, id, 'integrations.read');
  const rows = await getPool().query<{ id: string; kind: string; relay_type: string; relay_id: string; state: string; attempts: number; external_id: string | null; external_url: string | null; last_error_code: string | null; last_error: string | null; created_at: Date; finished_at: Date | null; next_attempt_at: Date | null }>(
    `SELECT id, kind, relay_type, relay_id, state, attempts, external_id, external_url, last_error_code, last_error, created_at, finished_at, next_attempt_at
       FROM integration_sync_jobs WHERE integration_id=$1 ORDER BY created_at DESC LIMIT 50`, [id]);
  return { items: rows.rows.map((r) => ({ ...r, created_at: r.created_at.toISOString(), finished_at: r.finished_at?.toISOString() ?? null,
    next_attempt_at: ['queued', 'waiting_retry', 'unknown'].includes(r.state) && r.next_attempt_at ? r.next_attempt_at.toISOString() : null })) };
}
