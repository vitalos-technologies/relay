// Relay support (V4 SUP) — customer side: Help → Contact support / My requests.
// Identity and workspace come from the request context only (never the payload). Every read goes through
// loadVisibleTicket()/visibleSql() (access.ts). Customer DTOs are built from support_tickets + support_messages +
// customer-audience activity ONLY: support_notes and staff-audience activity are never selected here.
// Status policy: customer message → waiting_on_relay (reopens a resolved request inside the reopen window); staff public
// reply → waiting_on_customer; resolve by either side; archived requests are read-only (start a new request).
import { z } from 'zod';
import { AppError } from '@social-lite/core';
import {
  RESTRICTED_SUPPORT_CATEGORIES, SUPPORT_CATEGORY_LABEL, SUPPORT_REOPEN_WINDOW_DAYS, SUPPORT_TICKET_CATEGORIES,
  type CustomerActivityDto, type CustomerMessageDto, type CustomerTicketDetail, type CustomerTicketSummary, type CustomerTicketsResponse, type SupportDiagnostics,
  type SupportResolutionReason, type SupportSource, type SupportTicketCategory, type SupportTicketStatus,
} from '@social-lite/core/contracts/v4-support';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { beginIdempotent, completeIdempotent } from '../idempotency.js';
import { enforceRateLimit } from '../ratelimit.js';
import { writeOutbox } from '../outbox.js';
import { canAnywhere } from '../access.js';
import { assertUuid, authorizeCtx, isUuid } from '../tenancy.js';
import { canSeeWorkspaceTickets, loadVisibleTicket, visibleSql, type VisibleTicket } from './access.js';
import { attachmentsFor, bindAttachments } from './attachments.js';
import { activityText, appendSearch, iso, newReference, redactSecrets, safeDiagnostics, staffPublicName, writeActivity } from './shared.js';

export const CREATE_RATE = { capacity: 10, refillPerSecond: 10 / 3600 }; // per person: 10 burst, 10 per hour
export const REPLY_RATE = { capacity: 30, refillPerSecond: 30 / 600 }; // per person: 30 burst, 30 per 10 min

const diagnosticsSchema = z.object({
  app_version: z.string().max(64).nullish(), route: z.string().max(2000).nullish(), occurred_at: z.string().max(40).nullish(),
  browser_family: z.string().max(20).nullish(), correlation_ids: z.array(z.string().max(200)).max(20).optional(), error_code: z.string().max(64).nullish(),
}).strip();

export const createSchema = z.object({
  category: z.enum(SUPPORT_TICKET_CATEGORIES, { message: 'Choose a category' }),
  subject: z.string().trim().min(1, 'Add a subject').max(200),
  message: z.string().trim().min(1, 'Describe what you need').max(10000),
  attachment_ids: z.array(z.string()).max(5).default([]),
  /** Opt-in safe technical context (app version, page path, browser family, error references). */
  diagnostics: diagnosticsSchema.nullish(),
}).strict();

const replySchema = z.object({ body: z.string().trim().min(1, 'Write a message').max(10000), attachment_ids: z.array(z.string()).max(5).default([]) }).strict();

// ------------------------------------------------------------------ create
export interface CreateTicketInput {
  category: SupportTicketCategory; subject: string; message: string; attachmentIds: string[]; diagnostics: SupportDiagnostics;
  source: SupportSource; problemReportId?: string | null;
}

