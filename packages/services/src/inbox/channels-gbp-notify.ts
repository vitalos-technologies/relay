// Stream F wiring (stream B ↔ C): a verified Google Business Profile Pub/Sub review notification (C's handler,
// integrations-v35/gbp/service.ts → onGbpNotification) triggers an immediate poll of the matching Google reviews inbox
// channel(s). The notification only says "something changed at this location"; the review itself is always read from
// the API by the normal poll (same adapter, cursor, dedupe and channel scoping), so nothing is trusted from the push.
import { getPool, many } from '@social-lite/db';
import { log } from '../log.js';
import { onGbpNotification } from '../integrations-v35/gbp/service.js';
import { pollChannel, type PollOutcome } from './channels-poll.js';

export async function onGbpReviewNotification(n: { integrationIds: string[]; notificationType: string; locationName: string | null }): Promise<Array<{ channelId: string; outcome: PollOutcome }>> {
  if (!n.integrationIds.length || !/review/i.test(n.notificationType)) return [];
  const rows = await many<{ id: string }>(getPool(),
    `SELECT id FROM inbox_channels WHERE kind='google_business_profile' AND disconnected_at IS NULL AND integration_id = ANY($1::uuid[])
        AND ($2::text IS NULL OR external_account_id=$2) LIMIT 20`, [n.integrationIds, n.locationName]);
  const out: Array<{ channelId: string; outcome: PollOutcome }> = [];
  for (const r of rows) {
    const outcome = await pollChannel(r.id);
    if (outcome.state === 'error') log.warn('inbox.gbp_notification_poll_failed', { channelId: r.id, code: outcome.code });
    out.push({ channelId: r.id, outcome });
  }
  return out;
}

let installed = false;
export function registerGbpReviewNotifications(): void {
  if (installed) return;
  installed = true;
  onGbpNotification(async (n) => { await onGbpReviewNotification(n); });
}
