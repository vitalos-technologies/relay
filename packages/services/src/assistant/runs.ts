// Assistant runs (brief §16–17). A run is requested by a person (ai.use + the context's own read permission), queued
// on the 'ai-assist' queue (bulk pool, ai_assist class — pages never wait for generation), and executed by the worker:
//   lease → re-load the requester's CURRENT access (revocation ⇒ blocked) → scoped retrieval → budget reservation →
//   model call (no tools) → deterministic checks (evidence verified verbatim, links/numbers grounded, commitments need
//   a current approved source) → proposed actions built by Relay from Relay's own context → access re-check → persist.
// Recorded per run: provider, model, latency, token usage + cost estimate, source references and an action trace.
// Prompts and message bodies are never logged; run output is kept 30 days for the requester, then purged.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, notFound } from '@social-lite/core';
import {
  ASSISTANT_SURFACES, ASSISTANT_TASKS, PROPOSED_ACTION_KINDS, SURFACE_TASKS, type AssistantContextRef, type AssistantOutputDto, type AssistantRunDto,
  type AssistantStatusDto, type AssistantTask, type EvidenceItem, type ProposedActionDto, type ProposedActionKind, type SourceRefDto, type SuggestionItem,
} from '@social-lite/core/contracts/v35-ai';
import { PRIORITIES } from '@social-lite/core/contracts/v35-inbox';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { writeOutbox } from '../outbox.js';
import { canAnywhere } from '../access.js';
import { enforceRateLimit } from '../ratelimit.js';
import { assertUuid, authorizeCtx, loadAccess, requireAction } from '../tenancy.js';
import { AI_METER, costEstimateUsd, readUsage, reserveTokens } from '../ai/usage.js';
import { readMeterUsage, releaseUsage, settleUsage } from '../product/budgets.js';
import { NOT_CONFIGURED_MESSAGE, assistantConfigured, resolveAssistantClient, type AssistantModelOutput } from './client.js';
import { checkOutput, countInjections, verifyQuote } from './guard.js';
import { ASSISTANT_SYSTEM_PROMPT, buildAssistantPrompt } from './prompt.js';
import { assertPaidAction } from '../entitlements/actions.js';
import { contextBrand, retrieve, type RetrievedSource } from './retrieval.js';

export const ASSISTANT_MAX_OUTPUT_TOKENS = 8_000;
const LEASE_MS = 3 * 60_000;
const OUTPUT_RETENTION_DAYS = 30;

const contextSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('conversation'), id: z.string().uuid() }).strict(),
  z.object({ type: z.literal('post'), id: z.string().uuid() }).strict(),
  z.object({ type: z.literal('brand'), id: z.string().uuid() }).strict(),
  z.object({ type: z.literal('analytics'), brand_id: z.string().uuid(), range_days: z.number().int().min(7).max(90) }).strict(),
  z.object({ type: z.literal('listening_query'), id: z.string().uuid() }).strict(),
]);

export const runRequestSchema = z.object({
  surface: z.enum(ASSISTANT_SURFACES),
  task: z.enum(ASSISTANT_TASKS),
  context: contextSchema,
  prompt: z.string().trim().max(2000).nullish(),
  target_language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/).nullish(),
  idempotency_key: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
}).strict();
export type RunRequest = z.infer<typeof runRequestSchema>;

/** Which contexts a task accepts. */
const TASK_CONTEXTS: Record<AssistantTask, ReadonlyArray<AssistantContextRef['type']>> = {
  draft_copy: ['post', 'brand'], summarize_conversation: ['conversation'], suggest_reply: ['conversation'], suggest_triage: ['conversation'],
  translate: ['conversation', 'post'], explain_analytics: ['analytics'], summarize_listening: ['listening_query'], campaign_brief: ['brand', 'post'],
  insight_to_draft: ['analytics', 'listening_query'], answer_question: ['brand', 'conversation', 'post', 'analytics', 'listening_query'],
};

/** Proposed actions the model may suggest per task (Relay builds the actual action from its own context). */
const TASK_ACTIONS: Record<AssistantTask | 'auto_reply', readonly ProposedActionKind[]> = {
  draft_copy: ['use_copy'], summarize_conversation: ['add_note'], suggest_reply: ['use_reply_draft'], suggest_triage: ['apply_labels', 'set_priority'],
  translate: [], explain_analytics: ['create_task'], summarize_listening: ['create_task'], campaign_brief: ['create_task'], insight_to_draft: ['create_task', 'use_copy'],
  answer_question: [], auto_reply: [],
};

