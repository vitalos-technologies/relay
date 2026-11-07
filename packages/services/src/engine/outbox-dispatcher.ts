// Outbox dispatcher (spec §11 step 4): moves committed outbox rows into the pg-boss queue using a
// deterministic job id derived from the outbox id, then marks them dispatched. If the process dies
// after enqueue but before marking, the next pass re-sends with the same id and pg-boss ignores the
// duplicate. A due-work sweep in the worker independently claims due deliveries, so a lost wake-up
// can only delay — never drop — publication.
import { PgBoss } from 'pg-boss';
import { v5 as uuidv5 } from 'uuid';
import { getPool, many, withTx, type Pool } from '@social-lite/db';
import { log } from '../log.js';

const NAMESPACE = '6b1d2b4e-58f7-4d0a-9d47-4a2f1d1f5c11';
export const QUEUE_DELIVERY_DUE = 'delivery-due';
export const QUEUE_EVENTS = 'events';
/** V3.1 'video' workload class: uploaded videos are validated/transcoded on their own queue (not behind notifications). */
export const QUEUE_MEDIA_TRANSCODE = 'media-transcode';
/** V3 workload-class queues (event type → queue). Publishing (delivery-due) keeps its own queue and priority. */
export const WORKLOAD_QUEUES: Record<string, string> = {
  // V3 Content Hub (content-hub/jobs.ts)
  'source.import_requested': 'source-import', 'source.changes_signal': 'source-import',
  'export.requested': 'report-export', 'writeback.requested': 'writeback',
  // V3.1 bulk jobs (data/bulk.ts)
  'bulk.requested': 'bulk-ops',
  // V3.1 PERF workload isolation (workload/policy.ts)
  'asset.uploaded': QUEUE_MEDIA_TRANSCODE,
};

export function jobIdFor(outboxId: string): string {
  return uuidv5(`outbox:${outboxId}`, NAMESPACE);
}

export async function startBoss(connectionString: string): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, schema: 'pgboss', max: 4 });
  boss.on('error', (err) => log.error('pgboss_error', { err }));
  await boss.start();
  for (const q of [QUEUE_DELIVERY_DUE, QUEUE_EVENTS, ...new Set(Object.values(WORKLOAD_QUEUES))]) {
    await boss.createQueue(q, { retryLimit: 5, retryDelay: 10, retryBackoff: true }).catch((err: Error) => {
      if (!/already exists/i.test(err.message)) throw err;
    });
  }
  return boss;
}

interface OutboxRow { id: string; workspace_id: string | null; aggregate_type: string; aggregate_id: string; event_type: string; payload: Record<string, unknown>; attempts: number }

export async function dispatchOutbox(boss: Pick<PgBoss, 'send'>, pool: Pool = getPool(), batch = 50): Promise<number> {
  return withTx(async (tx) => {
    const rows = await many<OutboxRow>(tx,
      `SELECT id::text, workspace_id, aggregate_type, aggregate_id, event_type, payload, attempts FROM outbox
        WHERE dispatch_state='pending' AND available_at <= now() ORDER BY available_at, id LIMIT $1 FOR UPDATE SKIP LOCKED`, [batch]);
    for (const r of rows) {
      const queue = r.event_type === 'delivery.due' ? QUEUE_DELIVERY_DUE : WORKLOAD_QUEUES[r.event_type] ?? QUEUE_EVENTS;
      try {
        await boss.send(queue, { outboxId: r.id, eventType: r.event_type, aggregateId: r.aggregate_id, workspaceId: r.workspace_id, payload: r.payload },
          { id: jobIdFor(r.id) });
        await tx.query(`UPDATE outbox SET dispatch_state='dispatched', dispatched_at=now(), attempts=attempts+1 WHERE id=$1`, [r.id]);
      } catch (err) {
        const dead = r.attempts + 1 >= 10;
        await tx.query(`UPDATE outbox SET attempts=attempts+1, last_error=$2, dispatch_state=$3, available_at=now() + interval '30 seconds' WHERE id=$1`,
          [r.id, (err as Error).message.slice(0, 300), dead ? 'dead' : 'pending']);
      }
    }
    return rows.length;
  }, pool);
}
