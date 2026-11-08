// Relay support (V4 SUP) — Platform → Support (staff inbox). Support staff only (role 'support' or 'operator'; billing
// staff are refused in requireSupportStaff). Queues are views over status + assignee. Public replies and internal notes
// are separate operations writing separate tables; only public replies reach customers (message + customer activity +
// customer notification). Workspace context is metadata only: no posts, media, credentials or social messages.
// Every staff change is in the ticket history (support_activity); assignment, status, duplicate and access requests are
// also in the platform audit (and the workspace audit for workspace-touching facts).
import { z } from 'zod';
import { AppError, notFound } from '@social-lite/core';
import {
  SUPPORT_PRIORITIES, SUPPORT_QUEUES, SUPPORT_RESOLUTION_REASONS, SUPPORT_SOURCES, SUPPORT_TICKET_CATEGORIES, SUPPORT_TICKET_STATUSES,
  type SavedReplyDto, type StaffTicketDetail, type StaffTicketSummary, type StaffTicketsResponse, type StaffTimelineItem, type SupportDiagnostics, type SupportQueue,
  type SupportResolutionReason, type SupportStaffDto, type SupportTicketStatus, type WorkspaceSupportContext,
} from '@social-lite/core/contracts/v4-support';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import { beginPlatformIdempotent, completePlatformIdempotent } from '../idempotency.js';
import { enforceRateLimit } from '../ratelimit.js';
import { writeOutbox } from '../outbox.js';
import { assertUuid, isUuid } from '../tenancy.js';
import { platformAudit, type PlatformCtx } from '../admin/platform.js';
import { requestSupportAccess } from '../admin/support-access.js';
import { activeSupportStaff, requireSupportStaff } from './access.js';
import { attachmentsFor, bindAttachments } from './attachments.js';
import { deliverySummary } from './notify.js';
import { activityText, appendSearch, iso, writeActivity } from './shared.js';
import { commercialSummary } from './commercial.js';
import { visitorStaffInfo } from './widget.js';

export const STAFF_REPLY_RATE = { capacity: 120, refillPerSecond: 120 / 600 };

interface SummaryRow {
  id: string; reference: string; subject: string; category: StaffTicketSummary['category']; restricted: boolean; status: SupportTicketStatus; priority: StaffTicketSummary['priority'];
  source: StaffTicketSummary['source']; requester_kind: StaffTicketSummary['requester_kind']; requester_user_id: string | null; requester_name: string | null; requester_email: string | null;
  visitor_name: string | null; visitor_email: string | null; workspace_id: string | null; workspace_name: string | null; assignee_user_id: string | null; assignee_name: string | null;
  assignee_email: string | null; created_at: Date; updated_at: Date; last_customer_at: Date | null; last_staff_reply_at: Date | null; duplicate_of: string | null;
}

const SUMMARY_SELECT = `SELECT t.id, t.reference, t.subject, t.category, t.restricted, t.status, t.priority, t.source, t.requester_kind, t.requester_user_id,
    ru.name AS requester_name, ru.email::text AS requester_email, t.visitor_name, t.visitor_email::text AS visitor_email, t.workspace_id, w.name AS workspace_name,
    t.assignee_user_id, au.name AS assignee_name, au.email::text AS assignee_email, t.created_at, t.updated_at, t.last_customer_at, t.last_staff_reply_at, t.duplicate_of
  FROM support_tickets t LEFT JOIN users ru ON ru.id=t.requester_user_id LEFT JOIN workspaces w ON w.id=t.workspace_id LEFT JOIN users au ON au.id=t.assignee_user_id`;

function summaryDto(r: SummaryRow): StaffTicketSummary {
  return {
    id: r.id, reference: r.reference, subject: r.subject, category: r.category, restricted: r.restricted, status: r.status, priority: r.priority, source: r.source,
    requester_kind: r.requester_kind,
    requester: r.requester_kind === 'visitor' ? { id: null, name: r.visitor_name, email: r.visitor_email } : { id: r.requester_user_id, name: r.requester_name, email: r.requester_email },
    workspace: r.workspace_id ? { id: r.workspace_id, name: r.workspace_name ?? '' } : null,
    assignee: r.assignee_user_id ? { id: r.assignee_user_id, name: r.assignee_name, email: r.assignee_email ?? '' } : null,
    created_at: r.created_at.toISOString(), updated_at: r.updated_at.toISOString(), last_customer_at: iso(r.last_customer_at), last_staff_reply_at: iso(r.last_staff_reply_at),
    duplicate_of: r.duplicate_of,
  };
}

const QUEUE_SQL: Record<SupportQueue, string> = {
  open: `t.status NOT IN ('resolved','archived')`,
  unassigned: `t.status NOT IN ('resolved','archived') AND t.assignee_user_id IS NULL`,
  mine: `t.status NOT IN ('resolved','archived') AND t.assignee_user_id = $1::uuid`,
  waiting_on_relay: `t.status IN ('new','waiting_on_relay')`,
  waiting_on_customer: `t.status = 'waiting_on_customer'`,
  resolved: `t.status = 'resolved'`,
  archived: `t.status = 'archived'`,
};

