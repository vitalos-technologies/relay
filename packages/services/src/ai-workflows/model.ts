// Model steps of a workflow. Reuses the V3.5 assistant client (same provider resolution, structured output schema and
// test-only fake injection via setAssistantModelClient), the same budget meter (ai.tokens reservations) and ledger
// (ai_usage), the same prompt discipline (sources quoted as DATA with their trust level) and the same deterministic
// output checks (links/numbers must be grounded; commitments need an approved source).
// No provider ⇒ NotConfigured: the step is recorded as "AI is not set up" — never a fixture or placeholder output.
import type { AssistantTask, SourceKind, SuggestionItem } from '@social-lite/core/contracts/v35-ai';
import { AppError } from '@social-lite/core';
import { getPool } from '@social-lite/db';
import { config } from '../config.js';
import { log } from '../log.js';
import { costEstimateUsd, reserveTokens } from '../ai/usage.js';
import { releaseUsage, settleUsage } from '../product/budgets.js';
import { resolveAssistantClient, type AssistantModelOutput } from '../assistant/client.js';
import { checkOutput, countInjections, quoteData, verifyQuote } from '../assistant/guard.js';
import { ASSISTANT_SYSTEM_PROMPT } from '../assistant/prompt.js';
import { NotConfigured, RunStop, type StepCtx } from './engine.js';

export interface WfSource { kind: SourceKind | 'attachment' | 'document'; title: string; trust: 'approved' | 'observed' | 'untrusted'; stale: boolean; freshness: string | null; text: string; id: string | null; link: string | null }

export interface CheckedSuggestion extends SuggestionItem {}

export interface ModelStepOutput {
  summary: string;
  evidence: Array<{ text: string; source: string; verified: boolean }>;
  suggestions: CheckedSuggestion[];
  proposed: AssistantModelOutput['proposed'];
  answerable: boolean;
  uncertainty: string;
  ignored_instructions: number;
}

const WORKFLOW_RULES = `
Workflow
- You are one step of a Relay workflow. Relay saves drafts and prepares actions itself; you only return text.
- Never claim that anything was published, scheduled, sent or saved.`;

export function buildWorkflowPrompt(p: { task: string; request: string | null; sources: Array<WfSource & { ref: string }> }): string {
  const parts: string[] = [];
  parts.push(`<task>\n${p.task}\nAllowed proposed action kinds: create_task.\n</task>`);
  if (p.request?.trim()) parts.push(`<person_request>\n${quoteData(p.request, 2000)}\n</person_request>`);
  parts.push('<sources>');
  for (const s of p.sources) {
    const kind = s.kind === 'attachment' || s.kind === 'document' ? 'knowledge' : s.kind;
    parts.push(`<source ref="${s.ref}" kind="${kind}" trust="${s.trust}" stale="${s.stale}" title="${quoteData(s.title, 120).replace(/"/g, "'")}"${s.freshness ? ` as_of="${s.freshness}"` : ''}>\n${quoteData(s.text)}\n</source>`);
  }
  parts.push('</sources>');
  return parts.join('\n\n');
}

/**
 * One model call for a step. `usageTask` labels the call in the shared ai_usage ledger (existing task names).
 * Throws NotConfigured (no provider), RunStop('budget_exhausted' | 'entitlement') or AppError (provider failure).
 */
