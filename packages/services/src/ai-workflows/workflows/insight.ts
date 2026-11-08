// V5 §14 "Inbox assistance", "Performance analysis" and the single-step "Ask". Reads are authorized with the
// requester's current context; customer messages are untrusted content. Replies are only PREPARED (send_reply preview
// + "put in reply box"); nothing is sent by the run.
import { z } from 'zod';
import { AppError, PROVIDER_LABEL } from '@social-lite/core';
import type { OverviewResponse } from '@social-lite/core/contracts/analytics';
import { getPool, maybeOne } from '@social-lite/db';
import { authorizeCtx, requireAction } from '../../tenancy.js';
import { classifyText } from '../../assistant/classify.js';
import { retrieve } from '../../assistant/retrieval.js';
import { NotConfigured, StepSkip, plural, registerWorkflow, type StepCtx } from '../engine.js';
import { callModel, firstOf, issuesOf, type ModelStepOutput, type WfSource } from '../model.js';
import { brandContext, conversationsOf } from '../sources.js';
import { commonInput, hashOf, ids, uuid } from './common.js';

export const inboxInputSchema = z.object({ ...commonInput, conversation_ids: z.array(uuid).min(1).max(10) }).strict();
export const performanceInputSchema = z.object({ ...commonInput, range_days: z.union([z.literal(7), z.literal(28), z.literal(90)]) }).strict();
export const askInputSchema = z.object({ ...commonInput }).strict();

// ------------------------------------------------------------------ inbox assistance
interface ConvState { id: string; title: string; channel: string; kind: string; version: number; waiting_since: string | null; latest: string; sources: WfSource[] }

