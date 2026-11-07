// V3.1 §11 bulk workflows as durable jobs with per-item results.
//  preview  → per item: eligible / ineligible (+ reason) / not_found, with permission and policy consequences, and a
//             preview_hash binding selection + state + policy version.
//  start    → recomputes the preview; a changed hash fails with conflict (preview_stale). Creates the job + one row per
//             item (ineligible ⇒ 'skipped') + an outbox event in ONE transaction (Idempotency-Key per user: a repeated
//             start returns the same job). The worker ('bulk-ops' queue, plus a sweep) runs it.
//  run      → reloads the job, rebuilds the creator's authority FROM THE DATABASE (grants/membership re-checked; a
//             revoked person's remaining items fail 'forbidden'), processes only 'pending' items. Each item goes through
//             the same shared services as the UI (updatePostPlanning, duplicatePost, archivePost, reschedule, trash,
//             updateAsset, ...). Side effects are idempotent: set-style operations converge, and duplicate/reschedule
//             use per-item idempotency keys with the target computed once and stored in the item's `before`, so a
//             crash between the change and the status update never repeats work. Succeeded items are never re-run.
//  retry    → failed items (all or chosen ones) back to 'pending'; succeeded items untouched.
//  undo     → a new job applying the inverse of each succeeded item with a concurrency check against its recorded
//             `after` state (changed since ⇒ that item fails with conflict instead of overwriting someone's work).
// No access broadening: items stay on their own brand, assignees/teams/campaigns must already be entitled to/belong
// to that brand, and every item is authorized against the creator's current grants.
import { createHash, randomUUID } from 'node:crypto';
import { AppError, notFound, toLocalInput, type Permission } from '@social-lite/core';
import {
  BULK_ACTION_PERMISSION, BULK_ASSET_ACTIONS, BULK_MAX_ITEMS, BULK_POST_ACTIONS, type BulkAction, type BulkItemStatus, type BulkJobStatus, type BulkJobView,
  type BulkParams, type BulkPreview, type BulkPreviewItem, type BulkRequest,
} from '@social-lite/core/contracts/v31-data';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { log } from '../log.js';
import { writeOutbox } from '../outbox.js';
import { authorize, loadUserAuthz, type AuthzState } from '../authz.js';
import { beginIdempotent, completeIdempotent, stableStringify } from '../idempotency.js';
import { assertUuid, authorizeCtx, isUuid, loadAccess, requireAction } from '../tenancy.js';
import { archivePost, duplicatePost, loadPost } from '../posts/service.js';
import { reschedule } from '../posts/scheduling.js';
import { approvalRequiredFor } from '../posts/approval-policy.js';
import { updatePostPlanning } from '../collab/planning.js';
import { staffAllowed } from '../collab/access.js';
import { archiveAsset, updateAsset } from '../media/assets.js';
import { assetFacts, postFacts, restoreTx, trashTx } from './trash.js';

const LEASE_SECONDS = 120;
const REFRESH_AUTHZ_EVERY = 25;

// ------------------------------------------------------------------ rows

interface PostItemRow { id: string; brand_id: string; title: string | null; version: number; tags: string[]; archived_at: Date | null; deleted_at: Date | null;
  campaign_id: string | null; assignee_user_id: string | null; team_id: string | null }
interface AssetItemRow { id: string; brand_id: string; title: string | null; tags: string[]; status: string; archived_at: Date | null; deleted_at: Date | null }
interface ScheduleLite { id: string; generation: number; due_at: Date; input_timezone: string; status: string; started: number }

interface JobRow {
  id: string; workspace_id: string; created_by: string | null; target_kind: 'post' | 'asset'; action: BulkAction; params: BulkParams & { source_job_id?: string };
  preview_hash: string; idempotency_key: string; request_hash: string; undo_of: string | null; started_mfa: boolean; policy_version: string; status: BulkJobStatus;
  item_count: number; attempts: number; lease_until: Date | null; created_at: Date; started_at: Date | null; finished_at: Date | null;
}
interface ItemRow { job_id: string; item_id: string; brand_id: string | null; position: number; status: BulkItemStatus; error_code: string | null; error_message: string | null;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null; attempts: number }

const actionsFor = (k: 'post' | 'asset'): readonly string[] => (k === 'post' ? BULK_POST_ACTIONS : BULK_ASSET_ACTIONS);
const permFor = (k: 'post' | 'asset', a: string): Permission => BULK_ACTION_PERMISSION[`${k}.${a}`] ?? 'workspace.manage';

// ------------------------------------------------------------------ input validation

function normTags(tags: unknown): string[] {
  if (!Array.isArray(tags) || !tags.length) throw new AppError('validation_failed', 'Choose at least one tag', { tags: 'Required' });
  const t = [...new Set(tags.map((x) => String(x).trim()).filter(Boolean))];
  if (!t.length || t.length > 20 || t.some((x) => x.length > 40)) throw new AppError('validation_failed', 'Up to 20 tags of 40 characters', { tags: 'Up to 20 tags of 40 characters' });
  return t;
}

export function validateRequest(req: BulkRequest): { ids: string[]; params: BulkParams } {
  if (req.target_kind !== 'post' && req.target_kind !== 'asset') throw new AppError('validation_failed', 'Unknown target', { target_kind: 'Use post or asset' });
  if (!actionsFor(req.target_kind).includes(req.action)) throw new AppError('validation_failed', 'This action is not available for these items', { action: 'Not supported' });
  if (!Array.isArray(req.item_ids) || !req.item_ids.length) throw new AppError('validation_failed', 'Select at least one item', { item_ids: 'Required' });
  const ids = [...new Set(req.item_ids)];
  if (ids.length > BULK_MAX_ITEMS) throw new AppError('validation_failed', `Select at most ${BULK_MAX_ITEMS} items`, { item_ids: `At most ${BULK_MAX_ITEMS}` });
  if (ids.some((i) => !isUuid(i))) throw new AppError('validation_failed', 'Invalid item id', { item_ids: 'Invalid id' });
  const p = req.params ?? {};
  const params: BulkParams = {};
  switch (req.action) {
    case 'assign':
      if (p.assignee_user_id === undefined && p.team_id === undefined) throw new AppError('validation_failed', 'Choose a person or a team', { assignee_user_id: 'Required' });
      for (const k of ['assignee_user_id', 'team_id'] as const) {
        if (p[k] !== undefined) {
          if (p[k] !== null && !isUuid(p[k])) throw new AppError('validation_failed', 'Invalid id', { [k]: 'Invalid' });
          params[k] = p[k];
        }
      }
      break;
    case 'add_tags': case 'remove_tags': params.tags = normTags(p.tags); break;
    case 'set_campaign':
      if (p.campaign_id === undefined || (p.campaign_id !== null && !isUuid(p.campaign_id))) throw new AppError('validation_failed', 'Choose a campaign', { campaign_id: 'Required' });
      params.campaign_id = p.campaign_id;
      break;
    case 'reschedule':
      if (!Number.isInteger(p.shift_minutes) || p.shift_minutes === 0 || Math.abs(p.shift_minutes!) > 60 * 24 * 366) {
        throw new AppError('validation_failed', 'Shift by a whole number of minutes (up to one year)', { shift_minutes: 'Invalid' });
      }
      params.shift_minutes = p.shift_minutes;
      break;
    default: break;
  }
  return { ids, params };
}