/** Insert a member ticket + first message inside `tx` (shared with the problem-report flow). */
export async function insertMemberTicket(tx: Queryable, ctx: Ctx, input: CreateTicketInput): Promise<{ id: string; reference: string; messageId: string }> {
  const reference = await newReference(tx);
  const restricted = RESTRICTED_SUPPORT_CATEGORIES.includes(input.category);
  const subject = redactSecrets(input.subject).text.slice(0, 200);
  const body = redactSecrets(input.message);
  const t = await one<{ id: string }>(tx,
    `INSERT INTO support_tickets(reference, requester_kind, workspace_id, requester_user_id, source, category, restricted, subject, diagnostics, problem_report_id, last_customer_at, search_doc)
     VALUES ($1,'member',$2,$3,$4,$5,$6,$7,$8,$9, now(), to_tsvector('simple', $1 || ' ' || $7)) RETURNING id`,
    [reference, ctx.access.workspaceId, ctx.actor.userId, input.source, input.category, restricted, subject, JSON.stringify(input.diagnostics), input.problemReportId ?? null]);
  const m = await one<{ id: string }>(tx,
    `INSERT INTO support_messages(ticket_id, author_kind, author_user_id, body, redactions) VALUES ($1,'member',$2,$3,$4) RETURNING id`, [t.id, ctx.actor.userId, body.text, body.count]);
  await bindAttachments(tx, { ids: input.attachmentIds, owner: { kind: 'member', userId: ctx.actor.userId, workspaceId: ctx.access.workspaceId }, ticketId: t.id, messageId: m.id });
  await appendSearch(tx, t.id, body.text);
  await writeActivity(tx, { ticketId: t.id, audience: 'customer', kind: 'ticket.created', actorKind: 'member', actorUserId: ctx.actor.userId, detail: { source: input.source } });
  await writeActivity(tx, { ticketId: t.id, audience: 'customer', kind: 'message.created', actorKind: 'member', actorUserId: ctx.actor.userId, refId: m.id });
  await tx.query(`INSERT INTO support_ticket_reads(ticket_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [t.id, ctx.actor.userId]);
  await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'support_ticket', aggregateId: t.id, eventType: 'support.ticket_created', payload: {} });
  // Workspace audit records the fact, never the text (restricted tickets are not named either).
  await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'support.ticket_created', resourceType: 'support_ticket', resourceId: t.id,
    diff: { reference, category: restricted ? 'restricted' : input.category, source: input.source, attachments: input.attachmentIds.length }, correlationId: ctx.correlationId });
  return { id: t.id, reference, messageId: m.id };
}

export async function createTicket(ctx: Ctx, raw: unknown, idemKey: string | null, opts: { userAgentFamily?: string | null } = {}): Promise<CustomerTicketDetail> {
  const input = createSchema.parse(raw);
  await enforceRateLimit('supportCreate', ctx.actor.userId, CREATE_RATE);
  const diagnostics = input.diagnostics ? safeDiagnostics({ ...input.diagnostics, browser_family: input.diagnostics.browser_family ?? opts.userAgentFamily ?? null }) : {};
  const res = await withTx(async (tx) => {
    const prior = await beginIdempotent(tx, { workspaceId: ctx.access.workspaceId, userId: ctx.actor.userId, action: 'support.create', key: idemKey, body: input });
    if (prior) return prior.body as { id: string };
    const r = await insertMemberTicket(tx, ctx, { category: input.category, subject: input.subject, message: input.message, attachmentIds: input.attachment_ids, diagnostics, source: 'app' });
    await completeIdempotent(tx, { workspaceId: ctx.access.workspaceId, action: 'support.create', key: idemKey!, status: 201, body: { id: r.id, reference: r.reference } });
    return { id: r.id };
  });
  return getTicket(ctx, res.id);
}

// ------------------------------------------------------------------ list / detail
interface SummaryRow {
  id: string; reference: string; subject: string; category: SupportTicketCategory; restricted: boolean; status: SupportTicketStatus; requester_user_id: string | null;
  requester_name: string | null; created_at: Date; updated_at: Date; last_staff_reply_at: Date | null; last_read_at: Date | null;
}

function summaryDto(r: SummaryRow, me: string): CustomerTicketSummary {
  return {
    id: r.id, reference: r.reference, subject: r.subject, category: r.category, restricted: r.restricted, status: r.status,
    requester: { id: r.requester_user_id, name: r.requester_name, mine: r.requester_user_id === me },
    created_at: r.created_at.toISOString(), updated_at: r.updated_at.toISOString(), last_staff_reply_at: iso(r.last_staff_reply_at),
    unread: !!r.last_staff_reply_at && (!r.last_read_at || r.last_staff_reply_at > r.last_read_at),
  };
}

const listSchema = z.object({
  scope: z.enum(['mine', 'workspace']).default('mine'),
  status: z.enum(['open', 'resolved', 'all']).default('all'),
  q: z.string().trim().max(200).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
}).strip();

export async function listTickets(ctx: Ctx, raw: unknown = {}, db: Queryable = getPool()): Promise<CustomerTicketsResponse> {
  const q = listSchema.parse(raw ?? {});
  const canWs = canSeeWorkspaceTickets(ctx);
  const params: unknown[] = [ctx.access.workspaceId, ctx.actor.userId, canWs];
  const where = [visibleSql(1, 2, 3)];
  if (q.scope === 'mine') where.push(`(t.requester_user_id = $2 OR EXISTS (SELECT 1 FROM support_ticket_participants sp WHERE sp.ticket_id=t.id AND sp.user_id=$2 AND sp.removed_at IS NULL))`);
  if (q.status === 'open') where.push(`t.status NOT IN ('resolved','archived')`);
  if (q.status === 'resolved') where.push(`t.status IN ('resolved','archived')`);
  if (q.q) {
    params.push(q.q);
    where.push(/^RLY-\d+$/i.test(q.q) ? `upper(t.reference) = upper($${params.length})` : `(t.search_doc @@ websearch_to_tsquery('simple', $${params.length}) OR t.subject ILIKE '%' || $${params.length} || '%')`);
  }
  if (q.cursor) {
    const [ts, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
    if (!ts || !isUuid(id) || Number.isNaN(Date.parse(ts))) throw new AppError('validation_failed', 'Invalid cursor');
    params.push(ts, id); where.push(`(t.updated_at, t.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const rows = await many<SummaryRow>(db,
    `SELECT t.id, t.reference, t.subject, t.category, t.restricted, t.status, t.requester_user_id, coalesce(u.name, split_part(u.email::text, '@', 1)) AS requester_name,
            t.created_at, t.updated_at, t.last_staff_reply_at, r.last_read_at
       FROM support_tickets t LEFT JOIN users u ON u.id=t.requester_user_id
       LEFT JOIN support_ticket_reads r ON r.ticket_id=t.id AND r.user_id=$2
      WHERE ${where.join(' AND ')} ORDER BY t.updated_at DESC, t.id DESC LIMIT $${params.length}`, params);
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => summaryDto(r, ctx.actor.userId)),
    next_cursor: rows.length > q.limit && last ? Buffer.from(`${last.updated_at.toISOString()}|${last.id}`).toString('base64url') : null,
    can_see_workspace: canWs,
  };
}

