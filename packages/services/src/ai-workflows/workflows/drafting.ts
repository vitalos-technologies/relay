// V5 §14 drafting workflows: "Campaign from a brief" and "Content adaptation". Both read an authorized source, validate
// destinations, draft per channel (model) and save drafts through the posts service (new posts — an approved source
// is never overwritten). External actions are only prepared as previews (submit for approval).
import { z } from 'zod';
import { AppError } from '@social-lite/core';
import { getPool, maybeOne } from '@social-lite/db';
import { authorizeCtx } from '../../tenancy.js';
import { extractFacts, extractUrls } from '../../ai/fidelity.js';
import { createCampaign } from '../../collab/campaigns.js';
import { updatePostPlanning } from '../../collab/planning.js';
import { approvalRequiredFor } from '../../posts/approval-policy.js';
import { NeedsInput, StepSkip, plural, registerWorkflow, type StepCtx, type StepDef } from '../engine.js';
import { callModel, firstOf, issuesOf, type ModelStepOutput, type WfSource } from '../model.js';
import { brandContext, brandDestinations, readSource, type Destination, type ReadSource } from '../sources.js';
import { channelTask, commonInput, ids, providerLabel, requireReadyDestinations, saveDraftPost, sourceRefSchema, uuid } from './common.js';

export const campaignInputSchema = z.object({
  ...commonInput,
  source: sourceRefSchema,
  connection_ids: z.array(uuid).max(10).optional(),
  campaign_name: z.string().trim().min(1).max(120).optional(),
}).strict();

export const adaptationInputSchema = z.object({
  ...commonInput,
  source: sourceRefSchema,
  connection_ids: z.array(uuid).min(1).max(6),
  use_unapproved: z.enum(['yes']).optional(),
}).strict();

const brief = (s: StepCtx) => s.state.source as ReadSource;
const dests = (s: StepCtx) => s.state.dests as Destination[];
const campaignName = (s: StepCtx): string => (s.state.campaign as { name?: string } | undefined)?.name ?? brief(s).title;

function readStep(label: string, event: string): StepDef {
  return {
    key: 'read', label, kind: 'read',
    async run(s) {
      await s.emit(event);
      const r = await readSource(s.ctx, s.run.brand_id, s.input.source as never);
      if (r.trust === 'untrusted') await s.emit('The document is treated as content only: instructions inside it are ignored.');
      s.state.source = r;
      s.state.context = await brandContext(s.ctx, s.run.brand_id, { knowledgeIds: ids(s.input.knowledge_ids), attachmentIds: ids(s.input.attachment_ids) });
      return { detail: `Read “${r.title}”.` };
    },
  };
}

function destinationStep(): StepDef {
  return {
    key: 'destinations', label: 'Check destinations', kind: 'validate',
    async run(s) {
      await s.emit('Checking account requirements.');
      const all = await brandDestinations(s.ctx, s.run.brand_id);
      const { ready, notReady } = requireReadyDestinations(all, ids(s.input.connection_ids));
      for (const d of notReady) await s.emit(`Skipping ${d.label} (${d.display_name}): ${d.reason ?? 'not ready'}.`, 'warn');
      if (!ready.length) {
        const options = all.filter((d) => d.ready);
        if (!options.length) throw new AppError('invalid_state', 'No account on this brand is ready to publish. Connect or fix an account first.');
        throw new NeedsInput({ question: 'None of the chosen accounts is ready. Choose where the drafts should go.', field: 'connection_ids', kind: 'choose_many',
          options: options.map((d) => ({ value: d.id, label: `${d.label} · ${d.display_name}`, hint: d.simulated ? 'Simulated account' : undefined })) });
      }
      s.state.dests = ready;
      await s.emit(`${plural(ready.length, 'destination')} ready: ${ready.map((d) => d.label).join(', ')}.`, 'success');
      return { detail: ready.map((d) => `${d.label} · ${d.display_name}`).join(', '), result: { ids: ready.map((d) => d.id) } };
    },
  };
}