const ACTION_PERMISSION: Record<ProposedActionKind, string> = {
  use_reply_draft: 'inbox.reply', apply_labels: 'inbox.reply', set_priority: 'inbox.reply', assign: 'inbox.assign', add_note: 'inbox.read', use_copy: 'content.edit', create_task: 'content.read',
  schedule_post: 'content.schedule', submit_for_approval: 'content.edit', send_reply: 'inbox.reply',
};

// ------------------------------------------------------------------ automation bridge (no import cycle)
export interface AutomationAiBridge {
  /** Service-actor context for a policy-driven run (throws AppError when the policy no longer allows it). */
  contextFor(run: RunRow): Promise<{ ctx: Ctx; knowledgeIds: string[] }>;
  /** Called after a policy-driven run settles (any status). */
  onFinished(runId: string): Promise<void>;
}
let bridge: AutomationAiBridge | null = null;
export function registerAutomationAiBridge(b: AutomationAiBridge | null): void { bridge = b; }

// ------------------------------------------------------------------ rows + DTOs
export interface RunRow {
  id: string; workspace_id: string; brand_id: string; surface: string; task: AssistantTask | 'auto_reply'; context: AssistantContextRef; params: Record<string, unknown>;
  status: AssistantRunDto['status']; status_detail: string | null; requested_by: string | null; automation_run_id: string | null; idempotency_key: string;
  output: AssistantOutputDto | null; sources: SourceRefDto[]; trace: unknown[]; provider: string | null; model: string | null; input_tokens: number; output_tokens: number;
  cost_estimate_usd: string; latency_ms: number | null; attempts: number; created_at: Date; started_at: Date | null; finished_at: Date | null;
}
interface ActionRow { id: string; run_id: string; brand_id: string; kind: ProposedActionKind; target_type: 'conversation' | 'post' | 'brand'; target_id: string; preview: ProposedActionDto['preview']; requires: string; status: ProposedActionDto['status']; decided_at: Date | null; error: string | null; expires_at: Date }

export function actionDto(a: ActionRow): ProposedActionDto {
  const expired = a.status === 'proposed' && a.expires_at.getTime() < Date.now();
  return { id: a.id, run_id: a.run_id, kind: a.kind, target: { type: a.target_type, id: a.target_id }, preview: a.preview, requires: a.requires, status: expired ? 'expired' : a.status,
    decided_at: a.decided_at?.toISOString() ?? null, error: a.error, expires_at: a.expires_at.toISOString() };
}

async function runDto(db: Queryable, r: RunRow): Promise<AssistantRunDto> {
  const actions = await many<ActionRow>(db, `SELECT * FROM ai_proposed_actions WHERE run_id=$1 ORDER BY created_at`, [r.id]);
  const who = r.requested_by ? await maybeOne<{ id: string; name: string | null; email: string }>(db, `SELECT id, name, email FROM users WHERE id=$1`, [r.requested_by]) : null;
  return {
    id: r.id, surface: r.surface as AssistantRunDto['surface'], task: (r.task === 'auto_reply' ? 'suggest_reply' : r.task), context: r.context, brand_id: r.brand_id,
    status: r.status, status_detail: r.status_detail, output: r.output, sources: r.sources, actions: actions.map(actionDto),
    usage: r.status === 'succeeded' || r.input_tokens ? { input_tokens: r.input_tokens, output_tokens: r.output_tokens, cost_estimate_usd: Number(r.cost_estimate_usd) } : null,
    provider: r.provider, model: r.model, latency_ms: r.latency_ms, requested_by: who ? { id: who.id, name: who.name ?? who.email } : null, automated: !!r.automation_run_id,
    created_at: r.created_at.toISOString(), finished_at: r.finished_at?.toISOString() ?? null,
  };
}

// ------------------------------------------------------------------ status
export async function assistantStatus(ctx: Ctx, db: Queryable = getPool()): Promise<AssistantStatusDto> {
  const configured = await assistantConfigured(db);
  const u = await readUsage(ctx.access.workspaceId, db);
  return {
    configured, reason: configured ? null : NOT_CONFIGURED_MESSAGE, provider: configured ? 'anthropic' : null,
    can_use: configured && canAnywhere(ctx, 'ai.use') && u.remaining > 0, period: u.period, used: u.used, cap: u.cap, remaining: u.remaining,
  };
}

