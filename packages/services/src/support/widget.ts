// V5 WID — marketing support widget over the EXISTING V4 support service (brief §9–10). A widget conversation is a
// support ticket with source 'widget'; there is no second ticket system.
//  * Visitors (requester_kind 'visitor'): identity = the widget session's visitor id (widget-session.ts). A visitor sees
//    tickets of their own visitor identity, plus — only after the one-time verification flow — tickets whose contact
//    email equals the session's VERIFIED email. A typed email alone grants nothing; tickets are never merged into a user
//    account or workspace by email.
//  * Signed-in customers (requester_kind 'member'): identity from the app session; the workspace comes from a chooser
//    validated on the server (loadAccess for that user + workspace); every read goes through the V4 visibility rules
//    (access.ts loadVisibleTicket). Creation/replies reuse insertMemberTicket()/replyTicket().
//  * DTOs carry customer-visible data only: support_messages (never support_notes) and customer-audience activity.
//  * Live updates: cursor = customer-audience support_activity id. Deltas return messages whose activity id is after the
//    cursor (writers lock the ticket row first, so ids per ticket become visible in order); clients also dedupe by id.
//  * Abuse controls: shared Postgres rate limits per visitor AND per IP, size caps, honeypot field, signed time trap,
//    staff block. Diagnostics: page path (no query), browser family, time — nothing else.
import { z } from 'zod';
import { AppError, notFound } from '@social-lite/core';
import {
  SUPPORT_ATTACHMENT_MAX_BYTES, SUPPORT_ATTACHMENT_TYPES, SUPPORT_ATTACHMENTS_PER_MESSAGE, SUPPORT_REOPEN_WINDOW_DAYS,
  type BrowserFamily, type SupportAttachmentDto, type SupportTicketCategory, type SupportTicketStatus, type SupportUploadIntent,
} from '@social-lite/core/contracts/v4-support';
import {
  WIDGET_MESSAGE_MAX, WIDGET_TOPICS, type WidgetAvailability, type WidgetConversation, type WidgetConversationSummary, type WidgetMessage,
  type WidgetSessionInfo,
} from '@social-lite/core/contracts/v5-widget';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Actor, Ctx } from '../context.js';
import { beginIdempotent, completeIdempotent, requestHash } from '../idempotency.js';
import { enforceRateLimit } from '../ratelimit.js';
import { writeOutbox } from '../outbox.js';
import { isUuid, loadAccess } from '../tenancy.js';
import { mailer } from '../email.js';
import { marketingConfig } from '../marketing/config.js';
import { platformAudit, type PlatformCtx } from '../admin/platform.js';
import { loadVisibleTicket, requireSupportStaff } from './access.js';
import {
  attachmentsFor, bindAttachments, completeCustomerUpload, completeVisitorUpload, customerUploadIntent, openCustomerAttachment, readReady, visitorUploadIntent,
  type OpenedFile,
} from './attachments.js';
import { CREATE_RATE, insertMemberTicket, listTickets, replyTicket } from './tickets.js';
import { appendSearch, iso, newReference, redactSecrets, safeDiagnostics, staffPublicName, writeActivity } from './shared.js';
import { checkFormToken, createVisitor, createWidgetSession, issueFormToken, type WidgetSession } from './widget-session.js';

// ------------------------------------------------------------------ limits (shared Postgres buckets)
export const WIDGET_RATES = {
  createPerVisitor: { capacity: 5, refillPerSecond: 5 / 3600 },   // 5 new conversations / hour / visitor
  createPerIp: { capacity: 10, refillPerSecond: 10 / 3600 },      // 10 / hour / IP (several people behind one NAT)
  replyPerVisitor: { capacity: 30, refillPerSecond: 30 / 600 },   // 30 / 10 min
  replyPerIp: { capacity: 60, refillPerSecond: 60 / 600 },
  attachPerIp: { capacity: 20, refillPerSecond: 20 / 600 },
  readPerIp: { capacity: 600, refillPerSecond: 600 / 600 },       // polling (5 s per open conversation): ~5 open widgets behind one IP
} as const;

// ------------------------------------------------------------------ caller (built by apps/web/app/api/widget/_lib.ts)
export interface MemberIdentity {
  actor: Actor;
  assurance: { mfaVerified: boolean; authTime: string | null };
  activeWorkspaceId: string | null;
  /** App session CSRF token (returned to the same-origin widget so it can mutate as the member). */
  csrfToken: string;
}

export interface WidgetCaller {
  /** Present only when the widget cookie resolved (and, on mutations, its CSRF token matched). */
  visitor: WidgetSession | null;
  /** Present only when the app session resolved (and, on mutations, its CSRF token matched). */
  member: MemberIdentity | null;
  ip: string;
  browser: BrowserFamily | null;
}

