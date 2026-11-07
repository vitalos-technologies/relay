// Posts: mutable versioned working draft + immutable revisions/variants (CO-01..CO-08).
import {
  AppError, EMPTY_DRAFT, aggregateStatus, canSchedule, can, draftContentSchema, mergeResults, notFound, resolveVariants,
  validateVariant, measure, composeTextWithLink, type DeliveryState, type DraftContent, type ValidationResult,
} from '@social-lite/core';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { assertBrand, assertUuid, brandAllowed, brandFilter, requireAction, type BrandRow } from '../tenancy.js';
import { beginIdempotent, completeIdempotent } from '../idempotency.js';
import { brandConnections, capabilitiesFor, contentHash, excerpt, mediaFacts, type ConnectionRow } from './shared.js';
import { assetsByIds } from '../media/assets.js';
import { approvalJson, connectionJson, deliveryJson, DELIVERY_SELECT, scheduleJson, type ApprovalRow, type DeliveryRow, type ScheduleRow } from './serialize.js';

export interface PostRow {
  id: string; workspace_id: string; brand_id: string; created_by: string | null; title: string | null; tags: string[];
  draft: DraftContent; version: number; current_revision_id: string | null; schedule_generation: number;
  source: Record<string, unknown> | null; created_at: Date; updated_at: Date; updated_by: string | null; archived_at: Date | null;
}

export async function loadPost(ctx: Ctx, postId: string, db: Queryable = getPool(), lock = false): Promise<PostRow> {
  assertUuid(postId, 'Post');
  const p = await maybeOne<PostRow>(db, `SELECT * FROM posts WHERE id=$1 AND workspace_id=$2 ${lock ? 'FOR UPDATE' : ''}`, [postId, ctx.access.workspaceId]);
  if (!p || !brandAllowed(ctx, p.brand_id)) throw notFound('Post');
  return p;
}

function normaliseDraft(d: unknown): DraftContent {
  const parsed = draftContentSchema.safeParse(d ?? EMPTY_DRAFT);
  return parsed.success ? { ...parsed.data, baseLink: parsed.data.baseLink ?? null } : { ...EMPTY_DRAFT };
}

/** Ensure every referenced asset/connection belongs to the post's brand (no cross-tenant refs). */
async function assertDraftRefs(db: Queryable, ctx: Ctx, brandId: string, draft: DraftContent): Promise<void> {
  const assetIds = new Set([...draft.baseAssetIds, ...draft.variants.flatMap((v) => v.assetIds ?? [])]);
  if (assetIds.size) {
    const ok = await many<{ id: string }>(db, `SELECT id FROM assets WHERE workspace_id=$1 AND brand_id=$2 AND id = ANY($3::uuid[])`,
      [ctx.access.workspaceId, brandId, [...assetIds]]);
    if (ok.length !== assetIds.size) throw new AppError('validation_failed', 'One or more images do not belong to this brand', { media: 'Choose images from this brand’s library' });
  }
  const connIds = new Set(draft.variants.map((v) => v.connectionId));
  if (connIds.size) {
    const ok = await many<{ id: string }>(db, `SELECT id FROM connections WHERE workspace_id=$1 AND brand_id=$2 AND id = ANY($3::uuid[])`,
      [ctx.access.workspaceId, brandId, [...connIds]]);
    if (ok.length !== connIds.size) throw new AppError('validation_failed', 'One or more destinations do not belong to this brand', { destinations: 'Choose destinations connected to this brand' });
  }
}