/** Customer-visible activity line for one row (never staff names). */
function customerActivity(r: { id: string; kind: string; detail: Record<string, unknown>; created_at: Date }): CustomerActivityDto {
  return { id: Number(r.id), kind: r.kind, at: r.created_at.toISOString(), text: activityText(r.kind, r.detail, false) };
}

export async function getTicket(ctx: Ctx, idOrRef: string, db: Queryable = getPool(), opts: { markRead?: boolean } = { markRead: true }): Promise<CustomerTicketDetail> {
  const v = await loadVisibleTicket(ctx, idOrRef, db);
  const t = await one<SummaryRow & { source: SupportSource; resolution_reason: SupportResolutionReason | null; resolved_at: Date | null; diagnostics: SupportDiagnostics; problem_report_id: string | null }>(db,
    `SELECT t.id, t.reference, t.subject, t.category, t.restricted, t.status, t.requester_user_id, coalesce(u.name, split_part(u.email::text, '@', 1)) AS requester_name,
            t.created_at, t.updated_at, t.last_staff_reply_at, r.last_read_at, t.source, t.resolution_reason, t.resolved_at, t.diagnostics, t.problem_report_id
       FROM support_tickets t LEFT JOIN users u ON u.id=t.requester_user_id LEFT JOIN support_ticket_reads r ON r.ticket_id=t.id AND r.user_id=$2
      WHERE t.id=$1`, [v.id, ctx.actor.userId]);
  // Customer-visible messages only (support_messages never contains internal notes).
  const msgs = await many<{ id: string; author_kind: 'member' | 'visitor' | 'staff'; author_user_id: string | null; author_name: string | null; author_email: string | null; body: string; created_at: Date }>(db,
    `SELECT m.id, m.author_kind, m.author_user_id, u.name AS author_name, u.email::text AS author_email, m.body, m.created_at
       FROM support_messages m LEFT JOIN users u ON u.id=m.author_user_id WHERE m.ticket_id=$1 ORDER BY m.created_at, m.id`, [v.id]);
  const files = await attachmentsFor(db, 'message_id', msgs.map((m) => m.id), '/api/support/attachments');
  const messages: CustomerMessageDto[] = msgs.map((m) => ({
    id: m.id,
    author: { kind: m.author_kind, mine: m.author_user_id === ctx.actor.userId,
      name: m.author_kind === 'staff' ? staffPublicName(m.author_name) : (m.author_name || m.author_email?.split('@')[0] || 'Customer') },
    body: m.body, created_at: m.created_at.toISOString(), attachments: files.get(m.id) ?? [],
  }));
  const activity = await many<{ id: string; kind: string; detail: Record<string, unknown>; created_at: Date }>(db,
    `SELECT id::text, kind, detail, created_at FROM support_activity WHERE ticket_id=$1 AND audience='customer' AND kind <> 'message.created' ORDER BY id`, [v.id]);
  const cursor = await one<{ id: string | null }>(db, `SELECT max(id)::text AS id FROM support_activity WHERE ticket_id=$1 AND audience='customer'`, [v.id]);
  const participants = await many<{ id: string; name: string | null; email: string }>(db,
    `SELECT u.id, u.name, u.email::text AS email FROM support_ticket_participants p JOIN users u ON u.id=p.user_id WHERE p.ticket_id=$1 AND p.removed_at IS NULL ORDER BY p.added_at`, [v.id]);
  const access = await many<{ id: string; status: string; reason: string; duration_minutes: number; requested_at: Date; expires_at: Date | null; request_expires_at: Date; operator_name: string | null }>(db,
    `SELECT g.id, g.status, g.reason, g.duration_minutes, g.requested_at, g.expires_at, g.request_expires_at, u.name AS operator_name
       FROM support_access_grants g JOIN users u ON u.id=g.operator_user_id WHERE g.support_ticket_id=$1 AND g.workspace_id=$2 ORDER BY g.requested_at DESC LIMIT 10`,
    [v.id, ctx.access.workspaceId]);
  const report = t.problem_report_id ? await maybeOne<{ id: string; created_at: Date }>(db, `SELECT id, created_at FROM support_reports WHERE id=$1 AND workspace_id=$2`, [t.problem_report_id, ctx.access.workspaceId]) : null;
  const canAct = v.mine || v.participant || canSeeWorkspaceTickets(ctx);
  const reopenable = t.status === 'resolved' && !!t.resolved_at && Date.now() - t.resolved_at.getTime() < SUPPORT_REOPEN_WINDOW_DAYS * 86_400_000;
  if (opts.markRead) {
    await db.query(`INSERT INTO support_ticket_reads(ticket_id, user_id, last_read_at) VALUES ($1,$2,now()) ON CONFLICT (ticket_id, user_id) DO UPDATE SET last_read_at=now()`, [v.id, ctx.actor.userId]);
  }
  return {
    ...summaryDto(t, ctx.actor.userId),
    unread: false,
    source: t.source, resolution_reason: t.resolution_reason, resolved_at: iso(t.resolved_at), diagnostics: t.diagnostics,
    messages, activity: activity.map(customerActivity), participants,
    problem_report: report ? { id: report.id, created_at: report.created_at.toISOString() } : null,
    support_access: access.map((g) => ({ id: g.id, status: g.status, reason: g.reason, duration_minutes: g.duration_minutes, requested_at: g.requested_at.toISOString(),
      expires_at: iso(g.expires_at), request_expires_at: g.request_expires_at.toISOString(), operator: staffPublicName(g.operator_name) })),
    can: {
      reply: canAct && t.status !== 'archived',
      resolve: canAct && t.status !== 'resolved' && t.status !== 'archived',
      reopen: canAct && reopenable,
      add_participants: (v.mine || canSeeWorkspaceTickets(ctx)) && canAnywhere(ctx, 'members.read') && t.status !== 'archived',
      decide_access: holdsIgnoringAssurance(ctx, 'members.manage'),
    },
    cursor: Number(cursor.id ?? 0),
  };
}

