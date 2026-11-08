// Relay support (V4 SUP) — worker sweeps (apps/worker/src/main.ts):
//  * support access: lapse unanswered requests and END expired grants (revokes the viewer grant, removes a membership
//    created for it, bumps the policy version so open sessions/streams lose access) — previously only lazy on reads;
//  * uploads never attached within an hour are deleted (object + row);
//  * resolved tickets are archived after SUPPORT_AUTO_ARCHIVE_DAYS; archived tickets are purged after
//    SUPPORT_RETENTION_DAYS_AFTER_ARCHIVE (objects first, then the ticket row — messages, notes, activity cascade);
//  * AI draft output older than 30 days is dropped.
import { SUPPORT_AUTO_ARCHIVE_DAYS, SUPPORT_RETENTION_DAYS_AFTER_ARCHIVE } from '@social-lite/core/contracts/v4-support';
import { getPool, many, withTx, type Pool } from '@social-lite/db';
import { sweepSupportAccess } from '../admin/support-access.js';
import { deleteObject } from '../storage.js';
import { log } from '../log.js';
import { sweepStaleUploads } from './attachments.js';
import { writeActivity } from './shared.js';

export async function sweepSupportAccessExpiry(pool: Pool = getPool()): Promise<number> {
  return sweepSupportAccess(pool);
}

export async function autoArchiveResolved(pool: Pool = getPool(), limit = 200): Promise<number> {
  const rows = await many<{ id: string }>(pool,
    `SELECT id FROM support_tickets WHERE status='resolved' AND resolved_at < now() - make_interval(days => $1) ORDER BY resolved_at LIMIT $2`, [SUPPORT_AUTO_ARCHIVE_DAYS, limit]);
  for (const r of rows) {
    await withTx(async (tx) => {
      const u = await tx.query(`UPDATE support_tickets SET status='archived', archived_at=now(), updated_at=now() WHERE id=$1 AND status='resolved'`, [r.id]);
      if (u.rowCount) await writeActivity(tx, { ticketId: r.id, audience: 'customer', kind: 'status.archived', actorKind: 'system' });
    }, pool);
  }
  return rows.length;
}

export async function purgeExpiredTickets(pool: Pool = getPool(), limit = 50): Promise<number> {
  const rows = await many<{ id: string }>(pool,
    `SELECT id FROM support_tickets WHERE status='archived' AND archived_at < now() - make_interval(days => $1) ORDER BY archived_at LIMIT $2`, [SUPPORT_RETENTION_DAYS_AFTER_ARCHIVE, limit]);
  for (const r of rows) {
    const files = await many<{ storage_key: string }>(pool, `SELECT storage_key FROM support_attachments WHERE ticket_id=$1 AND state <> 'deleted'`, [r.id]);
    for (const f of files) await deleteObject(f.storage_key).catch((err) => log.warn('support_purge_object_failed', { err: err as Error }));
    await pool.query(`DELETE FROM support_tickets WHERE id=$1`, [r.id]);
  }
  return rows.length;
}

export async function runSupportSweeps(pool: Pool = getPool()): Promise<void> {
  for (const [name, fn] of [
    ['access', () => sweepSupportAccessExpiry(pool)],
    ['uploads', () => sweepStaleUploads(pool)],
    ['archive', () => autoArchiveResolved(pool)],
    ['purge', () => purgeExpiredTickets(pool)],
    ['ai', () => pool.query(`DELETE FROM support_ai_drafts WHERE created_at < now() - interval '30 days'`)],
    // V5 WID: visitor email retries, verification/session/visitor housekeeping (widget-sweeps.ts).
    ['widget', async () => { const { sweepWidget } = await import('./widget-sweeps.js'); await sweepWidget(pool); }],
  ] as const) {
    try { await fn(); } catch (err) { log.warn('support_sweep_failed', { sweep: name, err: err as Error }); }
  }
}