export async function createPost(ctx: Ctx, brandId: string, input: { title?: string; template_id?: string; draft?: unknown; connection_ids?: string[] }, idemKey: string | null) {
  requireAction(ctx, 'drafts.edit');
  return withTx(async (tx) => {
    const brand = await assertBrand(ctx, brandId, tx);
    if (brand.archived_at) throw new AppError('invalid_state', 'This brand is archived');
    const idem = await beginIdempotent(tx, { workspaceId: ctx.access.workspaceId, userId: ctx.actor.userId, action: 'post.create', key: idemKey, body: { brandId, input } });
    if (idem) return idem.body as { id: string };
    let draft = normaliseDraft(input.draft);
    if (input.template_id) {
      assertUuid(input.template_id, 'Template');
      const t = await maybeOne<{ body: string }>(tx, `SELECT body FROM templates WHERE id=$1 AND workspace_id=$2 AND brand_id=$3 AND archived_at IS NULL`,
        [input.template_id, ctx.access.workspaceId, brandId]);
      if (!t) throw notFound('Template');
      draft = { ...draft, baseText: draft.baseText || t.body };
    }
    if (input.connection_ids?.length && !draft.variants.length) {
      draft.variants = input.connection_ids.map((connectionId) => ({ connectionId, inheritText: true, inheritMedia: true }));
    }
    await assertDraftRefs(tx, ctx, brandId, draft);
    const post = await one<{ id: string }>(tx,
      `INSERT INTO posts(workspace_id, brand_id, created_by, updated_by, title, draft) VALUES ($1,$2,$3,$3,$4,$5) RETURNING id`,
      [ctx.access.workspaceId, brandId, ctx.actor.userId, input.title?.slice(0, 200) ?? null, JSON.stringify(draft)]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId, actorUserId: ctx.actor.userId, action: 'post.created', resourceType: 'post', resourceId: post.id, correlationId: ctx.correlationId });
    const body = { id: post.id };
    await completeIdempotent(tx, { workspaceId: ctx.access.workspaceId, action: 'post.create', key: idemKey!, status: 200, body });
    return body;
  });
}

export async function updateDraft(ctx: Ctx, postId: string, input: { expected_version: number; draft?: unknown; title?: string | null; tags?: string[] }) {
  requireAction(ctx, 'drafts.edit');
  return withTx(async (tx) => {
    const post = await loadPost(ctx, postId, tx, true);
    if (post.archived_at) throw new AppError('invalid_state', 'This post is archived');
    if (post.version !== input.expected_version) {
      const who = await maybeOne<{ email: string }>(tx, `SELECT email FROM users WHERE id=$1`, [post.updated_by]);
      throw new AppError('version_conflict', 'Someone else saved this post since you opened it', undefined, {
        current: { version: post.version, updated_by: who?.email ?? null, updated_at: post.updated_at.toISOString() },
      });
    }
    const draft = input.draft === undefined ? post.draft : (draftContentSchema.parse(input.draft) as DraftContent);
    await assertDraftRefs(tx, ctx, post.brand_id, draft);
    const r = await one<{ version: number; updated_at: Date }>(tx,
      `UPDATE posts SET draft=$2, title=coalesce($3, title), tags=coalesce($4, tags), version=version+1, updated_at=now(), updated_by=$5
        WHERE id=$1 RETURNING version, updated_at`,
      [post.id, JSON.stringify(draft), input.title === undefined ? null : (input.title ?? ''), input.tags ?? null, ctx.actor.userId]);
    // AP-02: a content change invalidates any pending approval for this post.
    if (input.draft !== undefined) await invalidatePendingApprovalIfChanged(tx, ctx, post, draft);
    return { version: r.version, updated_at: r.updated_at.toISOString() };
  });
}

async function invalidatePendingApprovalIfChanged(tx: Queryable, ctx: Ctx, post: PostRow, draft: DraftContent): Promise<void> {
  const pending = await maybeOne<{ schedule_id: string; approval_id: string; content_hash: string; connection_ids: string[] }>(tx,
    `SELECT s.id AS schedule_id, a.id AS approval_id, r.content_hash,
            (SELECT array_agg(v.connection_id::text) FROM variants v WHERE v.revision_id = s.revision_id) AS connection_ids
       FROM schedules s JOIN approvals a ON a.schedule_id = s.id AND a.decision = 'pending'
       JOIN post_revisions r ON r.id = s.revision_id
      WHERE s.post_id=$1 AND s.status='pending_approval'`, [post.id]);
  if (!pending) return;
  const conns = await many<{ id: string; provider: ConnectionRow['provider'] }>(tx, `SELECT id, provider FROM connections WHERE id = ANY($1::uuid[])`, [pending.connection_ids ?? []]);
  const resolved = resolveVariants({ ...draft, variants: draft.variants.filter((v) => pending.connection_ids?.includes(v.connectionId)) }, conns);
  const hash = contentHash(draft.baseText, draft.baseLink ?? null, draft.baseAssetIds, resolved);
  if (hash === pending.content_hash) return;
  await tx.query(`UPDATE approvals SET decision='invalidated', decided_at=now(), reason='Content changed after submission' WHERE id=$1`, [pending.approval_id]);
  await tx.query(`UPDATE schedules SET status='superseded' WHERE id=$1`, [pending.schedule_id]);
  await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: post.brand_id, actorUserId: ctx.actor.userId, action: 'approval.invalidated', resourceType: 'approval', resourceId: pending.approval_id, diff: { reason: 'content_changed' }, correlationId: ctx.correlationId });
}