// ------------------------------------------------------------------ request
export async function createRun(ctx: Ctx, raw: unknown): Promise<AssistantRunDto> {
  const input = runRequestSchema.parse(raw);
  if (!(SURFACE_TASKS[input.surface] as readonly string[]).includes(input.task)) throw new AppError('validation_failed', 'This task is not available here.', { task: 'Not available on this surface' });
  if (!TASK_CONTEXTS[input.task].includes(input.context.type)) throw new AppError('validation_failed', 'This task does not apply to that item.', { context: 'Wrong context for this task' });
  if (input.task === 'translate' && !input.target_language) throw new AppError('validation_failed', 'Choose a target language.', { target_language: 'Required' });
  if ((input.task === 'answer_question' || input.task === 'campaign_brief') && !input.prompt?.trim()) throw new AppError('validation_failed', 'Write a question or brief first.', { prompt: 'Required' });
  const db = getPool();
  const prior = await maybeOne<RunRow>(db, `SELECT * FROM ai_runs WHERE workspace_id=$1 AND idempotency_key=$2`, [ctx.access.workspaceId, input.idempotency_key]);
  if (prior) {
    if (prior.requested_by !== ctx.actor.userId) throw new AppError('idempotency_conflict', 'This request key was already used.');
    return runDto(db, prior);
  }
  const brandId = await contextBrand(ctx, input.context, db);
  requireAction(ctx, 'ai.use', { brandId });
  await assertPaidAction(db, ctx.access.workspaceId, 'ai_drafting'); // V4 entitlements (re-checked by the reservation at run time)
  if (!(await assistantConfigured(db))) throw new AppError('provider_not_configured', NOT_CONFIGURED_MESSAGE);
  await enforceRateLimit('assistantRun', ctx.actor.userId, { capacity: 20, refillPerSecond: 20 / 600 }); // 20 burst, 20 per 10 min
  const usage = await readUsage(ctx.access.workspaceId, db);
  if (usage.remaining < ASSISTANT_MAX_OUTPUT_TOKENS) throw new AppError('budget_exhausted', 'The monthly AI budget is used up. An owner can raise it in Settings.');
  const row = await withTx(async (tx) => {
    const r = await one<RunRow>(tx,
      `INSERT INTO ai_runs(workspace_id, brand_id, surface, task, context, params, requested_by, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (workspace_id, idempotency_key) DO NOTHING RETURNING *`,
      [ctx.access.workspaceId, brandId, input.surface, input.task, JSON.stringify(input.context), JSON.stringify({ request: input.prompt ?? null, target_language: input.target_language ?? null }),
        ctx.actor.userId, input.idempotency_key]).catch(() => null);
    if (!r) throw new AppError('idempotency_conflict', 'This request key was already used.');
    await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'ai_run', aggregateId: r.id, eventType: 'ai.run_requested', payload: { task: input.task } });
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId, actorUserId: ctx.actor.userId, action: 'ai.run_requested', resourceType: 'ai_run', resourceId: r.id,
      diff: { surface: input.surface, task: input.task, context: input.context.type }, correlationId: ctx.correlationId });
    return r;
  });
  return runDto(db, row);
}

/** Internal: queue a policy-driven run (automation service actor). Same executor and checks as a person's run. */
export async function queueAutomationRun(tx: Queryable, a: { workspaceId: string; brandId: string; conversationId: string; automationRunId: string; idempotencyKey: string }): Promise<string> {
  const r = await maybeOne<{ id: string }>(tx,
    `INSERT INTO ai_runs(workspace_id, brand_id, surface, task, context, params, automation_run_id, idempotency_key)
     VALUES ($1,$2,'automation','auto_reply',$3,'{}',$4,$5) ON CONFLICT (workspace_id, idempotency_key) DO NOTHING RETURNING id`,
    [a.workspaceId, a.brandId, JSON.stringify({ type: 'conversation', id: a.conversationId }), a.automationRunId, a.idempotencyKey]);
  const id = r?.id ?? (await one<{ id: string }>(tx, `SELECT id FROM ai_runs WHERE workspace_id=$1 AND idempotency_key=$2`, [a.workspaceId, a.idempotencyKey])).id;
  if (r) await writeOutbox(tx, { workspaceId: a.workspaceId, aggregateType: 'ai_run', aggregateId: id, eventType: 'ai.run_requested', payload: { task: 'auto_reply' } });
  return id;
}