// ------------------------------------------------------------------ eligibility (preview + run share it)

type Elig = { ok: true; consequences: string[] } | { ok: false; code: string; reason: string };
const no = (code: string, reason: string): Elig => ({ ok: false, code, reason });
const yes = (...consequences: string[]): Elig => ({ ok: true, consequences });

async function liveSchedule(db: Queryable, postId: string): Promise<ScheduleLite | null> {
  return maybeOne<ScheduleLite>(db,
    `SELECT s.id, s.generation, s.due_at, s.input_timezone, s.status,
            (SELECT count(*) FROM deliveries d WHERE d.schedule_id=s.id AND d.state NOT IN ('scheduled','retry_wait','blocked','paused','cancelled'))::int AS started
       FROM schedules s WHERE s.post_id=$1 AND s.status IN ('active','pending_approval') ORDER BY s.generation DESC LIMIT 1`, [postId]);
}

interface EligCache { assignee?: AuthzState | null; teamBrands: Map<string, boolean>; campaign?: { brand_id: string } | null; approval: Map<string, boolean> }

async function postEligibility(db: Queryable, ctx: Ctx, action: string, params: BulkParams, p: PostItemRow, cache: EligCache): Promise<Elig> {
  if (action === 'restore') return p.deleted_at ? yes('Restored drafts are not scheduled or published.') : no('not_trashed', 'Not in Trash.');
  if (p.deleted_at) return no('trashed', 'In Trash.');
  switch (action) {
    case 'assign': {
      if (params.assignee_user_id) {
        if (cache.assignee === undefined) cache.assignee = await loadUserAuthz(params.assignee_user_id, ctx.access.workspaceId, null, db).catch(() => null);
        if (!cache.assignee || cache.assignee.subject.status !== 'active' || !staffAllowed(cache.assignee, 'content.read', p.brand_id)) {
          return no('assignee_no_access', 'This person has no access to this brand.');
        }
      }
      if (params.team_id) {
        if (!cache.teamBrands.has(p.brand_id)) {
          const t = await maybeOne(db,
            `SELECT 1 FROM teams t WHERE t.id=$1 AND t.workspace_id=$2 AND t.archived_at IS NULL AND EXISTS (
               SELECT 1 FROM scoped_role_grants g WHERE g.team_id=t.id AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())
                 AND (g.scope_type='workspace' OR g.brand_id=$3))`, [params.team_id, ctx.access.workspaceId, p.brand_id]);
          cache.teamBrands.set(p.brand_id, !!t);
        }
        if (!cache.teamBrands.get(p.brand_id)) return no('team_no_access', 'This team has no access to this brand.');
      }
      return yes();
    }
    case 'add_tags': return params.tags!.every((t) => p.tags.includes(t)) ? no('no_change', 'Already has these tags.') : yes();
    case 'remove_tags': return params.tags!.some((t) => p.tags.includes(t)) ? yes() : no('no_change', 'Has none of these tags.');
    case 'set_campaign': {
      if (params.campaign_id) {
        if (cache.campaign === undefined) {
          cache.campaign = await maybeOne<{ brand_id: string }>(db, `SELECT brand_id FROM campaigns WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL`, [params.campaign_id, ctx.access.workspaceId]);
        }
        if (!cache.campaign || cache.campaign.brand_id !== p.brand_id) return no('campaign_other_brand', 'The campaign belongs to another brand.');
      }
      return p.campaign_id === (params.campaign_id ?? null) ? no('no_change', 'Already in this campaign.') : yes();
    }
    case 'duplicate': return p.archived_at ? no('archived', 'Archived.') : yes('Creates a new draft. Copies are never scheduled or published.');
    case 'archive': {
      if (p.archived_at) return no('no_change', 'Already archived.');
      return (await liveSchedule(db, p.id)) ? no('live_schedule', 'Scheduled or waiting for approval. Cancel it first.') : yes();
    }
    case 'unarchive': return p.archived_at ? yes() : no('no_change', 'Not archived.');
    case 'trash': {
      const f = await postFacts(db, ctx.access.workspaceId, p.id);
      if (f.live_schedules) return no('live_schedule', 'Scheduled or waiting for approval. Cancel it first.');
      if (f.active_deliveries) return no('publishing', 'Publishing is in progress.');
      if (f.published_deliveries) return no('published', 'Published posts can be archived, not deleted.');
      return yes('Nothing on social networks is deleted.');
    }
    case 'reschedule': {
      if (p.archived_at) return no('archived', 'Archived.');
      const s = await liveSchedule(db, p.id);
      if (!s) return no('not_scheduled', 'Not scheduled.');
      if (s.started > 0) return no('publishing', 'Publishing has already started.');
      if (!cache.approval.has(p.brand_id)) cache.approval.set(p.brand_id, await approvalRequiredFor(db, ctx.access.workspaceId, p.brand_id));
      const needsApproval = cache.approval.get(p.brand_id)!;
      // Mirrors posts/scheduling.ts reschedule(): approval brands let editors/approvers move it (it then needs approval again).
      const allowed = needsApproval
        ? authorizeCtx(ctx, 'content.edit', { brandId: p.brand_id }).allowed || authorizeCtx(ctx, 'content.approve', { brandId: p.brand_id }).allowed
        : authorizeCtx(ctx, 'content.schedule', { brandId: p.brand_id }).allowed;
      if (!allowed) return no('no_permission', 'You cannot reschedule posts for this brand.');
      const target = new Date(s.due_at.getTime() + params.shift_minutes! * 60_000);
      if (target.getTime() < Date.now()) return no('in_past', 'The new time would be in the past.');
      return yes(needsApproval ? 'Needs approval again: the current approval is invalidated.' : 'Moves the scheduled time; content and destinations are unchanged.');
    }
    default: return no('unsupported', 'Not supported.');
  }
}

