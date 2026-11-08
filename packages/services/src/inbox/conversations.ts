// Conversations: queues, filters, detail timeline, status/priority/labels/snooze, assignment, drafts, presence, notes.
// Reads come from stored, indexed rows only (no provider calls in page requests). Notes are separate from replies.
import { AppError, notFound } from '@social-lite/core';
import {
  INBOX_QUEUES, REPLY_MODES, type ConversationDetail, type ConversationListItem, type InboxListQuery, type InboxQueue, type NoteDto, type PersonRef,
  type ReplyAttemptDto, type TimelineEntry,
} from '@social-lite/core/contracts/v35-inbox';
import { getInboxAdapter } from '@social-lite/providers';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { writeOutbox } from '../outbox.js';
import { loadUserAuthz } from '../authz.js';
import { deliverNotification } from '../collab/notifications.js';
import { staffAllowed } from '../collab/access.js';
import { authorizeCtx, brandAllowed, requireAction } from '../tenancy.js';
import { getSetting } from '../settings.js';
import { iso, inboxEvent, loadChannelRow, loadConversation, people, type ConversationRow } from './shared.js';

type ListRow = ConversationRow & { ch_kind: ConversationListItem['channel']['kind']; ch_name: string; ch_sim: boolean; c_name: string | null; c_handle: string | null; case_number: string | null; case_state: string | null };

async function inboxBrandIds(ctx: Ctx, db: Queryable = getPool()): Promise<string[]> {
  const rows = await many<{ id: string }>(db, `SELECT id FROM brands WHERE workspace_id=$1`, [ctx.access.workspaceId]);
  return rows.map((r) => r.id).filter((b) => brandAllowed(ctx, b) && authorizeCtx(ctx, 'inbox.read', { brandId: b }).allowed);
}

function encodeCursor(r: { last_message_at: Date; id: string }): string {
  return Buffer.from(`${r.last_message_at.toISOString()}|${r.id}`).toString('base64url');
}
function decodeCursor(c: string | null | undefined): { at: Date; id: string } | null {
  if (!c) return null;
  const [a, id] = Buffer.from(c, 'base64url').toString('utf8').split('|');
  if (!a || !id || !/^[0-9a-f-]{36}$/.test(id) || Number.isNaN(Date.parse(a))) throw new AppError('validation_failed', 'Invalid cursor');
  return { at: new Date(a), id };
}

function queueSql(q: InboxQueue, me: string, p: unknown[]): string {
  switch (q) {
    case 'unassigned': return `c.status = 'open' AND c.assignee_id IS NULL`;
    case 'mine': p.push(me); return `c.assignee_id = $${p.length} AND c.status IN ('open','waiting')`;
    case 'team': p.push(me); return `c.team_id IN (SELECT team_id FROM team_memberships WHERE user_id = $${p.length}) AND c.status IN ('open','waiting')`;
    case 'waiting': return `c.status = 'waiting'`;
    case 'snoozed': return `c.status = 'snoozed'`;
    case 'resolved': return `c.status = 'resolved'`;
    case 'spam': return `c.status = 'spam'`;
    default: return `c.status <> 'spam'`;
  }
}

const LIST_SELECT = `SELECT c.*, ch.kind AS ch_kind, ch.display_name AS ch_name, ch.is_simulated AS ch_sim, ct.display_name AS c_name, ct.handle AS c_handle,
                            cs.number AS case_number, cs.state AS case_state
                       FROM inbox_conversations c JOIN inbox_channels ch ON ch.id=c.channel_id LEFT JOIN inbox_contacts ct ON ct.id=c.contact_id
                       LEFT JOIN care_cases cs ON cs.id=c.case_id`;

async function toListItems(db: Queryable, rows: ListRow[]): Promise<ConversationListItem[]> {
  const ppl = await people(db, rows.map((r) => r.assignee_id));
  return rows.map((r) => ({
    id: r.id, brand_id: r.brand_id, channel: { id: r.channel_id, kind: r.ch_kind, display_name: r.ch_name, is_simulated: r.ch_sim }, kind: r.kind, visibility: r.visibility,
    contact: { id: r.contact_id, name: r.c_name, handle: r.c_handle }, preview: r.preview, status: r.status, priority: r.priority, labels: r.labels, language: r.language,
    assignee: r.assignee_id ? ppl.get(r.assignee_id) ?? null : null, team_id: r.team_id, unanswered_since: iso(r.unanswered_since), last_message_at: r.last_message_at.toISOString(),
    snoozed_until: iso(r.snoozed_until), case: r.case_id && r.case_number ? { id: r.case_id, number: Number(r.case_number), state: r.case_state as 'open' } : null, version: r.version,
  }));
}