/** Holds the permission (an MFA / step-up requirement is satisfied at action time, so the action is still offered). */
function holdsIgnoringAssurance(ctx: Ctx, perm: 'members.manage'): boolean {
  const d = authorizeCtx(ctx, perm);
  return d.allowed || d.reason === 'mfa_required' || d.reason === 'step_up_required';
}

// ------------------------------------------------------------------ actions
async function lockVisible(tx: Queryable, ctx: Ctx, ref: string): Promise<VisibleTicket> {
  return loadVisibleTicket(ctx, ref, tx, true);
}

export async function replyTicket(ctx: Ctx, ref: string, raw: unknown, idemKey: string | null): Promise<CustomerTicketDetail> {
  const input = replySchema.parse(raw);
  await enforceRateLimit('supportReply', ctx.actor.userId, REPLY_RATE);
  const id = await withTx(async (tx) => {
    const t = await lockVisible(tx, ctx, ref);
    const prior = await beginIdempotent(tx, { workspaceId: ctx.access.workspaceId, userId: ctx.actor.userId, action: 'support.reply', key: idemKey, body: { ticket: t.id, ...input } });
    if (prior) return t.id;
    if (t.status === 'archived') throw new AppError('invalid_state', 'This request is closed. Start a new request.');
    let reopen = false;
    if (t.status === 'resolved') {
      if (!t.resolved_at || Date.now() - t.resolved_at.getTime() >= SUPPORT_REOPEN_WINDOW_DAYS * 86_400_000) throw new AppError('invalid_state', 'This request was resolved too long ago to reopen. Start a new request.');
      reopen = true;
    }
    const body = redactSecrets(input.body);
    const m = await one<{ id: string }>(tx, `INSERT INTO support_messages(ticket_id, author_kind, author_user_id, body, redactions) VALUES ($1,'member',$2,$3,$4) RETURNING id`,
      [t.id, ctx.actor.userId, body.text, body.count]);
    await bindAttachments(tx, { ids: input.attachment_ids, owner: { kind: 'member', userId: ctx.actor.userId, workspaceId: ctx.access.workspaceId }, ticketId: t.id, messageId: m.id });
    await tx.query(
      `UPDATE support_tickets SET status = CASE WHEN status='new' THEN 'new' ELSE 'waiting_on_relay' END, last_customer_at=now(), updated_at=now(),
              resolution_reason = CASE WHEN status='resolved' THEN NULL ELSE resolution_reason END, resolved_at = CASE WHEN status='resolved' THEN NULL ELSE resolved_at END,
              reopen_count = reopen_count + CASE WHEN status='resolved' THEN 1 ELSE 0 END
        WHERE id=$1`, [t.id]);
    await appendSearch(tx, t.id, body.text);
    if (reopen) await writeActivity(tx, { ticketId: t.id, audience: 'customer', kind: 'status.reopened', actorKind: 'member', actorUserId: ctx.actor.userId });
    await writeActivity(tx, { ticketId: t.id, audience: 'customer', kind: 'message.created', actorKind: 'member', actorUserId: ctx.actor.userId, refId: m.id });
    await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'support_ticket', aggregateId: t.id, eventType: 'support.message_created', payload: { messageId: m.id } });
    await completeIdempotent(tx, { workspaceId: ctx.access.workspaceId, action: 'support.reply', key: idemKey!, status: 200, body: { id: t.id, message_id: m.id } });
    return t.id;
  });
  return getTicket(ctx, id);
}