async function assetEligibility(db: Queryable, ctx: Ctx, action: string, params: BulkParams, a: AssetItemRow): Promise<Elig> {
  if (action === 'restore') return a.deleted_at ? yes() : no('not_trashed', 'Not in Trash.');
  if (a.deleted_at) return no('trashed', 'In Trash.');
  switch (action) {
    case 'add_tags': return params.tags!.every((t) => a.tags.includes(t)) ? no('no_change', 'Already has these tags.') : yes();
    case 'remove_tags': return params.tags!.some((t) => a.tags.includes(t)) ? yes() : no('no_change', 'Has none of these tags.');
    case 'archive': case 'trash': {
      if (action === 'archive' && a.status === 'archived') return no('no_change', 'Already archived.');
      const f = await assetFacts(db, ctx.access.workspaceId, a.id);
      if (f.live_schedules || f.active_deliveries) return no('used_by_scheduled_post', 'Used by a scheduled post. Cancel or finish that post first.');
      return yes(...(f.drafts ? [`Used by ${f.drafts} draft${f.drafts === 1 ? '' : 's'}.`] : []));
    }
    case 'unarchive': return a.status === 'archived' ? yes() : no('no_change', 'Not archived.');
    default: return no('unsupported', 'Not supported.');
  }
}

async function loadItems(db: Queryable, ctx: Ctx, kind: 'post' | 'asset', ids: string[]): Promise<Map<string, PostItemRow | AssetItemRow>> {
  const rows = kind === 'post'
    ? await many<PostItemRow>(db, `SELECT id, brand_id, title, version, tags, archived_at, deleted_at, campaign_id, assignee_user_id, team_id FROM posts WHERE workspace_id=$1 AND id = ANY($2::uuid[])`, [ctx.access.workspaceId, ids])
    : await many<AssetItemRow>(db, `SELECT id, brand_id, original_filename AS title, tags, status::text AS status, archived_at, deleted_at FROM assets WHERE workspace_id=$1 AND id = ANY($2::uuid[])`, [ctx.access.workspaceId, ids]);
  return new Map(rows.map((r) => [r.id, r]));
}

/** Brand visible to the caller (no existence leak for other brands). */
const visible = (ctx: Ctx, brandId: string) => ctx.access.brandIds === null || ctx.access.brandIds.includes(brandId);

async function computePreview(db: Queryable, ctx: Ctx, req: BulkRequest): Promise<BulkPreview> {
  const { ids, params } = validateRequest(req);
  const perm = permFor(req.target_kind, req.action);
  const rows = await loadItems(db, ctx, req.target_kind, ids);
  const cache: EligCache = { teamBrands: new Map(), approval: new Map() };
  const items: BulkPreviewItem[] = [];
  for (const id of ids) {
    const r = rows.get(id);
    if (!r || !visible(ctx, r.brand_id)) { items.push({ id, brand_id: null, title: null, eligibility: 'not_found', reason_code: 'not_found', reason: 'Not found.', consequences: [] }); continue; }
    // reschedule's permission depends on the brand's approval policy (checked inside postEligibility)
    if (req.action !== 'reschedule' && !authorizeCtx(ctx, perm, { brandId: r.brand_id }).allowed) {
      items.push({ id, brand_id: r.brand_id, title: r.title, eligibility: 'ineligible', reason_code: 'no_permission', reason: 'You do not have permission for this brand.', consequences: [] });
      continue;
    }
    const e = req.target_kind === 'post' ? await postEligibility(db, ctx, req.action, params, r as PostItemRow, cache) : await assetEligibility(db, ctx, req.action, params, r as AssetItemRow);
    items.push(e.ok
      ? { id, brand_id: r.brand_id, title: r.title, eligibility: 'eligible', reason_code: null, reason: null, consequences: e.consequences }
      : { id, brand_id: r.brand_id, title: r.title, eligibility: 'ineligible', reason_code: e.code, reason: e.reason, consequences: [] });
  }
  const consequences: string[] = [];
  if (req.action === 'reschedule') consequences.push('Approval rules apply as for a single post: posts on brands that require approval need approval again.');
  if (req.action === 'trash' || req.action === 'archive') consequences.push('Nothing on social networks is deleted or changed.');
  if (req.action === 'restore') consequences.push('Restoring never schedules or publishes anything.');
  if (req.action === 'assign') consequences.push('Only people and teams with access to each post’s brand can be assigned; access is not extended.');
  consequences.push('Each item is checked again when the job runs; items that become ineligible fail individually and can be retried.');
  const pv = ctx.access.authz?.policyVersion ?? 0;
  const preview_hash = createHash('sha256').update(stableStringify({
    w: ctx.access.workspaceId, u: ctx.actor.userId, k: req.target_kind, a: req.action, p: params, pv,
    i: items.map((i) => [i.id, i.eligibility, i.reason_code]),
  })).digest('hex');
  const eligible = items.filter((i) => i.eligibility === 'eligible').length;
  return { action: req.action, target_kind: req.target_kind, total: items.length, eligible, ineligible: items.length - eligible, items, consequences, preview_hash, policy_version: pv };
}

/** POST /api/bulk/preview — read-only. */
export async function previewBulk(ctx: Ctx, req: BulkRequest): Promise<BulkPreview> {
  validateRequest(req);
  requireAction(ctx, req.action === 'reschedule' ? 'content.read' : permFor(req.target_kind, req.action));
  return computePreview(getPool(), ctx, req);
}

// ------------------------------------------------------------------ start / retry / cancel / undo