export async function callModel(s: StepCtx, p: { usageTask: AssistantTask; task: string; sources: WfSource[]; maxTokens?: number; maxLength?: number }): Promise<ModelStepOutput> {
  const client = await resolveAssistantClient();
  if (!client) throw new NotConfigured();
  const sources = p.sources.map((x, i) => ({ ...x, ref: `s${i + 1}` }));
  const prompt = buildWorkflowPrompt({ task: p.task, request: s.request, sources });
  const maxTokens = p.maxTokens ?? 4_000;
  const system = ASSISTANT_SYSTEM_PROMPT + WORKFLOW_RULES;
  let reservation;
  try {
    reservation = await reserveTokens(s.run.workspace_id, maxTokens + Math.ceil((system.length + prompt.length) / 3) + 1_000, { userId: s.run.requested_by, ref: `ai-run:${s.run.id}:${s.step.key}` });
  } catch (err) {
    if (err instanceof AppError && err.code === 'budget_exhausted') throw new RunStop('budget_exhausted', 'The monthly AI budget is used up. An owner can raise it in Usage.');
    if (err instanceof AppError && err.code === 'entitlement_required') throw new RunStop('entitlement', err.message);
    throw err;
  }
  const model = config().AI_MODEL;
  const t0 = Date.now();
  let res;
  try {
    res = await client.generate({ model, maxTokens, system, prompt });
  } catch (err) {
    await releaseUsage(reservation.id).catch(() => undefined);
    throw err instanceof AppError ? err : new AppError('provider_error', 'The AI provider is unavailable. Try again shortly.');
  }
  const served = res.model || model;
  const cost = costEstimateUsd(served, res.inputTokens, res.outputTokens);
  await settleUsage(reservation.id, res.inputTokens + res.outputTokens).catch(() => undefined);
  const db = getPool();
  await db.query(
    `INSERT INTO ai_usage(workspace_id, brand_id, post_id, user_id, model, task, status, period, reserved_tokens, input_tokens, output_tokens, cost_estimate_usd, correlation_id, ai_run_id)
     VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [s.run.workspace_id, s.run.brand_id, s.run.requested_by, served, p.usageTask, res.stopReason === 'refusal' ? 'refused' : res.output ? 'ok' : 'failed', reservation.period, reservation.amount,
      res.inputTokens, res.outputTokens, cost, s.run.id, s.run.id]).catch((err) => log.error('ai_workflow.usage_record_failed', { runId: s.run.id, err: err as Error }));
  await db.query(`UPDATE ai_runs SET input_tokens=input_tokens+$2, output_tokens=output_tokens+$3, cost_estimate_usd=cost_estimate_usd+$4, provider=$5, model=$6,
                         latency_ms = coalesce(latency_ms, 0) + $7 WHERE id=$1`,
    [s.run.id, res.inputTokens, res.outputTokens, cost, client.provider, served, Date.now() - t0]);
  if (res.stopReason === 'refusal') throw new AppError('provider_error', 'The AI declined this request.');
  if (!res.output) throw new AppError('provider_error', 'The AI response was incomplete. Try again.');

  // Deterministic checks (same as V3.5 assistant runs).
  const allowedText = [...sources.map((x) => x.text), s.request ?? ''].join('\n');
  const linkText = [...sources.filter((x) => x.trust !== 'untrusted').map((x) => x.text), s.request ?? ''].join('\n');
  const approved = sources.filter((x) => x.trust === 'approved' && x.kind !== 'brand_voice');
  const approvedText = approved.filter((x) => !x.stale).map((x) => x.text).join('\n');
  const byRef = new Set(sources.map((x) => x.ref));
  const suggestions: CheckedSuggestion[] = res.output.suggestions.slice(0, 8).map((x) => {
    const text = x.text.normalize('NFC').replace(/[ \t]+$/gm, '').trim();
    const issues = checkOutput({ text, kind: x.kind, allowedText, linkText, approvedText, hasStaleApproved: approved.some((a) => a.stale), maxLength: p.maxLength ?? (x.kind === 'reply' ? 2000 : 6000), strict: false });
    if (!res.output!.answerable && (x.kind === 'reply' || x.kind === 'answer')) issues.push({ code: 'uncertain', severity: 'warn', message: 'The AI was not sure the sources answer this.' });
    return { kind: x.kind, text, language: /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(x.language) ? x.language : null, based_on: x.based_on.filter((b) => byRef.has(b)).slice(0, 10), issues };
  });
  const evidence = res.output.evidence.slice(0, 8).filter((e) => byRef.has(e.source)).map((e) => {
    const srcRow = sources.find((x) => x.ref === e.source)!;
    return { text: e.quote.slice(0, 400), source: srcRow.title, verified: verifyQuote(e.quote, srcRow.text) };
  });
  return {
    evidence,
    summary: res.output.summary.trim().slice(0, 600), suggestions, proposed: res.output.proposed.slice(0, 6), answerable: res.output.answerable,
    uncertainty: res.output.uncertainty.trim().slice(0, 300), ignored_instructions: countInjections(sources.filter((x) => x.trust === 'untrusted').map((x) => x.text)),
  };
}

export const firstOf = (o: ModelStepOutput, kind: SuggestionItem['kind']) => o.suggestions.find((x) => x.kind === kind && x.text && !x.issues.some((i) => i.severity === 'block')) ?? null;
export const issuesOf = (x: CheckedSuggestion | null) => (x?.issues ?? []).map((i) => ({ severity: i.severity, message: i.message }));
