// Listening actions: sentiment correction, exclusion, per-channel opt-out, and turning an insight into work (brief §15:
// "Create task, case, or content draft from an insight"). Insight actions reuse the normal domain services with the
// caller's own permissions (collab tasks: content.read + contributor; cases: cases.manage via the inbox; drafts:
// drafts.edit) and never copy customer text into the new record — only a link back (so source deletions propagate).
// Idempotent per client key (advisory lock + UNIQUE(workspace, idempotency_key)).
import { AppError, notFound } from '@social-lite/core';
import { getPool, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { assertUuid, authorizeCtx, brandAllowed, requireAction } from '../tenancy.js';
import { createTask } from '../collab/tasks.js';
import { createCase } from '../inbox/cases.js';
import { createPost } from '../posts/service.js';
import { sourceLabel } from './sources.js';
import { canListen, loadObservation, loadSearch, LISTENING_MANAGE, LISTENING_READ } from './shared.js';

export const correctionSchema = z.object({ label: z.enum(['positive', 'negative', 'neutral', 'mixed']).nullable() }).strict();
export const exclusionSchema = z.object({ excluded: z.boolean(), reason: z.string().trim().max(200).nullable().optional() }).strict();

export async function correctSentiment(ctx: Ctx, id: string, input: z.infer<typeof correctionSchema>): Promise<{ ok: true; effective: string }> {
  return withTx(async (tx) => {
    const o = await loadObservation(ctx, id, LISTENING_MANAGE, tx, true);
    if (o.removed_at || !o.body) throw new AppError('invalid_state', 'This mention was removed at the source.');
    await tx.query(`UPDATE listening_observations SET corrected_label=$2, corrected_by=CASE WHEN $2::text IS NULL THEN NULL ELSE $3::uuid END, corrected_at=CASE WHEN $2::text IS NULL THEN NULL ELSE now() END WHERE id=$1`,
      [id, input.label, ctx.actor.userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: o.brand_id, actorUserId: ctx.actor.userId, action: 'listening.sentiment_corrected', resourceType: 'listening_observation', resourceId: id, diff: { from: o.corrected_label ?? o.sentiment_label, to: input.label ?? o.sentiment_label, inferred: o.sentiment_label }, correlationId: ctx.correlationId });
    return { ok: true as const, effective: input.label ?? o.sentiment_label };
  });
}

export async function setExcluded(ctx: Ctx, id: string, input: z.infer<typeof exclusionSchema>): Promise<{ ok: true }> {
  return withTx(async (tx) => {
    const o = await loadObservation(ctx, id, LISTENING_MANAGE, tx, true);
    await tx.query(`UPDATE listening_observations SET excluded_at=CASE WHEN $2 THEN now() ELSE NULL END, excluded_by=CASE WHEN $2 THEN $3::uuid ELSE NULL END, excluded_reason=CASE WHEN $2 THEN $4 ELSE NULL END WHERE id=$1`,
      [id, input.excluded, ctx.actor.userId, input.reason ?? null]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: o.brand_id, actorUserId: ctx.actor.userId, action: input.excluded ? 'listening.mention_excluded' : 'listening.mention_included', resourceType: 'listening_observation', resourceId: id, correlationId: ctx.correlationId });
    return { ok: true as const };
  });
}

/** Exclude a channel from listening (its mentions leave every listening view; the inbox keeps them) or include it again. */
export async function setChannelListening(ctx: Ctx, channelId: string, input: { excluded: boolean }): Promise<{ ok: true; removed: number }> {
  assertUuid(channelId, 'Channel');
  return withTx(async (tx) => {
    const ch = await maybeOne<{ id: string; brand_id: string; workspace_id: string }>(tx, `SELECT id, brand_id, workspace_id FROM inbox_channels WHERE id=$1 AND workspace_id=$2`, [channelId, ctx.access.workspaceId]);
    if (!ch || !canListen(ctx, ch.brand_id)) throw notFound('Channel');
    requireAction(ctx, LISTENING_MANAGE, { brandId: ch.brand_id });
    await tx.query(`INSERT INTO listening_channel_settings(channel_id, workspace_id, excluded, changed_by, changed_at, backfill_requested_at) VALUES ($1,$2,$3,$4,now(), CASE WHEN $3 THEN NULL ELSE now() END)
                    ON CONFLICT (channel_id) DO UPDATE SET excluded=EXCLUDED.excluded, changed_by=EXCLUDED.changed_by, changed_at=now(), backfill_requested_at=EXCLUDED.backfill_requested_at`,
      [ch.id, ch.workspace_id, input.excluded, ctx.actor.userId]);
    let removed = 0;
    if (input.excluded) removed = (await tx.query(`DELETE FROM listening_observations WHERE channel_id=$1`, [ch.id])).rowCount ?? 0;
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: ch.brand_id, actorUserId: ctx.actor.userId, action: input.excluded ? 'listening.channel_excluded' : 'listening.channel_included', resourceType: 'inbox_channel', resourceId: ch.id, diff: { removed }, correlationId: ctx.correlationId });
    return { ok: true as const, removed };
  });
}

// ------------------------------------------------------------------ insight → task / case / draft
export const insightActionSchema = z.object({
  action: z.enum(['task', 'case', 'draft']),
  observation_id: z.string().uuid().nullable().optional(),
  alert_id: z.string().uuid().nullable().optional(),
  search_id: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(200).optional(),
  assignee_id: z.string().uuid().nullable().optional(),
  idempotency_key: z.string().min(8).max(100),
}).strict().refine((v) => !!(v.observation_id || v.alert_id || v.search_id), 'Pick a mention, alert or search');