export async function getRun(ctx: Ctx, id: string): Promise<AssistantRunDto> {
  assertUuid(id, 'Run');
  const r = await maybeOne<RunRow>(getPool(), `SELECT * FROM ai_runs WHERE id=$1 AND workspace_id=$2 AND kind='task'`, [id, ctx.access.workspaceId]);
  if (!r || !(await canSeeRun(ctx, r))) throw notFound('Run');
  return runDto(getPool(), r);
}

/** A person sees their own runs; policy-driven runs need automation.manage. Context access is re-checked either way. */
async function canSeeRun(ctx: Ctx, r: RunRow): Promise<boolean> {
  if (r.automation_run_id) return authorizeCtx(ctx, 'automation.manage').allowed;
  if (r.requested_by !== ctx.actor.userId) return false;
  try { await contextBrand(ctx, r.context); return true; } catch { return false; }
}

export async function listRuns(ctx: Ctx, q: { limit?: number | null; context_id?: string | null } = {}): Promise<{ items: AssistantRunDto[] }> {
  const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 50);
  const params: unknown[] = [ctx.access.workspaceId, ctx.actor.userId, limit];
  let extra = '';
  if (q.context_id) { assertUuid(q.context_id, 'Context'); params.push(q.context_id); extra = ` AND (context->>'id' = $4 OR context->>'brand_id' = $4)`; }
  const rows = await many<RunRow>(getPool(), `SELECT * FROM ai_runs WHERE workspace_id=$1 AND requested_by=$2 AND kind='task'${extra} ORDER BY created_at DESC LIMIT $3`, params);
  const out: AssistantRunDto[] = [];
  for (const r of rows) if (await canSeeRun(ctx, r)) out.push(await runDto(getPool(), r));
  return { items: out };
}

// ------------------------------------------------------------------ execution (worker)
async function finish(id: string, status: AssistantRunDto['status'], detail: string | null, extra: Partial<Pick<RunRow, 'output' | 'sources' | 'trace' | 'provider' | 'model' | 'input_tokens' | 'output_tokens' | 'latency_ms'>> & { cost?: number } = {}): Promise<void> {
  await getPool().query(
    `UPDATE ai_runs SET status=$2, status_detail=$3, output=coalesce($4, output), sources=coalesce($5, sources), trace=coalesce($6, trace), provider=coalesce($7, provider), model=coalesce($8, model),
            input_tokens=coalesce($9, input_tokens), output_tokens=coalesce($10, output_tokens), cost_estimate_usd=coalesce($11, cost_estimate_usd), latency_ms=coalesce($12, latency_ms),
            lease_owner=NULL, lease_expires_at=NULL, finished_at=now() WHERE id=$1`,
    [id, status, detail?.slice(0, 300) ?? null, extra.output ? JSON.stringify(extra.output) : null, extra.sources ? JSON.stringify(extra.sources) : null, extra.trace ? JSON.stringify(extra.trace) : null,
      extra.provider ?? null, extra.model ?? null, extra.input_tokens ?? null, extra.output_tokens ?? null, extra.cost ?? null, extra.latency_ms ?? null]);
}

/** The requester's CURRENT access (membership / grants re-loaded), or null when revoked. */
async function requesterCtx(r: RunRow): Promise<Ctx | null> {
  if (!r.requested_by) return null;
  const access = await loadAccess(r.requested_by, r.workspace_id);
  if (!access) return null;
  const u = await maybeOne<{ email: string; name: string | null }>(getPool(), `SELECT email, name FROM users WHERE id=$1 AND disabled_at IS NULL`, [r.requested_by]);
  if (!u) return null;
  return { actor: { userId: r.requested_by, email: u.email, name: u.name, sessionId: `ai-run:${r.id}` }, access, correlationId: randomUUID() };
}

function sanitizeLabels(v: string): string[] {
  return [...new Set(v.split(/[,;\n]/).map((s) => s.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 40)).filter(Boolean))].slice(0, 5);
}

