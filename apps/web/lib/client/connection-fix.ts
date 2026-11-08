import { PROVIDER_LABEL, type ConnectionStatus } from '@social-lite/core';
import type { Connection } from './types';

/** The exact fix a user should apply for a connection's status (AC-04). */
export function connectionFix(c: Pick<Connection, 'status' | 'provider' | 'health' | 'is_mock' | 'paused'>): string | null {
  const p = PROVIDER_LABEL[c.provider];
  const missing = c.health?.missing_permissions?.length ? ` (${c.health.missing_permissions.join(', ')})` : '';
  const map: Record<ConnectionStatus, string | null> = {
    ready: null,
    pending_verification: 'Verifying…',
    missing_permission:
      c.provider === 'telegram'
        ? 'Make the bot a channel admin (“Post messages”), then Check.'
        : `Reconnect and approve all ${p} permissions${missing}.`,
    expiring: `Reconnect ${p} soon.`,
    reconnect_required:
      c.provider === 'telegram'
        ? 'Reconnect with a new @BotFather token.'
        : `Reconnect ${p} to resume.`,
    paused: 'Resume to send.',
    disconnected: 'Connect again to publish.',
  };
  return map[c.status] ?? null;
}

export function isDispatchable(c: Pick<Connection, 'status' | 'paused'>): boolean {
  return (c.status === 'ready' || c.status === 'expiring') && !c.paused;
}