export interface DestinationValidation { ok: boolean; measured_length: number; limit: number; provider: string }

/** Validate the working draft for the selected (or all draft) destinations (CO-04). */
export async function validateDraft(db: Queryable, ctx: Ctx, post: PostRow, connectionIds?: string[]): Promise<ValidationResult & { per_destination: Record<string, DestinationValidation> }> {
  const all = await brandConnections(db, ctx.access.workspaceId, post.brand_id, true);
  const ids = connectionIds ?? post.draft.variants.map((v) => v.connectionId);
  const draft: DraftContent = { ...post.draft, variants: ids.map((id) => post.draft.variants.find((v) => v.connectionId === id) ?? { connectionId: id, inheritText: true, inheritMedia: true }) };
  const resolved = resolveVariants(draft, all);
  const results: ValidationResult[] = [];
  const per: Record<string, DestinationValidation> = {};
  if (!ids.length) results.push({ ok: false, issues: [{ field: 'destination', code: 'no_destinations', message: 'Choose at least one destination.' }] });
  for (const id of ids) {
    const conn = all.find((c) => c.id === id);
    if (!conn) { results.push({ ok: false, issues: [{ connectionId: id, field: 'destination', code: 'unknown_destination', message: 'This destination no longer exists. Remove it.' }] }); continue; }
    const v = resolved.find((x) => x.connectionId === id)!;
    const issues: ValidationResult['issues'] = [];
    if (conn.disconnected_at) issues.push({ connectionId: id, provider: conn.provider, field: 'destination', code: 'disconnected', message: `${conn.display_name} is disconnected. Reconnect it or deselect it.` });
    else if (!['ready', 'expiring', 'paused'].includes(conn.status)) issues.push({ connectionId: id, provider: conn.provider, field: 'destination', code: 'not_ready', message: `${conn.display_name} needs attention (${conn.status.replace(/_/g, ' ')}). Fix it on Accounts or deselect it.` });
    const caps = capabilitiesFor(conn);
    if (!caps) { results.push({ ok: false, issues: [...issues, { connectionId: id, provider: conn.provider, field: 'destination', code: 'no_capabilities', message: `${conn.display_name}: publishing rules are unavailable. Run an account check.` }] }); continue; }
    const media = await mediaFacts(db, ctx.access.workspaceId, v.assetIds);
    const linkSeparate = conn.provider === 'facebook' && media.length === 0;
    const r = validateVariant({ provider: conn.provider, connectionId: id, constraints: caps.constraints, text: v.text, link: v.link, buttons: v.buttons, media, linkIsSeparateField: linkSeparate });
    const outgoing = linkSeparate ? v.text : composeTextWithLink(v.text, v.link);
    per[id] = { ok: r.ok && issues.length === 0, measured_length: measure(outgoing, caps.constraints.textCounting), limit: media.length ? caps.constraints.maxCaptionLength : caps.constraints.maxTextLength, provider: conn.provider };
    results.push({ ok: r.ok && !issues.length, issues: [...issues, ...r.issues] });
  }
  return { ...mergeResults(results), per_destination: per };
}

export async function validatePost(ctx: Ctx, postId: string, connectionIds?: string[]) {
  const db = getPool();
  const post = await loadPost(ctx, postId, db);
  return validateDraft(db, ctx, post, connectionIds);
}

