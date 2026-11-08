// External actions prepared by workflow runs (V5 §15): schedule_post, submit_for_approval, send_reply.
// A run only PREPARES them. previewAction() shows exactly what would happen (destinations, content per destination,
// timing, approval requirement, whether the person may do it) plus a hash of that exact state. confirmAction() requires
// the hash the person reviewed: if anything changed (post edited, new customer message, destinations or time differ)
// it refuses and asks for a fresh review. The NORMAL service then runs with the person's own context — scheduling
// (permissions, approval policy, brand rules, entitlements, post version) or requestReply (inbox.reply, thread
// changes, channel rules) — with an idempotency key per action, so a repeated confirm can never act twice.
// Source documents and customer messages cannot grant anything here: targets and parameters were built by Relay.
import { AppError, PROVIDER_LABEL, notFound, resolveVariants, resolveWallTime } from '@social-lite/core';
import type { ActionPreviewDto } from '@social-lite/core/contracts/v5-ai';
import type { ProposedActionDto } from '@social-lite/core/contracts/v35-ai';
import { getPool, maybeOne } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { assertUuid, authorizeCtx } from '../tenancy.js';
import { actionDto } from '../assistant/runs.js';
import { loadPost } from '../posts/service.js';
import { brandConnections, contentHash } from '../posts/shared.js';
import { approvalRequiredFor } from '../posts/approval-policy.js';
import { schedulePost, submitForReview } from '../posts/scheduling.js';
import { loadChannelRow, loadConversation } from '../inbox/shared.js';
import { requestReply } from '../inbox/replies.js';
import { holdsPermission, settleReviewIfDone } from './engine.js';
import { hashOf, humanTime } from './workflows/common.js';
import { destinationOf } from './sources.js';

export const EXTERNAL_KINDS = ['schedule_post', 'submit_for_approval', 'send_reply'] as const;
export type ExternalKind = (typeof EXTERNAL_KINDS)[number];
export const isExternalKind = (k: string): k is ExternalKind => (EXTERNAL_KINDS as readonly string[]).includes(k);

interface Row { id: string; workspace_id: string; run_id: string; brand_id: string; kind: ProposedActionDto['kind']; target_type: 'conversation' | 'post' | 'brand'; target_id: string;
  preview: ProposedActionDto['preview']; requires: string; status: ProposedActionDto['status']; decided_at: Date | null; error: string | null; expires_at: Date; bound_hash: string | null; requested_by: string | null }

async function load(ctx: Ctx, id: string): Promise<Row> {
  assertUuid(id, 'Action');
  const a = await maybeOne<Row>(getPool(), `SELECT a.*, r.requested_by FROM ai_proposed_actions a JOIN ai_runs r ON r.id=a.run_id WHERE a.id=$1 AND a.workspace_id=$2`, [id, ctx.access.workspaceId]);
  if (!a || a.requested_by !== ctx.actor.userId || !isExternalKind(a.kind)) throw notFound('Action');
  return a;
}

const str = (v: unknown) => (typeof v === 'string' ? v : null);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export async function previewAction(ctx: Ctx, id: string): Promise<ActionPreviewDto> {
  const a = await load(ctx, id);
  return buildPreview(ctx, a);
}

