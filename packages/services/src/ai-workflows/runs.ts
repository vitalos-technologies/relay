// V5 workflow runs: request, read (incremental events), cancel, retry, answer. Requests only QUEUE a run (outbox →
// 'ai-assist' queue, ai_assist workload class); the worker executes it (engine.ts). Pages poll GET with ?after=<seq>.
import { z } from 'zod';
import { AppError, notFound } from '@social-lite/core';
import {
  AI_WORKFLOWS, RUN_DEADLINE_MINUTES, WORKFLOW_FEATURE, WORKFLOW_LABEL, type AiWorkflow, type ResultActionDto, type ResultCardDto, type RunEventDto, type RunInputSummary,
  type ThreadDetailDto, type ThreadDto, type ThreadPageDto, type WorkflowRunDto, type WorkflowStatus, type WorkflowStepDto,
} from '@social-lite/core/contracts/v5-ai';
import type { ProposedActionDto } from '@social-lite/core/contracts/v35-ai';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { writeOutbox } from '../outbox.js';
import { enforceRateLimit } from '../ratelimit.js';
import { assertBrand, assertUuid, brandAllowed, requireAction } from '../tenancy.js';
import { assertPaidAction } from '../entitlements/actions.js';
import { assistantConfigured, NOT_CONFIGURED_MESSAGE } from '../assistant/client.js';
import { actionDto } from '../assistant/runs.js';
import { loadConversation } from '../inbox/shared.js';
import { emitEvent, workflowDef, type StepRow, type WfRunRow } from './engine.js';
import { sourceTitle, type SourceRef } from './sources.js';
import { adaptationInputSchema, campaignInputSchema } from './workflows/drafting.js';
import { askInputSchema, inboxInputSchema, performanceInputSchema } from './workflows/insight.js';
import { weeklyInputSchema } from './workflows/planning.js';

export const INPUT_SCHEMAS: Record<AiWorkflow, z.ZodType<Record<string, unknown>>> = {
  campaign_from_brief: campaignInputSchema, content_adaptation: adaptationInputSchema, inbox_assistance: inboxInputSchema,
  performance_analysis: performanceInputSchema, weekly_planning: weeklyInputSchema, ask: askInputSchema,
} as never;

export const workflowRequestSchema = z.object({
  workflow: z.enum(AI_WORKFLOWS),
  thread_id: z.string().uuid().nullish(),
  prompt: z.string().trim().max(2000).nullish(),
  inputs: z.record(z.string(), z.unknown()),
  idempotency_key: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
}).strict();

const TERMINAL: readonly WorkflowStatus[] = ['completed', 'partially_completed', 'failed', 'cancelled'];

// ------------------------------------------------------------------ DTOs
interface ResultRow { id: string; step_key: string; item_key: string; kind: ResultCardDto['kind']; title: string; body: string | null; data: Record<string, unknown>; record_type: string | null; record_id: string | null; generated: boolean; created_at: Date }
interface EventRow { seq: number; created_at: Date; level: RunEventDto['level']; message: string; step_key: string | null }

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

function recordLink(type: string | null, id: string | null, data: Record<string, unknown>): string | null {
  if (type === 'post' && id) return `/posts/${id}`;
  if (type === 'campaign' && id) return `/campaigns?campaign=${id}`;
  if (type === 'conversation' && id) return `/inbox?c=${id}`;
  if (type === 'task' && id) return `/tasks?task=${id}`;
  if (type === 'analytics') return typeof data.link === 'string' ? data.link : '/analytics';
  return null;
}

