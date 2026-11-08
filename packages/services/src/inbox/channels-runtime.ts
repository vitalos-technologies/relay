// V3.5 stream B — provider runtime for an inbox channel (adapter context + credentials + connection view), shared by
// replies, polling, moderation, attachments and templates. Two channel sources:
//  - social connections (Facebook, Instagram, Telegram, YouTube, Bluesky, Threads): credentials via getUsableCredentials
//    (refresh included);
//  - business integrations (WhatsApp, Google Business Profile): credentials from the integration's encrypted vault entry.
// Transport rule (unchanged from the foundation): a live channel ALWAYS gets the live HTTP transport (buildAdapterContext
// or the allow-listed HttpTransport); a simulated (mock_) channel gets the simulated API only when mock providers are
// enabled and never in production. There is no fallback from one to the other.
import type { AdapterContext, Provider, ProviderCredentials, PublishConnection } from '@social-lite/core';
import { getInboxAdapter, inboxMockTransport } from '@social-lite/providers';
import type { InboxAdapter } from '@social-lite/core/contracts/v35-inbox';
import { getPool, maybeOne, type Queryable } from '@social-lite/db';
import { config, mockProvidersEnabled } from '../config.js';
import { credentialAad, decryptSecret, type EncryptedBlob } from '../crypto.js';
import { DbMockStore } from '../mock-store.js';
import { buildAdapterContext, getUsableCredentials, CredentialUnavailableError, providerAppConfig } from '../connections/index.js';
import { scenarioOf } from '../connections/runtime.js';
import type { IntegrationRow } from '../connectors/store.js';
import type { ChannelRow } from './shared.js';

export interface ChannelRuntime { adapter: InboxAdapter; ctx: AdapterContext; creds: ProviderCredentials; conn: PublishConnection; simulated: boolean }

export class ChannelUnavailableError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly code = 'channel_unavailable') { super(message); this.name = 'ChannelUnavailableError'; }
}

/** Provider used for app config / live transport of integration-backed channels. */
const INTEGRATION_PROVIDER: Record<string, Provider> = { whatsapp: 'facebook', google_business_profile: 'youtube' };

function mockCtx(ch: ChannelRow, providerAccountId: string, scenario: Record<string, unknown>, cfg: AdapterContext['config']): AdapterContext {
  if (config().APP_ENV === 'production' || !mockProvidersEnabled()) throw new ChannelUnavailableError('Simulated channels are disabled in this environment.', false);
  return { transport: inboxMockTransport({ kind: ch.kind, providerAccountId, mockProvidersEnabled: true, mockStore: new DbMockStore(), mockScenario: scenarioOf(scenario) }), now: () => new Date(), config: cfg };
}

export async function channelRuntime(ch: ChannelRow, db: Queryable = getPool()): Promise<ChannelRuntime> {
  const adapter = getInboxAdapter(ch.kind);
  if (!adapter) throw new ChannelUnavailableError('This network has no inbox support in Relay yet.', false);
  if (ch.connection_id) {
    let u;
    try { u = await getUsableCredentials(ch.connection_id); } catch (err) {
      if (err instanceof CredentialUnavailableError) throw new ChannelUnavailableError(err.message, err.retryable, 'reconnect_required');
      throw err;
    }
    const conn: PublishConnection = { id: u.connection.id, provider: u.connection.provider, providerAccountId: u.connection.providerAccountId, displayName: u.connection.displayName, username: u.connection.username, metadata: u.connection.metadata, isMock: u.connection.isMock };
    const ctx = conn.isMock ? mockCtx(ch, conn.providerAccountId, conn.metadata, await providerAppConfig(conn.provider)) : await buildAdapterContext(conn.provider, conn);
    return { adapter, ctx, creds: u.credentials, conn, simulated: conn.isMock };
  }
  if (!ch.integration_id) throw new ChannelUnavailableError('This channel has no connected account.', false);
  const row = await maybeOne<IntegrationRow & { encrypted_blob: EncryptedBlob | null }>(db,
    `SELECT i.*, c.encrypted_blob FROM integration_connections i LEFT JOIN credentials c ON c.id=i.credential_id AND c.workspace_id=i.workspace_id WHERE i.id=$1`, [ch.integration_id]);
  if (!row || row.disconnected_at) throw new ChannelUnavailableError('The integration was disconnected. Reconnect it to receive and send messages.', false, 'reconnect_required');
  if (row.status === 'reconnect_required') throw new ChannelUnavailableError(row.health_message ?? 'Reconnect the integration.', false, 'reconnect_required');
  if (row.paused) throw new ChannelUnavailableError('The integration is paused.', true, 'integration_paused');
  if (!row.encrypted_blob) throw new ChannelUnavailableError('No stored credentials. Reconnect the integration.', false, 'reconnect_required');
  let creds: ProviderCredentials;
  try { creds = decryptSecret<ProviderCredentials>(row.encrypted_blob, credentialAad(row.workspace_id)); } catch { throw new ChannelUnavailableError('Stored credentials could not be decrypted. Reconnect the integration.', false, 'reconnect_required'); }
  const provider = INTEGRATION_PROVIDER[row.connector] ?? 'facebook';
  const settings = ch.settings ?? {};
  const conn: PublishConnection = {
    id: row.id, provider, providerAccountId: row.external_account_id, displayName: row.display_name, username: null, isMock: row.is_simulated,
    metadata: { ...row.settings, waba_id: row.external_account_id, phone_number_id: ch.kind === 'whatsapp' ? ch.external_account_id : undefined, location: ch.kind === 'google_business_profile' ? ch.external_account_id : undefined, mock_scenario: settings.mock_scenario },
  };
  if (conn.isMock && !conn.providerAccountId.startsWith('mock_')) throw new ChannelUnavailableError('Invalid simulated integration.', false);
  const cfg = await providerAppConfig(provider);
  const ctx = conn.isMock ? mockCtx(ch, conn.providerAccountId, conn.metadata, cfg) : await buildAdapterContext(provider, { ...conn, providerAccountId: conn.providerAccountId });
  return { adapter, ctx, creds, conn, simulated: conn.isMock };
}