/** POST /api/bulk/jobs — start a previewed bulk action (Idempotency-Key required). */
export async function startBulk(ctx: Ctx, req: BulkRequest & { preview_hash: string }, idemKey: string | null): Promise<BulkJobView> {
  const { params } = validateRequest(req);
  requireAction(ctx, req.action === 'reschedule' ? 'content.read' : permFor(req.target_kind, req.action));
  if (typeof req.preview_hash !== 'string' || !/^[0-9a-f]{64}$/.test(req.preview_hash)) throw new AppError('validation_failed', 'preview_hash is required', { preview_hash: 'Preview first' });
  const jobId = await withTx(async (tx) => {
    const idem = await beginIdempotent(tx, { workspaceId: ctx.access.workspaceId, userId: ctx.actor.userId, action: 'bulk.start', key: idemKey, body: { req } });
    if (idem) return (idem.body as { job_id: string }).job_id;
    const preview = await computePreview(tx, ctx, req);
    if (preview.preview_hash !== req.preview_hash) {
      throw new AppError('conflict', 'Items, permissions or policies changed since the preview. Review the preview again.', undefined, { reason: 'preview_stale', preview });
    }
    if (!preview.eligible) throw new AppError('invalid_state', 'None of the selected items can be changed.', undefined, { reason: 'nothing_eligible' });
    const job = await insertJob(tx, ctx, { target: req.target_kind, action: req.action, params, previewHash: preview.preview_hash, idemKey: idemKey!, undoOf: null,
      items: preview.items.map((i) => ({ id: i.id, brand_id: i.brand_id, skip: i.eligibility === 'eligible' ? null : { code: i.reason_code ?? 'ineligible', message: i.reason ?? 'Not eligible.' } })) });
    await completeIdempotent(tx, { workspaceId: ctx.access.workspaceId, action: 'bulk.start', key: idemKey!, status: 202, body: { job_id: job } });
    return job;
  });
  return getBulkJob(ctx, jobId);
}

async function insertJob(tx: Queryable, ctx: Ctx, j: { target: 'post' | 'asset'; action: BulkAction; params: object; previewHash: string; idemKey: string; undoOf: string | null;
  items: Array<{ id: string; brand_id: string | null; skip: { code: string; message: string } | null }> }): Promise<string> {
  const pv = ctx.access.authz?.policyVersion ?? 0;
  const job = await one<{ id: string }>(tx,
    `INSERT INTO bulk_jobs(workspace_id, created_by, target_kind, action, params, preview_hash, idempotency_key, request_hash, undo_of, started_mfa, policy_version, item_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$6,$8,$9,$10,$11) RETURNING id`,
    [ctx.access.workspaceId, ctx.actor.userId, j.target, j.action, JSON.stringify(j.params), j.previewHash, j.idemKey, j.undoOf,
      !!ctx.access.authz?.subject.assurance?.mfaVerified, pv, j.items.length]);
  await tx.query(
    `INSERT INTO bulk_job_items(workspace_id, job_id, item_id, brand_id, position, status, error_code, error_message)
     SELECT $1, $2, x.id, x.brand_id, x.pos, CASE WHEN x.code IS NULL THEN 'pending' ELSE 'skipped' END, x.code, x.msg
       FROM jsonb_to_recordset($3::jsonb) AS x(id uuid, brand_id uuid, pos int, code text, msg text)`,
    [ctx.access.workspaceId, job.id, JSON.stringify(j.items.map((i, pos) => ({ id: i.id, brand_id: i.brand_id, pos, code: i.skip?.code ?? null, msg: i.skip?.message ?? null })))]);
  await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'bulk_job', aggregateId: job.id, eventType: 'bulk.requested', payload: { attempt: 0 } });
  await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: j.undoOf ? 'bulk.undo_started' : 'bulk.started', resourceType: 'bulk_job', resourceId: job.id,
    diff: { action: j.action, target: j.target, items: j.items.length, skipped: j.items.filter((i) => i.skip).length, undo_of: j.undoOf, policy_version: pv }, correlationId: ctx.correlationId });
  return job.id;
}

async function loadJobForCaller(db: Queryable, ctx: Ctx, jobId: string, lock = false): Promise<JobRow> {
  assertUuid(jobId, 'Bulk job');
  const j = await maybeOne<JobRow>(db, `SELECT * FROM bulk_jobs WHERE id=$1 AND workspace_id=$2 ${lock ? 'FOR UPDATE' : ''}`, [jobId, ctx.access.workspaceId]);
  // Jobs are visible to the person who started them, and to workspace administrators.
  if (!j || (j.created_by !== ctx.actor.userId && !authorizeCtx(ctx, 'workspace.manage').allowed)) throw notFound('Bulk job');
  return j;
}

/** POST /api/bulk/jobs/:id/retry — failed items (all, or item_ids) go back to pending; successes are never re-run. */
export async function retryBulk(ctx: Ctx, jobId: string, itemIds?: string[]): Promise<BulkJobView> {
  requireAction(ctx, 'content.read');
  if (itemIds && (!Array.isArray(itemIds) || itemIds.length > BULK_MAX_ITEMS || itemIds.some((i) => !isUuid(i)))) throw new AppError('validation_failed', 'Invalid item ids', { item_ids: 'Invalid' });
  await withTx(async (tx) => {
    const j = await loadJobForCaller(tx, ctx, jobId, true);
    if (j.created_by !== ctx.actor.userId) throw new AppError('forbidden', 'Only the person who started this job can retry it.');
    if (j.status === 'queued' || j.status === 'running') return; // already going: a repeated retry is a no-op
    if (j.status === 'cancelled') throw new AppError('invalid_state', 'This job was cancelled.');
    const r = await tx.query(
      `UPDATE bulk_job_items SET status='pending', error_code=NULL, error_message=NULL, updated_at=now()
        WHERE job_id=$1 AND status='failed' AND ($2::uuid[] IS NULL OR item_id = ANY($2::uuid[]))`, [j.id, itemIds?.length ? itemIds : null]);
    if (!r.rowCount) throw new AppError('invalid_state', 'There are no failed items to retry.');
    await tx.query(`UPDATE bulk_jobs SET status='queued', finished_at=NULL, lease_until=NULL, updated_at=now() WHERE id=$1`, [j.id]);
    await writeOutbox(tx, { workspaceId: ctx.access.workspaceId, aggregateType: 'bulk_job', aggregateId: j.id, eventType: 'bulk.requested', payload: { attempt: j.attempts } });
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'bulk.retried', resourceType: 'bulk_job', resourceId: j.id,
      diff: { items: r.rowCount }, correlationId: ctx.correlationId });
  });
  return getBulkJob(ctx, jobId);
}