function cardActions(r: ResultRow, actions: ProposedActionDto[]): ResultActionDto[] {
  const link = recordLink(r.record_type, r.record_id, r.data);
  const mine = actions.filter((a) => a.preview.params.result_item === `${r.step_key}:${r.item_key}` && a.status === 'proposed');
  const out: ResultActionDto[] = [];
  const by = (k: ProposedActionDto['kind']) => mine.find((a) => a.kind === k);
  switch (r.kind) {
    case 'post_draft': case 'variant':
      if (link) out.push({ kind: 'open', label: 'Open draft', href: link });
      if (r.record_id && r.body !== null) out.push({ kind: 'edit', label: 'Edit' });
      if (r.kind === 'variant' && r.data.compare_with) out.push({ kind: 'compare_versions', label: 'Compare versions' });
      if (by('submit_for_approval')) out.push({ kind: 'submit_for_approval', label: 'Submit for approval', action_id: by('submit_for_approval')!.id });
      break;
    case 'schedule_plan':
      if (by('schedule_post')) out.push({ kind: 'review_schedule', label: 'Review schedule', action_id: by('schedule_post')!.id });
      if (link) out.push({ kind: 'open', label: 'Open draft', href: link });
      break;
    case 'reply_draft':
      if (by('send_reply')) out.push({ kind: 'review_reply', label: 'Review reply', action_id: by('send_reply')!.id });
      if (link) out.push({ kind: 'open_conversation', label: 'Open conversation', href: link });
      break;
    case 'summary':
      if (r.record_type === 'conversation' && link) out.push({ kind: 'open_conversation', label: 'Open conversation', href: link });
      for (const a of mine.filter((x) => x.kind === 'create_task')) out.push({ kind: 'create_task', label: `Create task: ${a.preview.detail}`.slice(0, 120), action_id: a.id });
      break;
    case 'report':
      if (link) out.push({ kind: 'view_report', label: 'View report', href: link });
      break;
    case 'campaign': case 'task':
      if (link) out.push({ kind: 'open', label: r.kind === 'campaign' ? 'Open campaign' : 'Open task', href: link });
      break;
    default: break;
  }
  return out;
}

export function resultDto(r: ResultRow, actions: ProposedActionDto[]): ResultCardDto {
  const link = recordLink(r.record_type, r.record_id, r.data);
  const cw = r.data.compare_with as { title?: string; text?: string } | undefined;
  return {
    id: r.id, step: r.step_key, kind: r.kind, title: r.title, body: r.body, generated: r.generated,
    facts: arr<{ label: string; value: string }>(r.data.facts).map((f) => ({ label: String(f.label), value: String(f.value) })),
    evidence: arr<{ text: string; source?: string | null; verified?: boolean }>(r.data.evidence).map((e) => ({ text: String(e.text), source: e.source ?? null })),
    issues: [...arr<{ severity: 'block' | 'warn'; message: string }>(r.data.issues), ...(typeof r.data.uncertainty === 'string' && r.data.uncertainty ? [{ severity: 'warn' as const, message: r.data.uncertainty }] : [])],
    compare_with: cw?.text ? { title: String(cw.title ?? 'Original'), text: cw.text } : null,
    record: r.record_type && link ? { type: r.record_type as never, id: r.record_id, link } : null,
    actions: cardActions(r, actions),
    created_at: r.created_at.toISOString(),
  };
}

