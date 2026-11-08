// Relay support (V4 SUP) — durable notifications for customers and Relay staff.
// Producers write outbox events in the SAME transaction as the persisted change (support.*); the worker delivers them
// (engine/notify.ts → handleSupportEvent). Guarantees:
//   * dedupe: one notification per (recipient, message/assignment/request) via notifications UNIQUE(user_id, dedupe_key),
//     so outbox redelivery or a pg-boss retry never duplicates; duplicate submissions never create a second message.
//   * permission re-check before delivery (here) AND again before a delayed/retried email (recipientStillAllowed,
//     called from collab/notifications.ts sendNotificationEmail).
//   * minimal content: titles carry the ticket reference only (never message text); links go back into Relay.
//   * email failures stay on the notification row (email_state failed/not_configured), separate from the message.
// Staff have no workspace: their rows use notifications.scope = 'platform' (workspace_id NULL) and their own feed.
// Internal notes never produce customer notifications (no event carries a note to customers).
import { notFound } from '@social-lite/core';
import type { PlatformNotificationDto } from '@social-lite/core/contracts/v4-support';
import { getPool, many, maybeOne, type Queryable } from '@social-lite/db';
import { channelsFor, quietUntil, safeLinkPath, sendNotificationEmail, settingsFor } from '../collab/notifications.js';
import { emitCollabEvent } from '../collab/events.js';
import { assertUuid, authorizeCtx, isUuid, loadAccess } from '../tenancy.js';
import type { Ctx } from '../context.js';
import type { PlatformCtx } from '../admin/platform.js';
import { log } from '../log.js';
import { activeSupportStaff, customerCanSee } from './access.js';

export const SUPPORT_EVENTS = ['support.ticket_created', 'support.message_created', 'support.ticket_assigned', 'support.access_requested', 'support.access_decided'] as const;
export type SupportEventType = (typeof SUPPORT_EVENTS)[number];

interface Ticket { id: string; reference: string; workspace_id: string | null; requester_user_id: string | null; assignee_user_id: string | null; status: string }

async function ticket(db: Queryable, id: unknown): Promise<Ticket | null> {
  if (!isUuid(id)) return null;
  return maybeOne<Ticket>(db, `SELECT id, reference, workspace_id, requester_user_id, assignee_user_id, status FROM support_tickets WHERE id=$1`, [id]);
}

async function supportStaffIds(db: Queryable): Promise<string[]> {
  return (await many<{ user_id: string }>(db,
    `SELECT o.user_id FROM platform_operators o JOIN users u ON u.id=o.user_id WHERE o.revoked_at IS NULL AND u.disabled_at IS NULL AND o.role IN ('operator','support')`)).map((r) => r.user_id);
}

export type Delivery = 'created' | 'duplicate' | 'not_entitled' | 'muted';

/** One platform-scope (staff) notification; staff role re-checked now. */
export async function deliverPlatformNotification(db: Queryable, n: {
  userId: string; kind: string; title: string; linkPath: string; ticketId: string; dedupeKey: string; email: boolean; actorId?: string | null;
}): Promise<Delivery> {
  if (!(await activeSupportStaff(db, n.userId))) return 'not_entitled';
  const r = await maybeOne<{ id: string }>(db,
    `INSERT INTO notifications(scope, workspace_id, user_id, severity, kind, title, reference_type, reference_id, dedupe_key, event_type, in_app, email_state, email_after, link_path, actor_id)
     VALUES ('platform', NULL, $1, 'info', $2, $3, 'support_ticket', $4, $5, 'support', true, $6, $7, $8, $9)
     ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING id`,
    [n.userId, n.kind, n.title.slice(0, 200), n.ticketId, n.dedupeKey, n.email ? 'pending' : 'none', n.email ? new Date() : null, safeLinkPath(n.linkPath), n.actorId ?? null]);
  if (!r) return 'duplicate';
  if (n.email) await sendNotificationEmail(db, r.id);
  return 'created';
}