async function buildPreview(ctx: Ctx, a: Row): Promise<ActionPreviewDto> {
  const db = getPool();
  const p = a.preview.params;
  const action = actionDto(a);
  if (a.kind === 'send_reply') {
    const conv = await loadConversation(ctx, a.target_id, 'inbox.read', db);
    const ch = await loadChannelRow(db, conv.channel_id);
    const mode = str(p.mode) === 'private_message' ? 'private_message' : 'public_reply';
    const body = str(p.body) ?? '';
    const base = Number(p.base_version);
    const allowed = authorizeCtx(ctx, 'inbox.reply', { brandId: conv.brand_id }).allowed;
    const label = ch ? `${ch.kind.replace(/_/g, ' ')} · ${ch.display_name}${ch.is_simulated ? ' (simulated)' : ''}` : 'Channel';
    return {
      action, kind: 'send_reply', hash: hashOf({ c: conv.id, m: mode, b: body, v: conv.version }), changed_since_prepared: conv.version !== base,
      destinations: [{ id: conv.channel_id, provider: ch?.kind ?? 'channel', display_name: label, ready: !!ch && ch.status === 'active' && !ch.disconnected_at }],
      content: [{ destination: mode === 'private_message' ? 'Private message' : 'Public reply', text: body }],
      timing: { mode: 'immediate', local_time: null, timezone: null, due_at: null }, approval_required: false,
      effect: `Sends this reply now as a ${mode === 'private_message' ? 'private message' : 'public reply'}${ch?.is_simulated ? ' on a simulated channel (nothing reaches a real customer)' : ''}.`,
      allowed, blocked_reason: allowed ? null : 'You can’t reply on this brand.',
      record: { type: 'conversation', id: conv.id, link: `/inbox?c=${conv.id}` },
    };
  }
  // schedule_post / submit_for_approval
  const post = await loadPost(ctx, a.target_id, db);
  const conns = await brandConnections(db, ctx.access.workspaceId, post.brand_id, true);
  const ids = strs(p.connection_ids);
  const resolved = resolveVariants({ ...post.draft, variants: ids.map((cid) => post.draft.variants.find((v) => v.connectionId === cid) ?? { connectionId: cid, inheritText: true, inheritMedia: true }) }, conns);
  const revision = contentHash(post.draft.baseText, post.draft.baseLink ?? null, post.draft.baseAssetIds, resolved);
  const approval = await approvalRequiredFor(db, ctx.access.workspaceId, post.brand_id);
  const local = a.kind === 'schedule_post' ? str(p.local_time) : null;
  const tz = a.kind === 'schedule_post' ? str(p.timezone) : null;
  const wall = local && tz ? resolveWallTime(local, tz) : null;
  const dueAt = wall?.kind === 'ok' ? wall.instant.toISOString() : wall?.kind === 'ambiguous' ? wall.options[0]!.instant.toISOString() : null;
  const perm = approval ? 'content.edit' : 'content.schedule';
  let allowed = holdsPermission(ctx, perm, post.brand_id); // MFA / fresh sign-in is enforced by the scheduling service on confirm
  let blocked: string | null = allowed ? null : approval ? 'You can’t submit posts for approval on this brand.' : 'You can’t schedule posts on this brand.';
  if (a.kind === 'submit_for_approval' && !approval) { allowed = false; blocked = 'This brand no longer requires approval. Schedule the post from its page instead.'; }
  if (dueAt && new Date(dueAt).getTime() < Date.now()) { allowed = false; blocked = 'This time has passed. Ask the assistant for a new plan or schedule it from the post.'; }
  const dests = ids.map((cid) => conns.find((c) => c.id === cid)).filter((c): c is NonNullable<typeof c> => !!c).map(destinationOf);
  const when = local && tz ? humanTime(local, tz) : null;
  return {
    action, kind: a.kind as 'schedule_post' | 'submit_for_approval',
    hash: hashOf({ p: post.id, v: post.version, r: revision, c: [...ids].sort(), t: local, z: tz }),
    changed_since_prepared: Number(p.expected_version ?? post.version) !== post.version,
    destinations: dests.map((d) => ({ id: d.id, provider: d.provider, display_name: `${PROVIDER_LABEL[d.provider]} · ${d.display_name}${d.simulated ? ' (simulated)' : ''}`, ready: d.ready })),
    content: resolved.map((v) => ({ destination: PROVIDER_LABEL[v.provider], text: v.text })),
    timing: a.kind === 'schedule_post' ? { mode: 'scheduled', local_time: local, timezone: tz, due_at: dueAt } : { mode: 'on_approval', local_time: null, timezone: null, due_at: null },
    approval_required: approval,
    effect: a.kind === 'submit_for_approval'
      ? 'Sends this draft to the brand’s reviewers. It publishes as soon as it is approved, unless someone schedules a time.'
      : approval ? `Submits this post for approval, to publish at ${when} once approved.` : `Schedules this post for ${when} on ${dests.length} account${dests.length === 1 ? '' : 's'}.`,
    allowed, blocked_reason: blocked,
    record: { type: 'post', id: post.id, link: `/posts/${post.id}` },
  };
}

