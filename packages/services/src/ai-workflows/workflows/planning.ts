// V5 §14 "Weekly planning": inspect the brand's calendar and ready/approved content, propose a practical schedule on
// the brand's posting slots (or disclosed default times), flag conflicts and missing assets, create drafts for empty
// slots (model) and PREPARE scheduling actions. Scheduling itself only happens when the person confirms each previewed
// action (destinations + exact time + content), through the shared scheduling service with its approval rules.
import { z } from 'zod';
import { resolveWallTime, type DraftContent } from '@social-lite/core';
import { getPool, many, type Queryable } from '@social-lite/db';
import { authorizeCtx, requireAction } from '../../tenancy.js';
import { approvalRequiredFor } from '../../posts/approval-policy.js';
import { loadPost, validateDraft } from '../../posts/service.js';
import { occurrencesAfter } from '../../slots/recurrence.js';
import { StepSkip, holdsPermission, plural, registerWorkflow, type StepCtx } from '../engine.js';
import { callModel, issuesOf, type ModelStepOutput, type WfSource } from '../model.js';
import { brandContext, brandDestinations, type Destination } from '../sources.js';
import { commonInput, hashOf, humanTime, ids, localInput, saveDraftPost, uuid } from './common.js';

export const weeklyInputSchema = z.object({
  ...commonInput,
  week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  connection_ids: z.array(uuid).max(10).optional(),
}).strict();

interface CalItem { post_id: string; title: string; due_at: string; local: string; connection_ids: string[]; status: string }
interface Candidate { post_id: string; title: string; version: number; connection_ids: string[]; approved: boolean; has_media: boolean; valid: boolean; problems: string[] }
interface Slot { local: string; instant: string; connection_ids: string[] | null }
interface PlanItem { post_id: string; title: string; version: number; connection_ids: string[]; local: string; tz: string; isNew?: boolean }

const CONFLICT_MS = 60 * 60_000;
const MEDIA_PROVIDERS = new Set(['instagram', 'tiktok', 'youtube', 'pinterest']);

async function brandTz(db: Queryable, s: StepCtx): Promise<string> {
  const b = await many<{ timezone: string }>(db, `SELECT timezone FROM brands WHERE id=$1 AND workspace_id=$2`, [s.run.brand_id, s.run.workspace_id]);
  return b[0]?.timezone ?? 'UTC';
}

function weekBounds(start: string, tz: string): { from: Date; to: Date } {
  const a = resolveWallTime(`${start}T00:00`, tz);
  const from = a.kind === 'ok' ? a.instant : a.kind === 'ambiguous' ? a.options[0]!.instant : new Date(`${start}T00:00:00Z`);
  return { from, to: new Date(from.getTime() + 7 * 86_400_000) };
}

/** Free slot occurrences in the week, minus times already taken on the same account (±1 h). Pure — exported for tests. */
export function freeSlots(slots: Slot[], cal: CalItem[], now: Date): Slot[] {
  return slots.filter((sl) => new Date(sl.instant).getTime() > now.getTime() + 15 * 60_000)
    .filter((sl) => !cal.some((c) => Math.abs(new Date(c.due_at).getTime() - new Date(sl.instant).getTime()) < CONFLICT_MS && (!sl.connection_ids || sl.connection_ids.some((x) => c.connection_ids.includes(x)))));
}

/** Pairs of calendar items on the same account less than an hour apart. Pure — exported for tests. */
export function conflicts(cal: CalItem[]): Array<[CalItem, CalItem]> {
  const out: Array<[CalItem, CalItem]> = [];
  for (let i = 0; i < cal.length; i++) for (let j = i + 1; j < cal.length; j++) {
    const a = cal[i]!, b = cal[j]!;
    if (a.connection_ids.some((x) => b.connection_ids.includes(x)) && Math.abs(new Date(a.due_at).getTime() - new Date(b.due_at).getTime()) < CONFLICT_MS) out.push([a, b]);
  }
  return out;
}