/** POST /api/bulk/jobs/:id/cancel — remaining pending items are skipped; completed items stay done. */
export async function cancelBulk(ctx: Ctx, jobId: string): Promise<BulkJobView> {
  requireAction(ctx, 'content.read');
  await withTx(async (tx) => {
    const j = await loadJobForCaller(tx, ctx, jobId, true);
    if (j.status !== 'queued' && j.status !== 'running') return;
    const r = await tx.query(`UPDATE bulk_job_items SET status='skipped', error_code='cancelled', error_message='Cancelled before it ran', updated_at=now() WHERE job_id=$1 AND status='pending'`, [j.id]);
    await tx.query(`UPDATE bulk_jobs SET status='cancelled', finished_at=now(), lease_until=NULL, updated_at=now() WHERE id=$1`, [j.id]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'bulk.cancelled', resourceType: 'bulk_job', resourceId: j.id, diff: { skipped: r.rowCount }, correlationId: ctx.correlationId });
  });
  return getBulkJob(ctx, jobId);
}

const UNDOABLE = new Set(['assign', 'add_tags', 'remove_tags', 'set_campaign', 'duplicate', 'archive', 'unarchive', 'reschedule', 'trash', 'restore']);

/** POST /api/bulk/jobs/:id/undo — start a job that reverses each succeeded item (concurrency-checked per item). */
export async function undoBulk(ctx: Ctx, jobId: string, idemKey: string | null): Promise<BulkJobView> {
  requireAction(ctx, 'content.read');
  const id = await withTx(async (tx) => {
    const idem = await beginIdempotent(tx, { workspaceId: ctx.access.workspaceId, userId: ctx.actor.userId, action: 'bulk.undo', key: idemKey, body: { jobId } });
    if (idem) return (idem.body as { job_id: string }).job_id;
    const j = await loadJobForCaller(tx, ctx, jobId, true);
    if (j.created_by !== ctx.actor.userId) throw new AppError('forbidden', 'Only the person who started this job can undo it.');
    if (!UNDOABLE.has(j.action)) throw new AppError('invalid_state', 'This job cannot be undone.');
    if (!['completed', 'completed_with_errors', 'cancelled'].includes(j.status)) throw new AppError('invalid_state', 'Wait until the job finishes.');
    const done = await many<{ item_id: string; brand_id: string | null }>(tx, `SELECT item_id, brand_id FROM bulk_job_items WHERE job_id=$1 AND status='succeeded' ORDER BY position`, [j.id]);
    if (!done.length) throw new AppError('invalid_state', 'Nothing was changed, so there is nothing to undo.');
    const existing = await maybeOne<{ id: string }>(tx, `SELECT id FROM bulk_jobs WHERE undo_of=$1 AND status <> 'cancelled' LIMIT 1`, [j.id]);
    if (existing) throw new AppError('conflict', 'This job was already undone.', undefined, { undo_job_id: existing.id });
    const nid = await insertJob(tx, ctx, { target: j.target_kind, action: 'undo', params: { source_job_id: j.id, source_action: j.action }, previewHash: j.preview_hash, idemKey: idemKey!, undoOf: j.id,
      items: done.map((d) => ({ id: d.item_id, brand_id: d.brand_id, skip: null })) });
    await completeIdempotent(tx, { workspaceId: ctx.access.workspaceId, action: 'bulk.undo', key: idemKey!, status: 202, body: { job_id: nid } });
    return nid;
  });
  return getBulkJob(ctx, id);
}

// ------------------------------------------------------------------ views

function itemResult(job: Pick<JobRow, 'action'>, i: ItemRow): Record<string, unknown> | null {
  if (i.status !== 'succeeded' || !i.after) return null;
  const a = i.after;
  if (job.action === 'duplicate') return { post_id: a.post_id };
  if (job.action === 'reschedule') return { schedule_id: a.schedule_id, due_at: a.due_at, approval_required: a.approval_required };
  return null;
}

export async function getBulkJob(ctx: Ctx, jobId: string): Promise<BulkJobView> {
  const db = getPool();
  const j = await loadJobForCaller(db, ctx, jobId);
  const items = await many<ItemRow>(db, `SELECT * FROM bulk_job_items WHERE job_id=$1 ORDER BY position`, [j.id]);
  const readPerm: Permission = j.target_kind === 'post' ? 'content.read' : 'assets.read';
  // Revocation-safe: only items on brands the caller can read now (counts are over the whole job).
  const shown = items.filter((i) => i.brand_id && visible(ctx, i.brand_id) && authorizeCtx(ctx, readPerm, { brandId: i.brand_id }).allowed);
  const count = (s: BulkItemStatus) => items.filter((i) => i.status === s).length;
  const undone = j.action !== 'undo' ? await maybeOne(db, `SELECT 1 FROM bulk_jobs WHERE undo_of=$1 AND status <> 'cancelled'`, [j.id]) : null;
  const mine = j.created_by === ctx.actor.userId;
  return {
    id: j.id, action: j.action, target_kind: j.target_kind, status: j.status, params: j.params, undo_of: j.undo_of,
    counts: { total: items.length, pending: count('pending'), succeeded: count('succeeded'), failed: count('failed'), skipped: count('skipped') },
    created_at: j.created_at.toISOString(), started_at: j.started_at?.toISOString() ?? null, finished_at: j.finished_at?.toISOString() ?? null,
    items: shown.map((i) => ({ id: i.item_id, brand_id: i.brand_id, status: i.status, error_code: i.error_code, error_message: i.error_message, result: itemResult(j, i), attempts: i.attempts })),
    can_retry: mine && ['completed_with_errors', 'failed'].includes(j.status) && count('failed') > 0,
    can_undo: mine && UNDOABLE.has(j.action) && ['completed', 'completed_with_errors', 'cancelled'].includes(j.status) && count('succeeded') > 0 && !undone,
    can_cancel: ['queued', 'running'].includes(j.status),
  };
}

export async function listBulkJobs(ctx: Ctx, q: { limit?: number } = {}): Promise<{ items: Array<Omit<BulkJobView, 'items'>> }> {
  requireAction(ctx, 'content.read');
  const rows = await many<{ id: string }>(getPool(), `SELECT id FROM bulk_jobs WHERE workspace_id=$1 AND created_by=$2 ORDER BY created_at DESC LIMIT $3`,
    [ctx.access.workspaceId, ctx.actor.userId, Math.min(Math.max(q.limit ?? 20, 1), 50)]);
  const out = [];
  for (const r of rows) { const { items: _items, ...rest } = await getBulkJob(ctx, r.id); out.push(rest); }
  return { items: out };
}

// ------------------------------------------------------------------ execution (worker)

