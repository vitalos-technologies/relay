// V5 WID — worker housekeeping for the support widget (runs inside the existing support-sweeps job, every 60 s):
//  * retry visitor emails whose back-off elapsed (widget-verify.ts);
//  * expire one-time verifications past their lifetime and delete them after 2 days;
//  * delete visitor sessions 30 days after they ended (revoked or expired);
//  * delete visitor identities with no ticket and no live session after 30 days (tickets keep the V4 retention).
import { getPool, type Queryable } from '@social-lite/db';
import { retryWidgetEmails } from './widget-verify.js';

export async function sweepWidget(db: Queryable = getPool()): Promise<void> {
  await retryWidgetEmails(db);
  await db.query(`UPDATE widget_verifications SET state='expired' WHERE state IN ('pending','issued','locked') AND expires_at < now()`);
  await db.query(`DELETE FROM widget_verifications WHERE created_at < now() - interval '2 days'`);
  await db.query(`DELETE FROM widget_sessions WHERE coalesce(revoked_at, expires_at) < now() - interval '30 days'`);
  await db.query(`DELETE FROM widget_submissions WHERE created_at < now() - interval '30 days'`);
  await db.query(`DELETE FROM widget_visitors v WHERE v.created_at < now() - interval '30 days'
                    AND NOT EXISTS (SELECT 1 FROM support_tickets t WHERE t.visitor_id=v.id)
                    AND NOT EXISTS (SELECT 1 FROM widget_sessions s WHERE s.visitor_id=v.id AND s.revoked_at IS NULL AND s.expires_at > now())`);
}