async function runDto(db: Queryable, r: WfRunRow, after: number | null): Promise<WorkflowRunDto> {
  const [steps, events, results, actions] = await Promise.all([
    many<StepRow>(db, `SELECT * FROM ai_run_steps WHERE run_id=$1 ORDER BY seq`, [r.id]),
    after === null
      ? many<EventRow>(db, `SELECT * FROM (SELECT seq, created_at, level, message, step_key FROM ai_run_events WHERE run_id=$1 ORDER BY seq DESC LIMIT 200) e ORDER BY seq`, [r.id])
      : many<EventRow>(db, `SELECT seq, created_at, level, message, step_key FROM ai_run_events WHERE run_id=$1 AND seq > $2 ORDER BY seq LIMIT 200`, [r.id, after]),
    many<ResultRow>(db, `SELECT * FROM ai_run_results WHERE run_id=$1 ORDER BY created_at, id`, [r.id]),
    many<Parameters<typeof actionDto>[0]>(db, `SELECT * FROM ai_proposed_actions WHERE run_id=$1 ORDER BY created_at`, [r.id]),
  ]);
  const acts = actions.map(actionDto);
  const summary = (r.params.summary ?? {}) as Partial<RunInputSummary>;
  return {
    id: r.id, thread_id: r.thread_id, workflow: r.task, title: r.title ?? WORKFLOW_LABEL[r.task], brand_id: r.brand_id, status: r.status, outcome_code: r.outcome_code, status_detail: r.status_detail,
    input: { prompt: typeof r.params.request === 'string' ? r.params.request : null, sources: summary.sources ?? [], attachments: summary.attachments ?? [], knowledge: summary.knowledge ?? [] },
    steps: steps.map((x): WorkflowStepDto => ({ key: x.key, label: x.label, kind: x.kind, status: x.status, detail: x.detail, attempts: x.attempts, started_at: x.started_at?.toISOString() ?? null, finished_at: x.finished_at?.toISOString() ?? null })),
    events: events.map((e) => ({ seq: e.seq, at: e.created_at.toISOString(), level: e.level, message: e.message, step: e.step_key })),
    last_event_seq: r.last_event_seq,
    results: results.map((x) => resultDto(x, acts)),
    actions: acts,
    pending_input: r.status === 'needs_input' ? r.pending_input : null,
    usage: r.input_tokens || r.output_tokens ? { input_tokens: r.input_tokens, output_tokens: r.output_tokens } : null,
    cancel_requested: !!r.cancel_requested_at,
    can_cancel: ['preparing', 'working', 'needs_input', 'needs_review'].includes(r.status) && !r.cancel_requested_at,
    can_retry: (r.status === 'failed' || r.status === 'partially_completed' || r.status === 'cancelled') && r.outcome_code !== 'blocked' && r.outcome_code !== 'entitlement',
    created_at: r.created_at.toISOString(), started_at: r.started_at?.toISOString() ?? null, finished_at: r.finished_at?.toISOString() ?? null, deadline_at: r.deadline_at?.toISOString() ?? null,
  };
}

async function loadRun(ctx: Ctx, id: string, db: Queryable = getPool(), lock = false): Promise<WfRunRow> {
  assertUuid(id, 'Run');
  const r = await maybeOne<WfRunRow>(db, `SELECT * FROM ai_runs WHERE id=$1 AND workspace_id=$2 AND kind='workflow'${lock ? ' FOR UPDATE' : ''}`, [id, ctx.access.workspaceId]);
  // Private to the person who asked, and only while they can still see the brand.
  if (!r || r.requested_by !== ctx.actor.userId || !brandAllowed(ctx, r.brand_id)) throw notFound('Run');
  return r;
}