/** Process one queued run. Returns the final status, or 'skipped' when another worker holds it. */
export async function executeRun(runId: string, workerId: string): Promise<AssistantRunDto['status'] | 'skipped' | string> {
  const db = getPool();
  // V5: workflow runs share this queue and table; they are executed by the workflow engine (ai-workflows/engine.ts).
  const kind = await maybeOne<{ kind: string }>(db, `SELECT kind FROM ai_runs WHERE id=$1`, [runId]);
  if (kind?.kind === 'workflow') return (await import('../ai-workflows/index.js')).executeWorkflowRun(runId, workerId);
  const r = await maybeOne<RunRow>(db,
    `UPDATE ai_runs SET status='running', attempts=attempts+1, started_at=coalesce(started_at, now()), lease_owner=$2, lease_expires_at=now() + make_interval(secs => $3)
      WHERE id=$1 AND (status='queued' OR (status='running' AND lease_expires_at < now())) RETURNING *`, [runId, workerId, LEASE_MS / 1000]);
  if (!r) return 'skipped';
  const trace: Array<Record<string, unknown>> = [];
  const done = async (status: AssistantRunDto['status'], detail: string | null, extra: Parameters<typeof finish>[3] = {}) => {
    await finish(r.id, status, detail, { trace, ...extra });
    if (r.automation_run_id && bridge) await bridge.onFinished(r.id).catch((err) => log.error('ai_automation_bridge_failed', { runId: r.id, err: err as Error }));
    return status;
  };
  if (r.attempts > 3) return done('failed', 'Gave up after repeated worker interruptions.');

  // 1. Who is asking, with what they may do NOW.
  let ctx: Ctx | null;
  let knowledgeIds: string[] | null = null;
  if (r.automation_run_id) {
    if (!bridge) return done('blocked', 'Automation is not available.');
    try { const b = await bridge.contextFor(r); ctx = b.ctx; knowledgeIds = b.knowledgeIds; } catch (err) { return done('blocked', err instanceof AppError ? err.message : 'The automation policy no longer allows this.'); }
  } else {
    ctx = await requesterCtx(r);
  }
  if (!ctx) { trace.push({ step: 'access', ok: false }); return done('blocked', 'Access was revoked. Nothing was retrieved.'); }
  try {
    const brand = await contextBrand(ctx, r.context);
    if (brand !== r.brand_id) throw notFound('Context');
    if (!r.automation_run_id) requireAction(ctx, 'ai.use', { brandId: r.brand_id });
  } catch {
    trace.push({ step: 'access', ok: false });
    return done('blocked', 'You no longer have access to this item. Nothing was retrieved.');
  }
  trace.push({ step: 'access', ok: true });

  // 2. Provider.
  const client = await resolveAssistantClient();
  if (!client) return done('not_configured', NOT_CONFIGURED_MESSAGE);

  // 3. Scoped retrieval.
  let retrieved: RetrievedSource[];
  try {
    retrieved = await retrieve(ctx, r.task, r.context, r.brand_id, { knowledgeIds });
  } catch (err) {
    log.warn('assistant.retrieval_failed', { runId: r.id, err: err as Error });
    return done('failed', err instanceof AppError ? err.message : 'The sources could not be loaded.');
  }
  // Automatic replies may only rely on the conversation, the brand voice and CURRENT approved knowledge.
  if (r.task === 'auto_reply') retrieved = retrieved.filter((s) => s.kind === 'conversation' || s.kind === 'brand_voice' || (s.trust === 'approved' && !s.stale));
  const sources = retrieved.map((s, i) => ({ ...s, ref: `s${i + 1}` }));
  const untrusted = sources.filter((s) => s.trust === 'untrusted');
  const ignored = countInjections(untrusted.map((s) => s.text));
  trace.push({ step: 'retrieve', sources: sources.length, by_kind: Object.fromEntries([...new Set(sources.map((s) => s.kind))].map((k) => [k, sources.filter((s) => s.kind === k).length])), untrusted: untrusted.length, instructions_in_sources: ignored });

  // 4. Budget reservation, then the call.
  const allowed = TASK_ACTIONS[r.task].filter((k) => authorizeCtx(ctx!, ACTION_PERMISSION[k] as never, { brandId: r.brand_id }).allowed);
  const request = typeof r.params.request === 'string' ? r.params.request : null;
  const targetLanguage = typeof r.params.target_language === 'string' ? r.params.target_language : null;
  const extra = r.task === 'translate'
    ? `If <person_request> contains text, translate exactly that text (for example a reply draft). Otherwise translate ${r.context.type === 'conversation' ? 'the customer\'s latest message' : 'the post\'s base copy'}.`
    : null;
  const prompt = buildAssistantPrompt({ task: r.task, allowed, request, targetLanguage, sources, extra });
  const model = config().AI_MODEL;
  let reservation;
  try {
    reservation = await reserveTokens(r.workspace_id, ASSISTANT_MAX_OUTPUT_TOKENS + Math.ceil((ASSISTANT_SYSTEM_PROMPT.length + prompt.length) / 3) + 1_500, { userId: r.requested_by, ref: `ai-run:${r.id}` });
  } catch (err) {
    if (err instanceof AppError && err.code === 'budget_exhausted') return done('budget_exhausted', err.details?.limit_source === 'plan' ? err.message : 'The monthly AI budget is used up.');
    // V4 entitlements: AI not in the plan / paid actions paused ⇒ stopped with the reason (nothing generated or sent).
    if (err instanceof AppError && err.code === 'entitlement_required') return done('blocked', err.message);
    throw err;
  }
  const t0 = Date.now();
  let res;
  try {
    res = await client.generate({ model, maxTokens: ASSISTANT_MAX_OUTPUT_TOKENS, system: ASSISTANT_SYSTEM_PROMPT, prompt });
  } catch (err) {
    await releaseUsage(reservation.id).catch(() => undefined);
    const msg = err instanceof AppError ? err.message : 'The AI provider is unavailable. Try again shortly.';
    trace.push({ step: 'model', ok: false, code: err instanceof AppError ? err.code : 'unexpected' });
    log.warn('assistant.run_failed', { runId: r.id, workspaceId: r.workspace_id, task: r.task, code: err instanceof AppError ? err.code : 'unexpected' });
    // Provider outage ⇒ a recoverable state: nothing invented, the person can retry (a new request).
    return done('failed', msg, { provider: client.provider, latency_ms: Date.now() - t0 });
  }
  const latency = Date.now() - t0;
  const servedModel = res.model || model;
  const cost = costEstimateUsd(servedModel, res.inputTokens, res.outputTokens);
  await settleUsage(reservation.id, res.inputTokens + res.outputTokens).catch(() => undefined);
  await db.query(
    `INSERT INTO ai_usage(workspace_id, brand_id, post_id, user_id, model, task, status, period, reserved_tokens, input_tokens, output_tokens, cost_estimate_usd, correlation_id, ai_run_id)
     VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [r.workspace_id, r.brand_id, r.requested_by, servedModel, r.task, res.stopReason === 'refusal' ? 'refused' : res.output ? 'ok' : 'failed', reservation.period, reservation.amount,
      res.inputTokens, res.outputTokens, cost, r.id, r.id]).catch((err) => log.error('assistant.usage_record_failed', { runId: r.id, err: err as Error }));
  trace.push({ step: 'model', ok: !!res.output, stop: res.stopReason, latency_ms: latency });
  const usageExtra = { provider: client.provider, model: servedModel, input_tokens: res.inputTokens, output_tokens: res.outputTokens, latency_ms: latency, cost };
  if (res.stopReason === 'refusal') return done('refused', 'The AI declined this request.', usageExtra);
  if (!res.output) return done('failed', 'The AI response was incomplete. Try again.', usageExtra);

  // 5. Access re-check after generation (revocation during the call ⇒ discard).
  const again = r.automation_run_id ? ctx : await requesterCtx(r);
  if (!again || !brandStillAllowed(again, r)) { trace.push({ step: 'access_after', ok: false }); return done('blocked', 'Access was revoked while the AI was working. The result was discarded.', usageExtra); }

  // 6. Checks + output.
  const { output, actions } = postProcess(r, sources, res.output, allowed, ignored, request);
  trace.push({ step: 'checks', evidence: output.evidence.length, unverified: output.evidence.filter((e) => !e.verified).length, blocked: output.suggestions.filter((s) => s.issues.some((i) => i.severity === 'block')).length, proposed: actions.length });
  await withTx(async (tx) => {
    for (const a of actions) {
      await tx.query(`INSERT INTO ai_proposed_actions(workspace_id, run_id, brand_id, kind, target_type, target_id, preview, requires) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [r.workspace_id, r.id, r.brand_id, a.kind, a.target_type, a.target_id, JSON.stringify(a.preview), a.requires]);
    }
  });
  const sourceRefs: SourceRefDto[] = sources.map(({ text: _t, ...s }) => s);
  log.info('assistant.run', { runId: r.id, workspaceId: r.workspace_id, task: r.task, model: servedModel, input_tokens: res.inputTokens, output_tokens: res.outputTokens, latency_ms: latency, sources: sources.length });
  return done('succeeded', null, { ...usageExtra, output, sources: sourceRefs });
}