/** Execute a reviewed external action through the normal service (permissions re-checked there, at dispatch). */
export async function confirmAction(ctx: Ctx, id: string, reviewedHash: string | null | undefined): Promise<{ action: ProposedActionDto; result: Record<string, unknown> }> {
  const a = await load(ctx, id);
  if (a.status !== 'proposed') throw new AppError('invalid_state', 'This action was already handled.');
  if (a.expires_at.getTime() < Date.now()) throw new AppError('invalid_state', 'This action expired. Ask the assistant again.');
  if (!reviewedHash) throw new AppError('validation_failed', 'Review the action before confirming it.', { reviewed_hash: 'Required' });
  const preview = await buildPreview(ctx, a);
  if (preview.hash !== reviewedHash) throw new AppError('conflict', 'This changed since you reviewed it. Review it again before confirming.', undefined, { reason: 'changed_since_review' });
  if (!preview.allowed) throw new AppError('forbidden', preview.blocked_reason ?? 'You can’t do this.');
  const key = `ai-action-${a.id.replace(/-/g, '')}`;
  const p = a.preview.params;
  let result: Record<string, unknown>;
  if (a.kind === 'send_reply') {
    // The reviewed hash covers the thread version shown in the preview: confirming acknowledges that version (newer
    // messages after the review still make requestReply refuse).
    const conv = await loadConversation(ctx, a.target_id, 'inbox.read');
    const r = await requestReply(ctx, a.target_id, { mode: str(p.mode) === 'private_message' ? 'private_message' : 'public_reply', body: str(p.body) ?? '', base_version: Number(p.base_version),
      acknowledge_version: conv.version, idempotency_key: key });
    result = { attempt_id: r.attempt.id, state: r.attempt.state };
  } else {
    const post = await loadPost(ctx, a.target_id);
    const req: Record<string, unknown> = { expected_version: post.version, connection_ids: strs(p.connection_ids) };
    if (a.kind === 'schedule_post') { req.input_local_time = str(p.local_time); req.timezone = str(p.timezone); }
    const r = preview.approval_required ? await submitForReview(ctx, a.target_id, req, key) : await schedulePost(ctx, a.target_id, req, key);
    const body = r.body as { schedule?: { id: string; status: string }; approval?: { id: string } };
    result = { schedule_id: body.schedule?.id ?? null, status: body.schedule?.status ?? null, approval_id: body.approval?.id ?? null };
  }
  const upd = await maybeOne<Row>(getPool(),
    `UPDATE ai_proposed_actions SET status='applied', decided_by=$2, decided_at=now(), confirmed_hash=$3, result=$4 WHERE id=$1 AND status='proposed' RETURNING *`,
    [a.id, ctx.actor.userId, reviewedHash, JSON.stringify(result)]);
  await audit(getPool(), { workspaceId: a.workspace_id, brandId: a.brand_id, actorUserId: ctx.actor.userId, action: 'ai.action_confirmed', resourceType: 'ai_proposed_action', resourceId: a.id,
    diff: { kind: a.kind, target_type: a.target_type, target_id: a.target_id, run_id: a.run_id, ...result }, correlationId: ctx.correlationId });
  await settleReviewIfDone(a.run_id);
  return { action: actionDto(upd ?? { ...a, status: 'applied', decided_at: new Date() }), result };
}
