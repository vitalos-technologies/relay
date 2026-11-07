// Notifications derived from outbox events. Deduplicated per user + key so one broken token
// cannot produce hundreds of messages (spec §14 alert dedupe). Critical items are emailed once.
import { PROVIDER_LABEL, type Provider } from '@social-lite/core';
import { getPool, many, maybeOne, type Queryable } from '@social-lite/db';
import { config } from '../config.js';
import { sendMail } from '../email.js';
import { log } from '../log.js';

type Severity = 'info' | 'warning' | 'critical';

async function recipients(db: Queryable, workspaceId: string, extraUserId?: string | null): Promise<string[]> {
  const rows = await many<{ user_id: string }>(db,
    `SELECT user_id FROM memberships WHERE workspace_id=$1 AND removed_at IS NULL AND role IN ('owner','admin')`, [workspaceId]);
  const ids = new Set(rows.map((r) => r.user_id));
  if (extraUserId) {
    const m = await maybeOne(db, `SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2 AND removed_at IS NULL`, [workspaceId, extraUserId]);
    if (m) ids.add(extraUserId);
  }
  return [...ids];
}

export async function notify(db: Queryable, p: {
  workspaceId: string; userIds: string[]; severity: Severity; kind: string; title: string; body?: string;
  referenceType?: string; referenceId?: string; dedupeKey: string; email?: boolean;
}): Promise<void> {
  for (const userId of p.userIds) {
    const r = await maybeOne<{ id: string; emailed_at: Date | null; inserted: boolean }>(db,
      `INSERT INTO notifications(workspace_id, user_id, severity, kind, title, body, reference_type, reference_id, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (user_id, dedupe_key) DO UPDATE SET occurrences = notifications.occurrences + 1, last_seen_at = now(), read_at = NULL
       RETURNING id, emailed_at, (xmax = 0) AS inserted`,
      [p.workspaceId, userId, p.severity, p.kind, p.title, p.body ?? null, p.referenceType ?? null, p.referenceId ?? null, p.dedupeKey]);
    if (r && p.email && p.severity === 'critical' && !r.emailed_at) {
      const u = await maybeOne<{ email: string }>(db, `SELECT email FROM users WHERE id=$1`, [userId]);
      if (u) {
        const link = `${config().APP_BASE_URL}${p.referenceType === 'post' ? `/posts/${p.referenceId}` : p.referenceType === 'connection' ? '/accounts' : '/'}`;
        const sent = await sendMail({ to: u.email, subject: `[Social Lite] ${p.title}`, text: `${p.title}\n\n${p.body ?? ''}\n\nOpen: ${link}\n` }).catch(() => false);
        if (sent) await db.query(`UPDATE notifications SET emailed_at=now() WHERE id=$1`, [r.id]);
      }
    }
  }
}

const DELIVERY_MESSAGES: Partial<Record<string, { severity: Severity; title: (p: string, n: string) => string; email: boolean }>> = {
  failed: { severity: 'warning', title: (p, n) => `${p} post to ${n} failed`, email: false },
  unknown: { severity: 'critical', title: (p, n) => `${p} result unknown for ${n} — needs review`, email: true },
  blocked: { severity: 'warning', title: (p, n) => `${p} post to ${n} is blocked`, email: false },
  expired: { severity: 'warning', title: (p, n) => `${p} post to ${n} was missed`, email: false },
};

