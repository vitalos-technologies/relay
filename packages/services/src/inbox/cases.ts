// Customer-care cases + service levels (brief §12). Calculations: @social-lite/core/contracts/v35-sla (definitions there).
// Every state change writes an append-only care_case_events row (SLA evidence) and bumps `version` (optimistic concurrency).
import { AppError, notFound } from '@social-lite/core';
import type { CareReport, CaseDto, CaseState, Priority, SlaPolicyDto } from '@social-lite/core/contracts/v35-inbox';
import { businessMsBetween, dueAt, SLA_DEFINITIONS, type BusinessCalendar } from '@social-lite/core/contracts/v35-sla';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { writeOutbox } from '../outbox.js';
import { deliverNotification } from '../collab/notifications.js';
import { loadUserAuthz } from '../authz.js';
import { staffAllowed } from '../collab/access.js';
import { assertUuid, authorizeCtx, brandAllowed, requireAction } from '../tenancy.js';
import { iso, loadConversation, people } from './shared.js';

export interface CaseRow {
  id: string; number: string; workspace_id: string; brand_id: string; title: string; category: string | null; priority: Priority; state: CaseState;
  owner_id: string | null; team_id: string | null; sla_policy_id: string | null; opened_at: Date; clock_started_at: Date; paused_since: Date | null;
  paused_business_ms: string; first_response_due_at: Date | null; first_responded_at: Date | null; resolution_due_at: Date | null; resolved_at: Date | null;
  resolution_reason: string | null; reopened_count: number; first_response_breached_at: Date | null; resolution_breached_at: Date | null; escalated_at: Date | null;
  version: number; created_by: string | null; created_at: Date; updated_at: Date;
}

interface PolicyRow { id: string; workspace_id: string; brand_id: string | null; name: string; timezone: string; business_hours: SlaPolicyDto['business_hours']; holidays: Array<Date | string>; first_response_minutes: number | null; resolution_minutes: number | null; count_automated: boolean; is_default: boolean }

const ymd = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));
export const calendarOf = (p: PolicyRow | null): BusinessCalendar => (p ? { timezone: p.timezone, business_hours: p.business_hours, holidays: p.holidays.map(ymd) } : { timezone: 'UTC', business_hours: null, holidays: [] });

const policyJson = (p: PolicyRow): SlaPolicyDto => ({ id: p.id, brand_id: p.brand_id, name: p.name, timezone: p.timezone, business_hours: p.business_hours, holidays: p.holidays.map(ymd), first_response_minutes: p.first_response_minutes, resolution_minutes: p.resolution_minutes, count_automated: p.count_automated, is_default: p.is_default });

async function policyFor(db: Queryable, workspaceId: string, brandId: string, id?: string | null): Promise<PolicyRow | null> {
  if (id) return maybeOne<PolicyRow>(db, `SELECT * FROM care_sla_policies WHERE id=$1 AND workspace_id=$2`, [id, workspaceId]);
  return maybeOne<PolicyRow>(db,
    `SELECT * FROM care_sla_policies WHERE workspace_id=$1 AND is_default AND archived_at IS NULL AND (brand_id=$2 OR brand_id IS NULL) ORDER BY brand_id NULLS LAST LIMIT 1`, [workspaceId, brandId]);
}

/** Recompute due dates from the clock (pauses excluded). */
async function recompute(tx: Queryable, c: CaseRow): Promise<void> {
  const p = await policyFor(tx, c.workspace_id, c.brand_id, c.sla_policy_id);
  const cal = calendarOf(p);
  const clock = { start: c.clock_started_at, pausedBusinessMs: Number(c.paused_business_ms), pausedSince: c.paused_since };
  const frDue = c.first_responded_at ? c.first_response_due_at : dueAt(clock, p?.first_response_minutes ?? null, cal);
  const resDue = c.resolved_at ? c.resolution_due_at : dueAt(clock, p?.resolution_minutes ?? null, cal);
  await tx.query(`UPDATE care_cases SET first_response_due_at=$2, resolution_due_at=$3, updated_at=now() WHERE id=$1`, [c.id, frDue, resDue]);
}