const listSchema = z.object({
  queue: z.enum(SUPPORT_QUEUES).default('open'),
  q: z.string().trim().max(200).optional(),
  category: z.enum(SUPPORT_TICKET_CATEGORIES).optional(),
  priority: z.enum(SUPPORT_PRIORITIES).optional(),
  source: z.enum(SUPPORT_SOURCES).optional(),
  assignee: z.string().uuid().optional(),
  workspace_id: z.string().uuid().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
}).strip();

export async function listStaffTickets(p: PlatformCtx, raw: unknown = {}, db: Queryable = getPool()): Promise<StaffTicketsResponse> {
  requireSupportStaff(p);
  const q = listSchema.parse(raw ?? {});
  const params: unknown[] = [p.actor.userId];
  const where = ['$1::uuid IS NOT NULL', QUEUE_SQL[q.queue]];
  const filters: string[] = [];
  const add = (sql: (n: number) => string, v: unknown) => { params.push(v); filters.push(sql(params.length)); };
  if (q.category) add((n) => `t.category = $${n}`, q.category);
  if (q.priority) add((n) => `t.priority = $${n}`, q.priority);
  if (q.source) add((n) => `t.source = $${n}`, q.source);
  if (q.assignee) add((n) => `t.assignee_user_id = $${n}`, q.assignee);
  if (q.workspace_id) add((n) => `t.workspace_id = $${n}`, q.workspace_id);
  if (q.q) {
    // Search covers the subject, reference and PUBLIC messages (search_doc) plus requester / workspace names. Internal
    // notes are not indexed and cannot be found by search.
    add((n) => /^RLY-\d+$/i.test(q.q!) ? `upper(t.reference) = upper($${n})`
      : `(t.search_doc @@ websearch_to_tsquery('simple', $${n}) OR t.subject ILIKE '%' || $${n} || '%' OR ru.email::text ILIKE '%' || $${n} || '%' OR w.name ILIKE '%' || $${n} || '%' OR t.visitor_email::text ILIKE '%' || $${n} || '%')`, q.q);
  }
  const countParams = [...params];
  if (q.cursor) {
    const [ts, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
    if (!ts || !isUuid(id) || Number.isNaN(Date.parse(ts))) throw new AppError('validation_failed', 'Invalid cursor');
    params.push(ts, id); where.push(`(t.updated_at, t.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const order = q.queue === 'resolved' || q.queue === 'archived' ? 't.updated_at DESC, t.id DESC'
    : `CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, t.updated_at DESC, t.id DESC`;
  const rows = await many<SummaryRow>(db, `${SUMMARY_SELECT} WHERE ${[...where, ...filters].join(' AND ')} ORDER BY ${q.cursor ? 't.updated_at DESC, t.id DESC' : order} LIMIT $${params.length}`, params);
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  const counts = await one<Record<SupportQueue, number>>(db,
    `SELECT ${SUPPORT_QUEUES.map((k) => `count(*) FILTER (WHERE ${QUEUE_SQL[k]})::int AS ${k}`).join(', ')}
       FROM support_tickets t LEFT JOIN users ru ON ru.id=t.requester_user_id LEFT JOIN workspaces w ON w.id=t.workspace_id ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}`, countParams);
  return {
    items: page.map(summaryDto),
    next_cursor: rows.length > q.limit && last ? Buffer.from(`${last.updated_at.toISOString()}|${last.id}`).toString('base64url') : null,
    counts,
  };
}

async function loadTicket(db: Queryable, idOrRef: string, lock = false): Promise<SummaryRow & { workspace_id: string | null }> {
  const byId = isUuid(idOrRef);
  if (!byId && !/^RLY-[0-9]{5,10}$/i.test(idOrRef)) throw notFound('Ticket');
  const r = await maybeOne<SummaryRow>(db, `${SUMMARY_SELECT} WHERE ${byId ? 't.id = $1::uuid' : 'upper(t.reference) = upper($1)'} ${lock ? 'FOR UPDATE OF t' : ''}`, [idOrRef]);
  if (!r) throw notFound('Ticket');
  return r;
}

// ------------------------------------------------------------------ detail
export async function getStaffTicket(p: PlatformCtx, idOrRef: string, db: Queryable = getPool()): Promise<StaffTicketDetail> {
  requireSupportStaff(p);
  const t = await loadTicket(db, idOrRef);
  const extra = await one<{ diagnostics: SupportDiagnostics; resolution_reason: SupportResolutionReason | null; resolved_at: Date | null; archived_at: Date | null; reopen_count: number }>(db,
    `SELECT diagnostics, resolution_reason, resolved_at, archived_at, reopen_count FROM support_tickets WHERE id=$1`, [t.id]);
  const msgs = await many<{ id: string; author_kind: 'member' | 'visitor' | 'staff'; author_user_id: string | null; name: string | null; email: string | null; body: string; created_at: Date }>(db,
    `SELECT m.id, m.author_kind, m.author_user_id, u.name, u.email::text AS email, m.body, m.created_at FROM support_messages m LEFT JOIN users u ON u.id=m.author_user_id
      WHERE m.ticket_id=$1 ORDER BY m.created_at, m.id`, [t.id]);
  const notes = await many<{ id: string; author_user_id: string | null; name: string | null; email: string | null; body: string; created_at: Date }>(db,
    `SELECT n.id, n.author_user_id, u.name, u.email::text AS email, n.body, n.created_at FROM support_notes n LEFT JOIN users u ON u.id=n.author_user_id
      WHERE n.ticket_id=$1 ORDER BY n.created_at, n.id`, [t.id]);
  const acts = await many<{ id: string; kind: string; audience: 'customer' | 'staff'; detail: Record<string, unknown>; created_at: Date }>(db,
    `SELECT id::text, kind, audience, detail, created_at FROM support_activity WHERE ticket_id=$1 AND kind NOT IN ('message.created','note.created') ORDER BY id`, [t.id]);
  const mFiles = await attachmentsFor(db, 'message_id', msgs.map((m) => m.id), '/api/platform/support/attachments');
  const nFiles = await attachmentsFor(db, 'note_id', notes.map((n) => n.id), '/api/platform/support/attachments');
  const delivery = await deliverySummary(db, msgs.filter((m) => m.author_kind === 'staff').map((m) => m.id));
  const display = (name: string | null, email: string | null) => name || email?.split('@')[0] || 'Unknown';
  const timeline: Array<StaffTimelineItem & { at: string }> = [
    ...msgs.map((m) => ({ type: 'message' as const, id: m.id, author: { kind: m.author_kind, name: m.author_kind === 'visitor' ? (t.visitor_name || 'Visitor') : display(m.name, m.email), id: m.author_user_id }, body: m.body,
      created_at: m.created_at.toISOString(), at: m.created_at.toISOString(), attachments: mFiles.get(m.id) ?? [],
      ...(delivery.get(m.id) ? { delivery: delivery.get(m.id) } : {}) })),
    ...notes.map((n) => ({ type: 'note' as const, id: n.id, author: { name: display(n.name, n.email), id: n.author_user_id }, body: n.body, created_at: n.created_at.toISOString(),
      at: n.created_at.toISOString(), attachments: nFiles.get(n.id) ?? [] })),
    ...acts.map((a) => ({ type: 'activity' as const, id: Number(a.id), kind: a.kind, audience: a.audience, text: activityText(a.kind, a.detail, true), created_at: a.created_at.toISOString(),
      at: a.created_at.toISOString() })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const participants = await many<{ id: string; name: string | null; email: string }>(db,
    `SELECT u.id, u.name, u.email::text AS email FROM support_ticket_participants sp JOIN users u ON u.id=sp.user_id WHERE sp.ticket_id=$1 AND sp.removed_at IS NULL`, [t.id]);
  const reports = await many<{ id: string; category: string; summary: string; created_at: Date; shared_at: Date | null }>(db,
    `SELECT id, category, summary, created_at, shared_at FROM support_reports WHERE support_ticket_id=$1 ORDER BY created_at DESC LIMIT 20`, [t.id]);
  const dups = await many<{ id: string; reference: string; subject: string; status: SupportTicketStatus }>(db,
    `SELECT id, reference, subject, status FROM support_tickets WHERE duplicate_of=$1 OR id=$2 ORDER BY created_at LIMIT 20`, [t.id, t.duplicate_of]);
  const cursor = await one<{ id: string | null }>(db, `SELECT max(id)::text AS id FROM support_activity WHERE ticket_id=$1`, [t.id]);
  await db.query(`INSERT INTO support_ticket_reads(ticket_id, user_id, last_read_at) VALUES ($1,$2,now()) ON CONFLICT (ticket_id, user_id) DO UPDATE SET last_read_at=now()`, [t.id, p.actor.userId]);
  return {
    ...summaryDto(t),
    diagnostics: extra.diagnostics, resolution_reason: extra.resolution_reason, resolved_at: iso(extra.resolved_at), archived_at: iso(extra.archived_at), reopen_count: extra.reopen_count,
    timeline: timeline.map(({ at: _at, ...rest }) => rest as StaffTimelineItem),
    participants,
    problem_reports: reports.map((r) => ({ id: r.id, category: r.category, summary: r.summary, created_at: r.created_at.toISOString(), shared_at: iso(r.shared_at) })),
    duplicates: dups.filter((d) => d.id !== t.id),
    context: await workspaceContext(db, t.workspace_id, t.id),
    // V5 WID: widget visitor metadata (verification / block state; no IPs or device details).
    visitor: t.requester_kind === 'visitor' ? await visitorStaffInfo(db, t.id) : null,
    cursor: Number(cursor.id ?? 0),
  };
}

/** Metadata-only workspace context for staff (no posts, media, credentials, tokens or social messages). */
export async function workspaceContext(db: Queryable, workspaceId: string | null, ticketId: string | null): Promise<WorkspaceSupportContext> {
  const empty: WorkspaceSupportContext = { workspace: null, commercial: null, connections: { total: 0, healthy: 0, problems: [] }, recent_failures: { window_days: 7, failed: 0, unknown: 0, codes: [] },
    problem_reports: { open: 0, shared: 0 }, support_access: [], other_open_tickets: [] };
  if (!workspaceId) return empty;
  const w = await maybeOne<{ id: string; name: string; state: string; created_at: Date; is_demo: boolean; suspended_reason: string | null; members: number }>(db,
    `SELECT w.id, w.name, w.state, w.created_at, w.is_demo, w.suspended_reason,
            (SELECT count(*)::int FROM memberships m WHERE m.workspace_id=w.id AND m.status='active' AND m.removed_at IS NULL) AS members
       FROM workspaces w WHERE w.id=$1`, [workspaceId]);
  if (!w) return empty;
  const conns = await many<{ provider: string; status: string; paused: boolean; n: number }>(db,
    `SELECT provider::text, status::text, paused, count(*)::int n FROM connections WHERE workspace_id=$1 AND disconnected_at IS NULL GROUP BY provider, status, paused`, [workspaceId]);
  const healthy = conns.filter((c) => ['ready', 'expiring'].includes(c.status) && !c.paused).reduce((s, c) => s + c.n, 0);
  const fails = await one<{ failed: number; unknown: number }>(db,
    `SELECT count(*) FILTER (WHERE state='failed')::int failed, count(*) FILTER (WHERE state='unknown')::int unknown
       FROM deliveries WHERE workspace_id=$1 AND state IN ('failed','unknown') AND updated_at > now() - interval '7 days'`, [workspaceId]);
  const codes = await many<{ code: string; count: number }>(db,
    `SELECT coalesce(last_error_code, 'unknown') AS code, count(*)::int AS count FROM deliveries
      WHERE workspace_id=$1 AND state IN ('failed','unknown') AND updated_at > now() - interval '7 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 5`, [workspaceId]);
  const reports = await one<{ open: number; shared: number }>(db,
    `SELECT count(*) FILTER (WHERE status='open')::int open, count(*) FILTER (WHERE support_ticket_id IS NOT NULL)::int shared FROM support_reports WHERE workspace_id=$1`, [workspaceId]);
  const access = await many<{ id: string; status: string; operator: string; expires_at: Date | null; request_expires_at: Date; support_ticket_id: string | null }>(db,
    `SELECT g.id, g.status, coalesce(u.name, u.email::text) AS operator, g.expires_at, g.request_expires_at, g.support_ticket_id
       FROM support_access_grants g JOIN users u ON u.id=g.operator_user_id WHERE g.workspace_id=$1 ORDER BY (g.status IN ('requested','active')) DESC, g.requested_at DESC LIMIT 5`, [workspaceId]);
  const others = await many<{ id: string; reference: string; subject: string; status: SupportTicketStatus }>(db,
    `SELECT id, reference, subject, status FROM support_tickets WHERE workspace_id=$1 AND id <> coalesce($2::uuid, '00000000-0000-0000-0000-000000000000') AND status NOT IN ('resolved','archived')
      ORDER BY updated_at DESC LIMIT 5`, [workspaceId, ticketId]);
  return {
    workspace: { id: w.id, name: w.name, state: w.state, created_at: w.created_at.toISOString(), is_demo: w.is_demo, members: w.members, suspended_reason: w.suspended_reason },
    commercial: await commercialSummary(db, workspaceId),
    connections: { total: conns.reduce((s, c) => s + c.n, 0), healthy,
      problems: conns.filter((c) => !['ready', 'expiring'].includes(c.status) || c.paused).map((c) => ({ provider: c.provider, status: c.paused ? 'paused' : c.status, count: c.n })) },
    recent_failures: { window_days: 7, failed: fails.failed, unknown: fails.unknown, codes },
    problem_reports: reports,
    support_access: access.map((g) => ({ id: g.id, status: g.status, operator: g.operator, expires_at: iso(g.expires_at), request_expires_at: g.request_expires_at.toISOString(), support_ticket_id: g.support_ticket_id })),
    other_open_tickets: others,
  };
}

// ------------------------------------------------------------------ reply / note
const replySchema = z.object({
  body: z.string().trim().min(1, 'Write a reply').max(10000),
  attachment_ids: z.array(z.string()).max(5).default([]),
  /** Reply and resolve in one step. */
  resolve: z.enum(SUPPORT_RESOLUTION_REASONS).nullish(),
}).strict();
const noteSchema = z.object({ body: z.string().trim().min(1, 'Write a note').max(10000), attachment_ids: z.array(z.string()).max(5).default([]) }).strict();

async function staffName(db: Queryable, userId: string): Promise<string | null> {
  return (await maybeOne<{ n: string | null }>(db, `SELECT coalesce(name, split_part(email::text, '@', 1)) AS n FROM users WHERE id=$1`, [userId]))?.n ?? null;
}

/** Public reply to the customer (support_messages + customer activity + customer notification via the outbox). */
export async function staffReply(p: PlatformCtx, ref: string, raw: unknown, idemKey: string | null): Promise<StaffTicketDetail> {
  requireSupportStaff(p);
  const input = replySchema.parse(raw);
  await enforceRateLimit('supportStaffReply', p.actor.userId, STAFF_REPLY_RATE);
  const id = await withTx(async (tx) => {
    const t = await loadTicket(tx, ref, true);
    const prior = await beginPlatformIdempotent(tx, { userId: p.actor.userId, action: 'support.staff_reply', key: idemKey, body: { ticket: t.id, ...input } });
    if (prior) return t.id;
    if (t.status === 'archived') throw new AppError('invalid_state', 'Reopen this ticket before replying.');
    const m = await one<{ id: string }>(tx, `INSERT INTO support_messages(ticket_id, author_kind, author_user_id, body) VALUES ($1,'staff',$2,$3) RETURNING id`, [t.id, p.actor.userId, input.body]);
    await bindAttachments(tx, { ids: input.attachment_ids, owner: { kind: 'staff', userId: p.actor.userId }, ticketId: t.id, messageId: m.id });
    const reopened = t.status === 'resolved' && !input.resolve;
    await tx.query(
      `UPDATE support_tickets SET status=$2, resolution_reason=$3, resolved_at=CASE WHEN $2='resolved' THEN coalesce(resolved_at, now()) ELSE NULL END,
              last_staff_reply_at=now(), updated_at=now(), assignee_user_id=coalesce(assignee_user_id, $4) WHERE id=$1`,
      [t.id, input.resolve ? 'resolved' : 'waiting_on_customer', input.resolve ?? null, p.actor.userId]);
    await appendSearch(tx, t.id, input.body);
    const actor = { actorKind: 'staff' as const, actorUserId: p.actor.userId };
    await writeActivity(tx, { ticketId: t.id, audience: 'customer', kind: 'message.created', ...actor, refId: m.id });
    if (reopened) await writeActivity(tx, { ticketId: t.id, audience: 'customer', kind: 'status.reopened', ...actor, detail: { actor_name: await staffName(tx, p.actor.userId) } });
    if (input.resolve) await writeActivity(tx, { ticketId: t.id, audience: 'customer', kind: 'status.resolved', ...actor, detail: { reason: input.resolve, actor_name: await staffName(tx, p.actor.userId) } });
    if (!t.assignee_user_id) await writeActivity(tx, { ticketId: t.id, audience: 'staff', kind: 'assigned', ...actor, refId: p.actor.userId, detail: { to_name: await staffName(tx, p.actor.userId), auto: true } });
    await writeOutbox(tx, { workspaceId: t.workspace_id, aggregateType: 'support_ticket', aggregateId: t.id, eventType: 'support.message_created', payload: { messageId: m.id } });
    await completePlatformIdempotent(tx, { userId: p.actor.userId, action: 'support.staff_reply', key: idemKey!, status: 200, body: { id: t.id, message_id: m.id } });
    return t.id;
  });
  return getStaffTicket(p, id);
}

/** Staff-only internal note (support_notes + staff activity). Never reaches customers in any form. */
export async function staffNote(p: PlatformCtx, ref: string, raw: unknown, idemKey: string | null): Promise<StaffTicketDetail> {
  requireSupportStaff(p);
  const input = noteSchema.parse(raw);
  await enforceRateLimit('supportStaffReply', p.actor.userId, STAFF_REPLY_RATE);
  const id = await withTx(async (tx) => {
    const t = await loadTicket(tx, ref, true);
    const prior = await beginPlatformIdempotent(tx, { userId: p.actor.userId, action: 'support.note', key: idemKey, body: { ticket: t.id, ...input } });
    if (prior) return t.id;
    const n = await one<{ id: string }>(tx, `INSERT INTO support_notes(ticket_id, author_user_id, body) VALUES ($1,$2,$3) RETURNING id`, [t.id, p.actor.userId, input.body]);
    await bindAttachments(tx, { ids: input.attachment_ids, owner: { kind: 'staff', userId: p.actor.userId }, ticketId: t.id, noteId: n.id });
    await tx.query(`UPDATE support_tickets SET updated_at=now() WHERE id=$1`, [t.id]);
    await writeActivity(tx, { ticketId: t.id, audience: 'staff', kind: 'note.created', actorKind: 'staff', actorUserId: p.actor.userId, refId: n.id });
    await completePlatformIdempotent(tx, { userId: p.actor.userId, action: 'support.note', key: idemKey!, status: 200, body: { id: t.id, note_id: n.id } });
    return t.id;
  });
  return getStaffTicket(p, id);
}

// ------------------------------------------------------------------ triage
const assignSchema = z.object({ assignee_id: z.string().uuid().nullable() }).strict();

export async function assignTicket(p: PlatformCtx, ref: string, raw: unknown): Promise<StaffTicketDetail> {
  requireSupportStaff(p);
  const { assignee_id } = assignSchema.parse(raw);
  const id = await withTx(async (tx) => {
    const t = await loadTicket(tx, ref, true);
    if (assignee_id && !(await activeSupportStaff(tx, assignee_id))) throw new AppError('validation_failed', 'Assign to a member of the support team', { assignee_id: 'Not support staff' });
    if (t.assignee_user_id === assignee_id) return t.id;
    await tx.query(`UPDATE support_tickets SET assignee_user_id=$2, updated_at=now() WHERE id=$1`, [t.id, assignee_id]);
    const activityId = await writeActivity(tx, { ticketId: t.id, audience: 'staff', kind: 'assigned', actorKind: 'staff', actorUserId: p.actor.userId, refId: assignee_id,
      detail: { to_name: assignee_id ? await staffName(tx, assignee_id) : null, from: t.assignee_user_id } });
    if (assignee_id) {
      await writeOutbox(tx, { workspaceId: t.workspace_id, aggregateType: 'support_ticket', aggregateId: t.id, eventType: 'support.ticket_assigned',
        payload: { assigneeId: assignee_id, byUserId: p.actor.userId, activityId } });
    }
    await platformAudit(tx, p, { action: 'support.ticket_assigned', targetType: 'support_ticket', targetId: t.id, workspaceId: t.workspace_id, diff: { from: t.assignee_user_id, to: assignee_id } });
    return t.id;
  });
  return getStaffTicket(p, id);
}

const updateSchema = z.object({
  priority: z.enum(SUPPORT_PRIORITIES).optional(),
  category: z.enum(SUPPORT_TICKET_CATEGORIES).optional(),
  status: z.enum(SUPPORT_TICKET_STATUSES).optional(),
  resolution_reason: z.enum(SUPPORT_RESOLUTION_REASONS).optional(),
}).strict();

export async function updateTicket(p: PlatformCtx, ref: string, raw: unknown): Promise<StaffTicketDetail> {
  requireSupportStaff(p);
  const input = updateSchema.parse(raw);
  const id = await withTx(async (tx) => {
    const t = await loadTicket(tx, ref, true);
    const cur = await one<{ status: SupportTicketStatus; priority: string; category: string; resolution_reason: string | null }>(tx,
      `SELECT status, priority, category, resolution_reason FROM support_tickets WHERE id=$1`, [t.id]);
    const name = await staffName(tx, p.actor.userId);
    const actor = { actorKind: 'staff' as const, actorUserId: p.actor.userId };
    const diff: Record<string, unknown> = {};
    if (input.priority && input.priority !== cur.priority) {
      await tx.query(`UPDATE support_tickets SET priority=$2 WHERE id=$1`, [t.id, input.priority]);
      await writeActivity(tx, { ticketId: t.id, audience: 'staff', kind: 'priority.changed', ...actor, detail: { from: cur.priority, to: input.priority, actor_name: name } });
      diff.priority = input.priority;
    }
    if (input.category && input.category !== cur.category) {
      // Restricted status follows the category, but a restricted ticket is never widened by staff re-categorisation.
      await tx.query(`UPDATE support_tickets SET category=$2, restricted = restricted OR $2 = 'security' WHERE id=$1`, [t.id, input.category]);
      await writeActivity(tx, { ticketId: t.id, audience: 'staff', kind: 'category.changed', ...actor, detail: { from: cur.category, to: input.category, actor_name: name } });
      diff.category = input.category;
    }
    if (input.status && input.status !== cur.status) {
      const to = input.status;
      if (to === 'resolved') {
        const reason = input.resolution_reason;
        if (!reason) throw new AppError('validation_failed', 'Choose a resolution reason', { resolution_reason: 'Required' });
        await tx.query(`UPDATE support_tickets SET status='resolved', resolution_reason=$2, resolved_at=now() WHERE id=$1`, [t.id, reason]);
        await writeActivity(tx, { ticketId: t.id, audience: 'customer', kind: 'status.resolved', ...actor, detail: { reason, actor_name: name } });
      } else if (to === 'archived') {
        if (cur.status !== 'resolved') throw new AppError('invalid_state', 'Resolve the ticket before archiving it.');
        await tx.query(`UPDATE support_tickets SET status='archived', archived_at=now() WHERE id=$1`, [t.id]);
        await writeActivity(tx, { ticketId: t.id, audience: 'customer', kind: 'status.archived', ...actor, detail: { actor_name: name } });
      } else if (cur.status === 'resolved' || cur.status === 'archived') {
        await tx.query(`UPDATE support_tickets SET status=$2, resolution_reason=NULL, resolved_at=NULL, archived_at=NULL, reopen_count=reopen_count+1 WHERE id=$1`, [t.id, to]);
        await writeActivity(tx, { ticketId: t.id, audience: 'customer', kind: 'status.reopened', ...actor, detail: { actor_name: name } });
      } else {
        await tx.query(`UPDATE support_tickets SET status=$2 WHERE id=$1`, [t.id, to]);
        await writeActivity(tx, { ticketId: t.id, audience: 'staff', kind: 'status.changed', ...actor, detail: { from: cur.status, to, actor_name: name } });
      }
      diff.status = to; if (input.resolution_reason) diff.resolution_reason = input.resolution_reason;
    }
    if (Object.keys(diff).length) {
      await tx.query(`UPDATE support_tickets SET updated_at=now() WHERE id=$1`, [t.id]);
      await platformAudit(tx, p, { action: 'support.ticket_updated', targetType: 'support_ticket', targetId: t.id, workspaceId: t.workspace_id, diff });
    }
    return t.id;
  });
  return getStaffTicket(p, id);
}

const duplicateSchema = z.object({ of: z.string().trim().min(5).max(40) }).strict();

/** Link as a duplicate of another ticket and resolve it (reason 'duplicate'). The customer sees only "Resolved · duplicate". */
export async function markDuplicate(p: PlatformCtx, ref: string, raw: unknown): Promise<StaffTicketDetail> {
  requireSupportStaff(p);
  const { of } = duplicateSchema.parse(raw);
  const id = await withTx(async (tx) => {
    const t = await loadTicket(tx, ref, true);
    const target = await loadTicket(tx, of);
    if (target.id === t.id) throw new AppError('validation_failed', 'A ticket can’t duplicate itself', { of: 'Same ticket' });
    if (target.duplicate_of === t.id) throw new AppError('validation_failed', 'That ticket is already a duplicate of this one', { of: 'Circular' });
    const name = await staffName(tx, p.actor.userId);
    await tx.query(`UPDATE support_tickets SET duplicate_of=$2, status='resolved', resolution_reason='duplicate', resolved_at=coalesce(resolved_at, now()), updated_at=now() WHERE id=$1`, [t.id, target.id]);
    await writeActivity(tx, { ticketId: t.id, audience: 'staff', kind: 'duplicate.marked', actorKind: 'staff', actorUserId: p.actor.userId, refId: target.id, detail: { of_reference: target.reference, actor_name: name } });
    await writeActivity(tx, { ticketId: t.id, audience: 'customer', kind: 'status.resolved', actorKind: 'staff', actorUserId: p.actor.userId, detail: { reason: 'duplicate', actor_name: name } });
    await writeActivity(tx, { ticketId: target.id, audience: 'staff', kind: 'duplicate.linked', actorKind: 'staff', actorUserId: p.actor.userId, refId: t.id, detail: { from_reference: t.reference } });
    await platformAudit(tx, p, { action: 'support.ticket_duplicate', targetType: 'support_ticket', targetId: t.id, workspaceId: t.workspace_id, diff: { duplicate_of: target.id } });
    return t.id;
  });
  return getStaffTicket(p, id);
}

// ------------------------------------------------------------------ support access from a ticket
const accessSchema = z.object({ reason: z.string().trim().min(10, 'Give a reason (10+ characters)').max(500), duration_minutes: z.number().int().min(15).max(1440) }).strict();

/** Reuses the existing owner-approved, time-boxed, read-only flow (admin/support-access.ts) with the ticket linked. */
export async function requestAccessForTicket(p: PlatformCtx, ref: string, raw: unknown): Promise<StaffTicketDetail> {
  requireSupportStaff(p);
  const input = accessSchema.parse(raw);
  const t = await loadTicket(getPool(), ref);
  if (!t.workspace_id) throw new AppError('invalid_state', 'This ticket has no workspace.');
  await requestSupportAccess(p, { workspace_id: t.workspace_id, reason: input.reason, duration_minutes: input.duration_minutes, support_ticket_id: t.id });
  return getStaffTicket(p, t.id);
}

// ------------------------------------------------------------------ staff, saved replies, feed
export async function listSupportStaff(p: PlatformCtx, db: Queryable = getPool()): Promise<{ items: SupportStaffDto[] }> {
  requireSupportStaff(p);
  const rows = await many<SupportStaffDto>(db,
    `SELECT u.id, u.name, u.email::text AS email, o.role FROM platform_operators o JOIN users u ON u.id=o.user_id
      WHERE o.revoked_at IS NULL AND u.disabled_at IS NULL AND o.role IN ('operator','support') ORDER BY coalesce(u.name, u.email::text)`);
  return { items: rows };
}

const savedSchema = z.object({
  title: z.string().trim().min(1).max(120), body: z.string().trim().min(1).max(5000), category: z.enum(SUPPORT_TICKET_CATEGORIES).nullish(),
}).strict();

const savedDto = (r: { id: string; title: string; body: string; category: SavedReplyDto['category']; updated_at: Date }): SavedReplyDto =>
  ({ id: r.id, title: r.title, body: r.body, category: r.category, updated_at: r.updated_at.toISOString() });

export async function listSavedReplies(p: PlatformCtx, db: Queryable = getPool()): Promise<{ items: SavedReplyDto[] }> {
  requireSupportStaff(p);
  const rows = await many<Parameters<typeof savedDto>[0]>(db, `SELECT id, title, body, category, updated_at FROM support_saved_replies WHERE archived_at IS NULL ORDER BY title LIMIT 200`);
  return { items: rows.map(savedDto) };
}

export async function createSavedReply(p: PlatformCtx, raw: unknown): Promise<SavedReplyDto> {
  requireSupportStaff(p);
  const input = savedSchema.parse(raw);
  return withTx(async (tx) => {
    const r = await one<Parameters<typeof savedDto>[0]>(tx,
      `INSERT INTO support_saved_replies(title, body, category, created_by, updated_by) VALUES ($1,$2,$3,$4,$4) RETURNING id, title, body, category, updated_at`,
      [input.title, input.body, input.category ?? null, p.actor.userId]);
    await platformAudit(tx, p, { action: 'support.saved_reply_created', targetType: 'support_saved_reply', targetId: r.id });
    return savedDto(r);
  });
}

export async function updateSavedReply(p: PlatformCtx, id: string, raw: unknown): Promise<SavedReplyDto> {
  requireSupportStaff(p);
  assertUuid(id, 'Saved reply');
  const input = savedSchema.parse(raw);
  return withTx(async (tx) => {
    const r = await maybeOne<Parameters<typeof savedDto>[0]>(tx,
      `UPDATE support_saved_replies SET title=$2, body=$3, category=$4, updated_by=$5, updated_at=now() WHERE id=$1 AND archived_at IS NULL RETURNING id, title, body, category, updated_at`,
      [id, input.title, input.body, input.category ?? null, p.actor.userId]);
    if (!r) throw notFound('Saved reply');
    await platformAudit(tx, p, { action: 'support.saved_reply_updated', targetType: 'support_saved_reply', targetId: id });
    return savedDto(r);
  });
}

export async function archiveSavedReply(p: PlatformCtx, id: string): Promise<{ ok: true }> {
  requireSupportStaff(p);
  assertUuid(id, 'Saved reply');
  await withTx(async (tx) => {
    const r = await tx.query(`UPDATE support_saved_replies SET archived_at=now(), updated_by=$2 WHERE id=$1 AND archived_at IS NULL`, [id, p.actor.userId]);
    if (!r.rowCount) throw notFound('Saved reply');
    await platformAudit(tx, p, { action: 'support.saved_reply_archived', targetType: 'support_saved_reply', targetId: id });
  });
  return { ok: true };
}

/** Staff change feed across all tickets (content-free; cursor = activity id). */
export async function staffEvents(p: PlatformCtx, after: number, db: Queryable = getPool()): Promise<{ items: Array<{ id: number; ticket_id: string; reference: string; kind: string; at: string }>; cursor: number }> {
  requireSupportStaff(p);
  const a = Number.isSafeInteger(after) && after > 0 ? after : 0;
  if (!a) {
    const c = await one<{ id: string | null }>(db, `SELECT max(id)::text AS id FROM support_activity`);
    return { items: [], cursor: Number(c.id ?? 0) };
  }
  const rows = await many<{ id: string; ticket_id: string; reference: string; kind: string; created_at: Date }>(db,
    `SELECT a.id::text, a.ticket_id, t.reference, a.kind, a.created_at FROM support_activity a JOIN support_tickets t ON t.id=a.ticket_id WHERE a.id > $1 ORDER BY a.id LIMIT 200`, [a]);
  return { items: rows.map((r) => ({ id: Number(r.id), ticket_id: r.ticket_id, reference: r.reference, kind: r.kind, at: r.created_at.toISOString() })), cursor: rows.length ? Number(rows[rows.length - 1]!.id) : a };
}

/** Open support requests per workspace (counts only — usable by any staff role, e.g. Platform → Workspaces). */
export async function openTicketCount(workspaceId: string, db: Queryable = getPool()): Promise<number> {
  const r = await one<{ n: number }>(db, `SELECT count(*)::int n FROM support_tickets WHERE workspace_id=$1 AND status NOT IN ('resolved','archived')`, [workspaceId]);
  return r.n;
}