export async function resolveTicket(ctx: Ctx, ref: string): Promise<CustomerTicketDetail> {
  const id = await withTx(async (tx) => {
    const t = await lockVisible(tx, ctx, ref);
    if (t.status === 'resolved' || t.status === 'archived') throw new AppError('invalid_state', 'This request is already resolved.');
    await tx.query(`UPDATE support_tickets SET status='resolved', resolution_reason='customer_resolved', resolved_at=now(), updated_at=now() WHERE id=$1`, [t.id]);
    await writeActivity(tx, { ticketId: t.id, audience: 'customer', kind: 'status.resolved', actorKind: 'member', actorUserId: ctx.actor.userId, detail: { reason: 'customer_resolved' } });
    return t.id;
  });
  return getTicket(ctx, id);
}

export async function reopenTicket(ctx: Ctx, ref: string): Promise<CustomerTicketDetail> {
  const id = await withTx(async (tx) => {
    const t = await lockVisible(tx, ctx, ref);
    if (t.status !== 'resolved') throw new AppError('invalid_state', t.status === 'archived' ? 'This request is closed. Start a new request.' : 'This request is still open.');
    if (!t.resolved_at || Date.now() - t.resolved_at.getTime() >= SUPPORT_REOPEN_WINDOW_DAYS * 86_400_000) throw new AppError('invalid_state', 'This request was resolved too long ago to reopen. Start a new request.');
    await tx.query(`UPDATE support_tickets SET status='waiting_on_relay', resolution_reason=NULL, resolved_at=NULL, reopen_count=reopen_count+1, updated_at=now() WHERE id=$1`, [t.id]);
    const activityId = await writeActivity(tx, { ticketId: t.id, audience: 'customer', kind: 'status.reopened', actorKind: 'member', actorUserId: ctx.actor.userId });
    await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'support_ticket', aggregateId: t.id, eventType: 'support.ticket_created', payload: { reopened: true, activityId } });
    return t.id;
  });
  return getTicket(ctx, id);
}