const ORDER_REF = /(#\s?\d{3,}|\border\s*(no\.?|number|#|id)?\s*[:#]?\s*[A-Z0-9-]{4,}|\b[A-Z]{2,4}-?\d{4,}\b)/i;

/** Deterministic "missing information" flags (shown as checks, never as facts about the customer). */
export function missingInfo(category: string, text: string): string[] {
  const out: string[] = [];
  if ((category === 'order_status' || category === 'refund') && !ORDER_REF.test(text)) out.push('No order number in the message.');
  if (category === 'support' && text.trim().split(/\s+/).length < 6) out.push('Very short message: the problem may need clarifying.');
  return out;
}

registerWorkflow({
  workflow: 'inbox_assistance',
  steps: () => [
    {
      key: 'read', label: 'Read conversations', kind: 'read',
      async run(s) {
        const wanted = ids(s.input.conversation_ids);
        await s.emit(`Reading ${plural(wanted.length, 'conversation')}.`);
        const rows = await conversationsOf(s.ctx, s.run.brand_id, wanted);
        const convs: ConvState[] = [];
        for (const id of wanted) {
          const row = rows.find((r) => r.id === id);
          try {
            if (!row) throw new AppError('not_found', 'Conversation not found');
            const srcs = await retrieve(s.ctx, 'suggest_reply', { type: 'conversation', id }, s.run.brand_id, { knowledgeIds: ids(s.input.knowledge_ids).length ? ids(s.input.knowledge_ids) : null });
            const latest = await maybeOne<{ body: string | null }>(getPool(),
              `SELECT body FROM inbox_messages WHERE conversation_id=$1 AND direction='inbound' AND deleted_at IS NULL AND body IS NOT NULL ORDER BY provider_created_at DESC LIMIT 1`, [id]);
            convs.push({ id, title: row.subject || row.preview?.slice(0, 60) || 'Conversation', channel: row.channel_kind, kind: row.kind, version: row.version,
              waiting_since: row.unanswered_since?.toISOString() ?? null, latest: latest?.body ?? '',
              sources: srcs.map((x) => ({ kind: x.kind, id: x.id, title: x.title, link: x.link, trust: x.trust, stale: x.stale, freshness: x.freshness, text: x.text })) });
          } catch {
            await s.emit('One conversation is no longer available to you and was skipped.', 'warn');
          }
        }
        if (!convs.length) throw new AppError('not_found', 'None of the selected conversations is available to you.');
        s.state.convs = convs;
        return { detail: `Read ${plural(convs.length, 'conversation')}.` };
      },
    },
    {
      key: 'triage', label: 'Summarise the issues', kind: 'validate',
      async run(s) {
        const convs = s.state.convs as ConvState[];
        let urgent = 0;
        for (const c of convs) {
          const k = classifyText(c.latest);
          if (k.urgency === 'high') urgent++;
          const flags = missingInfo(k.category, c.latest);
          await s.result({ item: c.id, kind: 'summary', title: c.title, record: { type: 'conversation', id: c.id }, body: null,
            data: {
              facts: [
                { label: 'Category', value: k.category.replace(/_/g, ' ') }, { label: 'Urgency', value: k.urgency },
                { label: 'Sentiment (estimate)', value: k.sentiment }, { label: 'Channel', value: c.channel },
                ...(c.waiting_since ? [{ label: 'Waiting since', value: c.waiting_since }] : []),
              ],
              issues: [...flags.map((m) => ({ severity: 'warn', message: m })), ...(k.injection_suspected ? [{ severity: 'warn', message: 'The message contains instruction-like text. It is treated as content only.' }] : [])],
            } });
        }
        await s.emit(`Summarised ${plural(convs.length, 'conversation')}${urgent ? `: ${urgent} urgent` : ''}.`, 'success');
        return { detail: `${convs.length} checked` };
      },
    },
    {
      key: 'drafts', label: 'Draft replies', kind: 'model',
      async run(s) {
        const convs = s.state.convs as ConvState[];
        const outputs: Record<string, ModelStepOutput> = { ...((s.prior.outputs as Record<string, ModelStepOutput>) ?? {}) };
        for (const c of convs) {
          await s.checkpointCancel();
          if (!outputs[c.id]) {
            await s.emit(`Drafting a reply for “${c.title.slice(0, 50)}”.`);
            outputs[c.id] = await callModel(s, { usageTask: 'suggest_reply', sources: c.sources, maxTokens: 2_000, maxLength: 2000,
              task: 'For the customer conversation in the sources: (1) one suggestion of kind "summary" describing the customer\'s issue in one sentence; (2) one suggestion of kind "reply" with a reply to the latest customer message, in their language, for an agent to review. List information the team must confirm before replying (order number, account details, policy) in "uncertainty". Use approved sources for any policy, price or timing; otherwise do not commit and say a teammate will confirm.' });
            await s.checkpoint({ outputs });
          }
          const out = outputs[c.id]!;
          const reply = firstOf(out, 'reply');
          const summary = firstOf(out, 'summary');
          await s.result({ item: c.id, kind: 'reply_draft', title: `Reply · ${c.title}`.slice(0, 200), body: reply?.text ?? null, generated: true, record: { type: 'conversation', id: c.id },
            data: { summary: summary?.text ?? null, issues: [...issuesOf(reply), ...(out.uncertainty ? [{ severity: 'warn', message: `Check before replying: ${out.uncertainty}` }] : []),
              ...(out.ignored_instructions ? [{ severity: 'warn', message: 'The conversation contained instructions; they were ignored.' }] : [])],
              evidence: out.evidence } });
        }
        return { result: { outputs }, detail: `Drafted ${plural(Object.keys(outputs).length, 'reply', 'replies')}.` };
      },
    },
    {
      key: 'prepare', label: 'Prepare replies for review', kind: 'external',
      async run(s) {
        const outputs = (s.state.drafts as { outputs?: Record<string, ModelStepOutput> } | undefined)?.outputs;
        if (!outputs) throw new StepSkip('No AI reply drafts to review.');
        if (!authorizeCtx(s.ctx, 'inbox.reply', { brandId: s.run.brand_id }).allowed) throw new StepSkip('You can’t reply on this brand: the drafts are ready for a teammate who can.');
        let n = 0;
        for (const c of s.state.convs as ConvState[]) {
          const reply = outputs[c.id] ? firstOf(outputs[c.id]!, 'reply') : null;
          if (!reply) continue;
          const mode = c.kind === 'dm' ? 'private_message' : 'public_reply';
          await s.propose({ kind: 'send_reply', target_type: 'conversation', target_id: c.id, requires: 'inbox.reply', result_item: `drafts:${c.id}`,
            bound_hash: hashOf({ c: c.id, m: mode, b: reply.text, v: c.version }),
            preview: { title: 'Send reply', detail: reply.text.slice(0, 280), params: { mode, body: reply.text, base_version: c.version } } });
          await s.propose({ kind: 'use_reply_draft', target_type: 'conversation', target_id: c.id, requires: 'inbox.reply', result_item: `drafts:${c.id}`, optional: true,
            preview: { title: 'Put in reply box', detail: reply.text.slice(0, 280), params: { body: reply.text } } });
          n++;
        }
        if (!n) throw new StepSkip('No reply passed the checks.');
        await s.emit(`Prepared ${plural(n, 'reply', 'replies')} for your review. Nothing is sent until you confirm.`, 'success');
        return { detail: `${n} ready for review` };
      },
    },
  ],
  summary: (st) => `Drafted ${plural(Object.keys((st.drafts as { outputs?: object } | undefined)?.outputs ?? {}).length, 'reply', 'replies')}.`,
});

// ------------------------------------------------------------------ performance analysis
interface Report { period: string; previous: string | null; tz: string; synthetic: boolean; lines: string[]; insights: string[]; coverage: string | null; link: string; posts: number; through: string | null }

const pct = (x: number | null) => (x === null ? 'n/a' : `${x > 0 ? '+' : ''}${(x * 100).toFixed(1)}%`);

export function reportFrom(o: OverviewResponse, brandId: string): Report {
  const p = o.meta.period;
  const lines = o.kpis.map((k) => `${k.label}: ${k.value ?? 'no data'} (previous ${k.comparison.previous ?? 'n/a'}, ${pct(k.comparison.change_pct)})`);
  for (const t of o.top_content.slice(0, 3)) lines.push(`Top post: “${(t.title ?? t.excerpt ?? 'Untitled').slice(0, 60)}” on ${PROVIDER_LABEL[t.provider]} — ${t.engagements ?? 'n/a'} engagements`);
  const cov = o.data_health.coverage;
  return {
    period: `${p.from} – ${p.to}`, previous: o.meta.previous_period ? `${o.meta.previous_period.from} – ${o.meta.previous_period.to}` : null, tz: p.timezone, synthetic: o.meta.synthetic,
    lines, insights: o.insights.map((i) => i.text), coverage: cov.eligible ? `${cov.with_data} of ${cov.eligible} eligible ${cov.unit} have data` : null,
    link: `/analytics?brand=${brandId}&from=${p.from}&to=${p.to}`, posts: Number(o.kpis.find((k) => k.measure === 'posts_published')?.value ?? 0), through: o.data_health.freshness.through_date,
  };
}

registerWorkflow({
  workflow: 'performance_analysis',
  steps: () => [
    {
      key: 'read', label: 'Read stored analytics', kind: 'read',
      async run(s) {
        requireAction(s.ctx, 'analytics.read', { brandId: s.run.brand_id });
        const days = Number(s.input.range_days) || 28;
        const { filtersFromQuery } = await import('../../analytics/api.js');
        const { overview } = await import('../../analytics/query.js');
        const to = new Date(Date.now() - 86_400_000);
        const from = new Date(to.getTime() - (days - 1) * 86_400_000);
        const filters = await filtersFromQuery(s.ctx, new URLSearchParams({ brand: s.run.brand_id, from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }));
        const rep = reportFrom(await overview(s.ctx, filters), s.run.brand_id);
        await s.emit(`Reading stored analytics for ${rep.period}.`);
        s.state.rep = rep;
        return { detail: rep.period };
      },
    },
    {
      key: 'report', label: 'Build the report', kind: 'validate',
      async run(s) {
        const r = s.state.rep as Report;
        await s.result({ item: 'report', kind: 'report', title: `Performance · ${r.period}`, record: { type: 'analytics', id: null },
          body: r.posts ? r.lines.join('\n') : 'No published posts with data in this period.',
          data: { link: r.link, facts: [{ label: 'Period', value: `${r.period} (${r.tz})` }, ...(r.previous ? [{ label: 'Compared with', value: r.previous }] : []),
            ...(r.coverage ? [{ label: 'Coverage', value: r.coverage }] : []), ...(r.through ? [{ label: 'Data complete through', value: r.through }] : []),
            ...(r.synthetic ? [{ label: 'Data', value: 'Demo data — not reported by a network' }] : [])],
          evidence: r.insights.map((t) => ({ text: t, source: 'Relay analytics' })) } });
        await s.emit('Built a report from stored data.', 'success');
        return { detail: r.coverage ?? 'Report ready' };
      },
    },
    {
      key: 'explain', label: 'Explain the changes', kind: 'model',
      async run(s) {
        const r = s.state.rep as Report;
        if (!r.posts) throw new StepSkip('Nothing to explain: no published posts with data in this period.');
        await s.emit('Explaining the observed changes.');
        const out = await callModel(s, { usageTask: 'explain_analytics', maxTokens: 2_000,
          sources: [{ kind: 'analytics', id: null, link: r.link, title: `Analytics ${r.period}`, trust: 'observed', stale: false, freshness: r.through,
            text: [`Period: ${r.period} (${r.tz})${r.previous ? `, compared with ${r.previous}` : ''}`, ...(r.synthetic ? ['Note: demo data (not reported by a network).'] : []), ...r.lines, ...r.insights.map((t) => `Observed: ${t}`), ...(r.coverage ? [`Coverage: ${r.coverage}`] : [])].join('\n') }],
          task: 'Explain the observed numbers in plain language: what changed and where, quoting the numbers you use as evidence. Do not state causes as facts; mark hypotheses clearly. One suggestion of kind "explanation". Propose up to 3 practical next steps as create_task actions (value = a short task title).' });
        const e = firstOf(out, 'explanation');
        if (!e) throw new AppError('provider_error', out.uncertainty || 'The AI could not explain these numbers.');
        await s.result({ item: 'explain', kind: 'summary', title: 'What changed', body: e.text, generated: true, data: { issues: issuesOf(e), evidence: out.evidence } });
        const tasks = out.proposed.filter((p) => p.kind === 'create_task' && p.value.trim()).slice(0, 3);
        for (const t of tasks) {
          const title = t.value.replace(/\s+/g, ' ').trim().slice(0, 120);
          await s.propose({ kind: 'create_task', target_type: 'brand', target_id: s.run.brand_id, requires: 'content.read', result_item: `explain:explain`, optional: true,
            preview: { title: 'Create task', detail: title, params: { title } } });
        }
        if (tasks.length) await s.emit(`Suggested ${plural(tasks.length, 'next step')} you can turn into tasks.`);
        return { result: { output: { text: e.text } } };
      },
    },
  ],
  summary: () => 'Report ready.',
});

// ------------------------------------------------------------------ ask (single step, ai_drafting)
registerWorkflow({
  workflow: 'ask',
  steps: () => [
    {
      key: 'read', label: 'Read brand context', kind: 'read',
      async run(s) {
        const ctx = await brandContext(s.ctx, s.run.brand_id, { knowledgeIds: ids(s.input.knowledge_ids), attachmentIds: ids(s.input.attachment_ids) });
        const approved = ctx.filter((x) => x.trust === 'approved' && x.kind !== 'brand_voice').length;
        await s.emit(approved ? `Reading ${plural(approved, 'approved source')}.` : 'Reading the brand voice.');
        s.state.sources = ctx;
        return { detail: `${ctx.length} sources` };
      },
    },
    {
      key: 'answer', label: 'Answer', kind: 'model',
      async run(s) {
        if (!s.request) throw new AppError('validation_failed', 'Write a question or task first.');
        await s.emit('Writing an answer.');
        let out: ModelStepOutput;
        try {
          out = await callModel(s, { usageTask: 'answer_question', sources: s.state.sources as WfSource[],
            task: 'Do what the team member asks using the sources: answer a question (kind "answer") or draft copy (kind "copy"). Cite evidence. If the sources do not cover it, say so and set answerable to false.' });
        } catch (err) { if (err instanceof NotConfigured) throw err; throw err; }
        const a = firstOf(out, 'answer') ?? firstOf(out, 'copy');
        await s.result({ item: 'answer', kind: 'answer', title: 'Answer', body: a?.text ?? (out.uncertainty || 'The sources do not cover this.'), generated: true,
          data: { issues: issuesOf(a), evidence: out.evidence, uncertainty: out.answerable ? null : out.uncertainty || null } });
        return { result: { output: { text: a?.text ?? null } } };
      },
    },
  ],
  summary: () => 'Answered.',
});

export type { StepCtx };