async function caseEvent(tx: Queryable, c: { id: string; workspace_id: string }, kind: string, actorId: string | null, data: Record<string, unknown> = {}): Promise<void> {
  await tx.query(`INSERT INTO care_case_events(workspace_id, case_id, kind, actor_id, data) VALUES ($1,$2,$3,$4,$5)`, [c.workspace_id, c.id, kind, actorId, JSON.stringify(data)]);
}

async function pause(tx: Queryable, c: CaseRow, at: Date, actorId: string | null): Promise<void> {
  if (c.paused_since) return;
  await tx.query(`UPDATE care_cases SET paused_since=$2 WHERE id=$1`, [c.id, at]);
  await caseEvent(tx, c, 'paused', actorId);
  c.paused_since = at;
}

async function resume(tx: Queryable, c: CaseRow, at: Date, actorId: string | null): Promise<void> {
  if (!c.paused_since) return;
  const p = await policyFor(tx, c.workspace_id, c.brand_id, c.sla_policy_id);
  const add = businessMsBetween(c.paused_since, at, calendarOf(p));
  await tx.query(`UPDATE care_cases SET paused_since=NULL, paused_business_ms=paused_business_ms+$2 WHERE id=$1`, [c.id, add]);
  await caseEvent(tx, c, 'resumed', actorId, { paused_business_ms: add });
  c.paused_since = null;
  c.paused_business_ms = String(Number(c.paused_business_ms) + add);
}

// ------------------------------------------------------------------ hooks from ingest / replies
/** Customer wrote on a conversation linked to the case: waiting → open; resolved → reopened. */
export async function onCustomerMessage(tx: Queryable, caseId: string, at: Date): Promise<void> {
  const c = await maybeOne<CaseRow>(tx, `SELECT * FROM care_cases WHERE id=$1 FOR UPDATE`, [caseId]);
  if (!c) return;
  if (c.state === 'waiting') {
    await resume(tx, c, at, null);
    await tx.query(`UPDATE care_cases SET state='open', version=version+1 WHERE id=$1`, [c.id]);
    await caseEvent(tx, c, 'state_changed', null, { from: 'waiting', to: 'open', by: 'customer_message' });
  } else if (c.state === 'resolved') {
    await resume(tx, c, at, null);
    await tx.query(`UPDATE care_cases SET state='reopened', resolved_at=NULL, reopened_count=reopened_count+1, version=version+1 WHERE id=$1`, [c.id]);
    await caseEvent(tx, c, 'reopened', null, { by: 'customer_message' });
    c.resolved_at = null;
  } else return;
  await recompute(tx, { ...c, resolved_at: null });
}

/** A business reply reached the provider (state 'sent'). First response is measured once. */
export async function onBusinessReply(tx: Queryable, caseId: string, at: Date, automated: boolean): Promise<void> {
  const c = await maybeOne<CaseRow>(tx, `SELECT * FROM care_cases WHERE id=$1 FOR UPDATE`, [caseId]);
  if (!c || c.first_responded_at || at < c.clock_started_at) return;
  if (automated) {
    const p = await policyFor(tx, c.workspace_id, c.brand_id, c.sla_policy_id);
    if (!p?.count_automated) return;
  }
  await tx.query(`UPDATE care_cases SET first_responded_at=$2, version=version+1, updated_at=now() WHERE id=$1`, [c.id, at]);
  await caseEvent(tx, c, 'first_response', null, { automated });
}

// ------------------------------------------------------------------ API
export const createCaseSchema = z.object({
  conversation_id: z.string().uuid(), title: z.string().min(1).max(200), category: z.string().max(60).nullable().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(), owner_id: z.string().uuid().nullable().optional(), sla_policy_id: z.string().uuid().nullable().optional(),
}).strict();