const participantSchema = z.object({ user_id: z.string().uuid() }).strict();

/** Add an active member of the same workspace (requester or support.workspace holder, with members.read). */
export async function addParticipant(ctx: Ctx, ref: string, raw: unknown): Promise<CustomerTicketDetail> {
  const { user_id } = participantSchema.parse(raw);
  const id = await withTx(async (tx) => {
    const t = await lockVisible(tx, ctx, ref);
    if (!(t.mine || canSeeWorkspaceTickets(ctx)) || !canAnywhere(ctx, 'members.read')) throw new AppError('forbidden', 'Only the requester or a workspace admin can add people.');
    if (t.status === 'archived') throw new AppError('invalid_state', 'This request is closed.');
    const m = await maybeOne<{ name: string | null; email: string }>(tx,
      `SELECT u.name, u.email::text AS email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.user_id=$2 AND m.status='active' AND m.removed_at IS NULL`,
      [ctx.access.workspaceId, user_id]);
    if (!m) throw new AppError('validation_failed', 'Add someone from this workspace', { user_id: 'Not a member' });
    if (user_id === t.requester_user_id) return t.id;
    await tx.query(`INSERT INTO support_ticket_participants(ticket_id, user_id, added_by) VALUES ($1,$2,$3)
                    ON CONFLICT (ticket_id, user_id) DO UPDATE SET removed_at=NULL, added_by=$3, added_at=now()`, [t.id, user_id, ctx.actor.userId]);
    await writeActivity(tx, { ticketId: t.id, audience: 'customer', kind: 'participant.added', actorKind: 'member', actorUserId: ctx.actor.userId, refId: user_id, detail: { name: m.name || m.email.split('@')[0] } });
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'support.participant_added', resourceType: 'support_ticket', resourceId: t.id, diff: { user_id }, correlationId: ctx.correlationId });
    return t.id;
  });
  return getTicket(ctx, id);
}

