// Notifications derived from outbox events. Deduplicated per user + key so one broken token
// cannot produce hundreds of messages (spec §14 alert dedupe). Critical items are emailed once.
import { BRAND } from '@social-lite/core';
import { PROVIDER_LABEL, type Provider } from '@social-lite/core';
import { getPool, many, maybeOne, type Queryable } from '@social-lite/db';
import { config } from '../config.js';
import { sendMail } from '../email.js';
import { log } from '../log.js';
import { onApprovalDecided, onApprovalRequested } from '../collab/inbox.js';
import { onCommentCreated } from '../collab/comments.js';
import { onAssignmentChanged } from '../collab/planning.js';
import { onReviewShared } from '../collab/review.js';
import { routeOperationalEmail } from '../collab/notifications.js';

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
    // V2 (collab/notifications.ts): per-user preferences (in-app/email/digest) and quiet hours decide delivery;
    // V1 emails only critical alerts. Email content is minimal and the recipient is re-checked at send.
    if (r) await routeOperationalEmail(db, { notificationId: r.id, workspaceId: p.workspaceId, userId, kind: p.kind, alreadyEmailed: !!r.emailed_at || !(p.email && p.severity === 'critical') });
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
    case 'approval.requested':
      // V2: everyone eligible for the CURRENT stage (policy roles/teams/guests/SoD), entitled at send time.
      await onApprovalRequested(db, { workspace_id: evt.workspace_id, aggregate_id: evt.aggregate_id, payload: evt.payload });
      return;
    case 'approval.decided':
      await onApprovalDecided(db, { workspace_id: evt.workspace_id, aggregate_id: evt.aggregate_id });
      return;
    case 'comment.created':
      await onCommentCreated(db, evt.aggregate_id);
      return;
    case 'assignment.changed':
      await onAssignmentChanged(db, { workspace_id: evt.workspace_id, aggregate_id: evt.aggregate_id, payload: evt.payload });
      return;
    case 'review.shared':
      await onReviewShared(db, { workspace_id: evt.workspace_id, aggregate_id: evt.aggregate_id, payload: evt.payload });
      return;
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