async function assertOwnerEligible(db: Queryable, workspaceId: string, brandId: string, userId: string): Promise<void> {
  const s = await loadUserAuthz(userId, workspaceId, null, db);
  if (s.subject.status !== 'active' || !staffAllowed(s, 'inbox.read', brandId)) throw new AppError('validation_failed', 'That person cannot access this brand’s inbox.', { owner_id: 'Choose someone with inbox access.' });
}

export async function createCase(ctx: Ctx, input: z.infer<typeof createCaseSchema>): Promise<CaseDto> {
  const id = await withTx(async (tx) => {
    const conv = await loadConversation(ctx, input.conversation_id, 'cases.manage', tx, true);
    if (conv.case_id) throw new AppError('conflict', 'This conversation already belongs to a case.', undefined, { reason: 'already_linked', case_id: conv.case_id });
    if (input.owner_id) await assertOwnerEligible(tx, ctx.access.workspaceId, conv.brand_id, input.owner_id);
    const pol = await policyFor(tx, ctx.access.workspaceId, conv.brand_id, input.sla_policy_id ?? null);
    if (input.sla_policy_id && !pol) throw notFound('Service level policy');
    const now = new Date();
    const start = conv.unanswered_since ?? now;
    const c = await one<CaseRow>(tx,
      `INSERT INTO care_cases(workspace_id, brand_id, title, category, priority, owner_id, sla_policy_id, opened_at, clock_started_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [ctx.access.workspaceId, conv.brand_id, input.title, input.category ?? null, input.priority ?? conv.priority, input.owner_id ?? conv.assignee_id, pol?.id ?? null, now, start, ctx.actor.userId]);
    await tx.query(`UPDATE inbox_conversations SET case_id=$2, updated_at=now() WHERE id=$1`, [conv.id, c.id]);
    await caseEvent(tx, c, 'created', ctx.actor.userId, { conversation_id: conv.id });
    await caseEvent(tx, c, 'clock_started', null, { at: start.toISOString(), from: conv.unanswered_since ? 'unanswered_message' : 'creation' });
    await recompute(tx, c);
    await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'care_case', aggregateId: c.id, eventType: 'case.changed', payload: { change: 'created' } });
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: conv.brand_id, actorUserId: ctx.actor.userId, action: 'case.created', resourceType: 'care_case', resourceId: c.id, diff: { conversation_id: conv.id }, correlationId: ctx.correlationId });
    return c.id;
  });
  return getCase(ctx, id);
}

async function loadCase(ctx: Ctx, id: string, perm: 'inbox.read' | 'cases.manage', db: Queryable = getPool(), forUpdate = false): Promise<CaseRow> {
  assertUuid(id, 'Case');
  const c = await maybeOne<CaseRow>(db, `SELECT * FROM care_cases WHERE id=$1 AND workspace_id=$2${forUpdate ? ' FOR UPDATE' : ''}`, [id, ctx.access.workspaceId]);
  if (!c || !brandAllowed(ctx, c.brand_id) || !authorizeCtx(ctx, 'inbox.read', { brandId: c.brand_id }).allowed) throw notFound('Case');
  requireAction(ctx, perm, { brandId: c.brand_id });
  return c;
}

export async function getCase(ctx: Ctx, id: string): Promise<CaseDto> {
  const c = await loadCase(ctx, id, 'inbox.read');
  return (await casesJson(getPool(), [c]))[0]!;
}

export async function casesJson(db: Queryable, rows: CaseRow[]): Promise<CaseDto[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [convs, links, ppl] = await Promise.all([
    many<{ id: string; case_id: string }>(db, `SELECT id, case_id FROM inbox_conversations WHERE case_id = ANY($1::uuid[])`, [ids]),
    many<{ relay_id: string; connector: string; external_id: string; external_url: string | null; status: string }>(db,
      `SELECT l.relay_id, i.connector, l.external_id, l.external_url, l.status FROM external_links l JOIN integration_connections i ON i.id=l.integration_id
        WHERE l.relay_type='case' AND l.relay_id = ANY($1::uuid[]) AND l.status <> 'unlinked'`, [ids]),
    people(db, rows.map((r) => r.owner_id)),
  ]);
  const now = Date.now();
  return rows.map((c) => ({
    id: c.id, number: Number(c.number), brand_id: c.brand_id, title: c.title, category: c.category, priority: c.priority, state: c.state,
    owner: c.owner_id ? ppl.get(c.owner_id) ?? null : null, team_id: c.team_id, sla_policy_id: c.sla_policy_id, opened_at: c.opened_at.toISOString(),
    first_response: { due_at: iso(c.first_response_due_at), at: iso(c.first_responded_at), breached: !!c.first_response_breached_at || (!c.first_responded_at && !!c.first_response_due_at && c.first_response_due_at.getTime() < now) },
    resolution: { due_at: iso(c.resolution_due_at), at: iso(c.resolved_at), breached: !!c.resolution_breached_at || (!c.resolved_at && !!c.resolution_due_at && c.resolution_due_at.getTime() < now), reason: c.resolution_reason },
    paused: !!c.paused_since, reopened_count: c.reopened_count, version: c.version,
    conversation_ids: convs.filter((x) => x.case_id === c.id).map((x) => x.id),
    external_links: links.filter((l) => l.relay_id === c.id).map(({ relay_id: _r, ...l }) => l),
  }));
}

export const updateCaseSchema = z.object({
  version: z.number().int().positive(),
  state: z.enum(['open', 'waiting', 'resolved', 'reopened']).optional(),
  resolution_reason: z.string().min(1).max(200).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  owner_id: z.string().uuid().nullable().optional(),
  title: z.string().min(1).max(200).optional(),
  category: z.string().max(60).nullable().optional(),
}).strict();

const TRANSITIONS: Record<CaseState, CaseState[]> = {
  open: ['waiting', 'resolved'], waiting: ['open', 'resolved'], resolved: ['reopened'], reopened: ['waiting', 'resolved'],
};

export async function updateCase(ctx: Ctx, id: string, input: z.infer<typeof updateCaseSchema>): Promise<CaseDto> {
  await withTx(async (tx) => {
    const c = await loadCase(ctx, id, 'cases.manage', tx, true);
    if (c.version !== input.version) throw new AppError('version_conflict', 'Someone else changed this case. Reload to see the latest.', undefined, { current_version: c.version });
    const now = new Date();
    if (input.owner_id !== undefined && input.owner_id !== c.owner_id) {
      if (input.owner_id) await assertOwnerEligible(tx, c.workspace_id, c.brand_id, input.owner_id);
      await tx.query(`UPDATE care_cases SET owner_id=$2 WHERE id=$1`, [c.id, input.owner_id]);
      await caseEvent(tx, c, 'owner_changed', ctx.actor.userId, { from: c.owner_id, to: input.owner_id });
    }
    if (input.priority && input.priority !== c.priority) {
      await tx.query(`UPDATE care_cases SET priority=$2 WHERE id=$1`, [c.id, input.priority]);
      await caseEvent(tx, c, 'priority_changed', ctx.actor.userId, { from: c.priority, to: input.priority });
    }
    if (input.title || input.category !== undefined) await tx.query(`UPDATE care_cases SET title=coalesce($2, title), category=CASE WHEN $3 THEN $4 ELSE category END WHERE id=$1`, [c.id, input.title ?? null, input.category !== undefined, input.category ?? null]);
    if (input.state && input.state !== c.state) {
      const to = input.state === 'open' && c.state === 'resolved' ? 'reopened' : input.state;
      if (!TRANSITIONS[c.state].includes(to)) throw new AppError('invalid_state', `A ${c.state} case cannot move to ${to}.`);
      if (to === 'resolved') {
        if (!input.resolution_reason) throw new AppError('validation_failed', 'Add a resolution reason.', { resolution_reason: 'Required' });
        await pause(tx, c, now, ctx.actor.userId);
        await tx.query(`UPDATE care_cases SET state='resolved', resolved_at=$2, resolution_reason=$3 WHERE id=$1`, [c.id, now, input.resolution_reason]);
        await caseEvent(tx, c, 'resolved', ctx.actor.userId, { reason_length: input.resolution_reason.length });
        await tx.query(`UPDATE inbox_conversations SET status='resolved', resolved_at=now(), version=version+1, updated_at=now() WHERE case_id=$1 AND status NOT IN ('resolved','spam')`, [c.id]);
        c.resolved_at = now;
      } else if (to === 'waiting') {
        await pause(tx, c, now, ctx.actor.userId);
        await tx.query(`UPDATE care_cases SET state='waiting' WHERE id=$1`, [c.id]);
        await caseEvent(tx, c, 'state_changed', ctx.actor.userId, { from: c.state, to });
      } else if (to === 'reopened') {
        await resume(tx, c, now, ctx.actor.userId);
        await tx.query(`UPDATE care_cases SET state='reopened', resolved_at=NULL, resolution_reason=NULL, reopened_count=reopened_count+1 WHERE id=$1`, [c.id]);
        await caseEvent(tx, c, 'reopened', ctx.actor.userId);
        c.resolved_at = null;
      } else {
        await resume(tx, c, now, ctx.actor.userId);
        await tx.query(`UPDATE care_cases SET state='open' WHERE id=$1`, [c.id]);
        await caseEvent(tx, c, 'state_changed', ctx.actor.userId, { from: c.state, to });
      }
    }
    await tx.query(`UPDATE care_cases SET version=version+1, updated_at=now() WHERE id=$1`, [c.id]);
    const fresh = await one<CaseRow>(tx, `SELECT * FROM care_cases WHERE id=$1`, [c.id]);
    await recompute(tx, fresh);
    await writeOutbox(tx, { workspaceId: c.workspace_id, aggregateType: 'care_case', aggregateId: c.id, eventType: 'case.changed', payload: { change: input.state ? 'state' : input.owner_id !== undefined ? 'owner' : 'details' } });
    await audit(tx, { workspaceId: c.workspace_id, brandId: c.brand_id, actorUserId: ctx.actor.userId, action: 'case.updated', resourceType: 'care_case', resourceId: c.id, diff: { state: input.state ?? null, owner_id: input.owner_id ?? undefined, priority: input.priority ?? undefined }, correlationId: ctx.correlationId });
  });
  return getCase(ctx, id);
}

export async function listCases(ctx: Ctx, q: { state?: string | null; brand_id?: string | null; owner?: string | null; limit?: number | null } = {}): Promise<{ items: CaseDto[] }> {
  requireAction(ctx, 'inbox.read');
  const rows = await many<CaseRow>(getPool(),
    `SELECT * FROM care_cases WHERE workspace_id=$1 AND ($2::text IS NULL OR state=$2) AND ($3::uuid IS NULL OR brand_id=$3) AND ($4::uuid IS NULL OR owner_id=$4)
      ORDER BY (state = 'resolved'), coalesce(first_response_due_at, resolution_due_at, opened_at) LIMIT $5`,
    [ctx.access.workspaceId, q.state ?? null, q.brand_id ?? null, q.owner === 'me' ? ctx.actor.userId : null, Math.min(Math.max(Number(q.limit) || 50, 1), 200)]);
  return { items: await casesJson(getPool(), rows.filter((r) => brandAllowed(ctx, r.brand_id) && authorizeCtx(ctx, 'inbox.read', { brandId: r.brand_id }).allowed)) };
}

// ------------------------------------------------------------------ SLA policies
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/);
export const slaPolicySchema = z.object({
  id: z.string().uuid().optional(), brand_id: z.string().uuid().nullable().optional(), name: z.string().min(1).max(80),
  timezone: z.string().min(1).max(64), business_hours: z.array(z.object({ day: z.number().int().min(0).max(6), start: hhmm, end: hhmm })).max(21).nullable(),
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(100).default([]),
  first_response_minutes: z.number().int().min(1).max(60 * 24 * 30).nullable(), resolution_minutes: z.number().int().min(1).max(60 * 24 * 90).nullable(),
  count_automated: z.boolean().default(false), is_default: z.boolean().default(true),
}).strict();

export async function listSlaPolicies(ctx: Ctx): Promise<{ items: SlaPolicyDto[]; definitions: Record<string, string> }> {
  requireAction(ctx, 'inbox.read');
  const rows = await many<PolicyRow>(getPool(), `SELECT * FROM care_sla_policies WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY brand_id NULLS FIRST, name`, [ctx.access.workspaceId]);
  return { items: rows.filter((r) => !r.brand_id || brandAllowed(ctx, r.brand_id)).map(policyJson), definitions: SLA_DEFINITIONS };
}

export async function upsertSlaPolicy(ctx: Ctx, input: z.infer<typeof slaPolicySchema>): Promise<SlaPolicyDto> {
  requireAction(ctx, 'inbox.manage', input.brand_id ? { brandId: input.brand_id } : undefined);
  try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }); } catch { throw new AppError('validation_failed', 'Unknown time zone.', { timezone: 'Use an IANA name, e.g. Europe/London.' }); }
  return withTx(async (tx) => {
    if (input.is_default) await tx.query(`UPDATE care_sla_policies SET is_default=false WHERE workspace_id=$1 AND brand_id IS NOT DISTINCT FROM $2 AND is_default AND ($3::uuid IS NULL OR id <> $3)`, [ctx.access.workspaceId, input.brand_id ?? null, input.id ?? null]);
    const args = [ctx.access.workspaceId, input.brand_id ?? null, input.name, input.timezone, input.business_hours ? JSON.stringify(input.business_hours) : null, input.holidays, input.first_response_minutes, input.resolution_minutes, input.count_automated, input.is_default];
    const row = input.id
      ? await maybeOne<PolicyRow>(tx, `UPDATE care_sla_policies SET brand_id=$2, name=$3, timezone=$4, business_hours=$5, holidays=$6, first_response_minutes=$7, resolution_minutes=$8, count_automated=$9, is_default=$10, updated_at=now()
                                       WHERE id=$11 AND workspace_id=$1 AND archived_at IS NULL RETURNING *`, [...args, input.id])
      : await one<PolicyRow>(tx, `INSERT INTO care_sla_policies(workspace_id, brand_id, name, timezone, business_hours, holidays, first_response_minutes, resolution_minutes, count_automated, is_default, created_by)
                                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [...args, ctx.actor.userId]);
    if (!row) throw notFound('Service level policy');
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: input.brand_id ?? null, actorUserId: ctx.actor.userId, action: 'care.sla_policy_saved', resourceType: 'care_sla_policy', resourceId: row.id, correlationId: ctx.correlationId });
    return policyJson(row);
  });
}