export async function listConversations(ctx: Ctx, q: InboxListQuery = {}): Promise<{ items: ConversationListItem[]; next_cursor: string | null }> {
  requireAction(ctx, 'inbox.read');
  const db = getPool();
  const brands = await inboxBrandIds(ctx, db);
  if (!brands.length) return { items: [], next_cursor: null };
  const queue = (INBOX_QUEUES as readonly string[]).includes(q.queue ?? '') ? q.queue! : 'all';
  const limit = Math.min(Math.max(Number(q.limit) || 30, 1), 100);
  const p: unknown[] = [ctx.access.workspaceId, brands];
  const where = [`c.workspace_id = $1`, `c.brand_id = ANY($2::uuid[])`, queueSql(queue, ctx.actor.userId, p)];
  const add = (sql: string, v: unknown) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)); };
  if (q.brand_id) add('c.brand_id = ?', q.brand_id);
  if (q.channel_id) add('c.channel_id = ?', q.channel_id);
  if (q.kind) add('c.kind = ?', q.kind);
  if (q.assignee_id) add('c.assignee_id = ?', q.assignee_id);
  if (q.priority) add('c.priority = ?', q.priority);
  if (q.language) add('c.language = ?', q.language);
  if (q.label) add('? = ANY(c.labels)', q.label);
  if (q.q && q.q.trim()) {
    const term = `%${q.q.trim().slice(0, 80).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    add(`(c.preview ILIKE ? OR ct.display_name ILIKE $${p.length + 1} OR c.subject ILIKE $${p.length + 1})`, term);
  }
  const cur = decodeCursor(q.cursor);
  if (cur) { p.push(cur.at, cur.id); where.push(`(c.last_message_at, c.id) < ($${p.length - 1}, $${p.length})`); }
  p.push(limit + 1);
  const rows = await many<ListRow>(db, `${LIST_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.last_message_at DESC, c.id DESC LIMIT $${p.length}`, p);
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  return { items: await toListItems(db, page), next_cursor: more ? encodeCursor(page[page.length - 1]!) : null };
}

export async function inboxCounts(ctx: Ctx): Promise<Record<InboxQueue, number>> {
  requireAction(ctx, 'inbox.read');
  const brands = await inboxBrandIds(ctx);
  const r = await one<Record<InboxQueue, number>>(getPool(),
    `SELECT count(*) FILTER (WHERE status='open' AND assignee_id IS NULL)::int unassigned,
            count(*) FILTER (WHERE assignee_id=$3 AND status IN ('open','waiting'))::int mine,
            count(*) FILTER (WHERE team_id IN (SELECT team_id FROM team_memberships WHERE user_id=$3) AND status IN ('open','waiting'))::int team,
            count(*) FILTER (WHERE status='waiting')::int waiting, count(*) FILTER (WHERE status='snoozed')::int snoozed,
            count(*) FILTER (WHERE status='resolved')::int resolved, count(*) FILTER (WHERE status='spam')::int spam, count(*) FILTER (WHERE status <> 'spam')::int "all"
       FROM inbox_conversations WHERE workspace_id=$1 AND brand_id = ANY($2::uuid[])`, [ctx.access.workspaceId, brands, ctx.actor.userId]);
  return r;
}

// ------------------------------------------------------------------ detail
type AttemptRow = { id: string; conversation_id: string; mode: 'public_reply' | 'private_message'; body: string; state: ReplyAttemptDto['state']; created_by: string | null; created_at: Date; sent_at: Date | null; attempts: number; provider_message_id: string | null; provider_result: ReplyAttemptDto['provider_result']; error_code: string | null; error_message: string | null; is_simulated: boolean };

export function attemptDto(a: AttemptRow, ppl: Map<string, PersonRef>): ReplyAttemptDto {
  return {
    id: a.id, conversation_id: a.conversation_id, mode: a.mode, body: a.body, state: a.state, created_by: (a.created_by && ppl.get(a.created_by)) || { id: a.created_by ?? '', name: null, email: null },
    created_at: a.created_at.toISOString(), sent_at: iso(a.sent_at), attempts: a.attempts, provider_result: a.provider_result,
    error: a.error_code ? { code: a.error_code, message: a.error_message ?? '' } : null, is_simulated: a.is_simulated,
  };
}

export async function replyAvailability(conv: ConversationRow, db: Queryable = getPool(), now = new Date()): Promise<ConversationDetail['reply']['modes']> {
  const ch = await loadChannelRow(db, conv.channel_id);
  const adapter = ch ? getInboxAdapter(ch.kind) : null;
  const features = (await getSetting('META_HUMAN_AGENT_APPROVED').catch(() => undefined)) === 'true' ? ['human_agent'] : [];
  return REPLY_MODES.map((mode) => {
    if (!ch || !adapter || ch.disconnected_at) return { mode, allowed: false, reason: 'This channel is no longer connected.', window_ends_at: null };
    if (ch.status !== 'active') return { mode, allowed: false, reason: ch.status === 'paused' ? 'Channel paused.' : (ch.status_detail ?? 'Channel needs attention.'), window_ends_at: null };
    if (conv.status === 'spam') return { mode, allowed: false, reason: 'Marked as spam.', window_ends_at: null };
    const r = adapter.replyRules({ kind: conv.kind, mode, now, lastInboundAt: conv.last_inbound_at, firstInboundAt: conv.first_inbound_at, privateReplyUsed: conv.private_reply_used, features });
    return r.allowed ? { mode, allowed: true, reason: null, window_ends_at: r.windowEndsAt } : { mode, allowed: false, reason: r.message, window_ends_at: null };
  });
}

export async function getConversation(ctx: Ctx, id: string, q: { before?: string | null } = {}): Promise<ConversationDetail> {
  const conv = await loadConversation(ctx, id, 'inbox.read');
  const db = getPool();
  const before = q.before && !Number.isNaN(Date.parse(q.before)) ? new Date(q.before) : null;
  const [listRow, msgs, notes, attempts, events, draft, presence] = await Promise.all([
    one<ListRow>(db, `${LIST_SELECT} WHERE c.id=$1`, [id]),
    many<{ id: string; direction: 'inbound' | 'outbound'; external_id: string | null; author_contact_id: string | null; author_user_id: string | null; body: string | null; revision: number; edited_at: Date | null; deleted_at: Date | null; attachments: Array<{ type: string; name: string | null; size: number | null }>; provider_created_at: Date; automated: boolean; delivery_state: 'sent' | 'delivered' | 'read' | null; reply_attempt_id: string | null; c_name: string | null }>(db,
      `SELECT m.*, ct.display_name AS c_name FROM inbox_messages m LEFT JOIN inbox_contacts ct ON ct.id=m.author_contact_id
        WHERE m.conversation_id=$1 AND ($2::timestamptz IS NULL OR m.provider_created_at < $2) ORDER BY m.provider_created_at DESC, m.id DESC LIMIT 51`, [id, before]),
    many<{ id: string; author_id: string | null; body: string; mentions: string[]; created_at: Date; edited_at: Date | null }>(db,
      `SELECT id, author_id, body, mentions, created_at, edited_at FROM inbox_notes WHERE conversation_id=$1 AND deleted_at IS NULL AND ($2::timestamptz IS NULL OR created_at < $2) ORDER BY created_at DESC LIMIT 50`, [id, before]),
    many<AttemptRow>(db, `SELECT * FROM inbox_reply_attempts WHERE conversation_id=$1 AND state <> 'sent' AND ($2::timestamptz IS NULL OR created_at < $2) ORDER BY created_at DESC LIMIT 20`, [id, before]),
    many<{ kind: string; actor_id: string | null; data: Record<string, unknown>; at: Date }>(db,
      `SELECT kind, actor_id, data, at FROM inbox_events WHERE conversation_id=$1 AND kind IN ('assigned','status_changed','case_linked','priority_changed') AND ($2::timestamptz IS NULL OR at < $2) ORDER BY id DESC LIMIT 30`, [id, before]),
    maybeOne<{ mode: 'public_reply' | 'private_message'; body: string; base_version: number; updated_at: Date }>(db, `SELECT mode, body, base_version, updated_at FROM inbox_drafts WHERE conversation_id=$1 AND user_id=$2`, [id, ctx.actor.userId]),
    many<{ user_id: string; state: 'viewing' | 'composing'; seen_at: Date }>(db,
      `SELECT p.user_id, p.state, p.seen_at FROM inbox_presence p JOIN memberships m ON m.workspace_id=p.workspace_id AND m.user_id=p.user_id AND m.status='active' AND m.removed_at IS NULL
        WHERE p.conversation_id=$1 AND p.user_id <> $2 AND p.seen_at > now() - interval '60 seconds'`, [id, ctx.actor.userId]),
  ]);
  const ppl = await people(db, [...msgs.map((m) => m.author_user_id), ...notes.map((n) => n.author_id), ...attempts.map((a) => a.created_by), ...events.map((e) => e.actor_id), ...presence.map((p) => p.user_id)]);
  const sentBy = new Map((await many<{ id: string; created_by: string | null }>(db, `SELECT id, created_by FROM inbox_reply_attempts WHERE id = ANY($1::uuid[])`, [msgs.map((m) => m.reply_attempt_id).filter(Boolean)])).map((x) => [x.id, x.created_by]));
  const timeline: TimelineEntry[] = [
    ...msgs.slice(0, 50).map((m): TimelineEntry => {
      const by = m.reply_attempt_id ? sentBy.get(m.reply_attempt_id) : m.author_user_id;
      return {
        type: 'message', at: m.provider_created_at.toISOString(), message: {
          id: m.id, direction: m.direction, external_id: m.external_id,
          author: m.direction === 'inbound' ? { kind: 'contact', name: m.c_name } : by ? { kind: 'user', name: ppl.get(by)?.name ?? ppl.get(by)?.email ?? null } : { kind: 'business', name: null },
          body: m.body, revision: m.revision, edited_at: iso(m.edited_at), deleted_at: iso(m.deleted_at), attachments: m.attachments.map((a) => ({ type: a.type, name: a.name, size: a.size })),
          at: m.provider_created_at.toISOString(), automated: m.automated, delivery: m.direction === 'outbound' ? m.delivery_state : null, reply_attempt_id: m.reply_attempt_id,
        },
      };
    }),
    ...notes.map((n): TimelineEntry => ({ type: 'note', at: n.created_at.toISOString(), note: { id: n.id, author: (n.author_id && ppl.get(n.author_id)) || { id: '', name: 'Former member', email: null }, body: n.body, mentions: n.mentions, at: n.created_at.toISOString(), edited_at: iso(n.edited_at) } satisfies NoteDto })),
    ...attempts.map((a): TimelineEntry => ({ type: 'attempt', at: a.created_at.toISOString(), attempt: attemptDto(a, ppl) })),
    ...events.map((e): TimelineEntry => ({ type: 'event', at: e.at.toISOString(), event: { kind: e.kind, actor: e.actor_id ? ppl.get(e.actor_id) ?? null : null, data: e.data } })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const [item] = await toListItems(db, [listRow]);
  return {
    ...item!, timeline, has_more: msgs.length > 50,
    reply: {
      modes: await replyAvailability(conv, db),
      can_reply: authorizeCtx(ctx, 'inbox.reply', { brandId: conv.brand_id }).allowed,
      can_note: authorizeCtx(ctx, 'inbox.read', { brandId: conv.brand_id }).allowed,
      can_assign: authorizeCtx(ctx, 'inbox.assign', { brandId: conv.brand_id }).allowed,
    },
    draft: draft ? { mode: draft.mode, body: draft.body, base_version: draft.base_version, updated_at: draft.updated_at.toISOString() } : null,
    presence: presence.map((p) => ({ user: ppl.get(p.user_id) ?? { id: p.user_id, name: null, email: null }, state: p.state, seen_at: p.seen_at.toISOString() })),
    related_post: conv.related_external_post_id || conv.related_post_id ? { id: conv.related_post_id, external_id: conv.related_external_post_id } : null,
  };
}

// ------------------------------------------------------------------ updates
export const updateConversationSchema = z.object({
  status: z.enum(['open', 'waiting', 'snoozed', 'resolved', 'spam']).optional(),
  snoozed_until: z.string().datetime({ offset: true }).nullable().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  labels: z.array(z.string().min(1).max(40)).max(20).optional(),
  language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/).nullable().optional(),
}).strict();

export async function updateConversation(ctx: Ctx, id: string, input: z.infer<typeof updateConversationSchema>): Promise<ConversationListItem> {
  await withTx(async (tx) => {
    const c = await loadConversation(ctx, id, 'inbox.reply', tx, true);
    if (input.status === 'snoozed' && (!input.snoozed_until || Date.parse(input.snoozed_until) <= Date.now())) throw new AppError('validation_failed', 'Choose when the conversation should come back.', { snoozed_until: 'Must be in the future' });
    const status = input.status ?? c.status;
    await tx.query(
      `UPDATE inbox_conversations SET status=$2, snoozed_until=$3, priority=coalesce($4, priority), labels=coalesce($5, labels), language=CASE WHEN $6 THEN $7 ELSE language END,
              resolved_at=CASE WHEN $2='resolved' THEN coalesce(resolved_at, now()) ELSE NULL END, updated_at=now() WHERE id=$1`,
      [id, status, status === 'snoozed' ? input.snoozed_until : null, input.priority ?? null, input.labels ?? null, input.language !== undefined, input.language ?? null]);
    if (input.status && input.status !== c.status) await inboxEvent(tx, { workspaceId: c.workspace_id, conversationId: id, brandId: c.brand_id, kind: 'status_changed', actorId: ctx.actor.userId, data: { from: c.status, to: input.status } });
    if (input.priority && input.priority !== c.priority) await inboxEvent(tx, { workspaceId: c.workspace_id, conversationId: id, brandId: c.brand_id, kind: 'priority_changed', actorId: ctx.actor.userId, data: { from: c.priority, to: input.priority } });
    await audit(tx, { workspaceId: c.workspace_id, brandId: c.brand_id, actorUserId: ctx.actor.userId, action: 'inbox.conversation_updated', resourceType: 'inbox_conversation', resourceId: id, diff: { status: input.status, priority: input.priority }, correlationId: ctx.correlationId });
  });
  const r = await one<ListRow>(getPool(), `${LIST_SELECT} WHERE c.id=$1`, [id]);
  return (await toListItems(getPool(), [r]))[0]!;
}

export const assignSchema = z.object({ assignee_id: z.string().uuid().nullable(), team_id: z.string().uuid().nullable().optional() }).strict();

export async function assignConversation(ctx: Ctx, id: string, input: z.infer<typeof assignSchema>): Promise<ConversationListItem> {
  await withTx(async (tx) => {
    const c = await loadConversation(ctx, id, 'inbox.assign', tx, true);
    if (input.assignee_id) {
      const s = await loadUserAuthz(input.assignee_id, c.workspace_id, null, tx);
      if (s.subject.status !== 'active' || !staffAllowed(s, 'inbox.read', c.brand_id)) throw new AppError('validation_failed', 'That person cannot access this brand’s inbox.', { assignee_id: 'Choose someone with inbox access.' });
    }
    if (input.team_id && !(await maybeOne(tx, `SELECT 1 FROM teams WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL`, [input.team_id, c.workspace_id]))) throw notFound('Team');
    await tx.query(`UPDATE inbox_conversations SET assignee_id=$2, team_id=CASE WHEN $3 THEN $4 ELSE team_id END, updated_at=now() WHERE id=$1`, [id, input.assignee_id, input.team_id !== undefined, input.team_id ?? null]);
    await inboxEvent(tx, { workspaceId: c.workspace_id, conversationId: id, brandId: c.brand_id, kind: 'assigned', actorId: ctx.actor.userId, data: { from: c.assignee_id, to: input.assignee_id } });
    await writeOutbox(tx, { workspaceId: c.workspace_id, aggregateType: 'inbox_conversation', aggregateId: id, eventType: 'inbox.assigned', payload: { assigneeId: input.assignee_id, previousAssigneeId: c.assignee_id } });
    if (input.assignee_id && input.assignee_id !== ctx.actor.userId && input.assignee_id !== c.assignee_id) {
      await deliverNotification(tx, {
        workspaceId: c.workspace_id, userId: input.assignee_id, event: 'assignment', kind: 'inbox.assigned', title: `${ctx.actor.name || 'A teammate'} assigned you a conversation`,
        referenceType: 'inbox_conversation', referenceId: id, dedupeKey: `inbox-assign:${id}:${input.assignee_id}:${Date.now()}`, requirement: { brandId: c.brand_id, permission: 'inbox.read' },
        linkPath: `/inbox?c=${id}`, actorId: ctx.actor.userId,
      });
    }
    await audit(tx, { workspaceId: c.workspace_id, brandId: c.brand_id, actorUserId: ctx.actor.userId, action: 'inbox.assigned', resourceType: 'inbox_conversation', resourceId: id, diff: { from: c.assignee_id, to: input.assignee_id }, correlationId: ctx.correlationId });
  });
  const r = await one<ListRow>(getPool(), `${LIST_SELECT} WHERE c.id=$1`, [id]);
  return (await toListItems(getPool(), [r]))[0]!;
}

/** People who can be assigned on this conversation's brand (bounded). */
export async function assigneeOptions(ctx: Ctx, id: string): Promise<{ items: PersonRef[] }> {
  const c = await loadConversation(ctx, id, 'inbox.read');
  const rows = await many<{ id: string; name: string | null; email: string }>(getPool(),
    `SELECT u.id, u.name, u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.status='active' AND m.removed_at IS NULL ORDER BY coalesce(u.name, u.email) LIMIT 200`, [c.workspace_id]);
  const out: PersonRef[] = [];
  for (const r of rows) {
    const s = await loadUserAuthz(r.id, c.workspace_id, null);
    if (s.subject.status === 'active' && staffAllowed(s, 'inbox.read', c.brand_id)) out.push({ id: r.id, name: r.name, email: r.email });
    if (out.length >= 50) break;
  }
  return { items: out };
}

// ------------------------------------------------------------------ notes (internal only)
export const noteSchema = z.object({ body: z.string().trim().min(1).max(4000), mentions: z.array(z.string().uuid()).max(10).optional() }).strict();

/** Internal note: stored in inbox_notes, which no outbound path reads. Never sent to the customer. */
export async function addNote(ctx: Ctx, id: string, input: z.infer<typeof noteSchema>): Promise<NoteDto> {
  return withTx(async (tx) => {
    const c = await loadConversation(ctx, id, 'inbox.read', tx, true);
    const mentions: string[] = [];
    for (const m of [...new Set(input.mentions ?? [])]) {
      const s = await loadUserAuthz(m, c.workspace_id, null, tx);
      if (s.subject.status === 'active' && staffAllowed(s, 'inbox.read', c.brand_id)) mentions.push(m);
    }
    const n = await one<{ id: string; created_at: Date }>(tx, `INSERT INTO inbox_notes(workspace_id, conversation_id, author_id, body, mentions) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
      [c.workspace_id, id, ctx.actor.userId, input.body, mentions]);
    await inboxEvent(tx, { workspaceId: c.workspace_id, conversationId: id, brandId: c.brand_id, kind: 'note.added', actorId: ctx.actor.userId, data: { note_id: n.id } });
    await writeOutbox(tx, { workspaceId: c.workspace_id, aggregateType: 'inbox_note', aggregateId: n.id, eventType: 'inbox.note_added', payload: { conversationId: id, mentions } });
    for (const m of mentions) {
      if (m === ctx.actor.userId) continue;
      await deliverNotification(tx, {
        workspaceId: c.workspace_id, userId: m, event: 'mention', kind: 'inbox.mention', title: `${ctx.actor.name || 'A teammate'} mentioned you in an inbox note`,
        referenceType: 'inbox_conversation', referenceId: id, dedupeKey: `inbox-note:${n.id}:${m}`, requirement: { brandId: c.brand_id, permission: 'inbox.read' }, linkPath: `/inbox?c=${id}`, actorId: ctx.actor.userId,
      });
    }
    return { id: n.id, author: { id: ctx.actor.userId, name: ctx.actor.name ?? null, email: ctx.actor.email }, body: input.body, mentions, at: n.created_at.toISOString(), edited_at: null };
  });
}