function brandStillAllowed(ctx: Ctx, r: RunRow): boolean {
  if (ctx.access.brandIds !== null && !ctx.access.brandIds.includes(r.brand_id)) return false;
  return r.automation_run_id ? true : authorizeCtx(ctx, 'ai.use', { brandId: r.brand_id }).allowed;
}

interface NewAction { kind: ProposedActionKind; target_type: 'conversation' | 'post' | 'brand'; target_id: string; preview: ProposedActionDto['preview']; requires: string }

/** Deterministic post-processing. Exported for unit tests. */
export function postProcess(r: Pick<RunRow, 'task' | 'context' | 'brand_id'>, sources: Array<RetrievedSource & { ref: string }>, m: AssistantModelOutput, allowed: readonly ProposedActionKind[], ignored: number, request: string | null): { output: AssistantOutputDto; actions: NewAction[] } {
  const byRef = new Map(sources.map((s) => [s.ref, s]));
  const evidence: EvidenceItem[] = m.evidence.slice(0, 12).filter((e) => byRef.has(e.source)).map((e) => ({ source: e.source, quote: e.quote.slice(0, 500), verified: verifyQuote(e.quote, byRef.get(e.source)!.text) }));
  const allowedText = [...sources.map((s) => s.text), request ?? ''].join('\n');
  const linkText = [...sources.filter((s) => s.trust !== 'untrusted').map((s) => s.text), request ?? ''].join('\n');
  const approved = sources.filter((s) => s.trust === 'approved' && s.kind !== 'brand_voice');
  const approvedText = approved.filter((s) => !s.stale).map((s) => s.text).join('\n');
  const strict = r.task === 'auto_reply';
  const suggestions: SuggestionItem[] = m.suggestions.slice(0, 5).map((s) => {
    const text = s.text.normalize('NFC').replace(/[ \t]+$/gm, '').trim();
    const issues = checkOutput({ text, kind: s.kind, allowedText, linkText, approvedText, hasStaleApproved: approved.some((x) => x.stale), maxLength: s.kind === 'reply' ? 2000 : 6000, strict });
    if (!m.answerable && (s.kind === 'reply' || s.kind === 'answer')) issues.push({ code: 'uncertain', severity: strict ? 'block' : 'warn', message: 'The AI was not sure the sources answer this.' });
    return { kind: s.kind, text, language: /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(s.language) ? s.language : null, based_on: s.based_on.filter((x) => byRef.has(x)).slice(0, 10), issues };
  });
  const notices: string[] = [];
  if (ignored) notices.push(`${ignored === 1 ? 'A source contains' : `${ignored} sources contain`} instructions. They were treated as text and ignored.`);
  if (evidence.some((e) => !e.verified)) notices.push('Some quotes could not be found in their source and are marked unverified.');
  if (approved.some((s) => s.stale)) notices.push('An approved source is past its review date; it is not used for commitments.');
  const unsupported = suggestions.some((s) => s.issues.some((i) => i.severity === 'block'));
  const output: AssistantOutputDto = {
    summary: m.summary.trim().slice(0, 600), evidence, suggestions, uncertain: !m.answerable || unsupported,
    uncertainty_reason: m.uncertainty.trim().slice(0, 300) || (unsupported ? 'Some suggested text is not supported by the sources.' : null), ignored_instructions: ignored, notices,
  };
  // Proposed actions: only kinds allowed for this task AND permitted to the requester; targets come from Relay's context.
  const actions: NewAction[] = [];
  const ctxType = r.context.type;
  const target = ctxType === 'conversation' || ctxType === 'post' || ctxType === 'brand' ? { type: ctxType, id: r.context.id } : { type: 'brand' as const, id: r.brand_id };
  const seen = new Set<ProposedActionKind>();
  const usable = (k: SuggestionItem['kind']) => suggestions.find((s) => s.kind === k && !s.issues.some((i) => i.severity === 'block'));
  for (const p of m.proposed.slice(0, 6)) {
    if (!allowed.includes(p.kind) || seen.has(p.kind)) continue;
    const v = p.value.trim();
    if (p.kind === 'apply_labels' && target.type === 'conversation') {
      const labels = sanitizeLabels(v);
      if (labels.length) actions.push({ kind: p.kind, target_type: 'conversation', target_id: target.id, requires: ACTION_PERMISSION[p.kind], preview: { title: 'Add labels', detail: labels.join(', '), params: { labels } } });
    } else if (p.kind === 'set_priority' && target.type === 'conversation') {
      const pr = v.toLowerCase();
      if ((PRIORITIES as readonly string[]).includes(pr)) actions.push({ kind: p.kind, target_type: 'conversation', target_id: target.id, requires: ACTION_PERMISSION[p.kind], preview: { title: 'Set priority', detail: pr, params: { priority: pr } } });
    } else if (p.kind === 'add_note' && target.type === 'conversation') {
      const body = (v || usable('summary')?.text || '').slice(0, 1000);
      if (body) actions.push({ kind: p.kind, target_type: 'conversation', target_id: target.id, requires: ACTION_PERMISSION[p.kind], preview: { title: 'Add internal note', detail: body, params: { body } } });
    } else if (p.kind === 'create_task') {
      const title = v.replace(/\s+/g, ' ').slice(0, 120);
      if (title) actions.push({ kind: p.kind, target_type: 'brand', target_id: r.brand_id, requires: ACTION_PERMISSION[p.kind], preview: { title: 'Create task', detail: title, params: { title } } });
    } else if (p.kind === 'use_copy') {
      const s = usable('copy');
      if (s) actions.push({ kind: p.kind, target_type: target.type, target_id: target.id, requires: ACTION_PERMISSION[p.kind], preview: { title: 'Use this copy', detail: s.text.slice(0, 280), params: { text: s.text } } });
    } else continue;
    seen.add(p.kind);
  }
  // A reply draft is always offered as an explicit, previewable action (never sent by the assistant).
  if (allowed.includes('use_reply_draft') && target.type === 'conversation') {
    const s = usable('reply');
    if (s) actions.push({ kind: 'use_reply_draft', target_type: 'conversation', target_id: target.id, requires: ACTION_PERMISSION.use_reply_draft, preview: { title: 'Put in reply box', detail: s.text.slice(0, 280), params: { body: s.text } } });
  }
  return { output, actions };
}