// ------------------------------------------------------------------ sweeps + report
/** Worker: record breaches once and escalate to the case owner (notification; Slack in stream C via case.changed). */
export async function sweepSla(limit = 100): Promise<{ breaches: number }> {
  const db = getPool();
  const due = await many<CaseRow & { which: 'first_response' | 'resolution' }>(db,
    `(SELECT *, 'first_response' AS which FROM care_cases WHERE first_responded_at IS NULL AND first_response_breached_at IS NULL AND paused_since IS NULL AND first_response_due_at < now() LIMIT $1)
     UNION ALL
     (SELECT *, 'resolution' AS which FROM care_cases WHERE resolved_at IS NULL AND resolution_breached_at IS NULL AND paused_since IS NULL AND resolution_due_at < now() LIMIT $1)`, [limit]);
  let n = 0;
  for (const c of due) {
    await withTx(async (tx) => {
      const col = c.which === 'first_response' ? 'first_response_breached_at' : 'resolution_breached_at';
      const upd = await tx.query(`UPDATE care_cases SET ${col}=now(), escalated_at=coalesce(escalated_at, now()), updated_at=now() WHERE id=$1 AND ${col} IS NULL`, [c.id]);
      if (!upd.rowCount) return;
      n++;
      await caseEvent(tx, c, c.which === 'first_response' ? 'first_response_breached' : 'resolution_breached', null, { due_at: (c.which === 'first_response' ? c.first_response_due_at : c.resolution_due_at)?.toISOString() });
      await writeOutbox(tx, { workspaceId: c.workspace_id, aggregateType: 'care_case', aggregateId: c.id, eventType: 'case.changed', payload: { change: 'breach', which: c.which } });
      if (c.owner_id) {
        await deliverNotification(tx, {
          workspaceId: c.workspace_id, userId: c.owner_id, event: 'assignment', severity: 'warning', kind: 'case.sla_breached',
          title: `Case #${c.number} missed its ${c.which === 'first_response' ? 'first response' : 'resolution'} target`, referenceType: 'care_case', referenceId: c.id,
          dedupeKey: `case-breach:${c.id}:${c.which}`, requirement: { brandId: c.brand_id, permission: 'inbox.read' }, linkPath: `/inbox?case=${c.id}`,
        });
      }
    });
  }
  return { breaches: n };
}

