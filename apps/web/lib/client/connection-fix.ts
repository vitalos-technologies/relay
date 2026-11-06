import { PROVIDER_LABEL, type ConnectionStatus } from '@social-lite/core';
import type { Connection } from './types';

/** The exact fix a user should apply for a connection's status (AC-04). */
export function connectionFix(c: Pick<Connection, 'status' | 'provider' | 'health' | 'is_mock' | 'paused'>): string | null {
  const p = PROVIDER_LABEL[c.provider];
  const missing = c.health?.missing_permissions?.length ? ` (${c.health.missing_permissions.join(', ')})` : '';
  const map: Record<ConnectionStatus, string | null> = {
    ready: null,
    pending_verification: 'We’re verifying this destination. It can publish once it shows Ready.',
    missing_permission:
      c.provider === 'telegram'
        ? 'Make the bot an administrator of the channel with “Post messages” enabled, then run Check.'
        : `Reconnect and approve every requested ${p} permission${missing}.`,
    expiring: `Access expires soon. Reconnect ${p} to keep publishing without interruption.`,
    reconnect_required:
      c.provider === 'telegram'
        ? 'The bot token no longer works. Reconnect with a valid token from @BotFather.'
        : `${p} access was revoked or expired. Reconnect to resume publishing.`,
    paused: 'Paused — scheduled posts for this destination won’t send. Resume it to continue.',
    disconnected: 'Disconnected. Queued posts for it are blocked. Connect it again to publish here.',
  };
  return map[c.status] ?? null;
}

export function isDispatchable(c: Pick<Connection, 'status' | 'paused'>): boolean {
  return (c.status === 'ready' || c.status === 'expiring') && !c.paused;
}