// ------------------------------------------------------------------ availability (Platform → Marketing config, MKT)
/** Reads the staffed-chat flag from the marketing configuration; unset = not staffed ("Send us a message"). */
export async function widgetAvailability(db: Queryable = getPool()): Promise<WidgetAvailability & { enabled: boolean; privacy_url: string | null }> {
  const cfg = await marketingWidgetConfig(db);
  return {
    enabled: cfg.enabled,
    staffed: cfg.staffed,
    title: cfg.staffed ? 'Chat with Relay support' : 'Send us a message',
    email_replies: !!mailer(),
    privacy_url: cfg.privacyUrl,
  };
}

/** MKT's Platform → Marketing configuration. Defaults: widget off, not staffed ("Send us a message"). */
async function marketingWidgetConfig(db: Queryable): Promise<{ enabled: boolean; staffed: boolean; privacyUrl: string | null }> {
  const cfg = await marketingConfig(db);
  return { enabled: cfg.widget_enabled, staffed: cfg.widget_enabled && cfg.widget_staffed, privacyUrl: cfg.privacy_url };
}

// ------------------------------------------------------------------ helpers
const REF_RE = /^RLY-[0-9]{5,10}$/i;
const TOPICS = WIDGET_TOPICS.map((t) => t.value) as [SupportTicketCategory, ...SupportTicketCategory[]];

function subjectFrom(message: string): string {
  const first = message.split('\n').map((l) => l.trim()).find(Boolean) ?? 'Message';
  const s = first.replace(/\s+/g, ' ');
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
}

/** SQL predicate (alias t) for visitor tickets this browser may see: own identity, or a VERIFIED email. */
export function visitorVisibleSql(visitorParam: number, emailParam: number): string {
  return `t.requester_kind = 'visitor' AND (t.visitor_id = $${visitorParam}::uuid OR ($${emailParam}::citext IS NOT NULL AND t.visitor_email = $${emailParam}::citext))`;
}

async function memberWorkspaces(db: Queryable, userId: string): Promise<Array<{ id: string; name: string }>> {
  return many<{ id: string; name: string }>(db,
    `SELECT w.id, w.name FROM memberships m JOIN workspaces w ON w.id=m.workspace_id
      WHERE m.user_id=$1 AND m.status='active' AND m.removed_at IS NULL AND w.state='active' ORDER BY w.name LIMIT 50`, [userId]);
}

/** Server-validated workspace context for a signed-in caller (never trusts the widget's workspace id by itself). */
export async function memberCtx(m: MemberIdentity, workspaceId: string | null | undefined, db: Queryable = getPool()): Promise<Ctx> {
  const ws = workspaceId ?? m.activeWorkspaceId;
  if (!ws || !isUuid(ws)) throw new AppError('validation_failed', 'Choose a workspace', { workspace_id: 'Required' });
  const access = await loadAccess(m.actor.userId, ws, db, { mfaVerified: m.assurance.mfaVerified, authTime: m.assurance.authTime });
  if (!access) throw new AppError('forbidden', 'Choose one of your workspaces', { workspace_id: 'Not a member' });
  return { actor: m.actor, access, correlationId: `widget-${Date.now().toString(36)}` };
}

const isMemberMode = async (c: WidgetCaller, db: Queryable) => !!c.member && (await memberWorkspaces(db, c.member.actor.userId)).length > 0;

// ------------------------------------------------------------------ session info
export async function widgetSessionInfo(c: WidgetCaller, db: Queryable = getPool()): Promise<WidgetSessionInfo & { enabled: boolean }> {
  const avail = await widgetAvailability(db);
  const workspaces = c.member ? await memberWorkspaces(db, c.member.actor.userId) : [];
  const member = c.member && workspaces.length ? c.member : null;
  const conversations: WidgetConversationSummary[] = [];
  let defaultWs: string | null = null;
  if (member) {
    defaultWs = workspaces.some((w) => w.id === member.activeWorkspaceId) ? member.activeWorkspaceId : workspaces[0]!.id;
    const ctx = await memberCtx(member, defaultWs, db);
    const list = await listTickets(ctx, { scope: 'mine', status: 'all', limit: 20 }, db);
    const wsName = workspaces.find((w) => w.id === defaultWs)?.name ?? '';
    for (const t of list.items) {
      conversations.push({ reference: t.reference, subject: t.subject, status: t.status, kind: 'member', workspace: { id: defaultWs!, name: wsName }, updated_at: t.updated_at, unread: t.unread });
    }
  }
  if (c.visitor) conversations.push(...await visitorConversations(db, c.visitor));
  conversations.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return {
    enabled: avail.enabled,
    mode: member ? 'member' : 'visitor',
    availability: { staffed: avail.staffed, title: avail.title, email_replies: avail.email_replies },
    csrf: { member: member?.csrfToken ?? null, visitor: c.visitor?.csrfToken ?? null },
    form_token: issueFormToken(),
    visitor: c.visitor ? { name: c.visitor.visitor.name, email: c.visitor.visitor.email, verified_email: c.visitor.verifiedEmail, expires_at: c.visitor.expiresAt.toISOString() } : null,
    member: member ? { name: member.actor.name ?? member.actor.email.split('@')[0]!, email: member.actor.email, workspaces, default_workspace_id: defaultWs } : null,
    conversations,
    limits: { message_max: member ? 10000 : WIDGET_MESSAGE_MAX, attachments_per_message: SUPPORT_ATTACHMENTS_PER_MESSAGE, attachment_max_bytes: SUPPORT_ATTACHMENT_MAX_BYTES,
      attachment_types: SUPPORT_ATTACHMENT_TYPES },
    privacy_url: avail.privacy_url,
  };
}