export async function careReport(ctx: Ctx, q: { days?: number | string | null; brand_id?: string | null } = {}): Promise<CareReport> {
  requireAction(ctx, 'inbox.read', q.brand_id ? { brandId: q.brand_id } : undefined);
  const days = Math.min(Math.max(Math.floor(Number(q.days) || 30), 1), 365);
  const brands = ctx.access.brandIds;
  const rows = await many<CaseRow>(getPool(),
    `SELECT * FROM care_cases WHERE workspace_id=$1 AND opened_at > now() - make_interval(days => $2) AND ($3::uuid IS NULL OR brand_id=$3) AND ($4::uuid[] IS NULL OR brand_id = ANY($4::uuid[]))`,
    [ctx.access.workspaceId, days, q.brand_id ?? null, brands]);
  const visible = rows.filter((r) => authorizeCtx(ctx, 'inbox.read', { brandId: r.brand_id }).allowed);
  const policies = new Map<string, PolicyRow | null>();
  const calFor = async (c: CaseRow) => {
    const key = c.sla_policy_id ?? `default:${c.brand_id}`;
    if (!policies.has(key)) policies.set(key, await policyFor(getPool(), c.workspace_id, c.brand_id, c.sla_policy_id));
    return calendarOf(policies.get(key)!);
  };
  const fr: number[] = [];
  const res: number[] = [];
  for (const c of visible) {
    const cal = await calFor(c);
    if (c.first_responded_at) fr.push(Math.round(businessMsBetween(c.clock_started_at, c.first_responded_at, cal) / 60_000));
    if (c.resolved_at) res.push(Math.max(0, Math.round((businessMsBetween(c.clock_started_at, c.resolved_at, cal) - Number(c.paused_business_ms)) / 60_000)));
  }
  const median = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2); };
  const backlog = await one<{ n: number }>(getPool(),
    `SELECT count(*)::int n FROM care_cases WHERE workspace_id=$1 AND state <> 'resolved' AND ($2::uuid IS NULL OR brand_id=$2) AND ($3::uuid[] IS NULL OR brand_id = ANY($3::uuid[]))`,
    [ctx.access.workspaceId, q.brand_id ?? null, brands]);
  return {
    window_days: days, definitions: { ...SLA_DEFINITIONS, first_response_median: 'Median business minutes from clock start to first provider-confirmed reply, over cases opened in the window that have one.', resolution_median: 'Median business minutes from clock start to resolution, pauses excluded.' },
    cases_opened: visible.length, backlog: backlog.n,
    first_response: { n: fr.length, median_business_minutes: median(fr), breached: visible.filter((c) => c.first_response_breached_at).length },
    resolution: { n: res.length, median_business_minutes: median(res), breached: visible.filter((c) => c.resolution_breached_at).length },
    reopened: visible.filter((c) => c.reopened_count > 0).length,
  };
}