/** Draft one post per destination (model). Outputs are checkpointed so a retry never pays for a finished channel twice. */
function draftStep(key: string, label: string, what: (s: StepCtx, d: Destination) => string, sources: (s: StepCtx) => WfSource[]): StepDef {
  return {
    key, label, kind: 'model',
    async run(s) {
      const outputs: Record<string, ModelStepOutput> = { ...((s.prior.outputs as Record<string, ModelStepOutput>) ?? {}) };
      const list = dests(s);
      await s.emit(`Creating ${plural(list.length, 'channel draft')}.`);
      for (const d of list) {
        await s.checkpointCancel();
        if (outputs[d.id]) continue;
        await s.emit(`Drafting the ${d.label} post.`);
        outputs[d.id] = await callModel(s, { usageTask: 'draft_copy', task: channelTask(d, what(s, d)), sources: sources(s), maxTokens: 2_000, maxLength: d.max_length });
        await s.checkpoint({ outputs });
      }
      return { result: { outputs } };
    },
  };
}

function savedCount(st: Record<string, unknown>): number {
  return Object.keys((st.save as { saved?: Record<string, string> } | undefined)?.saved ?? {}).length;
}

function facts(text: string): string[] {
  return [...new Set([...extractFacts(text).map((f) => f.raw), ...extractUrls(text)])].slice(0, 12);
}