// ------------------------------------------------------------------ request
async function summarize(ctx: Ctx, brandId: string, w: AiWorkflow, input: Record<string, unknown>, db: Queryable): Promise<{ summary: RunInputSummary; title: string }> {
  const sources: RunInputSummary['sources'] = [];
  if (input.source) {
    const ref = input.source as SourceRef;
    sources.push({ kind: ref.kind, id: ref.id, title: await sourceTitle(ctx, brandId, ref, db) });
  }
  for (const id of (input.conversation_ids as string[] | undefined) ?? []) {
    const c = await loadConversation(ctx, id, 'inbox.read', db);
    if (c.brand_id !== brandId) throw notFound('Conversation');
    sources.push({ kind: 'conversation', id, title: c.subject || c.preview?.slice(0, 60) || 'Conversation' });
  }
  const attachments = [];
  for (const id of (input.attachment_ids as string[] | undefined) ?? []) attachments.push({ id, filename: await sourceTitle(ctx, brandId, { kind: 'attachment', id }, db) });
  const knowledge = [];
  for (const id of (input.knowledge_ids as string[] | undefined) ?? []) knowledge.push({ id, title: await sourceTitle(ctx, brandId, { kind: 'knowledge', id }, db) });
  const first = sources[0]?.title;
  const title = w === 'campaign_from_brief' ? `Campaign from “${first}”`
    : w === 'content_adaptation' ? `Versions of “${first}”`
    : w === 'inbox_assistance' ? `Replies for ${sources.length} conversation${sources.length === 1 ? '' : 's'}`
    : w === 'performance_analysis' ? `Performance · last ${Number(input.range_days)} days`
    : w === 'weekly_planning' ? `Week of ${new Date(`${String(input.week_start)}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}`
    : 'Question';
  return { summary: { prompt: null, sources, attachments, knowledge }, title: title.slice(0, 200) };
}

export async function createWorkflowRun(ctx: Ctx, raw: unknown): Promise<WorkflowRunDto> {
  const req = workflowRequestSchema.parse(raw);
  const db = getPool();
  const prior = await maybeOne<WfRunRow>(db, `SELECT * FROM ai_runs WHERE workspace_id=$1 AND idempotency_key=$2`, [ctx.access.workspaceId, req.idempotency_key]);
  if (prior) {
    if (prior.requested_by !== ctx.actor.userId || prior.kind !== 'workflow') throw new AppError('idempotency_conflict', 'This request key was already used.');
    return runDto(db, prior, null);
  }
  const parsed = INPUT_SCHEMAS[req.workflow].safeParse(req.inputs);
  if (!parsed.success) throw new AppError('validation_failed', 'Some details of this task are missing or invalid.', Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.') || 'inputs', i.message])));
  const input = parsed.data;
  const brandId = String(input.brand_id);
  const brand = await assertBrand(ctx, brandId, db);
  if (brand.archived_at) throw new AppError('invalid_state', 'This brand is archived.');
  requireAction(ctx, 'ai.use', { brandId });
  await assertPaidAction(db, ctx.access.workspaceId, WORKFLOW_FEATURE[req.workflow]);
  if (req.workflow === 'ask') {
    if (!req.prompt?.trim()) throw new AppError('validation_failed', 'Write a question or task first.', { prompt: 'Required' });
    if (!(await assistantConfigured(db))) throw new AppError('provider_not_configured', NOT_CONFIGURED_MESSAGE);
  }
  await enforceRateLimit('assistantWorkflow', ctx.actor.userId, { capacity: 10, refillPerSecond: 10 / 600 }); // 10 burst, 10 per 10 min
  const { summary, title: autoTitle } = await summarize(ctx, brandId, req.workflow, input, db);
  const title = req.workflow === 'ask' ? (req.prompt ?? '').replace(/\s+/g, ' ').slice(0, 80) : autoTitle;
  const def = workflowDef(req.workflow);
  const row = await withTx(async (tx) => {
    let threadId = req.thread_id ?? null;
    if (threadId) {
      const t = await maybeOne<{ id: string; brand_id: string }>(tx, `SELECT id, brand_id FROM ai_threads WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND archived_at IS NULL`, [threadId, ctx.access.workspaceId, ctx.actor.userId]);
      if (!t) throw notFound('Conversation');
      if (t.brand_id !== brandId) threadId = null; // a different brand starts a new conversation
      else await tx.query(`UPDATE ai_threads SET updated_at=now() WHERE id=$1`, [threadId]);
    }
    if (!threadId) threadId = (await one<{ id: string }>(tx, `INSERT INTO ai_threads(workspace_id, user_id, brand_id, title) VALUES ($1,$2,$3,$4) RETURNING id`, [ctx.access.workspaceId, ctx.actor.userId, brandId, title || 'New task'])).id;
    const r = await maybeOne<WfRunRow>(tx,
      `INSERT INTO ai_runs(workspace_id, brand_id, surface, task, context, params, requested_by, idempotency_key, kind, thread_id, title, status, deadline_at)
       VALUES ($1,$2,'workspace',$3,$4,$5,$6,$7,'workflow',$8,$9,'preparing', now() + make_interval(mins => $10))
       ON CONFLICT (workspace_id, idempotency_key) DO NOTHING RETURNING *`,
      [ctx.access.workspaceId, brandId, req.workflow, JSON.stringify({ type: 'brand', id: brandId }), JSON.stringify({ request: req.prompt?.trim() || null, input, summary }),
        ctx.actor.userId, req.idempotency_key, threadId, title || WORKFLOW_LABEL[req.workflow], RUN_DEADLINE_MINUTES]);
    if (!r) throw new AppError('idempotency_conflict', 'This request key was already used.');
    let seq = 1;
    for (const st of def.steps(input)) {
      await tx.query(`INSERT INTO ai_run_steps(workspace_id, run_id, seq, key, kind, label) VALUES ($1,$2,$3,$4,$5,$6)`, [ctx.access.workspaceId, r.id, seq++, st.key, st.kind, st.label]);
    }
    await emitEvent(tx, r.id, ctx.access.workspaceId, 'Queued.');
    await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'ai_run', aggregateId: r.id, eventType: 'ai.run_requested', payload: { task: req.workflow } });
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId, actorUserId: ctx.actor.userId, action: 'ai.workflow_requested', resourceType: 'ai_run', resourceId: r.id,
      diff: { workflow: req.workflow, sources: summary.sources.length, attachments: summary.attachments.length, knowledge: summary.knowledge.length }, correlationId: ctx.correlationId });
    return one<WfRunRow>(tx, `SELECT * FROM ai_runs WHERE id=$1`, [r.id]);
  });
  return runDto(db, row, null);
}

export async function getWorkflowRun(ctx: Ctx, id: string, q: { after?: string | number | null } = {}): Promise<WorkflowRunDto> {
  const r = await loadRun(ctx, id);
  const after = q.after === undefined || q.after === null || q.after === '' ? null : Math.max(0, Number(q.after) || 0);
  return runDto(getPool(), r, after);
}

// ------------------------------------------------------------------ control
/** Stop a run. Undispatched work never starts; finished work is kept and explained. Nothing is published or sent. */
export async function cancelWorkflowRun(ctx: Ctx, id: string): Promise<WorkflowRunDto> {
  const db = getPool();
  await withTx(async (tx) => {
    const r = await loadRun(ctx, id, tx, true);
    if (TERMINAL.includes(r.status)) throw new AppError('invalid_state', 'This run has already finished.');
    if (r.cancel_requested_at) return;
    await tx.query(`UPDATE ai_runs SET cancel_requested_at=now(), cancel_requested_by=$2 WHERE id=$1`, [r.id, ctx.actor.userId]);
    await audit(tx, { workspaceId: r.workspace_id, brandId: r.brand_id, actorUserId: ctx.actor.userId, action: 'ai.workflow_cancel_requested', resourceType: 'ai_run', resourceId: r.id, correlationId: ctx.correlationId });
    if (r.status === 'working') await emitEvent(tx, r.id, r.workspace_id, 'Stopping after the current step. Nothing new will start.', 'warn');
  });
  const r = await loadRun(ctx, id);
  // Not running in a worker right now ⇒ finalize immediately (a running worker finalizes at its next checkpoint).
  if (r.status === 'preparing' || r.status === 'needs_input' || r.status === 'needs_review') {
    const { finalize } = await import('./engine.js');
    const claimed = await db.query(`UPDATE ai_runs SET lease_owner='cancel', lease_expires_at=now() + interval '1 minute' WHERE id=$1 AND status IN ('preparing','needs_input','needs_review')`, [r.id]);
    if (claimed.rowCount) await finalize(r, { cancelled: true });
  }
  return getWorkflowRun(ctx, id);
}

/** Retry a failed / partial / cancelled run: completed writes and model steps are kept and never repeated. */
export async function retryWorkflowRun(ctx: Ctx, id: string): Promise<WorkflowRunDto> {
  await withTx(async (tx) => {
    const r = await loadRun(ctx, id, tx, true);
    if (!(r.status === 'failed' || r.status === 'partially_completed' || r.status === 'cancelled')) throw new AppError('invalid_state', 'Only a stopped or failed run can be retried.');
    if (r.outcome_code === 'blocked' || r.outcome_code === 'entitlement') throw new AppError('invalid_state', 'This run was stopped by access or plan rules. Start a new one when they allow it.');
    requireAction(ctx, 'ai.use', { brandId: r.brand_id });
    await assertPaidAction(tx, ctx.access.workspaceId, WORKFLOW_FEATURE[r.task]);
    await tx.query(`UPDATE ai_run_steps SET status='pending', detail=NULL WHERE run_id=$1 AND status <> 'succeeded'`, [r.id]);
    await tx.query(`UPDATE ai_runs SET status='preparing', outcome_code=NULL, status_detail=NULL, pending_input=NULL, cancel_requested_at=NULL, cancel_requested_by=NULL, attempts=0,
                           finished_at=NULL, deadline_at=now() + make_interval(mins => $2), lease_owner=NULL, lease_expires_at=NULL WHERE id=$1`, [r.id, RUN_DEADLINE_MINUTES]);
    await emitEvent(tx, r.id, r.workspace_id, 'Retrying. Completed steps are kept and will not run again.');
    await writeOutbox(tx, { workspaceId: r.workspace_id, aggregateType: 'ai_run', aggregateId: r.id, eventType: 'ai.run_requested', payload: { task: r.task, retry: true } });
    await audit(tx, { workspaceId: r.workspace_id, brandId: r.brand_id, actorUserId: ctx.actor.userId, action: 'ai.workflow_retried', resourceType: 'ai_run', resourceId: r.id, correlationId: ctx.correlationId });
  });
  return getWorkflowRun(ctx, id);
}

export const answerSchema = z.object({ field: z.string().min(1).max(60), value: z.union([z.string().max(200), z.array(z.string().max(200)).max(20)]) }).strict();

/** Answer a needs_input question with one of the options Relay offered; the run resumes in the worker. */
export async function answerWorkflowRun(ctx: Ctx, id: string, raw: unknown): Promise<WorkflowRunDto> {
  const a = answerSchema.parse(raw);
  await withTx(async (tx) => {
    const r = await loadRun(ctx, id, tx, true);
    if (r.status !== 'needs_input' || !r.pending_input) throw new AppError('invalid_state', 'This run is not waiting for an answer.');
    if (a.field !== r.pending_input.field) throw new AppError('validation_failed', 'Answer the question shown.', { field: 'Unexpected' });
    const allowed = new Set(r.pending_input.options.map((o) => o.value));
    const values = Array.isArray(a.value) ? a.value : [a.value];
    if (!values.length || values.some((v) => !allowed.has(v))) throw new AppError('validation_failed', 'Choose one of the options shown.', { value: 'Not an option' });
    const value = r.pending_input.kind === 'choose_many' ? values : values[0];
    const input = { ...(r.params.input ?? {}), [a.field]: value };
    const parsed = INPUT_SCHEMAS[r.task].safeParse(input);
    if (!parsed.success) throw new AppError('validation_failed', 'That answer does not fit this task.');
    await tx.query(`UPDATE ai_runs SET params = jsonb_set(params, '{input}', $2::jsonb), status='preparing', pending_input=NULL, status_detail=NULL WHERE id=$1`, [r.id, JSON.stringify(parsed.data)]);
    await emitEvent(tx, r.id, r.workspace_id, 'Thanks — continuing.');
    await writeOutbox(tx, { workspaceId: r.workspace_id, aggregateType: 'ai_run', aggregateId: r.id, eventType: 'ai.run_requested', payload: { task: r.task, answered: a.field } });
  });
  return getWorkflowRun(ctx, id);
}

// ------------------------------------------------------------------ threads (history sidebar)
interface ThreadRow { id: string; title: string; brand_id: string; brand_name: string; created_at: Date; updated_at: Date; workflow: AiWorkflow | null; last_status: WorkflowStatus | null; run_count: number }

const threadDto = (t: ThreadRow): ThreadDto => ({ id: t.id, title: t.title, brand_id: t.brand_id, brand_name: t.brand_name, workflow: t.workflow, last_status: t.last_status, run_count: t.run_count,
  created_at: t.created_at.toISOString(), updated_at: t.updated_at.toISOString() });

const THREAD_SELECT = `SELECT t.id, t.title, t.brand_id, b.name AS brand_name, t.created_at, t.updated_at,
    (SELECT r.task FROM ai_runs r WHERE r.thread_id=t.id ORDER BY r.created_at DESC LIMIT 1) AS workflow,
    (SELECT r.status FROM ai_runs r WHERE r.thread_id=t.id ORDER BY r.created_at DESC LIMIT 1) AS last_status,
    (SELECT count(*)::int FROM ai_runs r WHERE r.thread_id=t.id) AS run_count
  FROM ai_threads t JOIN brands b ON b.id=t.brand_id`;

/** My conversations, newest first, keyset-paginated (incremental loading). Brands I can no longer see are hidden. */
export async function listThreads(ctx: Ctx, q: { cursor?: string | null; limit?: number | string | null; q?: string | null } = {}): Promise<ThreadPageDto> {
  const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 50);
  const params: unknown[] = [ctx.access.workspaceId, ctx.actor.userId, limit + 1];
  let where = `t.workspace_id=$1 AND t.user_id=$2 AND t.archived_at IS NULL`;
  if (ctx.access.brandIds !== null) { params.push(ctx.access.brandIds); where += ` AND t.brand_id = ANY($${params.length}::uuid[])`; }
  if (q.cursor) {
    const [ts, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
    if (!ts || !id || Number.isNaN(Date.parse(ts))) throw new AppError('validation_failed', 'Invalid cursor');
    assertUuid(id, 'Cursor');
    params.push(ts, id); where += ` AND (t.updated_at, t.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  if (q.q?.trim()) { params.push(`%${q.q.trim().slice(0, 80).replace(/[%_\\]/g, '\\$&')}%`); where += ` AND t.title ILIKE $${params.length}`; }
  const rows = await many<ThreadRow>(getPool(), `${THREAD_SELECT} WHERE ${where} ORDER BY t.updated_at DESC, t.id DESC LIMIT $3`, params);
  const visible = rows.filter((t) => brandAllowed(ctx, t.brand_id));
  const page = visible.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page.map(threadDto), next_cursor: rows.length > limit && last ? Buffer.from(`${last.updated_at.toISOString()}|${last.id}`).toString('base64url') : null };
}