function itemCtx(base: Ctx): Ctx {
  const a = base.access.authz;
  return { ...base, correlationId: randomUUID(), access: { ...base.access, authz: a ? { ...a, required: new Set(), touchedBrands: new Set() } : undefined } };
}

async function creatorCtx(job: JobRow): Promise<Ctx | null> {
  if (!job.created_by) return null;
  const db = getPool();
  // Grants/membership are re-loaded from the database; assurance is the starting session's (not re-required in the background).
  const access = await loadAccess(job.created_by, job.workspace_id, db, { mfaVerified: job.started_mfa, authTime: null });
  if (!access) return null;
  const u = await maybeOne<{ email: string; name: string | null }>(db, `SELECT email, name FROM users WHERE id=$1`, [job.created_by]);
  return { actor: { userId: job.created_by, email: u?.email ?? '', name: u?.name ?? null, sessionId: `bulk:${job.id}` }, access, correlationId: job.id };
}

const idemFor = (job: JobRow, itemId: string, tag = '') => `bulk:${job.id}:${itemId}${tag}`;

/** The item's plan: current state (for undo + concurrency) and any computed target; stored once, reused on re-runs. */
async function planItem(ctx: Ctx, job: JobRow, itemId: string): Promise<Record<string, unknown>> {
  const db = getPool();
  if (job.action === 'undo') return {};
  const rows = await loadItems(db, ctx, job.target_kind, [itemId]);
  const r = rows.get(itemId);
  if (!r || !visible(ctx, r.brand_id)) throw notFound(job.target_kind === 'post' ? 'Post' : 'Asset');
  if (job.target_kind === 'asset') { const a = r as AssetItemRow; return { tags: a.tags, status: a.status, deleted_at: a.deleted_at?.toISOString() ?? null }; }
  const p = r as PostItemRow;
  const before: Record<string, unknown> = { version: p.version, tags: p.tags, archived_at: p.archived_at?.toISOString() ?? null, deleted_at: p.deleted_at?.toISOString() ?? null,
    campaign_id: p.campaign_id, assignee_user_id: p.assignee_user_id, team_id: p.team_id };
  if (job.action === 'reschedule') {
    const s = await liveSchedule(db, p.id);
    if (!s) throw new AppError('invalid_state', 'Not scheduled.');
    const target = new Date(s.due_at.getTime() + job.params.shift_minutes! * 60_000);
    Object.assign(before, { schedule_id: s.id, generation: s.generation, due_at: s.due_at.toISOString(), timezone: s.input_timezone,
      local_time: toLocalInput(s.due_at, s.input_timezone), target_local_time: toLocalInput(target, s.input_timezone) });
  }
  return before;
}

async function setTags(ctx: Ctx, kind: 'post' | 'asset', id: string, add: string[], remove: string[]): Promise<{ tags: string[]; added: string[]; removed: string[] }> {
  if (kind === 'asset') {
    const rows = await loadItems(getPool(), ctx, 'asset', [id]);
    const cur = (rows.get(id) as AssetItemRow | undefined)?.tags ?? [];
    const next = [...new Set([...cur.filter((t) => !remove.includes(t)), ...add])];
    await updateAsset(ctx, id, { tags: next });
    return { tags: next, added: add.filter((t) => !cur.includes(t)), removed: remove.filter((t) => cur.includes(t)) };
  }
  requireAction(ctx, 'content.edit');
  return withTx(async (tx) => {
    const post = await loadPost(ctx, id, tx, true);
    const next = [...new Set([...post.tags.filter((t) => !remove.includes(t)), ...add])].slice(0, 30);
    await tx.query(`UPDATE posts SET tags=$2 WHERE id=$1`, [post.id, next]);
    const out = { tags: next, added: add.filter((t) => !post.tags.includes(t)), removed: remove.filter((t) => post.tags.includes(t)) };
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: post.brand_id, actorUserId: ctx.actor.userId, action: 'post.tags_updated', resourceType: 'post', resourceId: post.id,
      diff: { added: out.added, removed: out.removed }, correlationId: ctx.correlationId });
    return out;
  });
}

async function setArchived(ctx: Ctx, kind: 'post' | 'asset', id: string, archived: boolean, expectArchivedAt?: string | null): Promise<Record<string, unknown>> {
  if (archived) {
    if (kind === 'post') { await archivePost(ctx, id); } else { await archiveAsset(ctx, id); }
    const r = await maybeOne<{ archived_at: Date | null }>(getPool(), `SELECT archived_at FROM ${kind === 'post' ? 'posts' : 'assets'} WHERE id=$1`, [id]);
    return { archived_at: r?.archived_at?.toISOString() ?? null };
  }
  requireAction(ctx, kind === 'post' ? 'content.archive' : 'assets.upload');
  return withTx(async (tx) => {
    const r = kind === 'post'
      ? await loadPost(ctx, id, tx, true)
      : (await loadItems(tx, ctx, 'asset', [id])).get(id) as AssetItemRow | undefined;
    if (!r || (kind === 'asset' && (!visible(ctx, r.brand_id) || !authorizeCtx(ctx, 'assets.upload', { brandId: r.brand_id }).allowed || (r as AssetItemRow).deleted_at))) throw notFound('Asset');
    if (expectArchivedAt !== undefined && (r.archived_at?.toISOString() ?? null) !== expectArchivedAt) throw new AppError('conflict', 'Changed since the bulk action.', undefined, { reason: 'changed_since' });
    if (kind === 'post') await tx.query(`UPDATE posts SET archived_at=NULL WHERE id=$1`, [id]);
    else await tx.query(`UPDATE assets SET status = CASE WHEN status='archived' THEN 'ready'::asset_status ELSE status END, archived_at=NULL, retention_at=NULL WHERE id=$1`, [id]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: r.brand_id, actorUserId: ctx.actor.userId, action: `${kind}.unarchived`, resourceType: kind, resourceId: id, correlationId: ctx.correlationId });
    return { archived_at: null };
  });
}