export async function removeParticipant(ctx: Ctx, ref: string, userId: string): Promise<CustomerTicketDetail> {
  assertUuid(userId, 'Person');
  const id = await withTx(async (tx) => {
    const t = await lockVisible(tx, ctx, ref);
    if (!(t.mine || canSeeWorkspaceTickets(ctx) || userId === ctx.actor.userId)) throw new AppError('forbidden', 'Only the requester or a workspace admin can remove people.');
    const r = await maybeOne<{ name: string | null; email: string }>(tx,
      `UPDATE support_ticket_participants p SET removed_at=now() FROM users u WHERE p.ticket_id=$1 AND p.user_id=$2 AND p.removed_at IS NULL AND u.id=p.user_id RETURNING u.name, u.email::text AS email`, [t.id, userId]);
    if (!r) return t.id;
    await writeActivity(tx, { ticketId: t.id, audience: 'customer', kind: 'participant.removed', actorKind: 'member', actorUserId: ctx.actor.userId, refId: userId, detail: { name: r.name || r.email.split('@')[0] } });
    return t.id;
  });
  if (userId === ctx.actor.userId) {
    try { return await getTicket(ctx, id); } catch { return { id } as CustomerTicketDetail; }
  }
  return getTicket(ctx, id);
}

/** People the caller may add (active members; needs members.read). */
export async function participantCandidates(ctx: Ctx, db: Queryable = getPool()): Promise<{ items: Array<{ id: string; name: string | null; email: string }> }> {
  if (!canAnywhere(ctx, 'members.read')) return { items: [] };
  const rows = await many<{ id: string; name: string | null; email: string }>(db,
    `SELECT u.id, u.name, u.email::text AS email FROM memberships m JOIN users u ON u.id=m.user_id
      WHERE m.workspace_id=$1 AND m.status='active' AND m.removed_at IS NULL AND u.disabled_at IS NULL AND u.id <> $2 ORDER BY coalesce(u.name, u.email::text) LIMIT 200`,
    [ctx.access.workspaceId, ctx.actor.userId]);
  return { items: rows };
}

/** Content-free change feed for one ticket (customer audience only; staff-only rows never leave the server here). */
export async function customerTicketEvents(ctx: Ctx, ref: string, after: number, db: Queryable = getPool()): Promise<{ items: Array<{ id: number; kind: string; at: string }>; cursor: number }> {
  const t = await loadVisibleTicket(ctx, ref, db);
  const a = Number.isSafeInteger(after) && after > 0 ? after : 0;
  const rows = await many<{ id: string; kind: string; created_at: Date }>(db,
    `SELECT id::text, kind, created_at FROM support_activity WHERE ticket_id=$1 AND audience='customer' AND id > $2 ORDER BY id LIMIT 100`, [t.id, a]);
  return { items: rows.map((r) => ({ id: Number(r.id), kind: r.kind, at: r.created_at.toISOString() })), cursor: rows.length ? Number(rows[rows.length - 1]!.id) : a };
}

/** Customer export: plain-text transcript of the PUBLIC conversation (never internal notes or staff-only history). */
export async function ticketTranscript(ctx: Ctx, ref: string): Promise<{ filename: string; text: string }> {
  const d = await getTicket(ctx, ref, getPool(), { markRead: false });
  const lines = [
    `${d.reference} — ${d.subject}`,
    `Category: ${SUPPORT_CATEGORY_LABEL[d.category]} · Status: ${d.status.replace(/_/g, ' ')} · Opened ${d.created_at}`,
    '',
    ...d.messages.flatMap((m) => [`[${m.created_at}] ${m.author.name}:`, m.body, ...(m.attachments.length ? [`(attachments: ${m.attachments.map((a) => a.filename).join(', ')})`] : []), '']),
  ];
  return { filename: `${d.reference}.txt`, text: lines.join('\n') };
}