export async function getThread(ctx: Ctx, id: string): Promise<ThreadDetailDto> {
  assertUuid(id, 'Conversation');
  const t = await maybeOne<ThreadRow>(getPool(), `${THREAD_SELECT} WHERE t.id=$1 AND t.workspace_id=$2 AND t.user_id=$3 AND t.archived_at IS NULL`, [id, ctx.access.workspaceId, ctx.actor.userId]);
  if (!t || !brandAllowed(ctx, t.brand_id)) throw notFound('Conversation');
  const runs = await many<WfRunRow>(getPool(), `SELECT * FROM ai_runs WHERE thread_id=$1 AND kind='workflow' ORDER BY created_at DESC LIMIT 20`, [id]);
  const dtos = [];
  for (const r of runs.reverse()) dtos.push(await runDto(getPool(), r, null));
  return { ...threadDto(t), runs: dtos };
}

export const threadPatchSchema = z.object({ title: z.string().trim().min(1).max(200).optional(), archived: z.boolean().optional() }).strict();

export async function updateThread(ctx: Ctx, id: string, raw: unknown): Promise<ThreadDto | { archived: true }> {
  const p = threadPatchSchema.parse(raw);
  assertUuid(id, 'Conversation');
  const t = await maybeOne<{ id: string }>(getPool(), `SELECT id FROM ai_threads WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND archived_at IS NULL`, [id, ctx.access.workspaceId, ctx.actor.userId]);
  if (!t) throw notFound('Conversation');
  if (p.archived) {
    const active = await maybeOne(getPool(), `SELECT 1 FROM ai_runs WHERE thread_id=$1 AND status IN ('preparing','working')`, [id]);
    if (active) throw new AppError('invalid_state', 'Stop the running task before removing this conversation.');
    await getPool().query(`UPDATE ai_threads SET archived_at=now() WHERE id=$1`, [id]);
    return { archived: true };
  }
  if (p.title) await getPool().query(`UPDATE ai_threads SET title=$2 WHERE id=$1`, [id, p.title]);
  const row = await one<ThreadRow>(getPool(), `${THREAD_SELECT} WHERE t.id=$1`, [id]);
  return threadDto(row);
}
