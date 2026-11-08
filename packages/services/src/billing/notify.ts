// Billing notifications for the workspace's billing managers (owner/admin hold billing.manage). Consumes BILLING_EVENTS
// from the outbox (engine/notify.ts → events queue). Deduplicated per user + event + state; emails only the critical ones
// (trial ended, payment failed) through the existing pipeline (preferences + recipient re-check). No amounts or card data
// in the message; the link opens Settings → Billing.
import { formatMinorGBP } from '@social-lite/core/contracts/v4-plans';
import { many, type Queryable } from '@social-lite/db';

const LINK = '/settings/workspace/billing';

async function billingManagers(db: Queryable, workspaceId: string): Promise<string[]> {
  const rows = await many<{ user_id: string }>(db,
    `SELECT DISTINCT g.user_id FROM scoped_role_grants g JOIN memberships m ON m.workspace_id=g.workspace_id AND m.user_id=g.user_id
      WHERE g.workspace_id=$1 AND g.principal_type='user' AND g.scope_type='workspace' AND g.role IN ('owner','admin') AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at > now()) AND m.status='active' AND m.removed_at IS NULL`, [workspaceId]);
  return rows.map((r) => r.user_id);
}

const day = (iso: unknown) => (typeof iso === 'string' ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');

export async function onBillingEventNotify(evt: { event_type: string; workspace_id: string | null; aggregate_id: string; payload: Record<string, unknown> }, db: Queryable): Promise<void> {
  if (!evt.workspace_id) return;
  const p = evt.payload;
  let m: { severity: 'info' | 'warning' | 'critical'; title: string; body?: string; email: boolean; key: string } | null = null;
  switch (evt.event_type) {
    case 'billing.trial_ending': m = { severity: 'warning', title: `Your free trial ends on ${day(p.ends_at)}`, body: 'Choose a plan to keep publishing.', email: false, key: `trial_ending:${p.ends_at}` }; break;
    case 'billing.trial_expired': m = { severity: 'critical', title: 'Your free trial has ended', body: 'Paid actions are paused. Your content is kept. Choose a plan to continue.', email: true, key: 'trial_expired' }; break;
    case 'billing.payment_failed': m = { severity: 'critical', title: 'A payment failed', body: 'Update your payment details to avoid interruption.', email: true, key: `payment_failed:${new Date().toISOString().slice(0, 10)}` }; break;
    case 'billing.payment_recovered': m = { severity: 'info', title: 'Payment received — your subscription is active again', email: false, key: `payment_recovered:${new Date().toISOString().slice(0, 10)}` }; break;
    case 'billing.cancellation_scheduled': m = { severity: 'info', title: 'Renewal cancelled', body: 'Your plan stays active until the end of the billing period.', email: false, key: `cancel_scheduled:${new Date().toISOString().slice(0, 13)}` }; break;
    case 'billing.subscription_ended': m = { severity: 'warning', title: 'Your subscription has ended', body: 'Paid actions are paused. Your content is kept.', email: false, key: `ended:${new Date().toISOString().slice(0, 10)}` }; break;
    case 'billing.subscription_activated': m = { severity: 'info', title: 'Subscription active', body: typeof p.seats === 'number' && p.plan_id ? `${p.seats} ${p.seats === 1 ? 'seat' : 'seats'}` : undefined, email: false, key: `activated:${new Date().toISOString().slice(0, 13)}` }; break;
    default: return;
  }
  const { notify } = await import('../engine/notify.js');
  const users = await billingManagers(db, evt.workspace_id);
  const dedupeKey = `billing:${evt.workspace_id}:${m.key}`;
  await notify(db, { workspaceId: evt.workspace_id, userIds: users, severity: m.severity, kind: evt.event_type, title: m.title, body: m.body,
    referenceType: 'billing', referenceId: evt.workspace_id, dedupeKey, email: m.email });
  if (users.length) await db.query(`UPDATE notifications SET link_path=$3 WHERE user_id = ANY($1::uuid[]) AND dedupe_key=$2 AND link_path IS NULL`, [users, dedupeKey, LINK]).catch(() => undefined);
}

export const _formatForTests = formatMinorGBP;