export async function visitorConversations(db: Queryable, s: WidgetSession): Promise<WidgetConversationSummary[]> {
  const rows = await many<{ reference: string; subject: string; status: SupportTicketStatus; updated_at: Date; last_staff_reply_at: Date | null; last_read_at: Date | null }>(db,
    `SELECT t.reference, t.subject, t.status, t.updated_at, t.last_staff_reply_at, r.last_read_at
       FROM support_tickets t LEFT JOIN widget_ticket_reads r ON r.ticket_id=t.id AND r.visitor_id=$1
      WHERE ${visitorVisibleSql(1, 2)} ORDER BY t.updated_at DESC, t.id DESC LIMIT 20`, [s.visitorId, s.verifiedEmail]);
  return rows.map((r) => ({ reference: r.reference, subject: r.subject, status: r.status, kind: 'visitor' as const, workspace: null, updated_at: r.updated_at.toISOString(),
    unread: !!r.last_staff_reply_at && (!r.last_read_at || r.last_staff_reply_at > r.last_read_at) }));
}

// ------------------------------------------------------------------ create
const diagSchema = z.object({ route: z.string().max(2000).nullish() }).strip();
const attachIds = z.array(z.string()).max(SUPPORT_ATTACHMENTS_PER_MESSAGE).default([]);

const visitorCreateSchema = z.object({
  client_id: z.string().uuid('Reload and try again'),
  name: z.string().trim().min(1, 'Add your name').max(120),
  email: z.email({ message: 'Enter an email address we can reply to' }).max(254),
  message: z.string().trim().min(1, 'Write a message').max(WIDGET_MESSAGE_MAX, `Keep it under ${WIDGET_MESSAGE_MAX} characters`),
  topic: z.enum(TOPICS).optional(),
  attachment_ids: attachIds,
  form_token: z.string().max(120),
  /** Honeypot: hidden from people; must stay empty. */
  website: z.string().max(500).optional(),
  diagnostics: diagSchema.nullish(),
}).strict();

const memberCreateSchema = z.object({
  client_id: z.string().uuid('Reload and try again'),
  workspace_id: z.string().uuid('Choose a workspace').optional(),
  message: z.string().trim().min(1, 'Write a message').max(10000),
  topic: z.enum(TOPICS).optional(),
  attachment_ids: attachIds,
  form_token: z.string().max(120).optional(),
  website: z.string().max(500).optional(),
  diagnostics: diagSchema.nullish(),
}).strict();

export interface CreateResult { conversation: WidgetConversation; newSession: { token: string; session: WidgetSession } | null }

/** Start a conversation: as the signed-in member (trusted context) or as a visitor (new or existing visitor session). */
export async function createConversation(c: WidgetCaller, raw: unknown, db: Queryable = getPool()): Promise<CreateResult> {
  if (!(await widgetAvailability(db)).enabled) throw new AppError('invalid_state', 'Messaging is turned off right now. Email us instead.');
  if (await isMemberMode(c, db)) return { conversation: await createMemberConversation(c, raw, db), newSession: null };
  return createVisitorConversation(c, raw, db);
}

async function createMemberConversation(c: WidgetCaller, raw: unknown, db: Queryable): Promise<WidgetConversation> {
  const input = memberCreateSchema.parse(raw);
  if (input.website) throw new AppError('validation_failed', 'Couldn’t send your message. Reload the page and try again.');
  const m = c.member!;
  const ctx = await memberCtx(m, input.workspace_id, db);
  await enforceRateLimit('supportCreate', ctx.actor.userId, CREATE_RATE); // same bucket as Help → Contact support
  const diagnostics = safeDiagnostics({ route: input.diagnostics?.route ?? null, browser_family: c.browser, occurred_at: new Date().toISOString() });
  const body = { workspace: ctx.access.workspaceId, message: input.message, topic: input.topic ?? null, attachment_ids: input.attachment_ids };
  const res = await withTx(async (tx) => {
    const prior = await beginIdempotent(tx, { workspaceId: ctx.access.workspaceId, userId: ctx.actor.userId, action: 'support.widget_create', key: input.client_id, body });
    if (prior) return prior.body as { id: string };
    const r = await insertMemberTicket(tx, ctx, { category: input.topic ?? 'general', subject: subjectFrom(redactSecrets(input.message).text), message: input.message,
      attachmentIds: input.attachment_ids, diagnostics, source: 'widget' });
    await completeIdempotent(tx, { workspaceId: ctx.access.workspaceId, action: 'support.widget_create', key: input.client_id, status: 201, body: { id: r.id, reference: r.reference } });
    return { id: r.id };
  });
  return memberView(ctx, res.id, 0, db);
}