/** Execute one item's action through the shared services. Returns the `after` state. */
async function executeItem(ctx: Ctx, job: JobRow, itemId: string, before: Record<string, unknown>): Promise<Record<string, unknown>> {
  const kind = job.target_kind;
  const p = job.params;
  // Per-item authorization against the creator's CURRENT grants (reschedule: approval-aware check in the service).
  if (job.action !== 'reschedule' && job.action !== 'undo') {
    const brand = (await maybeOne<{ brand_id: string }>(getPool(), `SELECT brand_id FROM ${kind === 'post' ? 'posts' : 'assets'} WHERE id=$1 AND workspace_id=$2`, [itemId, ctx.access.workspaceId]))?.brand_id;
    if (!brand || !visible(ctx, brand)) throw notFound(kind === 'post' ? 'Post' : 'Asset');
    if (!authorizeCtx(ctx, permFor(kind, job.action), { brandId: brand }).allowed) throw new AppError('forbidden', 'You no longer have permission for this brand.');
  }
  switch (job.action) {
    case 'assign': {
      await updatePostPlanning(ctx, itemId, { ...(p.assignee_user_id !== undefined ? { assignee_user_id: p.assignee_user_id } : {}), ...(p.team_id !== undefined ? { team_id: p.team_id } : {}) });
      return { assignee_user_id: p.assignee_user_id === undefined ? before.assignee_user_id : p.assignee_user_id, team_id: p.team_id === undefined ? before.team_id : p.team_id };
    }
    case 'set_campaign': await updatePostPlanning(ctx, itemId, { campaign_id: p.campaign_id ?? null }); return { campaign_id: p.campaign_id ?? null };
    case 'add_tags': return setTags(ctx, kind, itemId, p.tags!, []);
    case 'remove_tags': return setTags(ctx, kind, itemId, [], p.tags!);
    case 'duplicate': { const r = await duplicatePost(ctx, itemId, idemFor(job, itemId)); return { post_id: r.id }; }
    case 'archive': return setArchived(ctx, kind, itemId, true);
    case 'unarchive': return setArchived(ctx, kind, itemId, false);
    case 'trash': {
      requireAction(ctx, permFor(kind, 'trash'));
      try { const r = await withTx((tx) => trashTx(tx, ctx, kind, itemId)); return { deleted_at: r.deleted_at }; } catch (err) {
        // A re-run after a crash finds it already in trash from THIS job's first attempt: converge.
        if (err instanceof AppError && err.details?.reason === 'already_trashed' && before.deleted_at === null) {
          const r = await maybeOne<{ deleted_at: Date }>(getPool(), `SELECT deleted_at FROM ${kind === 'post' ? 'posts' : 'assets'} WHERE id=$1`, [itemId]);
          return { deleted_at: r?.deleted_at.toISOString() ?? null };
        }
        throw err;
      }
    }
    case 'restore': {
      requireAction(ctx, permFor(kind, 'restore'));
      try { await withTx((tx) => restoreTx(tx, ctx, kind, itemId)); } catch (err) {
        if (!(err instanceof AppError && err.details?.reason === 'not_trashed' && before.deleted_at !== null)) throw err;
      }
      return { deleted_at: null };
    }
    case 'reschedule': {
      const r = await reschedule(ctx, String(before.schedule_id), { input_local_time: String(before.target_local_time), timezone: String(before.timezone), expected_generation: Number(before.generation) },
        idemFor(job, itemId));
      const body = r.body as { schedule: { id: string; due_at: string; generation: number; status: string }; approval?: unknown };
      return { schedule_id: body.schedule.id, generation: body.schedule.generation, due_at: body.schedule.due_at, approval_required: body.schedule.status === 'pending_approval' };
    }
    case 'undo': return executeUndo(ctx, job, itemId);
    default: throw new AppError('invalid_state', 'Unsupported action');
  }
}

/** Inverse of a succeeded item, refusing when the item changed since (concurrency check against the recorded `after`). */
async function executeUndo(ctx: Ctx, job: JobRow, itemId: string): Promise<Record<string, unknown>> {
  const src = await maybeOne<JobRow>(getPool(), `SELECT * FROM bulk_jobs WHERE id=$1 AND workspace_id=$2`, [job.undo_of, ctx.access.workspaceId]);
  const it = src ? await maybeOne<ItemRow>(getPool(), `SELECT * FROM bulk_job_items WHERE job_id=$1 AND item_id=$2 AND status='succeeded'`, [src.id, itemId]) : null;
  if (!src || !it?.before || !it.after) throw new AppError('invalid_state', 'Nothing to undo for this item.');
  const b = it.before; const a = it.after; const kind = src.target_kind;
  const changed = () => new AppError('conflict', 'Changed since the bulk action; left as it is.', undefined, { reason: 'changed_since' });
  const cur = kind === 'post' ? (await loadItems(getPool(), ctx, 'post', [itemId])).get(itemId) as PostItemRow | undefined : undefined;
  switch (src.action) {
    case 'assign':
      if (!cur || cur.assignee_user_id !== a.assignee_user_id || cur.team_id !== a.team_id) throw changed();
      await updatePostPlanning(ctx, itemId, { assignee_user_id: b.assignee_user_id as string | null, team_id: b.team_id as string | null });
      return { assignee_user_id: b.assignee_user_id, team_id: b.team_id };
    case 'set_campaign':
      if (!cur || cur.campaign_id !== a.campaign_id) throw changed();
      await updatePostPlanning(ctx, itemId, { campaign_id: b.campaign_id as string | null });
      return { campaign_id: b.campaign_id };
    case 'add_tags': return setTags(ctx, kind, itemId, [], (a.added as string[]) ?? []);
    case 'remove_tags': return setTags(ctx, kind, itemId, (a.removed as string[]) ?? [], []);
    case 'duplicate': {
      // Remove the copy only if nobody edited it since (version 1).
      requireAction(ctx, 'content.archive');
      const r = await withTx((tx) => trashTx(tx, ctx, 'post', String(a.post_id), { expectedVersion: 1 }));
      return { trashed_copy: a.post_id, deleted_at: r.deleted_at };
    }
    case 'archive': return setArchived(ctx, kind, itemId, false, (a.archived_at as string | null) ?? null);
    case 'unarchive': {
      const row = (await loadItems(getPool(), ctx, kind, [itemId])).get(itemId);
      if (!row || row.archived_at) throw changed();
      return setArchived(ctx, kind, itemId, true);
    }
    case 'trash': {
      requireAction(ctx, permFor(kind, 'restore'));
      await withTx((tx) => restoreTx(tx, ctx, kind, itemId, { expectedDeletedAt: a.deleted_at as string }));
      return { deleted_at: null };
    }
    case 'restore': {
      requireAction(ctx, permFor(kind, 'trash'));
      const r = await withTx((tx) => trashTx(tx, ctx, kind, itemId, { expectedVersion: kind === 'post' ? (b.version as number) : null }));
      return { deleted_at: r.deleted_at };
    }
    case 'reschedule': {
      const r = await reschedule(ctx, String(a.schedule_id), { input_local_time: String(b.local_time), timezone: String(b.timezone), expected_generation: Number(a.generation) }, idemFor(job, itemId, ':undo'));
      const body = r.body as { schedule: { id: string; due_at: string; generation: number } };
      return { schedule_id: body.schedule.id, generation: body.schedule.generation, due_at: body.schedule.due_at };
    }
    default: throw new AppError('invalid_state', 'This action cannot be undone.');
  }
}

