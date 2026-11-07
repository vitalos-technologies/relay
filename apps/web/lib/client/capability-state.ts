// V3 connection capability states (spec §6): one honest label per connection, derived from its status + capabilities.
// Publishing formats and analytics are reported separately (a connection can publish while lacking analytics).
import type { ChannelCapabilities, Provider } from '@social-lite/core';
import type { Connection } from './types';

export type CapabilityState =
  | 'connected' | 'missing_permission' | 'awaiting_approval' | 'unsupported' | 'reconnect_required' | 'manual_handoff'
  | 'limited' | 'expiring' | 'paused' | 'verifying' | 'disconnected';

export const CAPABILITY_STATE_LABEL: Record<CapabilityState, string> = {
  connected: 'Connected',
  missing_permission: 'Missing permission',
  awaiting_approval: 'Awaiting platform approval',
  unsupported: 'Unsupported for this account',
  reconnect_required: 'Reconnect required',
  manual_handoff: 'Manual handoff',
  limited: 'Limited access',
  expiring: 'Expires soon',
  paused: 'Paused',
  verifying: 'Verifying',
  disconnected: 'Disconnected',
};

export function capabilityState(c: Pick<Connection, 'status' | 'paused' | 'capabilities'>): CapabilityState {
  const caps = c.capabilities as Partial<ChannelCapabilities>;
  if (c.status === 'disconnected') return 'disconnected';
  if (c.status === 'reconnect_required') return 'reconnect_required';
  if (c.status === 'missing_permission') return 'missing_permission';
  if (c.status === 'pending_verification') return 'verifying';
  if (caps.eligibility?.status === 'awaiting_approval') return 'awaiting_approval';
  if (caps.eligibility?.status === 'unsupported') return 'unsupported';
  if (c.status === 'paused' || c.paused) return 'paused';
  if (caps.publishMode === 'manual' || caps.publishMode === 'draft_handoff') return 'manual_handoff';
  if (caps.eligibility?.status === 'restricted') return 'limited';
  if (c.status === 'expiring') return 'expiring';
  return 'connected';
}

const FORMAT_LABEL: Record<string, string> = { text: 'Text', image: 'Image', album: 'Album', video: 'Video', reel: 'Reel', story: 'Story' };
export function formatLabels(c: Pick<Connection, 'capabilities'>): string[] | null {
  const caps = c.capabilities as Partial<ChannelCapabilities>;
  if (!caps.formats) return null;
  return caps.formats.map((f) => FORMAT_LABEL[f] ?? f);
}

/** Networks that connect without app credentials in Setup (bot token / app password). */
export const NO_APP_SETUP: Provider[] = ['telegram', 'bluesky'];
export const OAUTH_PROVIDERS: Provider[] = ['facebook', 'instagram', 'x', 'tiktok', 'youtube', 'linkedin', 'threads', 'pinterest'];
