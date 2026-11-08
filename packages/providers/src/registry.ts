// Provider registry. The engine and connection services obtain adapters, connectors and
// transports ONLY through here. A live connection can never receive a mock transport.
import type { OAuthConnector, Provider, PublishingAdapter, TelegramConnector, Transport } from '@social-lite/core';
import { facebookAdapter, facebookConnector, instagramAdapter, instagramConnector, metaFake } from './meta/index.js';
import { telegramAdapter, telegramConnector, telegramFake } from './telegram/index.js';
import { xAdapter, xConnector, xFake } from './x/index.js';
// V3 providers
import { tiktokAdapter, tiktokConnector, tiktokFake } from './tiktok/index.js';
import { youtubeAdapter, youtubeConnector, youtubeFake } from './youtube/index.js';
import { linkedinAdapter, linkedinConnector, linkedinFake } from './linkedin/index.js';
import { threadsAdapter, threadsConnector, threadsFake } from './threads/index.js';
import { pinterestAdapter, pinterestConnector, pinterestFake } from './pinterest/index.js';
import { blueskyAdapter, blueskyConnector, blueskyFake, type BlueskyConnector } from './bluesky/index.js';
import { HttpTransport, type HttpTransportOptions } from './transport/http.js';
import { MockTransport, type FakeHandler, type MockScenario, type MockStore } from './transport/mock.js';

const ADAPTERS: Record<Provider, () => PublishingAdapter> = {
  facebook: () => facebookAdapter,
  instagram: () => instagramAdapter,
  telegram: () => telegramAdapter,
  x: () => xAdapter,
  tiktok: () => tiktokAdapter,
  youtube: () => youtubeAdapter,
  linkedin: () => linkedinAdapter,
  threads: () => threadsAdapter,
  pinterest: () => pinterestAdapter,
  bluesky: () => blueskyAdapter,
};

const FAKES: Record<Provider, () => FakeHandler> = {
  facebook: () => metaFake,
  instagram: () => metaFake,
  telegram: () => telegramFake,
  x: () => xFake,
  tiktok: () => tiktokFake,
  youtube: () => youtubeFake,
  linkedin: () => linkedinFake,
  threads: () => threadsFake,
  pinterest: () => pinterestFake,
  bluesky: () => blueskyFake,
};

export function getAdapter(provider: Provider): PublishingAdapter {
  return ADAPTERS[provider]();
}

export function getOAuthConnector(provider: Provider): OAuthConnector | null {
  if (provider === 'facebook') return facebookConnector;
  if (provider === 'instagram') return instagramConnector;
  if (provider === 'x') return xConnector;
  if (provider === 'tiktok') return tiktokConnector;
  if (provider === 'youtube') return youtubeConnector;
  if (provider === 'linkedin') return linkedinConnector;
  if (provider === 'threads') return threadsConnector;
  if (provider === 'pinterest') return pinterestConnector;
  return null; // telegram (bot token) and bluesky (app password) use their own connectors
}

/** V3: Bluesky connects with an AT Protocol app password (no OAuth redirect). */
export function getBlueskyConnector(): BlueskyConnector {
  return blueskyConnector;
}

export function getTelegramConnector(): TelegramConnector {
  return telegramConnector;
}

export interface TransportSelection {
  provider: Provider;
  providerAccountId: string;
  isMock: boolean;
  /** Must be explicitly true AND not production for mock transport to be returned. */
  mockProvidersEnabled: boolean;
  mockStore?: MockStore;
  mockScenario?: MockScenario;
  liveOptions?: HttpTransportOptions;
}

export class TransportSelectionError extends Error {}

export function transportFor(sel: TransportSelection): Transport {
  if (sel.isMock) {
    if (!sel.mockProvidersEnabled) throw new TransportSelectionError('Simulated destinations are disabled in this environment');
    if (!sel.providerAccountId.startsWith('mock_')) throw new TransportSelectionError('Mock transport requires a mock_ destination');
    if (!sel.mockStore) throw new TransportSelectionError('Mock transport requires a store');
    return new MockTransport(FAKES[sel.provider](), {
      provider: sel.provider, accountId: sel.providerAccountId, scenario: sel.mockScenario ?? 'success', store: sel.mockStore,
    }, Math.max(0, Number(process.env.MOCK_PROVIDER_LATENCY_MS ?? 0) || 0)); // per simulated request (load tests)
  }
  if (sel.providerAccountId.startsWith('mock_')) throw new TransportSelectionError('A mock_ identity cannot use live transport');
  return new HttpTransport(sel.liveOptions);
}
