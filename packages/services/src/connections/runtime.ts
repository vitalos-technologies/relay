// Provider runtime wiring for connections and the engine: app configuration (env first, then
// setup page via getSetting), adapter contexts and transport selection.
// A live connection ALWAYS gets the live HTTP transport (never a mock fallback); a mock_ connection
// gets the simulated API only when mockProvidersEnabled().
import type { AdapterContext, Provider, ProviderAppConfig, PublishConnection, Transport } from '@social-lite/core';
import { HttpTransport, MOCK_SCENARIOS, transportFor, type MockScenario } from '@social-lite/providers';
import { config, mockProvidersEnabled } from '../config.js';
import { log } from '../log.js';
import { DbMockStore } from '../mock-store.js';
import { getSetting } from '../settings.js';

export type OAuthProvider = 'facebook' | 'instagram' | 'x';
export const OAUTH_PROVIDERS: readonly OAuthProvider[] = ['facebook', 'instagram', 'x'];
export const isOAuthProvider = (p: string): p is OAuthProvider => (OAUTH_PROVIDERS as readonly string[]).includes(p);

export function oauthRedirectUri(provider: Provider): string {
  return `${config().APP_BASE_URL.replace(/\/$/, '')}/api/oauth/${provider}/callback`;
}

/** Provider app configuration. Secrets are only held in memory for the call; never logged. */
export async function providerAppConfig(provider: Provider): Promise<ProviderAppConfig> {
  if (provider === 'facebook' || provider === 'instagram') {
    return {
      clientId: await getSetting('META_APP_ID'),
      clientSecret: await getSetting('META_APP_SECRET'),
      apiVersion: (await getSetting('META_GRAPH_VERSION')) ?? config().META_GRAPH_VERSION,
      redirectUri: oauthRedirectUri(provider),
    };
  }
  if (provider === 'x') {
    return { clientId: await getSetting('X_CLIENT_ID'), clientSecret: await getSetting('X_CLIENT_SECRET'), redirectUri: oauthRedirectUri('x') };
  }
  return {};
}

const onLog = (e: { op: string; method: string; url: string; status?: number; ms: number; error?: string }) => {
  // url is already redacted by the transport (Telegram /bot<token>/ path, token query params).
  if (e.error || (e.status ?? 0) >= 400) log.warn('provider_http', e);
  else log.debug('provider_http', e);
};

// ------------------------------------------------------------------ test seam
type LiveTransportFactory = (provider: Provider) => Transport;
let liveFactory: LiveTransportFactory | null = null;

/**
 * TEST SEAM: replace the live HTTP transport (e.g. with a FakeHandler-backed transport) for
 * integration tests. Refused in production.
 */
export function setLiveTransportFactoryForTests(f: LiveTransportFactory | null): void {
  if (config().APP_ENV === 'production') throw new Error('live transport override is not available in production');
  liveFactory = f;
}

function liveTransport(provider: Provider): Transport {
  if (liveFactory && config().APP_ENV !== 'production') return liveFactory(provider);
  return new HttpTransport({ onLog });
}

export function scenarioOf(metadata: Record<string, unknown>): MockScenario {
  const s = metadata.mock_scenario;
  return typeof s === 'string' && (MOCK_SCENARIOS as string[]).includes(s) ? (s as MockScenario) : 'success';
}

/** Adapter context for an existing connection (engine, health checks, refresh). */
export async function buildAdapterContext(provider: Provider, connection: PublishConnection): Promise<AdapterContext> {
  const cfg = await providerAppConfig(provider);
  let transport: Transport;
  if (connection.isMock) {
    transport = transportFor({
      provider, providerAccountId: connection.providerAccountId, isMock: true, mockProvidersEnabled: mockProvidersEnabled(),
      mockStore: new DbMockStore(), mockScenario: scenarioOf(connection.metadata),
    });
  } else {
    // transportFor enforces that a mock_ identity can never use live transport; the test seam is
    // applied only after that check.
    transport = transportFor({ provider, providerAccountId: connection.providerAccountId, isMock: false, mockProvidersEnabled: false, liveOptions: { onLog } });
    if (liveFactory) transport = liveTransport(provider);
  }
  return { transport, now: () => new Date(), config: cfg };
}

/** Adapter context for connection setup (no destination yet): always the live transport. */
export async function setupContext(provider: Provider): Promise<AdapterContext> {
  return { transport: liveTransport(provider), now: () => new Date(), config: await providerAppConfig(provider) };
}