/** One customer notification in the ticket's workspace: ticket visibility re-checked now; member preferences apply. */
export async function deliverCustomerNotification(db: Queryable, n: {
  workspaceId: string; userId: string; kind: string; title: string; linkPath: string; ticketId: string | null; dedupeKey: string; actorId?: string | null;
  /** Override the visibility check (e.g. owners notified about a support-access request on the workspace page). */
  check?: () => Promise<boolean>;
}): Promise<Delivery> {
  const ok = n.check ? await n.check() : !!n.ticketId && (await customerCanSee(db, n.userId, n.ticketId));
  if (!ok) return 'not_entitled';
  const ch = await channelsFor(db, n.workspaceId, n.userId, 'support');
  if (!ch.in_app && !ch.email) return 'muted';
  const quiet = quietUntil(await settingsFor(db, n.workspaceId, n.userId));
  const r = await maybeOne<{ id: string }>(db,
    `INSERT INTO notifications(scope, workspace_id, user_id, severity, kind, title, reference_type, reference_id, dedupe_key, event_type, in_app, email_state, email_after, link_path, actor_id)
     VALUES ('workspace', $1, $2, 'info', $3, $4, $5, $6, $7, 'support', $8, $9, $10, $11, $12)
     ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING id`,
    [n.workspaceId, n.userId, n.kind, n.title.slice(0, 200), n.ticketId ? 'support_ticket' : 'support_access', n.ticketId, n.dedupeKey, ch.in_app,
      ch.email ? 'pending' : 'none', ch.email ? (quiet ?? new Date()) : null, safeLinkPath(n.linkPath), n.actorId ?? null]);
  if (!r) return 'duplicate';
  if (ch.in_app) await emitCollabEvent(db, { workspaceId: n.workspaceId, audience: 'user', userId: n.userId, kind: 'notification', refId: r.id });
  if (ch.email && !quiet) await sendNotificationEmail(db, r.id);
  return 'created';
}

/** Re-check before a (delayed/retried) email: called from sendNotificationEmail for support.* and platform rows. */
export async function recipientStillAllowed(db: Queryable, row: { user_id: string; workspace_id: string | null; scope: string; kind: string; reference_id: string | null }): Promise<boolean> {
  if (row.scope === 'platform') return activeSupportStaff(db, row.user_id);
  if (row.kind === 'support.access_requested') {
    if (!row.workspace_id) return false;
    return ownerCanDecide(db, row.workspace_id, row.user_id);
  }
  return !!row.reference_id && customerCanSee(db, row.user_id, row.reference_id);
}

/** Holds members.manage now (session assurance — MFA/step-up — is checked when they actually decide). */
async function ownerCanDecide(db: Queryable, workspaceId: string, userId: string): Promise<boolean> {
  const access = await loadAccess(userId, workspaceId, db, { mfaVerified: true, authTime: new Date().toISOString() });
  if (!access) return false;
  const ctx: Ctx = { actor: { userId, email: '', name: null, sessionId: 'delivery' }, access, correlationId: 'delivery' };
  return authorizeCtx(ctx, 'members.manage').allowed;
}

const customerLink = (ref: string) => `/help/requests/${ref}`;
const staffLink = (ref: string) => `/admin/platform/support/${ref}`;