// ------------------------------------------------------------------ drafts + presence
export const draftSchema = z.object({ mode: z.enum(['public_reply', 'private_message']), body: z.string().max(4000), base_version: z.number().int().positive() }).strict();

/** Server copy of the agent's unsent reply (survives reloads/devices). Switching mode keeps the text. */
export async function saveDraft(ctx: Ctx, id: string, input: z.infer<typeof draftSchema>): Promise<{ updated_at: string }> {
  const c = await loadConversation(ctx, id, 'inbox.reply');
  if (!input.body.trim()) {
    await getPool().query(`DELETE FROM inbox_drafts WHERE conversation_id=$1 AND user_id=$2`, [id, ctx.actor.userId]);
    return { updated_at: new Date().toISOString() };
  }
  const r = await one<{ updated_at: Date }>(getPool(),
    `INSERT INTO inbox_drafts(workspace_id, conversation_id, user_id, mode, body, base_version) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (conversation_id, user_id) DO UPDATE SET mode=EXCLUDED.mode, body=EXCLUDED.body, base_version=EXCLUDED.base_version, updated_at=now() RETURNING updated_at`,
    [c.workspace_id, id, ctx.actor.userId, input.mode, input.body, input.base_version]);
  return { updated_at: r.updated_at.toISOString() };
}

