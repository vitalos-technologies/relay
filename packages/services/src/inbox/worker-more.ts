// V3.5 stream B worker wiring (one call in apps/worker/src/main.ts): the WhatsApp verified-webhook handler, processing
// of updates received on Relay-owned channel webhooks (Telegram), polling + reconciliation cursors, CSAT expiry,
// integration-backed channel health and stream B retention. All loops are bounded and idempotent.
import type { PgBoss } from 'pg-boss';
import { getPool } from '@social-lite/db';
import { log } from '../log.js';
import { deleteObject } from '../storage.js';
import { registerGbpReviewNotifications } from './channels-gbp-notify.js';
import type { V35WorkerDeps } from './worker.js';
import { onInboxEvent } from './hooks.js';
import { registerWhatsAppInbound } from './channels-whatsapp.js';
import { processInboundEvents } from './channels-telegram.js';
import { sweepPolls } from './channels-poll.js';
import { sweepCsat } from './csat.js';
import { refreshIntegrationChannels } from './channels-integration.js';

/** Register handlers that must exist in every process that processes events (worker + tests). Idempotent. */
export function registerInboxMoreHandlers(): void {
  registerWhatsAppInbound();
  registerGbpReviewNotifications();   // stream F: verified GBP Pub/Sub review notifications → poll the location's channel
  onInboxEvent('inbox.inbound_received', 'stream-b:inbound-store', async (e) => { await processInboundEvents(e.aggregateId); });
}

export async function registerInboxMoreWorkers(_boss: PgBoss, d: V35WorkerDeps): Promise<NodeJS.Timeout[]> {
  registerInboxMoreHandlers();
  const every = (name: string, ms: number, fn: () => Promise<unknown>) => {
    let running = false;
    const tick = async () => {
      if (d.stopping() || running) return;
      running = true;
      try { await fn(); } catch (err) { log.error('loop_failed', { loop: name, err: err as Error }); } finally { running = false; }
    };
    void tick();
    return setInterval(tick, ms);
  };
  return [
    // Inbound updates whose queue wake-up was lost (stored before the 200, so nothing is lost).
    every('inbox-inbound', 30_000, () => d.run('inbox_ingest', { queue: 'inbox-inbound-sweep' }, () => processInboundEvents(null, 100))),
    // Polling channels (YouTube, Bluesky, Threads, Google reviews): per-adapter interval, backoff, bounded.
    every('inbox-poll', 30_000, () => d.run('inbox_ingest', { queue: 'inbox-poll' }, () => sweepPolls(20))),
    every('inbox-more-sweeps', 60_000, () => d.run('inbox_ingest', { queue: 'inbox-sweeps' }, async () => { await sweepCsat(); await refreshIntegrationChannels(); })),
    // Retention: raw inbound update bodies 7 days; stored files of messages deleted at the provider removed.
    every('inbox-more-retention', 60 * 60_000, async () => {
      const db = getPool();
      await db.query(`UPDATE inbox_inbound_events SET body=NULL WHERE body IS NOT NULL AND received_at < now() - interval '7 days'`);
      await db.query(`DELETE FROM inbox_inbound_events WHERE received_at < now() - interval '30 days'`);
      const gone = await db.query<{ id: string; storage_key: string | null }>(`DELETE FROM inbox_attachments a USING inbox_messages m WHERE m.id=a.message_id AND m.deleted_at IS NOT NULL RETURNING a.id, a.storage_key`);
      for (const r of gone.rows) if (r.storage_key) await deleteObject(r.storage_key).catch(() => undefined);
    }),
  ];
}