/** Worker entry point for support.* outbox events (idempotent per recipient + dedupe key). */
export async function handleSupportEvent(evt: { event_type: string; workspace_id: string | null; aggregate_id: string; payload: Record<string, unknown> }, db: Queryable = getPool()): Promise<void> {
  const p = evt.payload;
  switch (evt.event_type as SupportEventType) {
    case 'support.ticket_created': {
      const t = await ticket(db, evt.aggregate_id);
      if (!t) return;
      const reopened = p.reopened === true;
      const targets = reopened && t.assignee_user_id ? [t.assignee_user_id] : await supportStaffIds(db);
      for (const uid of targets) {
        await deliverPlatformNotification(db, { userId: uid, kind: reopened ? 'support.reopened' : 'support.new', title: `${reopened ? 'Request reopened' : 'New support request'} · ${t.reference}`,
          linkPath: staffLink(t.reference), ticketId: t.id, dedupeKey: reopened ? `support:reopen:${String(p.activityId ?? '')}` : `support:new:${t.id}`, email: reopened && !!t.assignee_user_id,
          actorId: t.requester_user_id });
      }
      return;
    }
    case 'support.message_created': {
      const t = await ticket(db, evt.aggregate_id);
      if (!t || !isUuid(p.messageId)) return;
      const m = await maybeOne<{ id: string; author_kind: string; author_user_id: string | null }>(db, `SELECT id, author_kind, author_user_id FROM support_messages WHERE id=$1 AND ticket_id=$2`, [p.messageId, t.id]);
      if (!m) return;
      if (m.author_kind === 'staff') {
        if (!t.workspace_id) return; // visitor tickets: widget delivery arrives with V5
        const participants = (await many<{ user_id: string }>(db, `SELECT user_id FROM support_ticket_participants WHERE ticket_id=$1 AND removed_at IS NULL`, [t.id])).map((r) => r.user_id);
        const recipients = [...new Set([t.requester_user_id, ...participants].filter((x): x is string => !!x))];
        for (const uid of recipients) {
          await deliverCustomerNotification(db, { workspaceId: t.workspace_id, userId: uid, kind: 'support.reply', title: `Relay support replied · ${t.reference}`, linkPath: customerLink(t.reference),
            ticketId: t.id, dedupeKey: `support:msg:${m.id}`, actorId: null });
        }
        return;
      }
      // Customer message: the assignee (in-app + email), or every support staff member in-app when unassigned.
      const targets = t.assignee_user_id ? [t.assignee_user_id] : await supportStaffIds(db);
      for (const uid of targets) {
        if (uid === m.author_user_id) continue;
        await deliverPlatformNotification(db, { userId: uid, kind: 'support.customer_reply', title: `Customer replied · ${t.reference}`, linkPath: staffLink(t.reference), ticketId: t.id,
          dedupeKey: `support:msg:${m.id}`, email: !!t.assignee_user_id, actorId: m.author_user_id });
      }
      return;
    }
    case 'support.ticket_assigned': {
      const t = await ticket(db, evt.aggregate_id);
      if (!t || !isUuid(p.assigneeId) || p.assigneeId === p.byUserId || t.assignee_user_id !== p.assigneeId) return;
      await deliverPlatformNotification(db, { userId: p.assigneeId, kind: 'support.assigned', title: `Assigned to you · ${t.reference}`, linkPath: staffLink(t.reference), ticketId: t.id,
        dedupeKey: `support:assign:${String(p.activityId ?? '')}`, email: true, actorId: isUuid(p.byUserId) ? p.byUserId : null });
      return;
    }
    case 'support.access_requested': {
      // Owner notification on request (brief §8): owners/admins who can decide, in-app + email per their preferences.
      const g = await maybeOne<{ id: string; workspace_id: string; status: string; support_ticket_id: string | null; operator_user_id: string }>(db,
        `SELECT id, workspace_id, status, support_ticket_id, operator_user_id FROM support_access_grants WHERE id=$1`, [evt.aggregate_id]);
      if (!g || g.status !== 'requested') return;
      const owners = await many<{ user_id: string }>(db,
        `SELECT user_id FROM memberships WHERE workspace_id=$1 AND status='active' AND removed_at IS NULL AND role IN ('owner','admin') AND user_id <> $2`, [g.workspace_id, g.operator_user_id]);
      for (const o of owners) {
        await deliverCustomerNotification(db, { workspaceId: g.workspace_id, userId: o.user_id, kind: 'support.access_requested', title: 'Relay support requested read-only access',
          linkPath: '/admin/security/support', ticketId: g.support_ticket_id, dedupeKey: `support:access:${g.id}`, check: () => ownerCanDecide(db, g.workspace_id, o.user_id) });
      }
      return;
    }
    case 'support.access_decided': {
      const g = await maybeOne<{ id: string; operator_user_id: string; status: string; support_ticket_id: string | null; reference: string | null }>(db,
        `SELECT g.id, g.operator_user_id, g.status, g.support_ticket_id, t.reference FROM support_access_grants g LEFT JOIN support_tickets t ON t.id=g.support_ticket_id WHERE g.id=$1`, [evt.aggregate_id]);
      if (!g?.support_ticket_id || !g.reference) return;
      await deliverPlatformNotification(db, { userId: g.operator_user_id, kind: 'support.access_decided', title: `Support access ${g.status === 'active' ? 'approved' : 'declined'} · ${g.reference}`,
        linkPath: staffLink(g.reference), ticketId: g.support_ticket_id, dedupeKey: `support:access-decided:${g.id}`, email: false });
      return;
    }
    default:
      log.debug('support_event_ignored', { type: evt.event_type });
  }
}