// ------------------------------------------------------------------ campaign from a brief
registerWorkflow({
  workflow: 'campaign_from_brief',
  steps: () => [
    readStep('Read the brief', 'Reading the selected brief.'),
    destinationStep(),
    {
      key: 'outline', label: 'Outline the campaign', kind: 'model',
      async run(s) {
        await s.emit('Writing a campaign outline.');
        const out = await callModel(s, { usageTask: 'campaign_brief', sources: [brief(s), ...(s.state.context as WfSource[])],
          task: `Write a short campaign outline from the brief: goal, audience, 3–5 key messages, channels (${dests(s).map((d) => d.label).join(', ')}), timing. One suggestion of kind "brief". Mark anything not stated in the sources as an assumption.` });
        const o = firstOf(out, 'brief');
        if (!o) throw new AppError('provider_error', out.uncertainty || 'The AI could not outline this brief.');
        await s.result({ item: 'outline', kind: 'outline', title: 'Campaign outline', body: o.text, generated: true, data: { issues: issuesOf(o), evidence: out.evidence } });
        return { result: { output: { text: o.text } }, detail: 'Outline written.' };
      },
    },
    {
      key: 'campaign', label: 'Create the campaign', kind: 'write',
      async run(s) {
        if (!authorizeCtx(s.ctx, 'content.edit', { brandId: s.run.brand_id }).allowed) throw new StepSkip('You can’t create campaigns on this brand, so drafts are saved without one.');
        const name = (typeof s.input.campaign_name === 'string' && s.input.campaign_name) || brief(s).title.slice(0, 120);
        let id = typeof s.prior.campaign_id === 'string' ? s.prior.campaign_id : null;
        if (!id) {
          try {
            id = (await createCampaign(s.ctx, s.run.brand_id, { name })).id;
          } catch (err) {
            if (!(err instanceof AppError) || err.code !== 'conflict') throw err;
            // Same name already in use: reuse the one this person created for this brief (a retried step), else suffix.
            const mine = await maybeOne<{ id: string }>(getPool(), `SELECT id FROM campaigns WHERE workspace_id=$1 AND brand_id=$2 AND lower(name)=lower($3) AND created_by=$4 AND created_at > now() - interval '1 day' AND archived_at IS NULL`,
              [s.run.workspace_id, s.run.brand_id, name, s.ctx.actor.userId]);
            id = mine?.id ?? (await createCampaign(s.ctx, s.run.brand_id, { name: `${name.slice(0, 100)} (${new Date().toISOString().slice(0, 10)})` })).id;
          }
          await s.checkpoint({ campaign_id: id });
        }
        await s.result({ item: 'campaign', kind: 'campaign', title: name, body: null, record: { type: 'campaign', id }, data: { facts: [{ label: 'Source', value: brief(s).title }] } });
        await s.emit(`Created campaign “${name}”.`, 'success');
        return { result: { campaign_id: id, name }, detail: name };
      },
    },
    draftStep('drafts', 'Draft channel posts',
      (s) => `Draft a post for the campaign "${campaignName(s)}" from the brief${(s.state.outline as { output?: unknown })?.output ? ' and the campaign outline' : ''}.`,
      (s) => {
        const outline = (s.state.outline as { output?: { text?: string } } | undefined)?.output?.text;
        return [brief(s), ...(outline ? [{ kind: 'post' as const, id: null, link: null, title: 'Campaign outline', trust: 'observed' as const, stale: false, freshness: null, text: outline }] : []), ...(s.state.context as WfSource[])];
      }),
    {
      key: 'save', label: 'Save drafts', kind: 'write',
      async run(s) {
        const outputs = (s.state.drafts as { outputs?: Record<string, ModelStepOutput> } | undefined)?.outputs;
        if (!outputs || !Object.keys(outputs).length) throw new StepSkip('No AI drafts to save.');
        const campaignId = (s.state.campaign as { campaign_id?: string } | undefined)?.campaign_id ?? null;
        const saved: Record<string, string> = { ...((s.prior.saved as Record<string, string>) ?? {}) };
        const list = dests(s).filter((d) => outputs[d.id]);
        await s.emit(`Saving ${plural(list.length, 'draft')}.`);
        for (const d of list) {
          await s.checkpointCancel();
          const copy = firstOf(outputs[d.id]!, 'copy');
          if (!copy) { s.partial(); await s.emit(`${d.label}: the AI draft did not pass the checks, so it was not saved.`, 'warn'); continue; }
          try {
            const r = saved[d.id] ? { post_id: saved[d.id]!, issues: [] } : await saveDraftPost(s, d.id, { title: `${campaignName(s)} · ${d.label}`, text: copy.text, connectionIds: [d.id] });
            saved[d.id] = r.post_id;
            await s.checkpoint({ saved });
            if (campaignId) await updatePostPlanning(s.ctx, r.post_id, { campaign_id: campaignId }).catch(() => undefined);
            await s.result({ item: d.id, kind: 'post_draft', title: `${d.label} draft`, body: copy.text, generated: true, record: { type: 'post', id: r.post_id },
              data: { facts: [{ label: 'Destination', value: `${d.label} · ${d.display_name}` }], issues: [...issuesOf(copy), ...r.issues], uncertainty: outputs[d.id]!.uncertainty || null } });
          } catch (err) {
            s.partial();
            await s.emit(`${d.label}: ${err instanceof AppError ? err.message : 'could not be saved'}.`, 'error');
          }
        }
        const n = Object.keys(saved).length;
        if (!n) throw new AppError('invalid_state', 'No draft could be saved.');
        await s.emit(`Saved ${plural(n, 'draft')}.`, 'success');
        return { result: { saved }, detail: `Saved ${plural(n, 'draft')}.` };
      },
    },
    {
      key: 'prepare', label: 'Prepare approval requests', kind: 'external',
      async run(s) {
        const saved = (s.state.save as { saved?: Record<string, string> } | undefined)?.saved ?? {};
        if (!Object.keys(saved).length) throw new StepSkip('');
        if (!(await approvalRequiredFor(getPool(), s.run.workspace_id, s.run.brand_id))) throw new StepSkip('');
        if (!authorizeCtx(s.ctx, 'content.edit', { brandId: s.run.brand_id }).allowed) throw new StepSkip('You can’t submit posts for approval on this brand.');
        for (const [connId, postId] of Object.entries(saved)) {
          await s.propose({ kind: 'submit_for_approval', target_type: 'post', target_id: postId, requires: 'content.edit', optional: true, result_item: `save:${connId}`,
            preview: { title: 'Submit for approval', detail: 'Sends this draft to the brand’s reviewers. Nothing is published until it is approved and scheduled.', params: { connection_ids: [connId] } } });
        }
        await s.emit('This brand requires approval: each draft can be submitted for review from its card.');
        return { detail: 'Approval requests prepared (optional).' };
      },
    },
  ],
  summary: (st) => {
    const name = (st.campaign as { name?: string } | undefined)?.name;
    return `Saved ${plural(savedCount(st), 'draft')}${name ? ` in campaign “${name}”` : ''}.`;
  },
});