export async function handleEvent(evt: { event_type: string; workspace_id: string | null; aggregate_id: string; payload: Record<string, unknown> }, db: Queryable = getPool()): Promise<void> {
  if (evt.event_type === 'webhook.received') {
    const { processWebhookReceipt } = await import('../webhooks.js');
    await processWebhookReceipt(evt.aggregate_id);
    return;
  }
  if (!evt.workspace_id) return;
  switch (evt.event_type) {
    case 'delivery.state_changed': {
      const d = await maybeOne<{ id: string; post_id: string; provider: Provider; state: string; is_mock: boolean; display_name: string; created_by: string | null; last_error_message: string | null; blocked_reason: string | null; title: string | null }>(db,
        `SELECT d.id, d.post_id, d.provider, d.state, d.is_mock, c.display_name, p.created_by, d.last_error_message, d.blocked_reason, p.title
           FROM deliveries d JOIN connections c ON c.id=d.connection_id JOIN posts p ON p.id=d.post_id WHERE d.id=$1`, [evt.aggregate_id]);
      if (!d) return;
      const m = DELIVERY_MESSAGES[d.state];
      if (!m) return;
      const who = `${PROVIDER_LABEL[d.provider]}${d.is_mock ? ' (simulated)' : ''}`;
      await notify(db, {
        workspaceId: evt.workspace_id, userIds: await recipients(db, evt.workspace_id, d.created_by), severity: m.severity, kind: `delivery.${d.state}`,
        title: m.title(who, d.display_name), body: [d.title ? `Post: ${d.title}` : null, d.blocked_reason ?? d.last_error_message].filter(Boolean).join('\n'),
        referenceType: 'post', referenceId: d.post_id, dedupeKey: `delivery:${d.id}:${d.state}`, email: m.email && !d.is_mock,
      });
      return;
    }
    case 'connection.health_changed': {
      const c = await maybeOne<{ id: string; display_name: string; provider: Provider; status: string; is_mock: boolean }>(db,
        `SELECT id, display_name, provider, status, is_mock FROM connections WHERE id=$1`, [evt.aggregate_id]);
      if (!c || ['ready'].includes(c.status)) return;
      await notify(db, {
        workspaceId: evt.workspace_id, userIds: await recipients(db, evt.workspace_id), severity: c.status === 'expiring' ? 'info' : 'critical',
        kind: 'connection.health', title: `${PROVIDER_LABEL[c.provider]} account ${c.display_name}: ${c.status.replace(/_/g, ' ')}`,
        body: 'Open Accounts to see the exact fix. Scheduled posts to this account are held until it is fixed.',
        referenceType: 'connection', referenceId: c.id, dedupeKey: `connection:${c.id}:${c.status}`, email: !c.is_mock && c.status !== 'expiring',
      });
      return;
    }
    case 'approval.requested': {
      const approvers = await many<{ user_id: string }>(db,
        `SELECT m.user_id FROM memberships m WHERE m.workspace_id=$1 AND m.removed_at IS NULL AND m.role IN ('owner','admin','approver')
           AND (NOT m.brand_restricted OR m.role IN ('owner','admin') OR EXISTS (SELECT 1 FROM membership_brand_grants g WHERE g.workspace_id=m.workspace_id AND g.user_id=m.user_id AND g.brand_id=$2))`,
        [evt.workspace_id, evt.payload.brandId]);
      await notify(db, { workspaceId: evt.workspace_id, userIds: approvers.map((a) => a.user_id), severity: 'info', kind: 'approval.requested',
        title: 'A post is waiting for your review', referenceType: 'approval', referenceId: evt.aggregate_id, dedupeKey: `approval:${evt.aggregate_id}` });
      return;
    }
    case 'approval.decided': {
      const a = await maybeOne<{ requested_by: string; decision: string; reason: string | null; post_id: string }>(db, `SELECT requested_by, decision, reason, post_id FROM approvals WHERE id=$1`, [evt.aggregate_id]);
      if (!a?.requested_by) return;
      await notify(db, { workspaceId: evt.workspace_id, userIds: [a.requested_by], severity: a.decision === 'rejected' ? 'warning' : 'info', kind: `approval.${a.decision}`,
        title: a.decision === 'rejected' ? 'Your post was rejected' : 'Your post was approved', body: a.reason ?? undefined,
        referenceType: 'post', referenceId: a.post_id, dedupeKey: `approval:${evt.aggregate_id}:${a.decision}` });
      return;
    }
    case 'notification.created': {
      if (evt.payload.kind === 'budget_threshold') {
        await notify(db, { workspaceId: evt.workspace_id, userIds: await recipients(db, evt.workspace_id), severity: Number(evt.payload.percent) >= 100 ? 'critical' : 'warning',
          kind: 'budget', title: `X API ${evt.payload.meter === 'x.write' ? 'post' : 'read'} budget ${evt.payload.percent}% used (${evt.payload.period})`,
          body: `Monthly cap: ${evt.payload.cap}. At 100% X jobs are blocked; other channels continue.`, dedupeKey: `budget:${evt.payload.meter}:${evt.payload.period}:${evt.payload.percent}`, email: Number(evt.payload.percent) >= 80 });
      }
      return;
    }
    default:
      log.debug('event_ignored', { type: evt.event_type });
  }
}