// ------------------------------------------------------------------ staff notification feed (platform scope)
export async function listPlatformNotifications(p: PlatformCtx, q: { unread?: boolean; limit?: number } = {}, db: Queryable = getPool()): Promise<{ items: PlatformNotificationDto[]; unread_count: number }> {
  const rows = await many<{ id: string; kind: string; title: string; link_path: string | null; created_at: Date; read_at: Date | null }>(db,
    `SELECT id, kind, title, link_path, created_at, read_at FROM notifications WHERE scope='platform' AND user_id=$1 AND in_app AND ($2::boolean IS NOT TRUE OR read_at IS NULL)
      ORDER BY last_seen_at DESC, id DESC LIMIT $3`, [p.actor.userId, !!q.unread, Math.min(Math.max(q.limit ?? 30, 1), 100)]);
  const c = await maybeOne<{ n: number }>(db, `SELECT count(*)::int n FROM notifications WHERE scope='platform' AND user_id=$1 AND in_app AND read_at IS NULL`, [p.actor.userId]);
  return {
    items: rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, url: safeLinkPath(r.link_path), created_at: r.created_at.toISOString(), read_at: r.read_at?.toISOString() ?? null })),
    unread_count: c?.n ?? 0,
  };
}

export async function markPlatformNotification(p: PlatformCtx, id: string, read: boolean, db: Queryable = getPool()): Promise<{ ok: true }> {
  assertUuid(id, 'Notification');
  const r = await db.query(`UPDATE notifications SET read_at=${read ? 'coalesce(read_at, now())' : 'NULL'} WHERE id=$1 AND scope='platform' AND user_id=$2`, [id, p.actor.userId]);
  if (!r.rowCount) throw notFound('Notification');
  return { ok: true };
}

export async function markAllPlatformNotificationsRead(p: PlatformCtx, db: Queryable = getPool()): Promise<{ ok: true }> {
  await db.query(`UPDATE notifications SET read_at=now() WHERE scope='platform' AND user_id=$1 AND read_at IS NULL`, [p.actor.userId]);
  return { ok: true };
}

/** Per staff reply: who was notified and how email went (shown to staff, separate from the message itself). */
export async function deliverySummary(db: Queryable, messageIds: string[]): Promise<Map<string, { recipients: number; email: Record<string, number> }>> {
  const out = new Map<string, { recipients: number; email: Record<string, number> }>();
  if (!messageIds.length) return out;
  const rows = await many<{ key: string; email_state: string; n: number }>(db,
    `SELECT dedupe_key AS key, email_state, count(*)::int n FROM notifications WHERE scope='workspace' AND dedupe_key = ANY($1::text[]) GROUP BY dedupe_key, email_state`,
    [messageIds.map((id) => `support:msg:${id}`)]);
  for (const r of rows) {
    const id = r.key.slice('support:msg:'.length);
    const cur = out.get(id) ?? { recipients: 0, email: {} };
    cur.recipients += r.n;
    cur.email[r.email_state] = (cur.email[r.email_state] ?? 0) + r.n;
    out.set(id, cur);
  }
  return out;
}
