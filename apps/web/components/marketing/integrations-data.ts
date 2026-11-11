// Integrations read model (brief §4 Integrations; the section is "Works with the tools you already use" since 2026-11-11). Only integrations that are IMPLEMENTED in Relay appear, each with
// an honest status taken from the capability records:
//   - publishing networks: core PROVIDERS + docs/PROVIDER_CAPABILITIES.md (main gate per network),
//   - inbox: packages/services/src/inbox/capabilities.ts (CHANNEL_CAPABILITIES, implementedChannelKinds),
//   - business tools: packages/services/src/connectors/registry.ts (CONNECTORS prerequisites) + content hub (Drive, Notion),
//   - MCP: Relay's own MCP server (Professional).
// Nothing here has been verified against a live provider (docs/v3-5/CAPABILITY_MATRIX.md "Final status"); every network
// that needs provider review, a paid API or a commercial account says so. Icons identify the service only — no
// endorsement or customer relationship is implied (stated under the grid).
import { PROVIDERS, PROVIDER_LABEL, type Provider } from '@social-lite/core';
import type { ConnectorKey } from '@social-lite/core/contracts/v35-connectors';

export type IntegrationStatus = 'available' | 'provider_access' | 'limited';

export const STATUS_LABEL: Record<IntegrationStatus, string> = {
  available: 'Available',
  provider_access: 'Needs provider access',
  limited: 'Limited',
};

export const STATUS_HELP: Record<IntegrationStatus, string> = {
  available: 'Connect with your own account details. No provider review needed.',
  provider_access: 'Built in Relay. Goes live once the provider approves Relay’s app or API access.',
  limited: 'Works with the provider limits named on the tile.',
};

export interface NetworkEntry {
  provider: Provider;
  name: string;
  status: IntegrationStatus;
  /** What Relay does with it (publishing / inbox), short. */
  does: string;
  /** Why it is limited / what access it needs. */
  note: string;
}

const NETWORK_INFO: Record<Provider, Omit<NetworkEntry, 'provider' | 'name'>> = {
  instagram: { status: 'provider_access', does: 'Posts, reels, carousels · DMs and comments', note: 'Meta app review' },
  facebook: { status: 'provider_access', does: 'Page posts · Messenger and comments', note: 'Meta app review' },
  threads: { status: 'provider_access', does: 'Posts · replies', note: 'Meta app review' },
  x: { status: 'provider_access', does: 'Posts', note: 'Paid X API credits' },
  linkedin: { status: 'provider_access', does: 'Member and page posts', note: 'LinkedIn API approval for pages' },
  youtube: { status: 'provider_access', does: 'Videos · comments', note: 'Google app verification' },
  tiktok: { status: 'limited', does: 'Videos and photo posts', note: 'Private posts until TikTok audits the app' },
  pinterest: { status: 'limited', does: 'Pins on chosen boards', note: 'Pins visible only to you on trial API access' },
  telegram: { status: 'available', does: 'Channel posts · bot chats', note: 'Your bot token' },
  bluesky: { status: 'available', does: 'Posts · replies, mentions, DMs', note: 'Your app password' },
};

/** Every publishing network Relay implements (core PROVIDERS order). */
export function networks(): NetworkEntry[] {
  return PROVIDERS.map((p) => ({ provider: p, name: PROVIDER_LABEL[p], ...NETWORK_INFO[p] }));
}

export type ToolKey = ConnectorKey | 'google_drive' | 'notion' | 'mcp';

export interface ToolEntry {
  key: ToolKey;
  name: string;
  status: IntegrationStatus;
  does: string;
  note: string;
  /** Plan that includes it (catalogue feature `integrations_business` / `mcp` are Professional; D33: Free has no integrations). */
  plan: 'paid' | 'professional';
}

export const TOOLS: ToolEntry[] = [
  { key: 'slack', name: 'Slack', status: 'provider_access', does: 'Alerts and approvals in channels you choose', note: 'Relay Slack app', plan: 'professional' },
  { key: 'asana', name: 'Asana', status: 'provider_access', does: 'Tasks from posts and conversations', note: 'Relay Asana app', plan: 'professional' },
  { key: 'monday', name: 'monday.com', status: 'provider_access', does: 'Items on boards you choose', note: 'Relay monday app', plan: 'professional' },
  { key: 'hubspot', name: 'HubSpot', status: 'provider_access', does: 'CRM context and tickets', note: 'Relay HubSpot app', plan: 'professional' },
  { key: 'mailchimp', name: 'Mailchimp', status: 'provider_access', does: 'Draft campaigns from approved posts', note: 'Relay Mailchimp app', plan: 'professional' },
  { key: 'google_business_profile', name: 'Google Business Profile', status: 'provider_access', does: 'Local posts and review replies', note: 'Google API approval', plan: 'professional' },
  { key: 'google_translate', name: 'Google Cloud Translation', status: 'provider_access', does: 'Translations, originals kept', note: 'Google Cloud billing', plan: 'professional' },
  { key: 'whatsapp', name: 'WhatsApp Business', status: 'limited', does: 'Customer chats in the inbox', note: 'Your WhatsApp Business account · Meta charges per message', plan: 'paid' },
  { key: 'google_drive', name: 'Google Drive', status: 'provider_access', does: 'Pick files and docs into drafts', note: 'Google app verification', plan: 'paid' },
  { key: 'notion', name: 'Notion', status: 'provider_access', does: 'Turn pages and rows into drafts', note: 'Relay Notion app', plan: 'paid' },
  { key: 'mcp', name: 'MCP for AI clients', status: 'available', does: 'Use Relay from your AI assistant, with your permissions', note: 'Professional plan', plan: 'professional' },
];