// ------------------------------------------------------------------ maintenance
/** Worker: queued runs whose wake-up was lost, expired leases. */
export async function sweepRuns(): Promise<string[]> {
  const rows = await many<{ id: string }>(getPool(),
    `SELECT id FROM ai_runs WHERE kind='task' AND ((status='queued' AND created_at < now() - interval '30 seconds') OR (status='running' AND lease_expires_at < now())) ORDER BY created_at LIMIT 20`);
  // V5: workflow runs (lost wake-ups, expired leases; timed-out ones are finalized by the sweep itself).
  const wf = await (await import('../ai-workflows/index.js')).sweepWorkflowRuns();
  return [...rows.map((r) => r.id), ...wf];
}

/** Retention: run output (drafts/summaries) and the person's request text are purged after 30 days. */
export async function purgeRunOutputs(): Promise<number> {
  await (await import('../ai-workflows/index.js')).purgeWorkflowContent(OUTPUT_RETENTION_DAYS);
  const r = await getPool().query(`UPDATE ai_runs SET output=NULL, params = params - 'request', output_purged_at=now() WHERE output IS NOT NULL AND finished_at < now() - make_interval(days => $1)`, [OUTPUT_RETENTION_DAYS]);
  await getPool().query(`UPDATE ai_proposed_actions SET status='expired' WHERE status='proposed' AND expires_at < now()`);
  return r.rowCount ?? 0;
}

export async function aiMeterUsed(workspaceId: string): Promise<number> {
  return (await readMeterUsage(workspaceId, AI_METER)).used;
}

export { PROPOSED_ACTION_KINDS };