async function createVisitorConversation(c: WidgetCaller, raw: unknown, db: Queryable): Promise<CreateResult> {
  const input = visitorCreateSchema.parse(raw);
  if (input.website) throw new AppError('validation_failed', 'Couldn’t send your message. Reload the page and try again.');
  checkFormToken(input.form_token);
  if (c.visitor?.visitor.blocked) throw new AppError('forbidden', 'Messages from this browser can’t be sent. Email us instead.');
  const hash = requestHash({ name: input.name, email: input.email.toLowerCase(), message: input.message, topic: input.topic ?? null, attachment_ids: input.attachment_ids });
  // Deduplicated submission: the same client id returns the original conversation (also after a lost response).
  const prior = await maybeOne<{ visitor_id: string; ticket_id: string; request_hash: string }>(db, `SELECT visitor_id, ticket_id, request_hash FROM widget_submissions WHERE client_id=$1`, [input.client_id]);
  if (prior) return replayCreate(c, prior, hash, db);
  await enforceRateLimit('widgetCreateIp', c.ip, WIDGET_RATES.createPerIp);
  if (c.visitor) await enforceRateLimit('widgetCreateVisitor', c.visitor.visitorId, WIDGET_RATES.createPerVisitor);
  const diagnostics = safeDiagnostics({ route: input.diagnostics?.route ?? null, browser_family: c.browser, occurred_at: new Date().toISOString() });
  const out = await withTx(async (tx) => {
    let visitorId = c.visitor?.visitorId ?? null;
    let newSession: CreateResult['newSession'] = null;
    if (visitorId) {
      await tx.query(`UPDATE widget_visitors SET name=$2, contact_email=$3, last_seen_at=now() WHERE id=$1`, [visitorId, input.name, input.email]);
    } else {
      visitorId = await createVisitor(tx, { name: input.name, email: input.email });
      newSession = await createWidgetSession(tx, visitorId);
    }
    const reference = await newReference(tx);
    const subject = subjectFrom(redactSecrets(input.message).text);
    const msg = redactSecrets(input.message);
    const t = await one<{ id: string }>(tx,
      `INSERT INTO support_tickets(reference, requester_kind, visitor_id, visitor_name, visitor_email, source, category, restricted, subject, diagnostics, last_customer_at, search_doc)
       VALUES ($1,'visitor',$2,$3,$4,'widget',$5,false,$6,$7, now(), to_tsvector('simple', $1 || ' ' || $6)) RETURNING id`,
      [reference, visitorId, input.name, input.email, input.topic ?? 'general', subject, JSON.stringify(diagnostics)]);
    const m = await one<{ id: string }>(tx,
      `INSERT INTO support_messages(ticket_id, author_kind, author_user_id, body, redactions) VALUES ($1,'visitor',NULL,$2,$3) RETURNING id`, [t.id, msg.text, msg.count]);
    await bindAttachments(tx, { ids: input.attachment_ids, owner: { kind: 'visitor', visitorId }, ticketId: t.id, messageId: m.id });
    const ins = await tx.query(`INSERT INTO widget_submissions(client_id, visitor_id, ticket_id, message_id, request_hash) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (client_id) DO NOTHING`,
      [input.client_id, visitorId, t.id, m.id, hash]);
    // A concurrent duplicate with the same client id loses on the primary key and rolls back entirely.
    if (!ins.rowCount) throw new AppError('conflict', 'This message is already being sent.');
    await appendSearch(tx, t.id, `${input.name} ${input.email} ${msg.text}`);
    await writeActivity(tx, { ticketId: t.id, audience: 'customer', kind: 'ticket.created', actorKind: 'visitor', detail: { source: 'widget' } });
    await writeActivity(tx, { ticketId: t.id, audience: 'customer', kind: 'message.created', actorKind: 'visitor', refId: m.id });
    await tx.query(`INSERT INTO widget_ticket_reads(ticket_id, visitor_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [t.id, visitorId]);
    await writeOutbox(tx, { workspaceId: null, aggregateType: 'support_ticket', aggregateId: t.id, eventType: 'support.ticket_created', payload: { source: 'widget' } });
    return { ticketId: t.id, visitorId, newSession };
  });
  const session = out.newSession?.session ?? c.visitor!;
  return { conversation: await visitorView(db, session, out.ticketId, 0), newSession: out.newSession };
}

async function replayCreate(c: WidgetCaller, prior: { visitor_id: string; ticket_id: string; request_hash: string }, hash: string, db: Queryable): Promise<CreateResult> {
  if (prior.request_hash !== hash) throw new AppError('idempotency_conflict', 'This message was already sent with different content.');
  if (c.visitor && c.visitor.visitorId !== prior.visitor_id) throw new AppError('idempotency_conflict', 'This message was already sent from another chat.');
  if (c.visitor) return { conversation: await visitorView(db, c.visitor, prior.ticket_id, 0), newSession: null };
  // The response (and its cookie) was lost: the client id is a 122-bit secret only that browser generated, and the body
  // matches, so the same browser gets a fresh session for the identity it created.
  const newSession = await createWidgetSession(db, prior.visitor_id);
  return { conversation: await visitorView(db, newSession.session, prior.ticket_id, 0), newSession };
}

// ------------------------------------------------------------------ read (with missed-message recovery)
interface TicketHead { id: string; reference: string; subject: string; status: SupportTicketStatus; workspace_id: string | null; workspace_name: string | null; requester_kind: 'member' | 'visitor';
  resolved_at: Date | null; visitor_id: string | null }

async function head(db: Queryable, ref: string): Promise<TicketHead | null> {
  if (!REF_RE.test(ref)) return null;
  return maybeOne<TicketHead>(db,
    `SELECT t.id, t.reference, t.subject, t.status, t.workspace_id, w.name AS workspace_name, t.requester_kind, t.resolved_at, t.visitor_id
       FROM support_tickets t LEFT JOIN workspaces w ON w.id=t.workspace_id WHERE upper(t.reference)=upper($1)`, [ref]);
}

/** Load a ticket the caller may see, deciding visitor vs member access on the server. 404 otherwise (no existence leak). */
async function resolveAccess(c: WidgetCaller, ref: string, db: Queryable): Promise<{ kind: 'visitor'; t: TicketHead; s: WidgetSession } | { kind: 'member'; t: TicketHead; ctx: Ctx }> {
  const t = await head(db, ref);
  if (t?.requester_kind === 'visitor' && c.visitor) {
    const ok = await maybeOne(db, `SELECT 1 FROM support_tickets t WHERE t.id=$3 AND ${visitorVisibleSql(1, 2)}`, [c.visitor.visitorId, c.visitor.verifiedEmail, t.id]);
    if (ok) return { kind: 'visitor', t, s: c.visitor };
  }
  if (t?.requester_kind === 'member' && t.workspace_id && c.member) {
    const access = await loadAccess(c.member.actor.userId, t.workspace_id, db, { mfaVerified: c.member.assurance.mfaVerified, authTime: c.member.assurance.authTime });
    if (access) {
      const ctx: Ctx = { actor: c.member.actor, access, correlationId: 'widget' };
      await loadVisibleTicket(ctx, t.id, db); // V4 visibility rules; throws not_found
      return { kind: 'member', t, ctx };
    }
  }
  throw notFound('Conversation');
}

export async function getConversation(c: WidgetCaller, ref: string, after: number, db: Queryable = getPool()): Promise<WidgetConversation> {
  await enforceRateLimit('widgetReadIp', c.ip, WIDGET_RATES.readPerIp);
  const a = await resolveAccess(c, ref, db);
  return a.kind === 'visitor' ? visitorView(db, a.s, a.t.id, after) : memberView(a.ctx, a.t.id, after, db);
}

interface MsgRow { id: string; author_kind: 'member' | 'visitor' | 'staff'; author_user_id: string | null; author_name: string | null; author_email: string | null; body: string; created_at: Date }

/** Customer-visible messages (support_messages only — internal notes live in support_notes and are never read here). */
async function messagesSince(db: Queryable, ticketId: string, after: number): Promise<MsgRow[]> {
  if (after <= 0) {
    return many<MsgRow>(db, `SELECT m.id, m.author_kind, m.author_user_id, u.name AS author_name, u.email::text AS author_email, m.body, m.created_at
      FROM support_messages m LEFT JOIN users u ON u.id=m.author_user_id WHERE m.ticket_id=$1 ORDER BY m.created_at, m.id`, [ticketId]);
  }
  // Every writer of a message locks the ticket row (FOR UPDATE) before appending its activity row, so per-ticket activity
  // ids become visible in commit order and "id > cursor" never skips a message that committed late.
  return many<MsgRow>(db,
    `SELECT m.id, m.author_kind, m.author_user_id, u.name AS author_name, u.email::text AS author_email, m.body, m.created_at
       FROM support_activity a JOIN support_messages m ON m.id=a.ref_id AND m.ticket_id=a.ticket_id LEFT JOIN users u ON u.id=m.author_user_id
      WHERE a.ticket_id=$1 AND a.audience='customer' AND a.kind='message.created' AND a.id > $2
      ORDER BY a.id LIMIT 200`, [ticketId, after]);
}

async function cursorOf(db: Queryable, ticketId: string): Promise<number> {
  const r = await one<{ id: string | null }>(db, `SELECT max(id)::text AS id FROM support_activity WHERE ticket_id=$1 AND audience='customer'`, [ticketId]);
  return Number(r.id ?? 0);
}

async function toMessages(db: Queryable, rows: MsgRow[], mine: (m: MsgRow) => boolean, visitorName: string | null): Promise<WidgetMessage[]> {
  const files = await attachmentsFor(db, 'message_id', rows.map((m) => m.id), '/api/widget/attachments');
  return rows.map((m) => ({
    id: m.id,
    author: {
      kind: m.author_kind, mine: mine(m),
      name: m.author_kind === 'staff' ? staffPublicName(m.author_name) : m.author_kind === 'visitor' ? (visitorName || 'You') : (m.author_name || m.author_email?.split('@')[0] || 'Customer'),
    },
    body: m.body, created_at: m.created_at.toISOString(), attachments: files.get(m.id) ?? [],
  }));
}

function replyState(status: SupportTicketStatus, resolvedAt: Date | null, blocked: boolean): { can_reply: boolean; notice: string | null } {
  if (blocked) return { can_reply: false, notice: 'Messages from this browser can’t be sent. Email us instead.' };
  if (status === 'archived') return { can_reply: false, notice: 'This conversation is closed. Start a new one.' };
  if (status === 'resolved' && (!resolvedAt || Date.now() - resolvedAt.getTime() >= SUPPORT_REOPEN_WINDOW_DAYS * 86_400_000)) {
    return { can_reply: false, notice: 'This conversation was resolved a while ago. Start a new one.' };
  }
  return { can_reply: true, notice: status === 'resolved' ? 'Resolved. Reply to reopen it.' : null };
}

async function visitorView(db: Queryable, s: WidgetSession, ticketId: string, after: number): Promise<WidgetConversation> {
  const t = await one<TicketHead & { visitor_name: string | null }>(db,
    `SELECT t.id, t.reference, t.subject, t.status, NULL::uuid AS workspace_id, NULL::text AS workspace_name, t.requester_kind, t.resolved_at, t.visitor_id, t.visitor_name
       FROM support_tickets t WHERE t.id=$1`, [ticketId]);
  const rows = await messagesSince(db, ticketId, after);
  const messages = await toMessages(db, rows, (m) => m.author_kind === 'visitor', t.visitor_name);
  const cursor = await cursorOf(db, ticketId);
  if (after <= 0 || rows.some((r) => r.author_kind === 'staff')) {
    await db.query(`INSERT INTO widget_ticket_reads(ticket_id, visitor_id, last_read_at) VALUES ($1,$2,now()) ON CONFLICT (ticket_id, visitor_id) DO UPDATE SET last_read_at=now()`, [ticketId, s.visitorId]);
  }
  return { reference: t.reference, subject: t.subject, status: t.status, kind: 'visitor', workspace: null, messages, cursor, delta: after > 0,
    ...replyState(t.status, t.resolved_at, s.visitor.blocked) };
}

async function memberView(ctx: Ctx, ticketId: string, after: number, db: Queryable): Promise<WidgetConversation> {
  const v = await loadVisibleTicket(ctx, ticketId, db);
  const t = await one<{ workspace_name: string }>(db, `SELECT name AS workspace_name FROM workspaces WHERE id=$1`, [v.workspace_id]);
  const rows = await messagesSince(db, ticketId, after);
  const messages = await toMessages(db, rows, (m) => m.author_user_id === ctx.actor.userId, null);
  const cursor = await cursorOf(db, ticketId);
  if (after <= 0 || rows.some((r) => r.author_kind === 'staff')) {
    await db.query(`INSERT INTO support_ticket_reads(ticket_id, user_id, last_read_at) VALUES ($1,$2,now()) ON CONFLICT (ticket_id, user_id) DO UPDATE SET last_read_at=now()`, [ticketId, ctx.actor.userId]);
  }
  return { reference: v.reference, subject: v.subject, status: v.status as SupportTicketStatus, kind: 'member', workspace: { id: v.workspace_id, name: t.workspace_name },
    messages, cursor, delta: after > 0, ...replyState(v.status as SupportTicketStatus, v.resolved_at, false) };
}

// ------------------------------------------------------------------ reply
const replySchema = z.object({
  client_id: z.string().uuid('Reload and try again'),
  body: z.string().trim().min(1, 'Write a message').max(10000),
  attachment_ids: attachIds,
  /** Return only what is new after this cursor (the client's last known cursor). */
  after: z.number().int().min(0).optional(),
}).strict();

export async function sendMessage(c: WidgetCaller, ref: string, raw: unknown, db: Queryable = getPool()): Promise<WidgetConversation> {
  const input = replySchema.parse(raw);
  const a = await resolveAccess(c, ref, db);
  if (a.kind === 'member') {
    await replyTicket(a.ctx, a.t.id, { body: input.body, attachment_ids: input.attachment_ids }, input.client_id);
    return memberView(a.ctx, a.t.id, input.after ?? 0, db);
  }
  const s = a.s;
  if (s.visitor.blocked) throw new AppError('forbidden', 'Messages from this browser can’t be sent. Email us instead.');
  if (input.body.length > WIDGET_MESSAGE_MAX) throw new AppError('validation_failed', `Keep it under ${WIDGET_MESSAGE_MAX} characters`, { body: 'Too long' });
  const hash = requestHash({ ticket: a.t.id, body: input.body, attachment_ids: input.attachment_ids });
  const prior = await maybeOne<{ visitor_id: string; request_hash: string }>(db, `SELECT visitor_id, request_hash FROM widget_submissions WHERE client_id=$1`, [input.client_id]);
  if (prior) {
    if (prior.visitor_id !== s.visitorId || prior.request_hash !== hash) throw new AppError('idempotency_conflict', 'This message was already sent with different content.');
    return visitorView(db, s, a.t.id, input.after ?? 0);
  }
  await enforceRateLimit('widgetReplyVisitor', s.visitorId, WIDGET_RATES.replyPerVisitor);
  await enforceRateLimit('widgetReplyIp', c.ip, WIDGET_RATES.replyPerIp);
  await withTx(async (tx) => {
    const t = await one<{ id: string; status: SupportTicketStatus; resolved_at: Date | null }>(tx, `SELECT id, status, resolved_at FROM support_tickets WHERE id=$1 FOR UPDATE`, [a.t.id]);
    const st = replyState(t.status, t.resolved_at, false);
    if (!st.can_reply) throw new AppError('invalid_state', st.notice ?? 'This conversation is closed.');
    const reopen = t.status === 'resolved';
    const body = redactSecrets(input.body);
    const m = await one<{ id: string }>(tx, `INSERT INTO support_messages(ticket_id, author_kind, author_user_id, body, redactions) VALUES ($1,'visitor',NULL,$2,$3) RETURNING id`,
      [t.id, body.text, body.count]);
    const ins = await tx.query(`INSERT INTO widget_submissions(client_id, visitor_id, ticket_id, message_id, request_hash) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (client_id) DO NOTHING`,
      [input.client_id, s.visitorId, t.id, m.id, hash]);
    if (!ins.rowCount) throw new AppError('conflict', 'This message is already being sent.');
    await bindAttachments(tx, { ids: input.attachment_ids, owner: { kind: 'visitor', visitorId: s.visitorId }, ticketId: t.id, messageId: m.id });
    await tx.query(
      `UPDATE support_tickets SET status = CASE WHEN status='new' THEN 'new' ELSE 'waiting_on_relay' END, last_customer_at=now(), updated_at=now(),
              resolution_reason = CASE WHEN status='resolved' THEN NULL ELSE resolution_reason END, resolved_at = CASE WHEN status='resolved' THEN NULL ELSE resolved_at END,
              reopen_count = reopen_count + CASE WHEN status='resolved' THEN 1 ELSE 0 END
        WHERE id=$1`, [t.id]);
    await appendSearch(tx, t.id, body.text);
    if (reopen) await writeActivity(tx, { ticketId: t.id, audience: 'customer', kind: 'status.reopened', actorKind: 'visitor' });
    await writeActivity(tx, { ticketId: t.id, audience: 'customer', kind: 'message.created', actorKind: 'visitor', refId: m.id });
    await writeOutbox(tx, { workspaceId: null, aggregateType: 'support_ticket', aggregateId: t.id, eventType: 'support.message_created', payload: { messageId: m.id } });
  });
  return visitorView(db, s, a.t.id, input.after ?? 0);
}

// ------------------------------------------------------------------ attachments (same quarantine pipeline as V4)
const intentExtra = z.object({ workspace_id: z.string().uuid().optional(), reference: z.string().max(20).optional() }).passthrough();

export async function widgetUploadIntent(c: WidgetCaller, raw: unknown, db: Queryable = getPool()): Promise<SupportUploadIntent> {
  const extra = intentExtra.parse(raw ?? {});
  const { workspace_id, reference, ...rest } = extra;
  await enforceRateLimit('widgetAttachIp', c.ip, WIDGET_RATES.attachPerIp);
  if (await isMemberMode(c, db) && !(reference && (await head(db, reference))?.requester_kind === 'visitor')) {
    let ws = workspace_id ?? null;
    if (reference) { const a = await resolveAccess(c, reference, db); if (a.kind === 'member') ws = a.t.workspace_id; }
    const ctx = await memberCtx(c.member!, ws, db);
    return rewriteUrl(await customerUploadIntent(ctx, rest));
  }
  if (!c.visitor) throw new AppError('invalid_state', 'Send your first message, then add files to the conversation.');
  if (c.visitor.visitor.blocked) throw new AppError('forbidden', 'Messages from this browser can’t be sent.');
  return visitorUploadIntent(c.visitor.visitorId, rest);
}

export async function widgetCompleteUpload(c: WidgetCaller, id: string, db: Queryable = getPool()): Promise<SupportAttachmentDto> {
  if (!isUuid(id)) throw notFound('Attachment');
  const row = await maybeOne<{ owner_kind: string; owner_user_id: string | null; workspace_id: string | null; visitor_id: string | null }>(db,
    `SELECT owner_kind, owner_user_id, workspace_id, visitor_id FROM support_attachments WHERE id=$1`, [id]);
  if (row?.owner_kind === 'visitor' && c.visitor && row.visitor_id === c.visitor.visitorId) return completeVisitorUpload(c.visitor.visitorId, id);
  if (row?.owner_kind === 'member' && c.member && row.owner_user_id === c.member.actor.userId && row.workspace_id) {
    const ctx = await memberCtx(c.member, row.workspace_id, db);
    return rewriteDto(await completeCustomerUpload(ctx, id));
  }
  throw notFound('Attachment');
}

/** Authorized download (re-checked per request). Files on internal notes are never served here. */
export async function openWidgetAttachment(c: WidgetCaller, id: string, db: Queryable = getPool()): Promise<OpenedFile> {
  if (!isUuid(id)) throw notFound('Attachment');
  const a = await maybeOne<{ ticket_id: string | null; message_id: string | null; note_id: string | null; owner_kind: string; owner_user_id: string | null; workspace_id: string | null;
    visitor_id: string | null; storage_key: string; mime: string | null; filename: string; state: string; reference: string | null; requester_kind: string | null }>(db,
    `SELECT a.ticket_id, a.message_id, a.note_id, a.owner_kind, a.owner_user_id, a.workspace_id, a.visitor_id, a.storage_key, a.mime, a.filename, a.state, t.reference, t.requester_kind
       FROM support_attachments a LEFT JOIN support_tickets t ON t.id=a.ticket_id WHERE a.id=$1`, [id]);
  if (!a || a.state !== 'ready' || a.note_id) throw notFound('Attachment');
  if (!a.ticket_id) {
    if (a.owner_kind === 'visitor' && c.visitor && a.visitor_id === c.visitor.visitorId) return readReady(a);
    if (a.owner_kind === 'member' && c.member && a.owner_user_id === c.member.actor.userId && a.workspace_id) return openCustomerAttachment(await memberCtx(c.member, a.workspace_id, db), id, db);
    throw notFound('Attachment');
  }
  if (!a.message_id || !a.reference) throw notFound('Attachment');
  const acc = await resolveAccess(c, a.reference, db);
  if (acc.kind === 'member') return openCustomerAttachment(acc.ctx, id, db);
  return readReady(a);
}

const rewriteDto = (d: SupportAttachmentDto): SupportAttachmentDto => ({ ...d, url: d.url ? `/api/widget/attachments/${d.id}` : null });
const rewriteUrl = (i: SupportUploadIntent): SupportUploadIntent => ({ ...i, attachment: rewriteDto(i.attachment) });

// ------------------------------------------------------------------ staff side (Platform → Support)
export interface VisitorStaffInfo { email_verified: boolean; blocked: boolean; sessions: number; last_seen_at: string | null; other_conversations: number }

/** Visitor metadata for the staff ticket view (no IPs, no user agents beyond the diagnostics family). */
export async function visitorStaffInfo(db: Queryable, ticketId: string): Promise<VisitorStaffInfo | null> {
  const r = await maybeOne<{ email_verified_at: Date | null; blocked_at: Date | null; last_seen_at: Date | null; sessions: number; others: number }>(db,
    `SELECT v.email_verified_at, v.blocked_at, v.last_seen_at,
            (SELECT count(*)::int FROM widget_sessions s WHERE s.visitor_id=v.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS sessions,
            (SELECT count(*)::int FROM support_tickets o WHERE o.visitor_id=v.id AND o.id <> t.id) AS others
       FROM support_tickets t JOIN widget_visitors v ON v.id=t.visitor_id WHERE t.id=$1 AND t.requester_kind='visitor'`, [ticketId]);
  if (!r) return null;
  return { email_verified: !!r.email_verified_at, blocked: !!r.blocked_at, sessions: r.sessions, last_seen_at: iso(r.last_seen_at), other_conversations: r.others };
}

const blockSchema = z.object({ blocked: z.boolean() }).strict();

/** Staff abuse control: block / unblock the visitor identity behind a widget ticket (audited; ends its sessions on block). */
export async function setVisitorBlocked(p: PlatformCtx, ref: string, raw: unknown, db: Queryable = getPool()): Promise<VisitorStaffInfo> {
  requireSupportStaff(p);
  const { blocked } = blockSchema.parse(raw);
  const t = await head(db, ref);
  if (!t || t.requester_kind !== 'visitor' || !t.visitor_id) throw notFound('Ticket');
  await withTx(async (tx) => {
    await tx.query(`UPDATE widget_visitors SET blocked_at=${blocked ? 'coalesce(blocked_at, now())' : 'NULL'}, blocked_by=$2 WHERE id=$1`, [t.visitor_id, p.actor.userId]);
    if (blocked) await tx.query(`UPDATE widget_sessions SET revoked_at=now(), revoked_reason='blocked' WHERE visitor_id=$1 AND revoked_at IS NULL`, [t.visitor_id]);
    await writeActivity(tx, { ticketId: t.id, audience: 'staff', kind: blocked ? 'visitor.blocked' : 'visitor.unblocked', actorKind: 'staff', actorUserId: p.actor.userId });
    await platformAudit(tx, p, { action: blocked ? 'support.visitor_blocked' : 'support.visitor_unblocked', targetType: 'support_ticket', targetId: t.id, workspaceId: null, diff: { blocked } });
  });
  return (await visitorStaffInfo(db, t.id))!;
}
