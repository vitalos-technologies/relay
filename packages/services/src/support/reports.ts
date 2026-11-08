// Relay support (V4 SUP) — "Send to Relay support" from a workspace-local problem report (brief §6).
// Problem reports stay workspace-local by default. Nothing is exported automatically: a person explicitly reviews what
// will be shared (summary as already redacted, each diagnostic opt-in, the draft excerpt OFF unless ticked) and submits.
// The share creates a ticket (source 'problem_report', keeps the report id) or adds a message to one of their open
// tickets, records who submitted it (shared_by + workspace audit) and links the report to the ticket.
// Who may share: the person who filed the report, or a support.workspace holder (owners/admins).
import { z } from 'zod';
import { AppError, notFound } from '@social-lite/core';
import { SUPPORT_TICKET_CATEGORIES, type CustomerTicketDetail, type ProblemReportSharePreview, type SupportDiagnostics, type SupportTicketCategory } from '@social-lite/core/contracts/v4-support';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { beginIdempotent, completeIdempotent } from '../idempotency.js';
import { enforceRateLimit } from '../ratelimit.js';
import { writeOutbox } from '../outbox.js';
import { assertUuid } from '../tenancy.js';
import { canSeeWorkspaceTickets, loadVisibleTicket } from './access.js';
import { CREATE_RATE, getTicket, insertMemberTicket } from './tickets.js';
import { appendSearch, safeDiagnostics, writeActivity } from './shared.js';

interface ReportRow {
  id: string; user_id: string | null; category: string; summary: string; route: string | null; app_version: string | null; occurred_at: Date | null; correlation_ids: string[];
  attachments: { draft_excerpt?: { post_id: string; text: string } }; redactions: number; created_at: Date; browser_family: string | null; error_code: string | null;
  support_ticket_id: string | null;
}

/** Report categories → support categories (a sensible default the person can change). */
const CATEGORY_MAP: Record<string, SupportTicketCategory> = { bug: 'technical', publishing: 'publishing', integration: 'connections', performance: 'technical', account: 'account_access', other: 'technical' };

async function loadReport(ctx: Ctx, id: string, db: Queryable, lock = false): Promise<ReportRow> {
  assertUuid(id, 'Report');
  const r = await maybeOne<ReportRow>(db,
    `SELECT id, user_id, category, summary, route, app_version, occurred_at, correlation_ids, attachments, redactions, created_at, browser_family, error_code, support_ticket_id
       FROM support_reports WHERE id=$1 AND workspace_id=$2 ${lock ? 'FOR UPDATE' : ''}`, [id, ctx.access.workspaceId]);
  if (!r || !(r.user_id === ctx.actor.userId || canSeeWorkspaceTickets(ctx))) throw notFound('Report');
  return r;
}

function diagnosticItems(r: ReportRow): ProblemReportSharePreview['diagnostics'] {
  const items: ProblemReportSharePreview['diagnostics'] = [];
  if (r.app_version) items.push({ key: 'app_version', label: 'App version', value: r.app_version, default_selected: true });
  if (r.route) items.push({ key: 'route', label: 'Page (path only)', value: r.route, default_selected: true });
  if (r.occurred_at) items.push({ key: 'occurred_at', label: 'Time', value: r.occurred_at.toISOString(), default_selected: true });
  if (r.browser_family) items.push({ key: 'browser_family', label: 'Browser', value: r.browser_family, default_selected: true });
  if (r.error_code) items.push({ key: 'error_code', label: 'Error code', value: r.error_code, default_selected: true });
  if (r.correlation_ids.length) items.push({ key: 'correlation_ids', label: 'Error references', value: r.correlation_ids.join(', '), default_selected: true });
  return items;
}

export async function previewReportShare(ctx: Ctx, reportId: string, db: Queryable = getPool()): Promise<ProblemReportSharePreview> {
  const r = await loadReport(ctx, reportId, db);
  const shared = r.support_ticket_id ? await maybeOne<{ id: string; reference: string }>(db, `SELECT id, reference FROM support_tickets WHERE id=$1`, [r.support_ticket_id]) : null;
  const open = await many<{ id: string; reference: string; subject: string }>(db,
    `SELECT id, reference, subject FROM support_tickets WHERE workspace_id=$1 AND requester_user_id=$2 AND status NOT IN ('resolved','archived') ORDER BY updated_at DESC LIMIT 10`,
    [ctx.access.workspaceId, ctx.actor.userId]);
  return {
    report: { id: r.id, category: r.category, summary: r.summary, created_at: r.created_at.toISOString(), redactions: r.redactions },
    diagnostics: diagnosticItems(r),
    draft_excerpt_available: !!r.attachments?.draft_excerpt,
    already_shared: shared ? { ticket_id: shared.id, reference: shared.reference } : null,
    open_tickets: open,
  };
}