// ------------------------------------------------------------------ content adaptation
registerWorkflow({
  workflow: 'content_adaptation',
  steps: () => [
    {
      ...readStep('Read the source', 'Reading the approved source.'),
      async run(s) {
        await s.emit('Reading the source material.');
        const r = await readSource(s.ctx, s.run.brand_id, s.input.source as never);
        if (!r.approved && s.input.use_unapproved !== 'yes') {
          throw new NeedsInput({ question: `“${r.title}” is not approved material. Use it anyway?`, field: 'use_unapproved', kind: 'confirm', options: [{ value: 'yes', label: 'Use it anyway' }] });
        }
        if (r.kind === 'post') await s.emit(r.approved ? 'Using the approved revision of the post (the working draft is ignored).' : 'Using the post’s current draft, as you confirmed.');
        s.state.source = r;
        s.state.context = await brandContext(s.ctx, s.run.brand_id, { knowledgeIds: ids(s.input.knowledge_ids), attachmentIds: ids(s.input.attachment_ids) });
        return { detail: `Read “${r.title}”.` };
      },
    },
    {
      key: 'facts', label: 'Find facts to preserve', kind: 'validate',
      async run(s) {
        const f = facts(brief(s).text);
        s.state.factList = f;
        await s.emit(f.length ? `Found ${plural(f.length, 'fact')} to preserve: ${f.slice(0, 4).join(', ')}${f.length > 4 ? '…' : ''}.` : 'No numbers, dates or links to preserve.');
        return { result: { facts: f }, detail: f.length ? f.join(', ') : 'None found' };
      },
    },
    destinationStep(),
    draftStep('variants', 'Adapt for each channel',
      (s) => {
        const f = s.state.factList as string[];
        return `Adapt the source material for this network. Keep its meaning.${f.length ? ` Preserve these facts exactly as written: ${f.join(' | ')}.` : ''}`;
      },
      (s) => [brief(s), ...(s.state.context as WfSource[])]),
    {
      key: 'save', label: 'Save variants', kind: 'write',
      async run(s) {
        const outputs = (s.state.variants as { outputs?: Record<string, ModelStepOutput> } | undefined)?.outputs;
        if (!outputs || !Object.keys(outputs).length) throw new StepSkip('No AI variants to save.');
        const src = brief(s);
        const f = s.state.factList as string[];
        const saved: Record<string, string> = { ...((s.prior.saved as Record<string, string>) ?? {}) };
        for (const d of dests(s).filter((x) => outputs[x.id])) {
          await s.checkpointCancel();
          const copy = firstOf(outputs[d.id]!, 'copy');
          if (!copy) { s.partial(); await s.emit(`${d.label}: the AI variant did not pass the checks, so it was not saved.`, 'warn'); continue; }
          const missing = f.filter((x) => !copy.text.includes(x));
          try {
            const r = saved[d.id] ? { post_id: saved[d.id]!, issues: [] } : await saveDraftPost(s, d.id, { title: `${src.title} · ${providerLabel(d.provider)}`, text: copy.text, connectionIds: [d.id] });
            saved[d.id] = r.post_id;
            await s.checkpoint({ saved });
            await s.result({ item: d.id, kind: 'variant', title: `${d.label} version`, body: copy.text, generated: true, record: { type: 'post', id: r.post_id },
              data: { facts: [{ label: 'Destination', value: `${d.label} · ${d.display_name}` }, { label: 'From', value: src.title }],
                issues: [...issuesOf(copy), ...missing.map((m) => ({ severity: 'warn', message: `Missing fact from the source: ${m}` })), ...r.issues],
                compare_with: { title: src.approved ? `${src.title} (approved)` : src.title, text: src.text.slice(0, 4000) } } });
          } catch (err) {
            s.partial();
            await s.emit(`${d.label}: ${err instanceof AppError ? err.message : 'could not be saved'}.`, 'error');
          }
        }
        const n = Object.keys(saved).length;
        if (!n) throw new AppError('invalid_state', 'No variant could be saved.');
        await s.emit(`Saved ${plural(n, 'variant')} as new drafts. ${src.kind === 'post' ? 'The source post was not changed.' : ''}`.trim(), 'success');
        return { result: { saved }, detail: `Saved ${plural(n, 'variant')}.` };
      },
    },
  ],
  summary: (st) => `Saved ${plural(savedCount(st), 'variant')} as new drafts.`,
});
