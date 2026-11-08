// V3.5 inbox adapter registry. Inbox services obtain channel adapters ONLY through here (stream B adds Telegram,
// Instagram, WhatsApp, Google Business Profile, YouTube, …). Transport selection stays in registry.ts: a live
// connection never receives a mock transport.
import type { ChannelKind, InboxAdapter } from '@social-lite/core/contracts/v35-inbox';
import type { HttpRequest, HttpResponse, Provider, Transport } from '@social-lite/core';
import { facebookInboxAdapter } from './meta/inbox.js';
// Stream B adapters
import { instagramInboxAdapter } from './meta/inbox-instagram.js';
import { whatsAppInboxAdapter } from './whatsapp/inbox.js';
import { googleBusinessInboxAdapter } from './google-business/inbox.js';
import { youtubeInboxAdapter } from './youtube/inbox.js';
import { blueskyInboxAdapter } from './bluesky/inbox.js';
import { telegramInboxAdapter } from './telegram/inbox.js';
import { threadsInboxAdapter } from './threads/inbox.js';
import { whatsAppFake } from './whatsapp/inbox-fake.js';
import { googleBusinessFake } from './google-business/inbox-fake.js';
import { youtubeInboxFake } from './youtube/inbox-fake.js';
import { blueskyInboxFake } from './bluesky/inbox-fake.js';
import { telegramInboxFake } from './telegram/inbox-fake.js';
import { threadsInboxFake } from './threads/inbox-fake.js';
import { metaFake } from './meta/index.js';
import { telegramFake } from './telegram/index.js';
import { youtubeFake } from './youtube/index.js';
import { blueskyFake } from './bluesky/index.js';
import { threadsFake } from './threads/index.js';
import { MockTransport, json, type FakeEnv, type FakeHandler, type MockScenario, type MockStore } from './transport/mock.js';

const INBOX_ADAPTERS: Partial<Record<ChannelKind, InboxAdapter>> = {
  facebook_page: facebookInboxAdapter,
  instagram: instagramInboxAdapter,
  whatsapp: whatsAppInboxAdapter,
  google_business_profile: googleBusinessInboxAdapter,
  youtube: youtubeInboxAdapter,
  bluesky: blueskyInboxAdapter,
  telegram_bot: telegramInboxAdapter,
  threads: threadsInboxAdapter,
};

/** Channel kind served by a social connection's provider (null: no inbox adapter for it yet). */
export const PROVIDER_CHANNEL: Partial<Record<Provider, ChannelKind>> = {
  facebook: 'facebook_page',
  instagram: 'instagram',
  telegram: 'telegram_bot',
  youtube: 'youtube',
  bluesky: 'bluesky',
  threads: 'threads',
};

/** Channels backed by a business integration (integration_connections.connector) instead of a social connection. */
export const INTEGRATION_CHANNEL: Partial<Record<string, ChannelKind>> = {
  whatsapp: 'whatsapp',
  google_business_profile: 'google_business_profile',
};

export function getInboxAdapter(kind: ChannelKind): InboxAdapter | null {
  return INBOX_ADAPTERS[kind] ?? null;
}

export function implementedChannelKinds(): ChannelKind[] {
  return Object.keys(INBOX_ADAPTERS) as ChannelKind[];
}

// ------------------------------------------------------------------ simulated transport for inbox channels (stream B)
type InboxFake = (req: HttpRequest, env: FakeEnv) => Promise<HttpResponse | null>;
const INBOX_FAKES: Partial<Record<ChannelKind, { inbox: InboxFake | null; fallback: FakeHandler | null }>> = {
  facebook_page: { inbox: null, fallback: metaFake },          // metaFake routes Messenger/comments (meta/inbox-fake.ts)
  instagram: { inbox: null, fallback: metaFake },              // … and Instagram (meta/inbox-instagram-fake.ts)
  whatsapp: { inbox: whatsAppFake, fallback: null },
  google_business_profile: { inbox: googleBusinessFake, fallback: null },
  youtube: { inbox: youtubeInboxFake, fallback: youtubeFake },
  bluesky: { inbox: blueskyInboxFake, fallback: blueskyFake },
  telegram_bot: { inbox: telegramInboxFake, fallback: telegramFake },
  threads: { inbox: threadsInboxFake, fallback: threadsFake },
};

/** Store tag of each channel's simulated API (mock_provider_objects.provider). */
export const INBOX_MOCK_PROVIDER: Record<ChannelKind, Provider> = {
  facebook_page: 'facebook', instagram: 'instagram', whatsapp: 'facebook', google_business_profile: 'youtube', youtube: 'youtube', bluesky: 'bluesky',
  telegram_bot: 'telegram', threads: 'threads', x: 'x', linkedin: 'linkedin', tiktok: 'tiktok',
};

export interface InboxMockSelection { kind: ChannelKind; providerAccountId: string; mockProvidersEnabled: boolean; mockStore: MockStore; mockScenario?: MockScenario }

/**
 * Simulated transport for a SIMULATED inbox channel (mock_ identity, mock providers enabled, never production —
 * the caller checks the environment, this checks the identity). Live channels never come here: they use
 * registry.transportFor / the live HTTP transport.
 */
export function inboxMockTransport(sel: InboxMockSelection): Transport {
  if (!sel.mockProvidersEnabled) throw new Error('Simulated destinations are disabled in this environment');
  if (!sel.providerAccountId.startsWith('mock_')) throw new Error('Mock transport requires a mock_ identity');
  const f = INBOX_FAKES[sel.kind];
  if (!f) throw new Error('No simulated API for this channel');
  const handler: FakeHandler = async (req, env) => {
    const r = f.inbox ? await f.inbox(req, env) : null;
    if (r) return r;
    return f.fallback ? f.fallback(req, env) : json(404, { error: { message: 'Not found (simulated)' } });
  };
  return new MockTransport(handler, { provider: INBOX_MOCK_PROVIDER[sel.kind], accountId: sel.providerAccountId, scenario: sel.mockScenario ?? 'success', store: sel.mockStore });
}