const shareSchema = z.object({
  category: z.enum(SUPPORT_TICKET_CATEGORIES).optional(),
  subject: z.string().trim().min(1).max(200).optional(),
  message: z.string().trim().max(4000).optional(),
  /** Diagnostic keys the person ticked (anything not listed is not sent). */
  diagnostics: z.array(z.enum(['app_version', 'route', 'occurred_at', 'browser_family', 'error_code', 'correlation_ids'])).max(6).default([]),
  include_draft_excerpt: z.boolean().default(false),
  /** Add to one of the caller's open tickets instead of creating a new one. */
  ticket_id: z.string().uuid().nullish(),
  attachment_ids: z.array(z.string()).max(5).default([]),
}).strict();

export async function shareReportToSupport(ctx: Ctx, reportId: string, raw: unknown, idemKey: string | null): Promise<CustomerTicketDetail> {
  const input = shareSchema.parse(raw);
  await enforceRateLimit('supportCreate', ctx.actor.userId, CREATE_RATE);
  const ticketId = await withTx(async (tx) => {
    const r = await loadReport(ctx, reportId, tx, true);
    const prior = await beginIdempotent(tx, { workspaceId: ctx.access.workspaceId, userId: ctx.actor.userId, action: 'support.share_report', key: idemKey, body: { report: reportId, ...input } });
    if (prior) return (prior.body as { id: string }).id;
    if (r.support_ticket_id) throw new AppError('conflict', 'This report was already sent to Relay support.', undefined, { ticket_id: r.support_ticket_id });
    const picked = new Set(input.diagnostics);
    const diagnostics: SupportDiagnostics = safeDiagnostics({
      app_version: picked.has('app_version') ? r.app_version : null,
      route: picked.has('route') ? r.route : null,
      occurred_at: picked.has('occurred_at') ? r.occurred_at?.toISOString() : null,
      browser_family: picked.has('browser_family') ? r.browser_family : null,
      error_code: picked.has('error_code') ? r.error_code : null,
      correlation_ids: picked.has('correlation_ids') ? r.correlation_ids : [],
    });
    const excerpt = input.include_draft_excerpt ? r.attachments?.draft_excerpt?.text ?? null : null;
    const body = [input.message?.trim() || null, `Problem report (${r.created_at.toISOString().slice(0, 10)}):\n${r.summary}`, excerpt ? `Draft excerpt (redacted):\n${excerpt}` : null,
      Object.keys(diagnostics).length ? `Diagnostics: ${Object.entries(diagnostics).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`).join(' · ')}` : null]
      .filter(Boolean).join('\n\n').slice(0, 10000);
    let id: string;
    if (input.ticket_id) {
      const t = await loadVisibleTicket(ctx, input.ticket_id, tx, true);
      if (t.status === 'archived') throw new AppError('invalid_state', 'That request is closed. Send this report as a new request.');
      const m = await one<{ id: string }>(tx, `INSERT INTO support_messages(ticket_id, author_kind, author_user_id, body) VALUES ($1,'member',$2,$3) RETURNING id`, [t.id, ctx.actor.userId, body]);
      await tx.query(`UPDATE support_tickets SET status=CASE WHEN status IN ('new') THEN 'new' ELSE 'waiting_on_relay' END, resolution_reason=CASE WHEN status='resolved' THEN NULL ELSE resolution_reason END,
                        resolved_at=CASE WHEN status='resolved' THEN NULL ELSE resolved_at END, last_customer_at=now(), updated_at=now() WHERE id=$1`, [t.id]);
      await appendSearch(tx, t.id, body);
      await writeActivity(tx, { ticketId: t.id, audience: 'customer', kind: 'message.created', actorKind: 'member', actorUserId: ctx.actor.userId, refId: m.id });
      await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'support_ticket', aggregateId: t.id, eventType: 'support.message_created', payload: { messageId: m.id } });
      id = t.id;
    } else {
      const created = await insertMemberTicket(tx, ctx, {
        category: input.category ?? CATEGORY_MAP[r.category] ?? 'technical',
        subject: input.subject ?? `Problem report: ${r.summary.split('\n')[0]!.slice(0, 120)}`,
        message: body, attachmentIds: input.attachment_ids, diagnostics, source: 'problem_report', problemReportId: r.id,
      });
      id = created.id;
    }
    await tx.query(`UPDATE support_reports SET support_ticket_id=$2, shared_at=now(), shared_by=$3 WHERE id=$1`, [r.id, id, ctx.actor.userId]);
    await writeActivity(tx, { ticketId: id, audience: 'customer', kind: 'report.linked', actorKind: 'member', actorUserId: ctx.actor.userId, refId: r.id });
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'support_report.shared', resourceType: 'support_report', resourceId: r.id,
      diff: { ticket_id: id, diagnostics: [...picked], draft_excerpt: !!excerpt }, correlationId: ctx.correlationId });
    await completeIdempotent(tx, { workspaceId: ctx.access.workspaceId, action: 'support.share_report', key: idemKey!, status: 200, body: { id } });
    return id;
  });
  return getTicket(ctx, ticketId);
}