export async function presenceHeartbeat(ctx: Ctx, id: string, state: 'viewing' | 'composing'): Promise<{ others: ConversationDetail['presence'] }> {
  const c = await loadConversation(ctx, id, 'inbox.read');
  const db = getPool();
  await db.query(`INSERT INTO inbox_presence(conversation_id, user_id, workspace_id, state) VALUES ($1,$2,$3,$4)
                  ON CONFLICT (conversation_id, user_id) DO UPDATE SET state=EXCLUDED.state, seen_at=now()`, [id, ctx.actor.userId, c.workspace_id, state]);
  const rows = await many<{ user_id: string; state: 'viewing' | 'composing'; seen_at: Date }>(db,
    `SELECT p.user_id, p.state, p.seen_at FROM inbox_presence p JOIN memberships m ON m.workspace_id=p.workspace_id AND m.user_id=p.user_id AND m.status='active' AND m.removed_at IS NULL
      WHERE p.conversation_id=$1 AND p.user_id <> $2 AND p.seen_at > now() - interval '60 seconds'`, [id, ctx.actor.userId]);
  const ppl = await people(db, rows.map((r) => r.user_id));
  return { others: rows.map((r) => ({ user: ppl.get(r.user_id) ?? { id: r.user_id, name: null, email: null }, state: r.state, seen_at: r.seen_at.toISOString() })) };
}

