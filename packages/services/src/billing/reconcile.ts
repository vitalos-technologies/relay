// Billing worker sweep (every minute; bounded per tick). Missed-event reconciliation and time-based transitions:
//  1. retry stored webhook events that failed / never processed (backoff, max 10 attempts);
//  2. trials: expire no-card trials at their end; emit the 3-day trial-ending notice once;
//  3. expire abandoned checkout reservations;
//  4. re-fetch subscriptions from the provider: transitional states (incomplete / past due / scheduled change due) every
//     15 min, everything else every 6 h — catches any event the provider never delivered;
//  5. persist derived access changes caused only by the clock (grace end → restricted + billing.access_changed; a
//     cancellation date passed with the provider subscription already ended → Free, D33);
//  6. run staff-scheduled lifecycle actions that are due (service suspension), audited;
//  7. purge stored webhook bodies older than 90 days (metadata kept).
import { getPool, withTx, type Queryable } from '@social-lite/db';
import { log } from '../log.js';
import { deriveAccess, liveProviderSubscription } from './policy.js';
import { moveToFreeTx } from './free.js';
import { getBillingProvider } from './provider.js';
import { reconcileWorkspace } from './manage.js';
import { loadBilling, saveBilling, serviceSuspended } from './store.js';
import { sweepTrials } from './trials.js';
import { retryPendingWebhooks } from './webhooks.js';

export async function runBillingSweeps(db: Queryable = getPool(), now = new Date()): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const step = async (name: string, fn: () => Promise<number>) => {
    try { out[name] = await fn(); } catch (e) { log.warn('billing_sweep_step_failed', { step: name, err: e as Error }); out[name] = -1; }
  };
  await step('webhooks', () => retryPendingWebhooks(25, db));
  await step('trials', async () => { const r = await sweepTrials(db, now); return r.expired + r.ending; });
  await step('checkouts', async () => (await db.query(
    `UPDATE billing_checkout_sessions SET status='expired' WHERE status IN ('pending','open') AND expires_at < $1::timestamptz - interval '5 minutes'`, [now])).rowCount ?? 0);
  await step('reconcile', async () => {
    if (!getBillingProvider()) return 0;
    const due = await db.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM workspace_billing WHERE provider_subscription_ref IS NOT NULL AND (
          (status IN ('incomplete','past_due','payment_action_required') AND (provider_synced_at IS NULL OR provider_synced_at < $1::timestamptz - interval '15 minutes'))
       OR (scheduled_effective_at IS NOT NULL AND scheduled_effective_at <= $1)
       OR (cancel_at IS NOT NULL AND cancel_at <= $1 AND status = 'cancel_scheduled')
       OR (provider_status NOT IN ('canceled','incomplete_expired') AND (provider_synced_at IS NULL OR provider_synced_at < $1::timestamptz - interval '6 hours')))
       ORDER BY provider_synced_at NULLS FIRST LIMIT 20`, [now]);
    const open = await db.query<{ workspace_id: string }>(
      `SELECT DISTINCT workspace_id FROM billing_checkout_sessions WHERE status='open' AND provider_session_ref IS NOT NULL AND created_at < $1::timestamptz - interval '10 minutes' LIMIT 20`, [now]);
    const ids = [...new Set([...due.rows, ...open.rows].map((r) => r.workspace_id))];
    for (const id of ids) await reconcileWorkspace(id, { source: 'reconcile' }).catch((e) => log.warn('billing_reconcile_failed', { workspaceId: id, err: e as Error }));
    return ids.length;
  });
  await step('access', async () => {
    const rows = await db.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM workspace_billing WHERE (
          (access_level='full' AND status IN ('past_due','payment_action_required') AND grace_ends_at <= $1)
       OR (status='cancel_scheduled' AND cancel_at <= $1)
       OR (status IN ('expired','cancelled') AND (provider_subscription_ref IS NULL OR provider_status IN ('canceled','incomplete_expired'))))
       LIMIT 100`, [now]);
    let n = 0;
    for (const r of rows.rows) {
      await withTx(async (tx) => {
        const prev = await loadBilling(tx, r.workspace_id, { lock: true });
        if (!prev) return;
        const live = liveProviderSubscription(prev);
        const d = deriveAccess({ status: prev.status, serviceSuspended: await serviceSuspended(tx, r.workspace_id), graceEndsAt: prev.grace_ends_at, trialEndsAt: prev.trial_ends_at, cancelAt: prev.cancel_at, now,
          liveSubscription: live });
        if (d.free && !live && prev.status !== 'free') {
          // The subscription already ended at the provider (or never existed): persist the move to Free now. A live one
          // waits for the provider's own cancellation (webhook / reconcile above), which also lands on Free.
          await moveToFreeTx(tx, prev, { kind: prev.status === 'cancel_scheduled' ? 'cancellation_effective' : 'moved_to_free', source: 'system', actorService: 'billing-sweep' }, ['billing.subscription_ended']);
          n++;
          return;
        }
        if (d.access === prev.access_level) return;
        await saveBilling(tx, prev, { ...prev }, { kind: prev.status === 'cancel_scheduled' ? 'cancellation_effective' : 'grace_exhausted', source: 'system', actorService: 'billing-sweep' });
        n++;
      });
    }
    return n;
  });
  await step('scheduled', () => runScheduledActions(db, now));
  await step('purge', async () => (await db.query(
    `UPDATE billing_webhook_events SET payload=NULL WHERE payload IS NOT NULL AND status IN ('processed','ignored') AND received_at < $1::timestamptz - interval '90 days'`, [now])).rowCount ?? 0);
  return out;
}

export async function runScheduledActions(db: Queryable = getPool(), now = new Date()): Promise<number> {
  const due = await db.query<{ id: string; workspace_id: string; reason: string; created_by: string | null }>(
    `SELECT id, workspace_id, reason, created_by FROM billing_scheduled_actions WHERE status='scheduled' AND action='suspend' AND run_at <= $1 ORDER BY run_at LIMIT 10`, [now]);
  const { suspendWorkspaceTx } = await import('../admin/platform.js');
  for (const a of due.rows) {
    await withTx(async (tx) => {
      const claimed = await tx.query(`UPDATE billing_scheduled_actions SET status='done', done_at=now() WHERE id=$1 AND status='scheduled'`, [a.id]);
      if (!claimed.rowCount) return;
      await tx.query('SAVEPOINT scheduled_action');
      try {
        const r = await suspendWorkspaceTx(tx, a.workspace_id, { p: null, reason: a.reason, actorService: 'lifecycle-scheduler', scheduledBy: a.created_by });
        await tx.query(`UPDATE billing_scheduled_actions SET result=$2 WHERE id=$1`, [a.id, JSON.stringify(r.affected)]);
      } catch (e) {
        await tx.query('ROLLBACK TO SAVEPOINT scheduled_action');
        await tx.query(`UPDATE billing_scheduled_actions SET status='failed', result=$2 WHERE id=$1`, [a.id, JSON.stringify({ error: (e as Error).message.slice(0, 200) })]);
      }
    });
  }
  return due.rowCount ?? 0;
}