export interface InsightActionResult { action: 'task' | 'case' | 'draft'; target_id: string; href: string; existing: boolean }

const hrefFor = (action: string, id: string, conversationId?: string | null) => (action === 'task' ? `/tasks?task=${id}` : action === 'draft' ? `/posts/${id}` : `/inbox?c=${conversationId ?? ''}`);

export async function createFromInsight(ctx: Ctx, input: z.infer<typeof insightActionSchema>): Promise<InsightActionResult> {
  // Resolve the insight and its brand (read access first; the target service checks its own permission).
  let brandId: string;
  let conversationId: string | null = null;
  let context: string;
  let link: string;
  const db = getPool();
  if (input.observation_id) {
    const o = await loadObservation(ctx, input.observation_id);
    if (o.removed_at) throw new AppError('invalid_state', 'This mention was removed at the source.');
    brandId = o.brand_id; conversationId = o.conversation_id;
    context = `${o.conversation_kind} on ${sourceLabel(o.source_key)}${o.is_simulated ? ' (simulated)' : ''}`;
    link = `/listening/mentions/${o.id}`;
  } else if (input.alert_id) {
    assertUuid(input.alert_id, 'Alert');
    const a = await maybeOne<{ id: string; brand_id: string; observed: number; window_minutes: number; name: string; is_simulated: boolean }>(db,
      `SELECT a.id, a.brand_id, a.observed, (extract(epoch FROM a.window_end - a.window_start)/60)::int AS window_minutes, s.name, a.is_simulated FROM listening_alerts a JOIN listening_searches s ON s.id=a.search_id WHERE a.id=$1 AND a.workspace_id=$2`,
      [input.alert_id, ctx.access.workspaceId]);
    if (!a || !canListen(ctx, a.brand_id)) throw notFound('Alert');
    brandId = a.brand_id;
    context = `spike on “${a.name}”: ${a.observed} mentions in ${a.window_minutes} min${a.is_simulated ? ' (simulated)' : ''}`;
    link = `/listening/alerts/${a.id}`;
  } else {
    const s = await loadSearch(ctx, input.search_id!);
    brandId = s.brand_id;
    context = `search “${s.name}” (v${s.version})`;
    link = `/listening/searches/${s.id}`;
  }
  if (input.action === 'case' && !conversationId) throw new AppError('validation_failed', 'A case needs one mention (its conversation).', { action: 'Open a mention to create a case' });
  if (!brandAllowed(ctx, brandId) || !authorizeCtx(ctx, LISTENING_READ, { brandId }).allowed) throw notFound('Brand');

  return withTx(async (lock) => {
    await lock.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`listening-insight:${ctx.access.workspaceId}:${input.idempotency_key}`]);
    const prior = await maybeOne<{ action: 'task' | 'case' | 'draft'; target_id: string }>(lock, `SELECT action, target_id FROM listening_insight_actions WHERE workspace_id=$1 AND idempotency_key=$2`, [ctx.access.workspaceId, input.idempotency_key]);
    if (prior) return { action: prior.action, target_id: prior.target_id, href: hrefFor(prior.action, prior.target_id, conversationId), existing: true };
    const title = input.title ?? (input.action === 'task' ? `Follow up: ${context}` : input.action === 'case' ? `From listening: ${context}` : `Response to ${context}`);
    let targetId: string;
    if (input.action === 'task') {
      const t = await createTask(ctx, { brand_id: brandId, title: title.slice(0, 200), description: `Created from a listening insight: ${context}.\nOpen in Relay: ${link}`, assignee_id: input.assignee_id ?? null, priority: 'normal' });
      targetId = t.id;
    } else if (input.action === 'case') {
      try {
        targetId = (await createCase(ctx, { conversation_id: conversationId!, title: title.slice(0, 200) })).id;
      } catch (e) {
        const caseId = (e as AppError).details?.case_id as string | undefined;
        if ((e as AppError).code === 'conflict' && caseId) targetId = caseId; // already a case: link to it
        else throw e;
      }
    } else {
      const p = await createPost(ctx, brandId, { title: title.slice(0, 200) }, `listening:${input.idempotency_key}`);
      targetId = p.id;
    }
    await recordAction(lock, ctx, { brandId, input, targetId });
    return { action: input.action, target_id: targetId, href: hrefFor(input.action, targetId, conversationId), existing: false };
  });
}

async function recordAction(db: Queryable, ctx: Ctx, a: { brandId: string; input: z.infer<typeof insightActionSchema>; targetId: string }): Promise<void> {
  await one(db,
    `INSERT INTO listening_insight_actions(workspace_id, brand_id, observation_id, alert_id, search_id, action, target_id, idempotency_key, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [ctx.access.workspaceId, a.brandId, a.input.observation_id ?? null, a.input.alert_id ?? null, a.input.search_id ?? null, a.input.action, a.targetId, a.input.idempotency_key, ctx.actor.userId]);
  await audit(db, { workspaceId: ctx.access.workspaceId, brandId: a.brandId, actorUserId: ctx.actor.userId, action: `listening.insight_${a.input.action}`, resourceType: a.input.action, resourceId: a.targetId,
    diff: { observation_id: a.input.observation_id ?? null, alert_id: a.input.alert_id ?? null, search_id: a.input.search_id ?? null }, correlationId: ctx.correlationId });
}