async function summariesFor(db: Queryable, posts: PostRow[]) {
  if (!posts.length) return [];
  const ids = posts.map((p) => p.id);
  const sched = await many<{ post_id: string; due_at: Date; status: string; id: string }>(db,
    `SELECT DISTINCT ON (post_id) post_id, due_at, status, id FROM schedules WHERE post_id = ANY($1::uuid[]) ORDER BY post_id, generation DESC`, [ids]);
  const dels = await many<{ post_id: string; schedule_id: string; connection_id: string; provider: string; is_mock: boolean; state: DeliveryState }>(db,
    `SELECT post_id, schedule_id, connection_id, provider, is_mock, state FROM deliveries WHERE post_id = ANY($1::uuid[])`, [ids]);
  return posts.map((p) => {
    const s = sched.find((x) => x.post_id === p.id);
    const ds = s ? dels.filter((d) => d.schedule_id === s.id) : [];
    let status = ds.length ? aggregateStatus(ds.map((d) => d.state)) : 'draft';
    if (s?.status === 'pending_approval') status = 'pending_approval';
    if (s?.status === 'cancelled' && !ds.some((d) => d.state === 'published')) status = 'cancelled';
    const destinations = ds.length ? ds.map((d) => ({ connection_id: d.connection_id, provider: d.provider, is_mock: d.is_mock, state: d.state }))
      : p.draft.variants.map((v) => ({ connection_id: v.connectionId, provider: null, is_mock: null, state: null }));
    return {
      id: p.id, brand_id: p.brand_id, title: p.title, excerpt: excerpt(p.draft.baseText ?? ''), tags: p.tags, status,
      version: p.version, updated_at: p.updated_at.toISOString(), due_at: s && ['active', 'pending_approval', 'completed'].includes(s.status) ? s.due_at.toISOString() : null,
      destinations,
    };
  });
}

