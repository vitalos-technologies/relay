// V5 workflow execution engine (brief §13). A workflow run is an ai_runs row (kind='workflow') with a persisted step
// plan (ai_run_steps), progress events (ai_run_events) and structured results (ai_run_results). The worker executes it
// on the 'ai-assist' queue (ai_assist workload class); pages only queue, poll and cancel.
//
// Guarantees:
//  - Refresh/disconnect safe: everything the page shows is read back from the database.
//  - Each execution re-loads the requester's CURRENT access; revocation stops the run before anything is read.
//  - Retries never repeat a successful write or model step: their persisted result is reused. Read/validate steps run
//    again (cheap, and they re-check access). Writes use deterministic idempotency keys, so even a crash between a
//    save and its bookkeeping cannot create a second record.
//  - External actions are never executed here: a step can only PREPARE a previewed action (actions.ts).
//  - Cancellation is checked between steps and between items; work already dispatched is reported, never hidden.
//  - A deadline bounds every run; an interrupted worker's lease expires and the sweep resumes or times it out.
import { randomUUID } from 'node:crypto';
import { AppError } from '@social-lite/core';
import type { AiWorkflow, NeedsInputDto, OutcomeCode, StepKind, StepStatus, WorkflowStatus } from '@social-lite/core/contracts/v5-ai';
import type { ProposedActionDto } from '@social-lite/core/contracts/v35-ai';
import { getPool, many, maybeOne, one, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { log } from '../log.js';
import { audit } from '../audit.js';
import { authorizeCtx, loadAccess } from '../tenancy.js';
import { checkFeature, entitlementsCore } from '../entitlements/resolve.js';
import { WORKFLOW_FEATURE } from '@social-lite/core/contracts/v5-ai';

export const LEASE_MS = 3 * 60_000;
export const MAX_ATTEMPTS = 4;

// ------------------------------------------------------------------ rows
export interface WfRunRow {
  id: string; workspace_id: string; brand_id: string; task: AiWorkflow; kind: 'workflow'; thread_id: string; title: string | null;
  status: WorkflowStatus; status_detail: string | null; outcome_code: OutcomeCode | null; params: { request?: string | null; input?: Record<string, unknown>; summary?: unknown };
  requested_by: string | null; idempotency_key: string; pending_input: NeedsInputDto | null; cancel_requested_at: Date | null; cancel_requested_by: string | null;
  deadline_at: Date; last_event_seq: number; input_tokens: number; output_tokens: number; cost_estimate_usd: string; provider: string | null; model: string | null;
  attempts: number; created_at: Date; started_at: Date | null; finished_at: Date | null; lease_owner: string | null; lease_expires_at: Date | null;
}

export interface StepRow {
  id: string; run_id: string; seq: number; key: string; kind: StepKind; label: string; status: StepStatus; detail: string | null;
  result: Record<string, unknown>; attempts: number; started_at: Date | null; finished_at: Date | null;
}

// ------------------------------------------------------------------ step signals
export class NotConfigured extends Error { constructor() { super('AI is not set up.'); } }
export class StepSkip extends Error {}
export class NeedsInput extends Error { constructor(readonly input: NeedsInputDto) { super(input.question); } }
export class Cancelled extends Error {}
export class RunStop extends Error { constructor(readonly code: OutcomeCode, message: string) { super(message); } }

// ------------------------------------------------------------------ definitions
export interface NewResult {
  item: string;
  kind: 'post_draft' | 'campaign' | 'outline' | 'reply_draft' | 'report' | 'task' | 'schedule_plan' | 'variant' | 'summary' | 'answer' | 'notice';
  title: string;
  body?: string | null;
  generated?: boolean;
  data?: Record<string, unknown>;
  record?: { type: 'post' | 'campaign' | 'conversation' | 'task' | 'analytics'; id: string | null } | null;
}

export interface NewProposal {
  kind: ProposedActionDto['kind'];
  target_type: 'conversation' | 'post' | 'brand';
  target_id: string;
  requires: string;
  preview: { title: string; detail: string; params: Record<string, unknown> };
  bound_hash?: string | null;
  /** Item key of the result card this action belongs to. */
  result_item?: string;
  /** Optional offers (e.g. submit for approval) do not hold the run in needs_review. */
  optional?: boolean;
}

export interface StepCtx {
  run: WfRunRow;
  ctx: Ctx;
  input: Record<string, unknown>;
  request: string | null;
  /** Shared, in-memory state of this execution. state[stepKey] holds each finished step's result, so ad-hoc keys must not reuse a step key. */
  state: Record<string, unknown>;
  /** This step's persisted result from an earlier attempt (partial writes), or {}. */
  prior: Record<string, unknown>;
  step: StepRow;
  emit(message: string, level?: 'info' | 'success' | 'warn' | 'error'): Promise<void>;
  result(r: NewResult): Promise<string>;
  propose(p: NewProposal): Promise<string>;
  /** Persist partial progress of this step (e.g. ids created so far) before the step finishes. */
  checkpoint(partial: Record<string, unknown>): Promise<void>;
  /** Throws Cancelled when the person asked to stop; RunStop on timeout. Call between items. */
  checkpointCancel(): Promise<void>;
  /** Deterministic idempotency key for an internal save in this step. */
  idem(item: string): string;
  /** Mark the run as partially done (an item failed but the step continued). */
  partial(): void;
}

export interface StepReturn { result?: Record<string, unknown>; detail?: string | null }

export interface StepDef {
  key: string;
  label: string;
  kind: StepKind;
  run(s: StepCtx): Promise<StepReturn | void>;
}

export interface WorkflowDef {
  workflow: AiWorkflow;
  /** Steps for this input (persisted at creation so the page shows the plan immediately). */
  steps(input: Record<string, unknown>): StepDef[];
  /** One sentence for the final event, from the execution state. */
  summary?(state: Record<string, unknown>, status: WorkflowStatus): string | null;
}

const registry = new Map<AiWorkflow, WorkflowDef>();
export function registerWorkflow(d: WorkflowDef): void { registry.set(d.workflow, d); }
export function workflowDef(w: AiWorkflow): WorkflowDef {
  const d = registry.get(w);
  if (!d) throw new AppError('invalid_state', 'This workflow is not available.');
  return d;
}

// ------------------------------------------------------------------ persistence helpers
export async function emitEvent(db: Queryable, runId: string, workspaceId: string, message: string, level: 'info' | 'success' | 'warn' | 'error' = 'info', stepKey: string | null = null): Promise<void> {
  const r = await one<{ last_event_seq: number }>(db, `UPDATE ai_runs SET last_event_seq = last_event_seq + 1 WHERE id=$1 RETURNING last_event_seq`, [runId]);
  await db.query(`INSERT INTO ai_run_events(workspace_id, run_id, seq, step_key, level, message) VALUES ($1,$2,$3,$4,$5,$6)`,
    [workspaceId, runId, r.last_event_seq, stepKey, level, message.replace(/\s+/g, ' ').trim().slice(0, 300) || '…']);
}

async function setStep(id: string, patch: { status: StepStatus; detail?: string | null; result?: Record<string, unknown> | null; start?: boolean; finish?: boolean }): Promise<void> {
  await getPool().query(
    `UPDATE ai_run_steps SET status=$2, detail=coalesce($3, detail), result=coalesce($4, result),
            attempts = attempts + CASE WHEN $5 THEN 1 ELSE 0 END,
            started_at = CASE WHEN $5 THEN now() ELSE started_at END,
            finished_at = CASE WHEN $6 THEN now() WHEN $5 THEN NULL ELSE finished_at END
      WHERE id=$1`,
    [id, patch.status, patch.detail === undefined ? null : (patch.detail ?? '').slice(0, 300) || null, patch.result ? JSON.stringify(patch.result) : null, !!patch.start, !!patch.finish]);
}

/** The requester's CURRENT access (membership / grants re-loaded), or null when revoked. */
export async function requesterCtx(r: Pick<WfRunRow, 'id' | 'requested_by' | 'workspace_id'>): Promise<Ctx | null> {
  if (!r.requested_by) return null;
  const access = await loadAccess(r.requested_by, r.workspace_id);
  if (!access) return null;
  const u = await maybeOne<{ email: string; name: string | null }>(getPool(), `SELECT email, name FROM users WHERE id=$1 AND disabled_at IS NULL`, [r.requested_by]);
  if (!u) return null;
  return { actor: { userId: r.requested_by, email: u.email, name: u.name, sessionId: `ai-run:${r.id}` }, access, correlationId: randomUUID() };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Does the person hold this permission on the brand (grant-wise)? Runs execute without a browser session, so session
 * assurance (MFA / fresh sign-in) cannot be met there; it is enforced when the person CONFIRMS an action (dispatch).
 */
export function holdsPermission(ctx: Ctx, perm: Parameters<typeof authorizeCtx>[1], brandId: string): boolean {
  const d = authorizeCtx(ctx, perm, { brandId });
  return d.allowed || d.reason === 'mfa_required' || d.reason === 'step_up_required';
}
export { plural };

// ------------------------------------------------------------------ execution
/** Execute (or resume) one workflow run. Returns its status after this execution, or 'skipped' when not claimable. */
export async function executeWorkflowRun(runId: string, workerId: string): Promise<WorkflowStatus | 'skipped'> {
  const db = getPool();
  const r = await maybeOne<WfRunRow>(db,
    `UPDATE ai_runs SET status='working', attempts=attempts+1, started_at=coalesce(started_at, now()), lease_owner=$2, lease_expires_at=now() + make_interval(secs => $3)
      WHERE id=$1 AND kind='workflow' AND (status='preparing' OR (status='working' AND lease_expires_at < now())) RETURNING *`, [runId, workerId, LEASE_MS / 1000]);
  if (!r) return 'skipped';
  const emit = (m: string, level: 'info' | 'success' | 'warn' | 'error' = 'info', step: string | null = null) => emitEvent(db, r.id, r.workspace_id, m, level, step);
  const steps = await many<StepRow>(db, `SELECT * FROM ai_run_steps WHERE run_id=$1 ORDER BY seq`, [r.id]);

  if (r.cancel_requested_at) return finalize(r, { cancelled: true });
  if (r.attempts > MAX_ATTEMPTS) return finalize(r, { stop: new RunStop('interrupted', 'Stopped after repeated worker interruptions.') });
  if (r.deadline_at.getTime() < Date.now()) return finalize(r, { stop: new RunStop('timeout', 'Timed out.') });
  if (r.attempts === 1) await emit('Started.');
  else await emit('Resumed. Completed steps are kept and will not run again.');

  // 1. Who is asking, with what they may do NOW.
  const ctx = await requesterCtx(r);
  if (!ctx || !authorizeCtx(ctx, 'ai.use', { brandId: r.brand_id }).allowed) {
    await emit('Access was revoked. Nothing was read.', 'error');
    return finalize(r, { stop: new RunStop('blocked', 'You no longer have access to this brand or the assistant. Nothing was read.') });
  }
  // 2. Plan (V4 entitlements, re-checked at run time).
  const ent = checkFeature(await entitlementsCore(db, r.workspace_id), WORKFLOW_FEATURE[r.task], { paid: true });
  if (!ent.ok) {
    await emit(ent.message, 'error');
    return finalize(r, { stop: new RunStop('entitlement', ent.message) });
  }

  const def = workflowDef(r.task);
  const defs = new Map(def.steps(r.params.input ?? {}).map((d) => [d.key, d]));
  const state: Record<string, unknown> = { __results: 0 };
  let partial = false;

  for (const step of steps) {
    const d = defs.get(step.key);
    if (!d) continue;
    // Reuse persisted results of successful model/write steps (never repeat them); re-run read/validate steps.
    if (step.status === 'succeeded' && (step.kind === 'model' || step.kind === 'write' || step.kind === 'external')) { state[step.key] = step.result; continue; }
    const fresh = await maybeOne<{ cancel_requested_at: Date | null; deadline_at: Date }>(db, `SELECT cancel_requested_at, deadline_at FROM ai_runs WHERE id=$1`, [r.id]);
    if (fresh?.cancel_requested_at) return finalize(r, { cancelled: true });
    if (fresh && fresh.deadline_at.getTime() < Date.now()) return finalize(r, { stop: new RunStop('timeout', 'Timed out before finishing.') });
    await db.query(`UPDATE ai_runs SET lease_expires_at = now() + make_interval(secs => $2) WHERE id=$1`, [r.id, LEASE_MS / 1000]);
    await setStep(step.id, { status: 'running', start: true });

    const s: StepCtx = {
      run: r, ctx, input: r.params.input ?? {}, request: typeof r.params.request === 'string' ? r.params.request : null, state, prior: step.result ?? {}, step,
      emit: (m, level = 'info') => emit(m, level, step.key),
      result: async (x) => {
        const row = await one<{ id: string }>(db,
          `INSERT INTO ai_run_results(workspace_id, run_id, step_key, item_key, kind, title, body, data, record_type, record_id, generated)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (run_id, step_key, item_key) DO UPDATE SET kind=EXCLUDED.kind, title=EXCLUDED.title, body=EXCLUDED.body, data=EXCLUDED.data,
             record_type=EXCLUDED.record_type, record_id=EXCLUDED.record_id, generated=EXCLUDED.generated
           RETURNING id`,
          [r.workspace_id, r.id, step.key, x.item, x.kind, x.title.slice(0, 200), x.body ?? null, JSON.stringify(x.data ?? {}), x.record?.type ?? null, x.record?.id ?? null, !!x.generated]);
        if (x.kind !== 'notice') state.__results = Number(state.__results) + 1;
        return row.id;
      },
      propose: async (p) => {
        const existing = await maybeOne<{ id: string }>(db,
          `SELECT id FROM ai_proposed_actions WHERE run_id=$1 AND kind=$2 AND target_id=$3 AND preview->'params'->>'result_item' IS NOT DISTINCT FROM $4`, [r.id, p.kind, p.target_id, p.result_item ?? null]);
        if (existing) return existing.id;
        const row = await one<{ id: string }>(db,
          `INSERT INTO ai_proposed_actions(workspace_id, run_id, brand_id, kind, target_type, target_id, preview, requires, bound_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [r.workspace_id, r.id, r.brand_id, p.kind, p.target_type, p.target_id,
            JSON.stringify({ ...p.preview, params: { ...p.preview.params, result_item: p.result_item ?? null, step: step.key, optional: !!p.optional } }), p.requires, p.bound_hash ?? null]);
        return row.id;
      },
      checkpoint: async (partialResult) => { step.result = { ...step.result, ...partialResult }; await setStep(step.id, { status: 'running', result: step.result }); },
      checkpointCancel: async () => {
        const f = await maybeOne<{ cancel_requested_at: Date | null; deadline_at: Date }>(db, `SELECT cancel_requested_at, deadline_at FROM ai_runs WHERE id=$1`, [r.id]);
        if (f?.cancel_requested_at) throw new Cancelled();
        if (f && f.deadline_at.getTime() < Date.now()) throw new RunStop('timeout', 'Timed out before finishing.');
      },
      idem: (item) => `ai-${r.id.replace(/-/g, '')}-${step.key}-${item}`.slice(0, 200),
      partial: () => { partial = true; },
    };
    try {
      const out = (await d.run(s)) ?? {};
      const result = { ...step.result, ...(out.result ?? {}) };
      state[step.key] = result;
      await setStep(step.id, { status: 'succeeded', detail: out.detail ?? null, result, finish: true });
    } catch (err) {
      if (err instanceof NotConfigured) {
        await setStep(step.id, { status: 'not_configured', detail: 'AI is not set up. An owner can add a provider key in Setup.', finish: true });
        await emit(`${d.label}: AI is not set up, so this step was skipped.`, 'warn', step.key);
        state.__not_configured = true;
        continue;
      }
      if (err instanceof StepSkip) {
        await setStep(step.id, { status: 'skipped', detail: err.message, finish: true });
        if (err.message) await emit(err.message, 'info', step.key);
        continue;
      }
      if (err instanceof NeedsInput) {
        await setStep(step.id, { status: 'pending', detail: 'Waiting for your answer.' });
        await db.query(`UPDATE ai_runs SET status='needs_input', pending_input=$2, status_detail=$3, lease_owner=NULL, lease_expires_at=NULL WHERE id=$1`,
          [r.id, JSON.stringify(err.input), err.input.question.slice(0, 300)]);
        await emit(err.input.question, 'warn', step.key);
        return 'needs_input';
      }
      if (err instanceof Cancelled) {
        await setStep(step.id, { status: 'cancelled', detail: 'Stopped.', finish: true });
        return finalize(r, { cancelled: true });
      }
      if (err instanceof RunStop) {
        await setStep(step.id, { status: 'failed', detail: err.message, finish: true });
        return finalize(r, { stop: err });
      }
      const msg = err instanceof AppError ? err.message : 'Something went wrong in this step.';
      if (!(err instanceof AppError)) log.error('ai_workflow.step_failed', { runId: r.id, step: step.key, err: err as Error });
      else log.warn('ai_workflow.step_failed', { runId: r.id, step: step.key, code: err.code });
      await setStep(step.id, { status: 'failed', detail: msg, finish: true });
      await emit(`${d.label} failed: ${msg}`, 'error', step.key);
      return finalize(r, { stop: new RunStop('step_failed', msg) });
    }
  }
  return finalize(r, { partial, notConfigured: !!state.__not_configured, summary: def.summary?.(state, 'completed') ?? null });
}

// ------------------------------------------------------------------ finalize
interface FinalizeOpts { cancelled?: boolean; stop?: RunStop; partial?: boolean; notConfigured?: boolean; summary?: string | null }

async function counts(db: Queryable, runId: string) {
  const res = await one<{ results: number; records: number; pending: number; optional: number }>(db,
    `SELECT (SELECT count(*)::int FROM ai_run_results WHERE run_id=$1 AND kind <> 'notice') AS results,
            (SELECT count(*)::int FROM ai_run_results WHERE run_id=$1 AND record_id IS NOT NULL AND record_type IN ('post','campaign','task')) AS records,
            (SELECT count(*)::int FROM ai_proposed_actions WHERE run_id=$1 AND status='proposed' AND expires_at > now() AND kind IN ('schedule_post','submit_for_approval','send_reply') AND coalesce(preview->'params'->>'optional','false') <> 'true') AS pending,
            (SELECT count(*)::int FROM ai_proposed_actions WHERE run_id=$1 AND status='proposed') AS optional`, [runId]);
  return res;
}

/** Explain what was already done (kept) and what did not start, for cancellation / failure messages. */
async function doneSoFar(db: Queryable, runId: string): Promise<string> {
  const rows = await many<{ record_type: string | null; n: number }>(db,
    `SELECT record_type, count(*)::int AS n FROM ai_run_results WHERE run_id=$1 AND record_id IS NOT NULL GROUP BY record_type`, [runId]);
  const parts = rows.filter((x) => x.record_type === 'post' || x.record_type === 'campaign' || x.record_type === 'task')
    .map((x) => plural(x.n, x.record_type === 'post' ? 'draft' : x.record_type!));
  return parts.length ? `Already saved and kept: ${parts.join(', ')}.` : 'Nothing was saved.';
}

export async function finalize(r: Pick<WfRunRow, 'id' | 'workspace_id' | 'brand_id' | 'requested_by' | 'task'>, o: FinalizeOpts): Promise<WorkflowStatus> {
  const db = getPool();
  const c = await counts(db, r.id);
  let status: WorkflowStatus;
  let code: OutcomeCode | null = null;
  let detail: string | null = null;
  if (o.cancelled) {
    status = 'cancelled'; code = 'cancelled';
    await db.query(`UPDATE ai_run_steps SET status='cancelled', detail='Not started.' WHERE run_id=$1 AND status IN ('pending','running')`, [r.id]);
    await db.query(`UPDATE ai_proposed_actions SET status='dismissed', decided_at=now(), error='Run stopped' WHERE run_id=$1 AND status='proposed'`, [r.id]);
    detail = `Stopped. ${await doneSoFar(db, r.id)} Nothing else will run, and nothing was published or sent.`;
  } else if (o.stop) {
    code = o.stop.code;
    await db.query(`UPDATE ai_run_steps SET status='skipped', detail='Not started.' WHERE run_id=$1 AND status IN ('pending','running')`, [r.id]);
    status = c.results > 0 ? 'partially_completed' : 'failed';
    detail = status === 'partially_completed' ? `${o.stop.message} ${await doneSoFar(db, r.id)}` : o.stop.message;
  } else if (c.pending > 0) {
    status = 'needs_review';
    code = o.notConfigured ? 'not_configured' : null;
    detail = `${plural(c.pending, 'action')} ready for your review. Nothing is published or sent until you confirm.`;
  } else if (o.notConfigured) {
    code = 'not_configured';
    status = c.results > 0 ? 'partially_completed' : 'failed';
    detail = status === 'partially_completed' ? 'AI is not set up: Relay completed the data steps; AI-written parts were skipped.' : 'AI is not set up. An owner can add a provider key in Setup.';
  } else if (o.partial) {
    status = 'partially_completed'; code = 'step_failed';
    detail = 'Some items could not be completed. See the results.';
  } else {
    status = 'completed';
    detail = o.summary ?? null;
  }
  if (status === 'needs_review' && o.notConfigured) detail = `${detail} AI-written parts were skipped (AI is not set up).`;
  await db.query(
    `UPDATE ai_runs SET status=$2, outcome_code=$3, status_detail=$4, pending_input=NULL, lease_owner=NULL, lease_expires_at=NULL,
            finished_at = CASE WHEN $2 IN ('needs_review') THEN NULL ELSE now() END WHERE id=$1`,
    [r.id, status, code, detail?.slice(0, 300) ?? null]);
  const level = status === 'completed' ? 'success' : status === 'failed' ? 'error' : status === 'cancelled' ? 'info' : 'warn';
  await emitEvent(db, r.id, r.workspace_id, status === 'completed' ? (o.summary ?? 'Done.') : detail ?? status, level);
  await db.query(`UPDATE ai_threads SET updated_at=now() WHERE id=(SELECT thread_id FROM ai_runs WHERE id=$1)`, [r.id]);
  await audit(db, { workspaceId: r.workspace_id, brandId: r.brand_id, actorUserId: r.requested_by, action: 'ai.workflow_finished', resourceType: 'ai_run', resourceId: r.id,
    diff: { workflow: r.task, status, outcome: code } }).catch((err) => log.error('ai_workflow.audit_failed', { runId: r.id, err: err as Error }));
  return status;
}

/** After a proposed action is decided: a run waiting for review completes when nothing required is left to review. */
export async function settleReviewIfDone(runId: string): Promise<void> {
  const db = getPool();
  const r = await maybeOne<WfRunRow>(db, `SELECT * FROM ai_runs WHERE id=$1 AND kind='workflow' AND status='needs_review'`, [runId]);
  if (!r) return;
  const c = await counts(db, runId);
  if (c.pending > 0) return;
  const applied = await one<{ applied: number; other: number }>(db,
    `SELECT count(*) FILTER (WHERE status='applied')::int AS applied, count(*) FILTER (WHERE status IN ('dismissed','expired','failed'))::int AS other
       FROM ai_proposed_actions WHERE run_id=$1 AND kind IN ('schedule_post','submit_for_approval','send_reply')`, [runId]);
  const status: WorkflowStatus = r.outcome_code === 'not_configured' ? 'partially_completed' : 'completed';
  const detail = `Reviewed: ${applied.applied} confirmed${applied.other ? `, ${applied.other} not used` : ''}.`;
  const upd = await db.query(`UPDATE ai_runs SET status=$2, status_detail=$3, finished_at=now() WHERE id=$1 AND status='needs_review'`, [runId, status, detail]);
  if (upd.rowCount) await emitEvent(db, runId, r.workspace_id, detail, 'success');
}

// ------------------------------------------------------------------ maintenance (worker)
/** Workflow runs whose wake-up was lost, or whose worker died (lease expired). Timed-out ones are finalized here. */
export async function sweepWorkflowRuns(): Promise<string[]> {
  const db = getPool();
  const expired = await many<WfRunRow>(db,
    `SELECT * FROM ai_runs WHERE kind='workflow' AND deadline_at < now() AND (status='preparing' OR (status='working' AND (lease_expires_at IS NULL OR lease_expires_at < now()))) LIMIT 20`);
  for (const r of expired) {
    const claimed = await db.query(`UPDATE ai_runs SET lease_owner='sweep', lease_expires_at=now() + interval '1 minute' WHERE id=$1 AND status IN ('preparing','working') AND (lease_expires_at IS NULL OR lease_expires_at < now())`, [r.id]);
    if (claimed.rowCount) await finalize(r, r.cancel_requested_at ? { cancelled: true } : { stop: new RunStop('timeout', 'Timed out before finishing.') });
  }
  const due = await many<{ id: string }>(db,
    `SELECT id FROM ai_runs WHERE kind='workflow' AND ((status='preparing' AND created_at < now() - interval '20 seconds') OR (status='working' AND lease_expires_at < now()))
      ORDER BY created_at LIMIT 20`);
  return due.map((x) => x.id);
}

/** Retention: generated result text and attachment text are purged after 30 days (V3.5 policy). */
export async function purgeWorkflowContent(days = 30): Promise<number> {
  const db = getPool();
  const a = await db.query(`UPDATE ai_run_results SET body=NULL, data = data - 'evidence' - 'compare_with' WHERE body IS NOT NULL AND created_at < now() - make_interval(days => $1)`, [days]);
  await db.query(`UPDATE ai_run_steps SET result = result - 'output' WHERE result ? 'output' AND finished_at < now() - make_interval(days => $1)`, [days]);
  await db.query(`UPDATE ai_attachments SET text_content=NULL, purged_at=now() WHERE text_content IS NOT NULL AND created_at < now() - make_interval(days => $1)`, [days]);
  return a.rowCount ?? 0;
}