/** Content-free realtime feed for the inbox (ids + kinds), filtered to conversations the caller can read. */
export async function inboxEvents(ctx: Ctx, q: { after?: string | number | null } = {}): Promise<{ items: Array<{ id: number; conversation_id: string | null; kind: string; at: string }>; last_id: number }> {
  requireAction(ctx, 'inbox.read');
  const brands = await inboxBrandIds(ctx);
  const after = Math.max(0, Number(q.after) || 0);
  const rows = await many<{ id: string; conversation_id: string | null; kind: string; at: Date }>(getPool(),
    after ? `SELECT id, conversation_id, kind, at FROM inbox_events WHERE workspace_id=$1 AND id > $2 AND brand_id = ANY($3::uuid[]) ORDER BY id LIMIT 200`
      : `SELECT id, conversation_id, kind, at FROM inbox_events WHERE workspace_id=$1 AND $2::bigint = 0 AND brand_id = ANY($3::uuid[]) ORDER BY id DESC LIMIT 1`,
    [ctx.access.workspaceId, after, brands]);
  const last = rows.length ? Number(rows[rows.length - 1]!.id) : after;
  return { items: after ? rows.map((r) => ({ id: Number(r.id), conversation_id: r.conversation_id, kind: r.kind, at: r.at.toISOString() })) : [], last_id: last };
}

/** Worker: wake snoozed conversations whose time has come; purge stale presence. */
export async function sweepSnoozes(): Promise<number> {
  const r = await getPool().query(`UPDATE inbox_conversations SET status='open', snoozed_until=NULL, version=version+1, updated_at=now() WHERE status='snoozed' AND snoozed_until <= now() RETURNING id, workspace_id, brand_id`);
  for (const row of r.rows as Array<{ id: string; workspace_id: string; brand_id: string }>) await inboxEvent(getPool(), { workspaceId: row.workspace_id, conversationId: row.id, brandId: row.brand_id, kind: 'status_changed', data: { from: 'snoozed', to: 'open', by: 'snooze_ended' } });
  await getPool().query(`DELETE FROM inbox_presence WHERE seen_at < now() - interval '10 minutes'`);
  return r.rowCount ?? 0;
}