export async function listPosts(ctx: Ctx, brandId: string, q: { q?: string; tag?: string; cursor?: string; limit?: number; archived?: boolean }) {
  const db = getPool();
  await assertBrand(ctx, brandId, db);
  const limit = Math.min(Math.max(q.limit ?? 30, 1), 100);
  const params: unknown[] = [ctx.access.workspaceId, brandId];
  let where = `workspace_id=$1 AND brand_id=$2 AND archived_at IS ${q.archived ? 'NOT ' : ''}NULL`;
  if (q.q) { params.push(`%${q.q.slice(0, 100)}%`); where += ` AND (title ILIKE $${params.length} OR draft->>'baseText' ILIKE $${params.length})`; }
  if (q.tag) { params.push(q.tag); where += ` AND $${params.length} = ANY(tags)`; }
  if (q.cursor) {
    const [ts, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
    params.push(ts, id); where += ` AND (updated_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(limit + 1);
  const rows = await many<PostRow>(db, `SELECT * FROM posts WHERE ${where} ORDER BY updated_at DESC, id DESC LIMIT $${params.length}`, params);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: await summariesFor(db, page),
    next_cursor: rows.length > limit && last ? Buffer.from(`${last.updated_at.toISOString()}|${last.id}`).toString('base64url') : null,
  };
}

export async function brandJson(db: Queryable, b: BrandRow) {
  const n = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM connections WHERE brand_id=$1 AND disconnected_at IS NULL`, [b.id]);
  return {
    id: b.id, name: b.name, timezone: b.timezone, approval_required: b.approval_required, editors_can_publish: b.editors_can_publish,
    default_deadline_minutes: b.default_deadline_minutes, publishing_paused: b.publishing_paused, paused_reason: b.paused_reason,
    paused_at: b.paused_at?.toISOString() ?? null, voice: b.voice, is_demo: b.is_demo, connection_count: n.n, created_at: b.created_at.toISOString(),
  };
}

export async function deliveriesForSchedule(db: Queryable, scheduleId: string): Promise<DeliveryRow[]> {
  return many<DeliveryRow>(db, `SELECT ${DELIVERY_SELECT} FROM deliveries d JOIN connections c ON c.id=d.connection_id WHERE d.schedule_id=$1 ORDER BY d.provider, c.display_name`, [scheduleId]);
}

export async function getPostDetail(ctx: Ctx, postId: string) {
  const db = getPool();
  const post = await loadPost(ctx, postId, db);
  const brand = await assertBrand(ctx, post.brand_id, db);
  const conns = await brandConnections(db, ctx.access.workspaceId, post.brand_id, true);
  const draftConnIds = new Set(post.draft.variants.map((v) => v.connectionId));
  const assetIds = [...new Set([...post.draft.baseAssetIds, ...post.draft.variants.flatMap((v) => v.assetIds ?? [])])];
  const assets = await assetsByIds(ctx, assetIds, db); // includes short-lived signed preview/thumb URLs
  const sched = await maybeOne<ScheduleRow>(db,
    `SELECT s.*, r.revision_number, u.email AS created_by_email FROM schedules s JOIN post_revisions r ON r.id=s.revision_id
       LEFT JOIN users u ON u.id=s.created_by WHERE s.post_id=$1 ORDER BY s.generation DESC LIMIT 1`, [post.id]);
  const approval = sched ? await maybeOne<ApprovalRow>(db,
    `SELECT a.*, ru.email AS requested_by_email, rv.email AS reviewer_email FROM approvals a
       LEFT JOIN users ru ON ru.id=a.requested_by LEFT JOIN users rv ON rv.id=a.reviewer_id
      WHERE a.schedule_id=$1 ORDER BY a.requested_at DESC LIMIT 1`, [sched.id]) : null;
  const deliveries = sched ? await deliveriesForSchedule(db, sched.id) : [];
  const [summary] = await summariesFor(db, [post]);
  const updatedBy = await maybeOne<{ email: string }>(db, `SELECT email FROM users WHERE id=$1`, [post.updated_by]);
  const isApproved = approval?.decision === 'approved' && sched?.status === 'active';
  const sc = canSchedule({ role: ctx.access.role, editorsCanPublish: brand.editors_can_publish, approvalRequired: brand.approval_required, contentApproved: isApproved });
  const live = sched && ['active', 'pending_approval'].includes(sched.status);
  const scheduleBlockedByApproval = brand.approval_required;
  return {
    ...summary!,
    draft: post.draft, created_by: post.created_by, updated_by_email: updatedBy?.email ?? null, source: post.source,
    brand: await brandJson(db, brand),
    connections: conns.filter((c) => !c.disconnected_at || draftConnIds.has(c.id)).map(connectionJson),
    assets,
    current_schedule: sched ? scheduleJson(sched) : null,
    approval: approval ? approvalJson(approval) : null,
    deliveries: deliveries.map((d) => deliveryJson(d)),
    can: {
      edit: can(ctx.access.role, 'drafts.edit') && !post.archived_at,
      schedule: sc.allowed && !scheduleBlockedByApproval && !post.archived_at,
      schedule_reason: scheduleBlockedByApproval ? 'This brand requires approval: submit for review.' : sc.reason,
      submit: can(ctx.access.role, 'drafts.edit') && brand.approval_required && !post.archived_at,
      publish_now: sc.allowed && !scheduleBlockedByApproval && !post.archived_at,
      cancel: !!live && (can(ctx.access.role, 'schedule.publish') || ctx.access.role === 'approver' || (ctx.access.role === 'editor' && brand.editors_can_publish)),
    },
  };
}

export async function duplicatePost(ctx: Ctx, postId: string, idemKey: string | null) {
  const post = await loadPost(ctx, postId);
  return createPost(ctx, post.brand_id, { title: post.title ? `${post.title} (copy)` : undefined, draft: post.draft }, idemKey);
}

export async function archivePost(ctx: Ctx, postId: string) {
  requireAction(ctx, 'drafts.edit');
  return withTx(async (tx) => {
    const post = await loadPost(ctx, postId, tx, true);
    const live = await maybeOne(tx, `SELECT 1 FROM schedules WHERE post_id=$1 AND status IN ('active','pending_approval')`, [post.id]);
    const active = await maybeOne(tx, `SELECT 1 FROM deliveries WHERE post_id=$1 AND state NOT IN ('published','failed','cancelled','expired')`, [post.id]);
    if (live && active) throw new AppError('invalid_state', 'Cancel the schedule before archiving this post');
    await tx.query(`UPDATE posts SET archived_at=now() WHERE id=$1`, [post.id]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: post.brand_id, actorUserId: ctx.actor.userId, action: 'post.archived', resourceType: 'post', resourceId: post.id, correlationId: ctx.correlationId });
    return { ok: true };
  });
}

export { brandFilter };