registerWorkflow({
  workflow: 'weekly_planning',
  steps: () => [
    {
      key: 'calendar', label: 'Read the calendar', kind: 'read',
      async run(s) {
        requireAction(s.ctx, 'content.read', { brandId: s.run.brand_id });
        const db = getPool();
        const tz = await brandTz(db, s);
        const { from, to } = weekBounds(String(s.input.week_start), tz);
        const rows = await many<{ post_id: string; title: string | null; due_at: Date; status: string; connection_ids: string[] | null }>(db,
          `SELECT s.post_id, p.title, s.due_at, s.status, (SELECT array_agg(DISTINCT d.connection_id) FROM deliveries d WHERE d.schedule_id=s.id) AS connection_ids
             FROM schedules s JOIN posts p ON p.id=s.post_id
            WHERE s.workspace_id=$1 AND s.brand_id=$2 AND s.status IN ('active','pending_approval') AND s.due_at >= $3 AND s.due_at < $4 AND p.deleted_at IS NULL
            ORDER BY s.due_at`, [s.run.workspace_id, s.run.brand_id, from, to]);
        const cal: CalItem[] = rows.map((r) => ({ post_id: r.post_id, title: r.title || 'Untitled post', due_at: r.due_at.toISOString(), local: localInput(r.due_at, tz), connection_ids: r.connection_ids ?? [], status: r.status }));
        s.state.tz = tz; s.state.week = { from: from.toISOString(), to: to.toISOString() }; s.state.cal = cal;
        await s.emit(`Reading this week’s calendar: ${plural(cal.length, 'post')} already planned.`);
        return { detail: `${cal.length} planned` };
      },
    },
    {
      key: 'content', label: 'Find ready and approved content', kind: 'read',
      async run(s) {
        const db = getPool();
        const rows = await many<{ id: string; title: string | null; version: number; draft: DraftContent; approved: boolean }>(db,
          `SELECT p.id, p.title, p.version, p.draft,
                  EXISTS (SELECT 1 FROM approvals a WHERE a.post_id=p.id AND a.decision='approved') AS approved
             FROM posts p
            WHERE p.workspace_id=$1 AND p.brand_id=$2 AND p.deleted_at IS NULL AND p.archived_at IS NULL
              AND coalesce(p.draft->>'baseText','') <> '' AND jsonb_array_length(coalesce(p.draft->'variants','[]'::jsonb)) > 0
              AND NOT EXISTS (SELECT 1 FROM schedules x WHERE x.post_id=p.id AND x.status IN ('active','pending_approval','completed'))
            ORDER BY approved DESC, p.updated_at DESC LIMIT 10`, [s.run.workspace_id, s.run.brand_id]);
        const dests = await brandDestinations(s.ctx, s.run.brand_id);
        const byId = new Map(dests.map((d) => [d.id, d]));
        const out: Candidate[] = [];
        for (const r of rows) {
          await s.checkpointCancel();
          const conn = r.draft.variants.map((v) => v.connectionId).filter((id) => byId.get(id)?.ready);
          const hasMedia = r.draft.baseAssetIds.length > 0 || r.draft.variants.some((v) => (v.assetIds ?? []).length > 0);
          const problems: string[] = [];
          if (!conn.length) problems.push('No ready destination.');
          if (!hasMedia && conn.some((id) => MEDIA_PROVIDERS.has(byId.get(id)!.provider) || byId.get(id)!.requires_media)) problems.push('Missing an image or video for a destination that needs one.');
          let valid = conn.length > 0;
          if (valid) {
            try {
              const v = await validateDraft(db, s.ctx, await loadPost(s.ctx, r.id, db), conn);
              if (!v.ok) { valid = false; problems.push(...v.issues.slice(0, 2).map((i) => i.message)); }
            } catch { valid = false; problems.push('Could not be validated.'); }
          }
          out.push({ post_id: r.id, title: r.title || 'Untitled post', version: r.version, connection_ids: conn, approved: r.approved, has_media: hasMedia, valid, problems });
        }
        s.state.candidates = out; s.state.dests = dests;
        await s.emit(`Found ${plural(out.length, 'unscheduled draft')}${out.some((c) => c.approved) ? ` (${out.filter((c) => c.approved).length} approved)` : ''}.`);
        return { detail: `${out.length} candidates` };
      },
    },
    {
      key: 'check', label: 'Check conflicts and missing assets', kind: 'validate',
      async run(s) {
        const cal = s.state.cal as CalItem[];
        const cands = s.state.candidates as Candidate[];
        const tz = String(s.state.tz);
        const cs = conflicts(cal);
        const missing = cands.filter((c) => c.problems.some((p) => p.startsWith('Missing')));
        const invalid = cands.filter((c) => !c.valid && !c.problems.some((p) => p.startsWith('Missing')));
        const lines = [
          ...cs.map(([a, b]) => `Conflict: “${a.title}” and “${b.title}” are less than an hour apart on the same account (${humanTime(a.local, tz)}).`),
          ...missing.map((c) => `Missing asset: “${c.title}” needs an image or video.`),
          ...invalid.map((c) => `Not ready: “${c.title}” — ${c.problems.join(' ')}`),
        ];
        await s.result({ item: 'checks', kind: 'notice', title: lines.length ? `Checks · ${plural(lines.length, 'item')} to look at` : 'Checks · nothing to fix', body: lines.join('\n') || 'No conflicts or missing assets found.',
          data: { facts: [{ label: 'Planned this week', value: String(cal.length) }, { label: 'Conflicts', value: String(cs.length) }, { label: 'Missing assets', value: String(missing.length) }] } });
        await s.emit(cs.length || missing.length ? `Found ${plural(cs.length, 'conflict')} and ${plural(missing.length, 'draft')} missing images.` : 'No conflicts or missing assets.', cs.length || missing.length ? 'warn' : 'success');
        return { detail: `${cs.length} conflicts, ${missing.length} missing assets` };
      },
    },
    {
      key: 'propose', label: 'Propose a schedule', kind: 'validate',
      async run(s) {
        const db = getPool();
        const tz = String(s.state.tz);
        const week = s.state.week as { from: string; to: string };
        const dests = (s.state.dests as Destination[]).filter((d) => d.ready && (!ids(s.input.connection_ids).length || ids(s.input.connection_ids).includes(d.id)));
        const slotRows = await many<{ weekdays: number[]; local_time: string; timezone: string; connection_ids: string[] }>(db,
          `SELECT weekdays, local_time, timezone, connection_ids FROM posting_slots WHERE workspace_id=$1 AND brand_id=$2 AND archived_at IS NULL AND active`, [s.run.workspace_id, s.run.brand_id]);
        const from = new Date(week.from), to = new Date(week.to);
        let slots: Slot[] = [];
        for (const r of slotRows) {
          for (const o of occurrencesAfter({ weekdays: r.weekdays.map(Number), localTime: r.local_time, timezone: r.timezone }, new Date(from.getTime() - 1), 8)) {
            if (o.kind === 'ok' && o.instant < to) slots.push({ local: o.local, instant: o.instant.toISOString(), connection_ids: r.connection_ids?.length ? r.connection_ids : null });
          }
        }
        const defaults = !slots.length;
        if (defaults) {
          // No posting slots: weekdays 10:00 in the brand's zone (disclosed on the plan).
          for (let i = 0; i < 7; i++) {
            const day = new Date(from.getTime() + i * 86_400_000 + 12 * 3_600_000);
            const local = `${localInput(day, tz).slice(0, 10)}T10:00`;
            const wd = new Date(`${local.slice(0, 10)}T12:00:00Z`).getUTCDay();
            if (wd === 0 || wd === 6) continue;
            const r = resolveWallTime(local, tz);
            if (r.kind === 'ok') slots.push({ local, instant: r.instant.toISOString(), connection_ids: null });
          }
        }
        slots = freeSlots(slots.sort((a, b) => a.instant.localeCompare(b.instant)), s.state.cal as CalItem[], new Date());
        const ready = (s.state.candidates as Candidate[]).filter((c) => c.valid && !c.problems.length);
        const plan: PlanItem[] = [];
        const left = [...slots];
        for (const c of ready) {
          const i = left.findIndex((sl) => !sl.connection_ids || sl.connection_ids.some((x) => c.connection_ids.includes(x)));
          if (i < 0) continue;
          const sl = left.splice(i, 1)[0]!;
          plan.push({ post_id: c.post_id, title: c.title, version: c.version, connection_ids: c.connection_ids, local: sl.local.slice(0, 16), tz });
        }
        for (const p of plan) {
          await s.result({ item: p.post_id, kind: 'schedule_plan', title: p.title, record: { type: 'post', id: p.post_id }, body: null,
            data: { facts: [{ label: 'Proposed time', value: humanTime(p.local, tz) }, { label: 'Destinations', value: p.connection_ids.map((id) => dests.find((d) => d.id === id)?.label ?? 'Account').join(', ') || '—' },
              { label: 'Based on', value: defaults ? 'Default time (no posting slots set)' : 'Posting slot' }] } });
        }
        s.state.plan = plan; s.state.free = left.slice(0, 3); s.state.ready_dests = dests;
        await s.emit(plan.length ? `Proposed times for ${plural(plan.length, 'draft')}${defaults ? ' (default times: no posting slots are set)' : ''}.` : 'No ready draft to place this week.', plan.length ? 'success' : 'info');
        return { detail: `${plan.length} placed, ${left.length} free slots` };
      },
    },
    {
      key: 'ideas', label: 'Draft posts for empty slots', kind: 'model',
      async run(s) {
        const free = s.state.free as Slot[];
        const dests = s.state.ready_dests as Destination[];
        if (!free.length || !dests.length) throw new StepSkip(dests.length ? 'Every free slot already has a draft.' : 'No ready account to draft for.');
        if (!authorizeCtx(s.ctx, 'content.edit', { brandId: s.run.brand_id }).allowed) throw new StepSkip('You can’t create drafts on this brand.');
        if (s.prior.output) return { result: { output: s.prior.output } };
        await s.emit(`Drafting ${plural(free.length, 'post idea')} for empty slots.`);
        const cal = s.state.cal as CalItem[];
        const ctx = await brandContext(s.ctx, s.run.brand_id, { knowledgeIds: ids(s.input.knowledge_ids), attachmentIds: ids(s.input.attachment_ids) });
        const planned: WfSource = { kind: 'post', id: null, link: null, title: 'Already planned this week', trust: 'observed', stale: false, freshness: null,
          text: cal.map((c) => `${c.local}: ${c.title}`).join('\n') || 'Nothing planned yet.' };
        const out = await callModel(s, { usageTask: 'draft_copy', sources: [planned, ...ctx], maxTokens: 3_000,
          task: `Suggest ${free.length} different social posts for this week that complement what is already planned (no repeats). Return each as a suggestion of kind "copy" (max 280 characters each, suitable for ${dests.map((d) => d.label).join(', ')}). Use only facts from the sources.` });
        return { result: { output: out } };
      },
    },
    {
      key: 'save_ideas', label: 'Save new drafts', kind: 'write',
      async run(s) {
        const out = (s.state.ideas as { output?: ModelStepOutput } | undefined)?.output;
        const free = s.state.free as Slot[];
        const dests = (s.state.ready_dests as Destination[]).filter((d) => !d.requires_media);
        if (!out) throw new StepSkip('No AI drafts to save.');
        if (!dests.length) throw new StepSkip('Every ready account needs an image or video, so text drafts were not created.');
        const copies = out.suggestions.filter((x) => x.kind === 'copy' && !x.issues.some((i) => i.severity === 'block')).slice(0, free.length);
        const saved: Record<string, string> = { ...((s.prior.saved as Record<string, string>) ?? {}) };
        const added: PlanItem[] = [];
        for (let i = 0; i < copies.length; i++) {
          await s.checkpointCancel();
          const sl = free[i]!;
          const conn = dests.filter((d) => !sl.connection_ids || sl.connection_ids.includes(d.id)).map((d) => d.id);
          if (!conn.length) continue;
          const r = saved[String(i)] ? { post_id: saved[String(i)]!, issues: [] } : await saveDraftPost(s, `idea${i}`, { title: `Idea for ${humanTime(sl.local.slice(0, 16), String(s.state.tz)).split(' (')[0]}`, text: copies[i]!.text, connectionIds: conn });
          saved[String(i)] = r.post_id;
          await s.checkpoint({ saved });
          const p = await loadPost(s.ctx, r.post_id);
          added.push({ post_id: r.post_id, title: p.title ?? 'New draft', version: p.version, connection_ids: conn, local: sl.local.slice(0, 16), tz: String(s.state.tz), isNew: true });
          await s.result({ item: r.post_id, kind: 'post_draft', title: p.title ?? 'New draft', body: copies[i]!.text, generated: true, record: { type: 'post', id: r.post_id },
            data: { facts: [{ label: 'Proposed time', value: humanTime(sl.local.slice(0, 16), String(s.state.tz)) }], issues: [...issuesOf(copies[i]!), ...r.issues] } });
        }
        if (added.length) await s.emit(`Saved ${plural(added.length, 'new draft')}.`, 'success');
        return { result: { saved, added } };
      },
    },
    {
      key: 'prepare', label: 'Prepare scheduling for review', kind: 'external',
      async run(s) {
        const plan = [...(s.state.plan as PlanItem[]), ...(((s.state.save_ideas as { added?: PlanItem[] } | undefined)?.added) ?? [])];
        if (!plan.length) throw new StepSkip('Nothing to schedule.');
        const needsApproval = await approvalRequiredFor(getPool(), s.run.workspace_id, s.run.brand_id);
        const perm = needsApproval ? 'content.edit' : 'content.schedule'; // what the scheduling service checks (submit = drafts.edit)
        if (!holdsPermission(s.ctx, perm, s.run.brand_id)) {
          throw new StepSkip(needsApproval ? 'You can’t submit posts for approval on this brand: share the plan with a teammate.' : 'You can’t schedule posts on this brand: share the plan with a teammate who can.');
        }
        for (const p of plan) {
          await s.propose({ kind: 'schedule_post', target_type: 'post', target_id: p.post_id, requires: perm, result_item: `${p.isNew ? 'save_ideas' : 'propose'}:${p.post_id}`,
            bound_hash: hashOf({ p: p.post_id, v: p.version, c: [...p.connection_ids].sort(), t: p.local, z: p.tz }),
            preview: { title: needsApproval ? 'Submit for approval at this time' : 'Schedule', detail: `${humanTime(p.local, p.tz)} · ${p.title}`,
              params: { connection_ids: p.connection_ids, local_time: p.local, timezone: p.tz, expected_version: p.version, approval_required: needsApproval } } });
        }
        await s.emit(`Prepared ${plural(plan.length, 'scheduling action')} for your review. Nothing is scheduled until you confirm.`, 'success');
        return { detail: `${plan.length} ready for review` };
      },
    },
  ],
  summary: () => 'Plan ready.',
});
