// Proposed actions (brief §17: "prepare an action for review"). Applying one goes through the NORMAL domain service
// with the person's own context, so the same permission, approval and concurrency rules apply as for a manual change.
// Nothing here sends a customer message: a reply draft lands in the reply box (server draft) and the agent sends it.
import { AppError, notFound } from '@social-lite/core';
import type { ProposedActionDto } from '@social-lite/core/contracts/v35-ai';
import { getPool, maybeOne } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { assertUuid, requireAction } from '../tenancy.js';
import { addNote, saveDraft, updateConversation } from '../inbox/conversations.js';
import { loadConversation } from '../inbox/shared.js';
import { createTask } from '../collab/tasks.js';
import { actionDto } from './runs.js';

interface Row { id: string; workspace_id: string; run_id: string; brand_id: string; kind: ProposedActionDto['kind']; target_type: 'conversation' | 'post' | 'brand'; target_id: string; preview: ProposedActionDto['preview']; requires: string; status: ProposedActionDto['status']; decided_at: Date | null; error: string | null; expires_at: Date }

async function load(ctx: Ctx, id: string): Promise<Row> {
  assertUuid(id, 'Action');
  const a = await maybeOne<Row & { requested_by: string | null }>(getPool(),
    `SELECT a.*, r.requested_by FROM ai_proposed_actions a JOIN ai_runs r ON r.id=a.run_id WHERE a.id=$1 AND a.workspace_id=$2`, [id, ctx.access.workspaceId]);
  // Only the person who asked sees and applies their run's proposals.
  if (!a || a.requested_by !== ctx.actor.userId) throw notFound('Action');
  return a;
}

async function decide(ctx: Ctx, a: Row, status: 'applied' | 'dismissed' | 'failed', error: string | null = null): Promise<ProposedActionDto> {
  const r = await maybeOne<Row>(getPool(), `UPDATE ai_proposed_actions SET status=$2, decided_by=$3, decided_at=now(), error=$4 WHERE id=$1 AND status='proposed' RETURNING *`, [a.id, status, ctx.actor.userId, error]);
  if (!r) throw new AppError('invalid_state', 'This suggestion was already handled.');
  await audit(getPool(), { workspaceId: a.workspace_id, brandId: a.brand_id, actorUserId: ctx.actor.userId, action: `ai.action_${status}`, resourceType: 'ai_proposed_action', resourceId: a.id,
    diff: { kind: a.kind, target_type: a.target_type, target_id: a.target_id, run_id: a.run_id }, correlationId: ctx.correlationId });
  // V5: a workflow run waiting for review completes once nothing required is left to review.
  await (await import('../ai-workflows/engine.js')).settleReviewIfDone(a.run_id);
  return actionDto(r);
}

export async function dismissAction(ctx: Ctx, id: string): Promise<ProposedActionDto> {
  const a = await load(ctx, id);
  return decide(ctx, a, 'dismissed');
}

/** Apply through the normal service. Returns the action plus, for copy/reply, the text the client puts in its editor. */
export async function applyAction(ctx: Ctx, id: string, body: { reviewed_hash?: string | null } = {}): Promise<{ action: ProposedActionDto; text: string | null; result?: Record<string, unknown> }> {
  const a = await load(ctx, id);
  // V5 external actions (schedule / submit for approval / send reply): only with the hash of the reviewed preview.
  if (a.kind === 'schedule_post' || a.kind === 'submit_for_approval' || a.kind === 'send_reply') {
    const r = await (await import('../ai-workflows/actions.js')).confirmAction(ctx, id, body.reviewed_hash);
    return { action: r.action, text: null, result: r.result };
  }
  if (a.status !== 'proposed') throw new AppError('invalid_state', 'This suggestion was already handled.');
  if (a.expires_at.getTime() < Date.now()) throw new AppError('invalid_state', 'This suggestion expired. Ask again.');
  const p = a.preview.params;
  let text: string | null = null;
  switch (a.kind) {
    case 'use_reply_draft': {
      const conv = await loadConversation(ctx, a.target_id, 'inbox.reply');
      text = String(p.body ?? '');
      await saveDraft(ctx, a.target_id, { mode: conv.kind === 'dm' ? 'private_message' : 'public_reply', body: text, base_version: conv.version });
      break;
    }
    case 'apply_labels': {
      const conv = await loadConversation(ctx, a.target_id, 'inbox.reply');
      const labels = [...new Set([...conv.labels, ...((p.labels as string[]) ?? [])])].slice(0, 20);
      await updateConversation(ctx, a.target_id, { labels });
      break;
    }
    case 'set_priority':
      await updateConversation(ctx, a.target_id, { priority: p.priority as 'low' | 'normal' | 'high' | 'urgent' });
      break;
    case 'add_note':
      await addNote(ctx, a.target_id, { body: String(p.body ?? '').slice(0, 4000) });
      break;
    case 'use_copy':
      // The composer applies the text through its normal versioned save; here we only check the person may edit.
      requireAction(ctx, 'content.edit', { brandId: a.brand_id });
      text = String(p.text ?? '');
      break;
    case 'create_task':
      await createTask(ctx, { title: String(p.title ?? '').slice(0, 200), brand_id: a.brand_id } as Parameters<typeof createTask>[1]);
      break;
    case 'assign':
      throw new AppError('invalid_state', 'Assignment is chosen by a person.');
    default:
      throw new AppError('invalid_state', 'This action is not available.');
  }
  return { action: await decide(ctx, a, 'applied'), text };
}