function safeError(err: unknown): { code: string; message: string } {
  if (err instanceof AppError) return { code: err.code === 'conflict' && err.details?.reason === 'changed_since' ? 'changed_since' : err.code, message: err.message.slice(0, 300) };
  log.error('bulk_item_failed', { err: err as Error });
  return { code: 'internal', message: 'Something went wrong with this item. Retry it.' };
}

/**
 * Run (or resume) a bulk job. Safe to call concurrently and repeatedly: a lease admits one runner; only pending
 * items are processed; a crashed runner's lease expires and the sweep resumes it.
 */
export async function runBulkJob(jobId: string): Promise<{ processed: number; status: BulkJobStatus | null }> {
  const pool = getPool();
  const job = await maybeOne<JobRow>(pool,
    `UPDATE bulk_jobs SET status='running', started_at=coalesce(started_at, now()), attempts=attempts+1, lease_until=now() + make_interval(secs => $2), updated_at=now()
      WHERE id=$1 AND (status='queued' OR (status='running' AND lease_until < now())) RETURNING *`, [jobId, LEASE_SECONDS]);
  if (!job) return { processed: 0, status: null };
  let processed = 0;
  let base = await creatorCtx(job);
  const pending = await many<ItemRow>(pool, `SELECT * FROM bulk_job_items WHERE job_id=$1 AND status='pending' ORDER BY position`, [job.id]);
  for (const item of pending) {
    if (processed > 0 && processed % REFRESH_AUTHZ_EVERY === 0) {
      base = await creatorCtx(job); // pick up revocations during long jobs
      const st = await maybeOne<{ status: string }>(pool, `UPDATE bulk_jobs SET lease_until=now() + make_interval(secs => $2), updated_at=now() WHERE id=$1 RETURNING status`, [job.id, LEASE_SECONDS]);
      if (st?.status === 'cancelled') break;
    }
    processed++;
    if (!base) {
      await pool.query(`UPDATE bulk_job_items SET status='failed', error_code='forbidden', error_message='The person who started this job no longer has access.', attempts=attempts+1, updated_at=now() WHERE job_id=$1 AND item_id=$2 AND status='pending'`, [job.id, item.item_id]);
      continue;
    }
    const ctx = itemCtx(base);
    try {
      let before = item.before;
      if (!before) {
        before = await planItem(ctx, job, item.item_id);
        // Keep the FIRST plan: a re-run after a crash reuses it (same idempotency payloads, true pre-change state).
        const saved = await maybeOne<{ before: Record<string, unknown> }>(pool,
          `UPDATE bulk_job_items SET before = coalesce(before, $3::jsonb), updated_at=now() WHERE job_id=$1 AND item_id=$2 AND status='pending' RETURNING before`,
          [job.id, item.item_id, JSON.stringify(before)]);
        if (!saved) continue;
        before = saved.before;
      }
      const after = await executeItem(itemCtx(base), job, item.item_id, before);
      await pool.query(`UPDATE bulk_job_items SET status='succeeded', after=$3, error_code=NULL, error_message=NULL, attempts=attempts+1, updated_at=now() WHERE job_id=$1 AND item_id=$2 AND status='pending'`,
        [job.id, item.item_id, JSON.stringify(after)]);
    } catch (err) {
      const e = safeError(err);
      await pool.query(`UPDATE bulk_job_items SET status='failed', error_code=$3, error_message=$4, attempts=attempts+1, updated_at=now() WHERE job_id=$1 AND item_id=$2 AND status='pending'`,
        [job.id, item.item_id, e.code, e.message]);
    }
  }
  return withTx(async (tx) => {
    const j = await one<{ status: BulkJobStatus }>(tx, `SELECT status FROM bulk_jobs WHERE id=$1 FOR UPDATE`, [job.id]);
    if (j.status !== 'running') return { processed, status: j.status };
    const c = await one<{ pending: number; succeeded: number; failed: number }>(tx,
      `SELECT count(*) FILTER (WHERE status='pending')::int pending, count(*) FILTER (WHERE status='succeeded')::int succeeded, count(*) FILTER (WHERE status='failed')::int failed
         FROM bulk_job_items WHERE job_id=$1`, [job.id]);
    if (c.pending > 0) { // interrupted (cancel check / lease): leave for the sweep
      await tx.query(`UPDATE bulk_jobs SET status='queued', lease_until=NULL, updated_at=now() WHERE id=$1`, [job.id]);
      return { processed, status: 'queued' as const };
    }
    const status: BulkJobStatus = c.failed === 0 ? 'completed' : c.succeeded === 0 ? 'failed' : 'completed_with_errors';
    await tx.query(`UPDATE bulk_jobs SET status=$2, finished_at=now(), lease_until=NULL, updated_at=now() WHERE id=$1`, [job.id, status]);
    await audit(tx, { workspaceId: job.workspace_id, actorService: 'worker:bulk', actorUserId: job.created_by, action: 'bulk.finished', resourceType: 'bulk_job', resourceId: job.id,
      diff: { action: job.action, succeeded: c.succeeded, failed: c.failed }, correlationId: job.id });
    return { processed, status };
  });
}

/** Worker sweep: resume queued jobs whose wake-up was lost and running jobs whose runner died (expired lease). */
export async function sweepBulkJobs(limit = 5): Promise<number> {
  const due = await many<{ id: string }>(getPool(),
    `SELECT id FROM bulk_jobs WHERE (status='queued' AND updated_at < now() - interval '30 seconds') OR (status='running' AND lease_until < now()) ORDER BY updated_at LIMIT $1`, [limit]);
  for (const j of due) await runBulkJob(j.id);
  return due.length;
}

/** pg-boss 'bulk-ops' handler: ids only; everything is reloaded and re-authorized. */
export async function handleBulkJob(data: { aggregateId: string }): Promise<void> {
  await runBulkJob(data.aggregateId);
}

