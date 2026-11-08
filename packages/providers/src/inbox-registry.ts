// V3.5 inbox adapter registry. Inbox services obtain channel adapters ONLY through here (stream B adds Telegram,
// Instagram, WhatsApp, Google Business Profile, YouTube, …). Transport selection stays in registry.ts: a live
// connection never receives a mock transport.
import type { ChannelKind, InboxAdapter } from '@social-lite/core/contracts/v35-inbox';
import type { Provider } from '@social-lite/core';
import { facebookInboxAdapter } from './meta/inbox.js';

const INBOX_ADAPTERS: Partial<Record<ChannelKind, InboxAdapter>> = {
  facebook_page: facebookInboxAdapter,
};

/** Channel kind served by a social connection's provider (null: no inbox adapter for it yet). */
export const PROVIDER_CHANNEL: Partial<Record<Provider, ChannelKind>> = {
  facebook: 'facebook_page',
};

export function getInboxAdapter(kind: ChannelKind): InboxAdapter | null {
  return INBOX_ADAPTERS[kind] ?? null;
}

export function implementedChannelKinds(): ChannelKind[] {
  return Object.keys(INBOX_ADAPTERS) as ChannelKind[];
}
