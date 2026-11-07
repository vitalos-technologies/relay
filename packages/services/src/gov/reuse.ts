// V3.1 §13 — content reuse + evergreen queue.
//  - Reuse/duplicate: a NEW draft with provenance (original → derived); never a re-publication of the original.
//  - Evergreen eligibility is explicit (default: not eligible) and re-checked against time-sensitive signals every
//    time: TipSignal picks/results (and anything derived from them), dates/times, scores, probabilities, ended
//    campaigns, expired content/promotions and expired assets are never recycled.
//  - Queue: brand-level, pausable, inspectable. "Schedule next" consumes ONE item into ONE slot occurrence through the
//    normal slot/scheduling pipeline; an item/post is consumed once. Slots never authorize recurring publication of the
//    same content — reusing it again needs a new derived draft (and passes every check again).
import { z } from 'zod';
import { AppError, notFound, resolveVariants } from '@social-lite/core';
import type { ContentQueueDto, ContentQueueItemDto, ProvenanceDto, ReuseEligibility, ReuseResult, SimilarPostWarning, TimeSensitiveReason } from '@social-lite/core/contracts/v31-gov';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { assertBrand, assertUuid, authorizeCtx, requireAction } from '../tenancy.js';
import { loadPost, type PostRow } from '../posts/service.js';
import { brandConnections, excerpt } from '../posts/shared.js';
import { recordVersion } from '../posts/versions.js';
import { findDuplicates } from '../product/duplicates.js';
import { queuePost } from '../slots/service.js';
import { extractFacts } from '../ai/fidelity.js';

const PROMO_TAGS = new Set(['promo', 'promotion', 'offer', 'sale', 'deal', 'discount', 'competition', 'giveaway', 'limited']);
const TIME_SENSITIVE_TAGS = new Set(['tipsignal', 'picks', 'pick', 'picks.ready', 'results', 'result', 'results.settled', 'fixture', 'live']);

export interface SignalInput {
  sourceKind: string | null;
  derivedFromTimeSensitive: boolean;
  text: string;
  tags: string[];
  campaignEndsOn: string | null;     // YYYY-MM-DD
  contentExpiresAt: Date | null;
  assetExpired: boolean;
  now: Date;
}

/** Pure: why this content is time-sensitive (empty = no signal). */
export function timeSensitiveReasons(i: SignalInput): Array<{ code: TimeSensitiveReason; message: string }> {
  const out: Array<{ code: TimeSensitiveReason; message: string }> = [];
  const tags = i.tags.map((t) => t.toLowerCase());
  if (i.sourceKind === 'tipsignal' || tags.some((t) => TIME_SENSITIVE_TAGS.has(t))) out.push({ code: 'tipsignal_source', message: 'Football picks and results are time-sensitive and are never recycled.' });
  if (i.derivedFromTimeSensitive) out.push({ code: 'derived_from_time_sensitive', message: 'Derived from time-sensitive content.' });
  const facts = extractFacts(i.text);
  if (facts.some((f) => f.kind === 'date' || f.kind === 'time')) out.push({ code: 'contains_date_or_time', message: 'Mentions a date or time; remove it to make this evergreen.' });
  if (facts.some((f) => f.kind === 'score')) out.push({ code: 'contains_score', message: 'Mentions a score or result.' });
  if (facts.some((f) => f.kind === 'percent')) out.push({ code: 'contains_probability', message: 'Mentions a probability or percentage.' });
  if (i.campaignEndsOn && i.campaignEndsOn < i.now.toISOString().slice(0, 10)) out.push({ code: 'campaign_ended', message: `Its campaign ended on ${i.campaignEndsOn}.` });
  if (i.contentExpiresAt && i.contentExpiresAt.getTime() <= i.now.getTime()) out.push({ code: 'content_expired', message: `Expired on ${i.contentExpiresAt.toISOString().slice(0, 10)}.` });
  if (tags.some((t) => PROMO_TAGS.has(t)) && !(i.contentExpiresAt && i.contentExpiresAt.getTime() > i.now.getTime())) {
    out.push({ code: 'promotion_tag', message: 'Promotions need an end date before they can be reused.' });
  }
  if (i.assetExpired) out.push({ code: 'asset_expired', message: 'Uses an expired asset.' });
  return out;
}

async function derivedFromTimeSensitive(db: Queryable, workspaceId: string, postId: string): Promise<boolean> {
  // Walk the provenance chain (bounded) looking for a TipSignal/time-sensitive-tagged ancestor.
  const r = await maybeOne<{ hit: boolean }>(db,
    `WITH RECURSIVE chain(id, depth) AS (
       SELECT original_post_ref, 1 FROM content_provenance WHERE workspace_id=$1 AND derived_post_id=$2
       UNION ALL
       SELECT cp.original_post_ref, c.depth + 1 FROM content_provenance cp JOIN chain c ON cp.derived_post_id=c.id WHERE cp.workspace_id=$1 AND c.depth < 20)
     SELECT EXISTS (SELECT 1 FROM chain c JOIN posts p ON p.id=c.id WHERE p.workspace_id=$1
       AND (p.source->>'kind' = 'tipsignal' OR p.tags && ARRAY['tipsignal','picks','results']::text[])) AS hit`, [workspaceId, postId]);
  return !!r?.hit;
}

export async function eligibilityFor(db: Queryable, workspaceId: string, post: PostRow, now = new Date()): Promise<ReuseEligibility> {
  const policy = await maybeOne<{ evergreen: boolean; expires_at: Date | null }>(db, `SELECT evergreen, expires_at FROM content_reuse_policy WHERE post_id=$1 AND workspace_id=$2`, [post.id, workspaceId]);
  const campaign = (post as PostRow & { campaign_id?: string | null }).campaign_id
    ? await maybeOne<{ ends_on: string | null }>(db, `SELECT to_char(ends_on,'YYYY-MM-DD') AS ends_on FROM campaigns WHERE id=$1 AND workspace_id=$2`, [(post as { campaign_id?: string }).campaign_id, workspaceId])
    : null;
  const assetIds = [...new Set([...(post.draft.baseAssetIds ?? []), ...post.draft.variants.flatMap((v) => v.assetIds ?? [])])];
  const expired = assetIds.length ? await maybeOne(db, `SELECT 1 FROM asset_governance WHERE workspace_id=$1 AND asset_id = ANY($2::uuid[]) AND expires_at <= $3`, [workspaceId, assetIds, now]) : null;
  const texts = [post.draft.baseText ?? '', ...post.draft.variants.filter((v) => !v.inheritText).map((v) => v.text ?? '')].join('\n');
  const reasons: ReuseEligibility['reasons'] = timeSensitiveReasons({
    sourceKind: (post.source?.kind as string | undefined) ?? null, derivedFromTimeSensitive: await derivedFromTimeSensitive(db, workspaceId, post.id),
    text: texts, tags: post.tags ?? [], campaignEndsOn: campaign?.ends_on ?? null, contentExpiresAt: policy?.expires_at ?? null, assetExpired: !!expired, now,
  });
  if (!policy?.evergreen) reasons.unshift({ code: 'not_marked_evergreen', message: 'Not marked as evergreen.' });
  if (post.archived_at) reasons.push({ code: 'archived', message: 'Archived.' });
  const used = await maybeOne(db, `SELECT 1 FROM deliveries WHERE post_id=$1 AND state='published' LIMIT 1`, [post.id]);
  if (used) reasons.push({ code: 'already_used', message: 'Already published. Reuse it as a new draft instead.' });
  return { post_id: post.id, evergreen: !!policy?.evergreen, eligible: reasons.length === 0, reasons, expires_at: policy?.expires_at?.toISOString() ?? null };
}

// ------------------------------------------------------------------ evergreen marking
export const evergreenSchema = z.object({ evergreen: z.boolean(), expires_at: z.string().datetime({ offset: true }).nullish(), note: z.string().trim().max(500).nullish() }).strict();

export async function getReuseEligibility(ctx: Ctx, postId: string): Promise<ReuseEligibility> {
  const db = getPool();
  const post = await loadPost(ctx, postId, db);
  requireAction(ctx, 'content.read', { brandId: post.brand_id });
  return eligibilityFor(db, ctx.access.workspaceId, post);
}

export async function setEvergreen(ctx: Ctx, postId: string, raw: unknown): Promise<ReuseEligibility> {
  const input = evergreenSchema.parse(raw);
  const db = getPool();
  const post = await loadPost(ctx, postId, db);
  requireAction(ctx, 'content.edit', { brandId: post.brand_id });
  if (input.evergreen && (post.source?.kind === 'tipsignal' || await derivedFromTimeSensitive(db, ctx.access.workspaceId, post.id))) {
    throw new AppError('validation_failed', 'Football picks and results are time-sensitive and can’t be marked evergreen.', { evergreen: 'Time-sensitive content' }, { reason: 'time_sensitive' });
  }
  await withTx(async (tx) => {
    await tx.query(
      `INSERT INTO content_reuse_policy(post_id, workspace_id, brand_id, evergreen, expires_at, note, marked_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (post_id) DO UPDATE SET evergreen=$4, expires_at=$5, note=$6, marked_by=$7, marked_at=now()`,
      [post.id, ctx.access.workspaceId, post.brand_id, input.evergreen, input.expires_at ? new Date(input.expires_at) : null, input.note ?? null, ctx.actor.userId]);
    if (!input.evergreen) {
      await tx.query(`UPDATE content_queue_items SET status='removed', removed_at=now(), removed_by=$2, removed_reason='no_longer_evergreen' WHERE post_id=$1 AND status='queued'`, [post.id, ctx.actor.userId]);
    }
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: post.brand_id, actorUserId: ctx.actor.userId, action: 'post.evergreen_set', resourceType: 'post', resourceId: post.id,
      diff: { evergreen: input.evergreen, expires_at: input.expires_at ?? null }, correlationId: ctx.correlationId });
  });
  return eligibilityFor(db, ctx.access.workspaceId, post);
}

// ------------------------------------------------------------------ reuse as a new draft (provenance)
export const reuseSchema = z.object({ mode: z.enum(['duplicate', 'reuse']).default('reuse'), title: z.string().trim().max(200).optional() }).strict();

export async function similarPosts(ctx: Ctx, postId: string, opts: { lookbackDays?: number } = {}, db: Queryable = getPool()): Promise<SimilarPostWarning[]> {
  const post = await loadPost(ctx, postId, db);
  requireAction(ctx, 'content.read', { brandId: post.brand_id });
  const days = Math.min(Math.max(opts.lookbackDays ?? 30, 1), 365);
  const conns = await brandConnections(db, ctx.access.workspaceId, post.brand_id);
  const ids = post.draft.variants.map((v) => v.connectionId).filter((id) => conns.some((c) => c.id === id));
  if (!ids.length) return [];
  const resolved = resolveVariants({ ...post.draft, variants: post.draft.variants.filter((v) => ids.includes(v.connectionId)) }, conns);
  // Reuses V2 duplicate detection per destination, looking back `days` around now.
  const dups = await findDuplicates(db, { workspaceId: ctx.access.workspaceId, postId: post.id, at: new Date(), windowHours: days * 24,
    targets: resolved.map((v) => ({ connectionId: v.connectionId, text: v.text, assetIds: v.assetIds })) });
  const exclude = new Set([post.id]);
  return dups.filter((d) => !exclude.has(d.other_post_id)).map((d) => ({ connection_id: d.connection_id, other_post_id: d.other_post_id, other_title: d.other_title,
    other_excerpt: d.other_excerpt, other_at: d.other_at, similarity: d.similarity, same_media: d.same_media }));
}

export async function reusePost(ctx: Ctx, postId: string, raw: unknown): Promise<ReuseResult> {
  const input = reuseSchema.parse(raw ?? {});
  const db = getPool();
  const original = await loadPost(ctx, postId, db);
  requireAction(ctx, 'content.create', { brandId: original.brand_id, message: 'You cannot create drafts for this brand' });
  requireAction(ctx, 'content.read', { brandId: original.brand_id });
  const brand = await assertBrand(ctx, original.brand_id, db);
  if (brand.archived_at) throw new AppError('invalid_state', 'This brand is archived');
  if (original.source?.kind === 'tipsignal' || await derivedFromTimeSensitive(db, ctx.access.workspaceId, original.id)) {
    throw new AppError('invalid_state', 'Football picks and results are time-sensitive and are never recycled.', undefined, { reason: 'time_sensitive' });
  }
  if (input.mode === 'reuse') {
    const ok = await maybeOne(db, `SELECT 1 FROM deliveries WHERE post_id=$1 AND state='published' LIMIT 1`, [original.id]);
    if (!ok) throw new AppError('invalid_state', 'Only published posts can be reused. Duplicate it instead.', undefined, { reason: 'not_published' });
  }
  const title = input.title ?? (original.title ? `${original.title} (${input.mode === 'reuse' ? 'reuse' : 'copy'})`.slice(0, 200) : null);
  const draft = original.draft;
  const derivedId = await withTx(async (tx) => {
    const p = await one<{ id: string }>(tx,
      `INSERT INTO posts(workspace_id, brand_id, created_by, updated_by, title, draft, tags) VALUES ($1,$2,$3,$3,$4,$5,$6) RETURNING id`,
      [ctx.access.workspaceId, original.brand_id, ctx.actor.userId, title, JSON.stringify(draft), (original.tags ?? []).filter((t) => !PROMO_TAGS.has(t.toLowerCase()))]);
    await recordVersion(tx, ctx, { postId: p.id, version: 1, baseVersion: 1, kind: 'created', title, draft });
    await tx.query(
      `INSERT INTO content_provenance(derived_post_id, workspace_id, brand_id, original_post_id, original_post_ref, original_revision_id, kind, created_by)
       VALUES ($1,$2,$3,$4,$4,$5,$6,$7)`, [p.id, ctx.access.workspaceId, original.brand_id, original.id, original.current_revision_id, input.mode, ctx.actor.userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: original.brand_id, actorUserId: ctx.actor.userId, action: 'post.created', resourceType: 'post', resourceId: p.id,
      diff: { via: input.mode, original_post_id: original.id, original_revision_id: original.current_revision_id }, correlationId: ctx.correlationId });
    return p.id;
  });
  const derived = await loadPost(ctx, derivedId, db);
  return {
    post_id: derivedId, provenance: (await getProvenance(ctx, derivedId)).derived_from!,
    eligibility: await eligibilityFor(db, ctx.access.workspaceId, derived), similar: await similarPosts(ctx, derivedId),
  };
}

interface ProvRow { derived_post_id: string; original_post_id: string | null; original_post_ref: string; original_revision_id: string | null; kind: 'duplicate' | 'reuse'; created_at: Date }
const provDto = (r: ProvRow): ProvenanceDto => ({ derived_post_id: r.derived_post_id, original_post_id: r.original_post_id, original_post_ref: r.original_post_ref,
  original_revision_id: r.original_revision_id, kind: r.kind, created_at: r.created_at.toISOString() });

/** Where a post came from and what was derived from it (only posts the caller can see). */
export async function getProvenance(ctx: Ctx, postId: string): Promise<{ derived_from: ProvenanceDto | null; derivatives: ProvenanceDto[] }> {
  const db = getPool();
  const post = await loadPost(ctx, postId, db);
  requireAction(ctx, 'content.read', { brandId: post.brand_id });
  const from = await maybeOne<ProvRow>(db, `SELECT * FROM content_provenance WHERE workspace_id=$1 AND derived_post_id=$2`, [ctx.access.workspaceId, post.id]);
  const der = await many<ProvRow>(db, `SELECT * FROM content_provenance WHERE workspace_id=$1 AND original_post_ref=$2 AND brand_id=$3 ORDER BY created_at DESC LIMIT 100`,
    [ctx.access.workspaceId, post.id, post.brand_id]);
  return { derived_from: from ? provDto(from) : null, derivatives: der.map(provDto) };
}

// ------------------------------------------------------------------ queue
interface ItemRow { id: string; post_id: string; status: 'queued' | 'scheduled' | 'removed'; position: string; added_at: Date; schedule_id: string | null; scheduled_at: Date | null }

export async function getContentQueue(ctx: Ctx, brandId: string, q: { include_removed?: boolean } = {}): Promise<ContentQueueDto> {
  const db = getPool();
  const brand = await assertBrand(ctx, brandId, db);
  requireAction(ctx, 'content.read', { brandId: brand.id });
  const qrow = await maybeOne<{ paused: boolean; paused_reason: string | null; paused_at: Date | null }>(db, `SELECT paused, paused_reason, paused_at FROM content_queues WHERE brand_id=$1 AND workspace_id=$2`, [brand.id, ctx.access.workspaceId]);
  const rows = await many<ItemRow>(db,
    `SELECT id, post_id, status, position::text, added_at, schedule_id, scheduled_at FROM content_queue_items
      WHERE workspace_id=$1 AND brand_id=$2 AND status IN ${q.include_removed ? `('queued','scheduled','removed')` : `('queued','scheduled')`}
      ORDER BY (status='queued') DESC, position, added_at LIMIT 200`, [ctx.access.workspaceId, brand.id]);
  const posts = rows.length ? await many<PostRow>(db, `SELECT * FROM posts WHERE workspace_id=$1 AND id = ANY($2::uuid[])`, [ctx.access.workspaceId, rows.map((r) => r.post_id)]) : [];
  const items: ContentQueueItemDto[] = [];
  for (const r of rows) {
    const p = posts.find((x) => x.id === r.post_id);
    if (!p) continue;
    const el = await eligibilityFor(db, ctx.access.workspaceId, p);
    items.push({ id: r.id, post_id: r.post_id, title: p.title, excerpt: excerpt(p.draft.baseText ?? ''), status: r.status, position: Number(r.position), added_at: r.added_at.toISOString(),
      schedule_id: r.schedule_id, scheduled_at: r.scheduled_at?.toISOString() ?? null,
      eligibility: r.status === 'queued' ? el : { ...el, reasons: el.reasons.filter((x) => x.code !== 'already_used') } });
  }
  const may = (p: Parameters<typeof authorizeCtx>[1]) => authorizeCtx(ctx, p, { brandId: brand.id }).allowed;
  return {
    brand_id: brand.id, paused: qrow?.paused ?? false, paused_reason: qrow?.paused_reason ?? null, paused_at: qrow?.paused_at?.toISOString() ?? null, items,
    can: { add: may('content.edit'), pause: may('publishing.pause'), resume: may('publishing.resume'), schedule_next: may('content.schedule') || (brand.approval_required && may('content.edit')) },
  };
}

export async function addToContentQueue(ctx: Ctx, postId: string, expectedBrandId?: string): Promise<ContentQueueItemDto> {
  const db = getPool();
  const post = await loadPost(ctx, postId, db);
  if (expectedBrandId && post.brand_id !== expectedBrandId) throw notFound('Post');
  requireAction(ctx, 'content.edit', { brandId: post.brand_id });
  const el = await eligibilityFor(db, ctx.access.workspaceId, post);
  if (!el.eligible) throw new AppError('invalid_state', `Not eligible for the queue: ${el.reasons.map((r) => r.message).join(' ')}`, undefined, { reason: 'not_eligible', eligibility: el });
  const live = await maybeOne(db, `SELECT 1 FROM schedules WHERE post_id=$1 AND status IN ('active','pending_approval')`, [post.id]);
  if (live) throw new AppError('invalid_state', 'This post is already scheduled.', undefined, { reason: 'already_scheduled' });
  const row = await withTx(async (tx) => {
    await tx.query(`INSERT INTO content_queues(brand_id, workspace_id) VALUES ($1,$2) ON CONFLICT (brand_id) DO NOTHING`, [post.brand_id, ctx.access.workspaceId]);
    const r = await maybeOne<ItemRow>(tx,
      `INSERT INTO content_queue_items(workspace_id, brand_id, post_id, position, added_by)
       VALUES ($1,$2,$3,(SELECT coalesce(max(position),0)+1 FROM content_queue_items WHERE brand_id=$2),$4)
       ON CONFLICT DO NOTHING RETURNING id, post_id, status, position::text, added_at, schedule_id, scheduled_at`, [ctx.access.workspaceId, post.brand_id, post.id, ctx.actor.userId]);
    if (!r) throw new AppError('conflict', 'This post is already in the queue (or was already used from it).', undefined, { reason: 'already_queued' });
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: post.brand_id, actorUserId: ctx.actor.userId, action: 'content_queue.added', resourceType: 'post', resourceId: post.id,
      diff: { item_id: r.id }, correlationId: ctx.correlationId });
    return r;
  });
  return { id: row.id, post_id: post.id, title: post.title, excerpt: excerpt(post.draft.baseText ?? ''), status: 'queued', position: Number(row.position), added_at: row.added_at.toISOString(),
    schedule_id: null, scheduled_at: null, eligibility: el };
}

async function loadItem(ctx: Ctx, itemId: string, db: Queryable) {
  assertUuid(itemId, 'Queue item');
  const it = await maybeOne<ItemRow & { brand_id: string }>(db, `SELECT id, post_id, brand_id, status, position::text, added_at, schedule_id, scheduled_at FROM content_queue_items WHERE id=$1 AND workspace_id=$2`, [itemId, ctx.access.workspaceId]);
  if (!it) throw notFound('Queue item');
  await assertBrand(ctx, it.brand_id, db).catch(() => { throw notFound('Queue item'); });
  return it;
}

export async function removeFromContentQueue(ctx: Ctx, itemId: string): Promise<{ ok: true }> {
  const db = getPool();
  const it = await loadItem(ctx, itemId, db);
  requireAction(ctx, 'content.edit', { brandId: it.brand_id });
  if (it.status !== 'queued') throw new AppError('invalid_state', 'Only queued items can be removed. Cancel the schedule instead.');
  await withTx(async (tx) => {
    await tx.query(`UPDATE content_queue_items SET status='removed', removed_at=now(), removed_by=$2, removed_reason='removed' WHERE id=$1 AND status='queued'`, [it.id, ctx.actor.userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: it.brand_id, actorUserId: ctx.actor.userId, action: 'content_queue.removed', resourceType: 'post', resourceId: it.post_id, diff: { item_id: it.id }, correlationId: ctx.correlationId });
  });
  return { ok: true };
}

export const queuePauseSchema = z.object({ paused: z.boolean(), reason: z.string().trim().max(500).nullish() }).strict();

export async function setContentQueuePaused(ctx: Ctx, brandId: string, raw: unknown): Promise<ContentQueueDto> {
  const input = queuePauseSchema.parse(raw);
  const db = getPool();
  const brand = await assertBrand(ctx, brandId, db);
  requireAction(ctx, input.paused ? 'publishing.pause' : 'publishing.resume', { brandId: brand.id });
  await withTx(async (tx) => {
    await tx.query(
      `INSERT INTO content_queues(brand_id, workspace_id, paused, paused_reason, paused_by, paused_at) VALUES ($1,$2,$3,$4,$5,CASE WHEN $3 THEN now() END)
       ON CONFLICT (brand_id) DO UPDATE SET paused=$3, paused_reason=$4, paused_by=$5, paused_at=CASE WHEN $3 THEN coalesce(content_queues.paused_at, now()) END, updated_at=now()`,
      [brand.id, ctx.access.workspaceId, input.paused, input.paused ? (input.reason ?? null) : null, input.paused ? ctx.actor.userId : null]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: brand.id, actorUserId: ctx.actor.userId, action: input.paused ? 'content_queue.paused' : 'content_queue.resumed',
      resourceType: 'brand', resourceId: brand.id, diff: { reason: input.reason ?? null }, correlationId: ctx.correlationId });
  });
  return getContentQueue(ctx, brand.id);
}

/**
 * Take the first ELIGIBLE queued item and place it into the next free slot occurrence (normal approval/permission/
 * validation/brand-rule pipeline). Ineligible items are skipped and reported, never scheduled. One item per call.
 */
export async function scheduleNextFromQueue(ctx: Ctx, brandId: string, idemKey: string | null) {
  const db = getPool();
  const brand = await assertBrand(ctx, brandId, db);
  if (!idemKey || idemKey.length < 8 || idemKey.length > 150) throw new AppError('validation_failed', 'An Idempotency-Key header (8-150 characters) is required for this request');
  const q = await maybeOne<{ paused: boolean }>(db, `SELECT paused FROM content_queues WHERE brand_id=$1 AND workspace_id=$2`, [brand.id, ctx.access.workspaceId]);
  if (q?.paused) throw new AppError('invalid_state', 'The queue is paused. Resume it first.', undefined, { reason: 'queue_paused' });
  // Replay: an item already scheduled under this key returns the same result.
  const prior = await maybeOne<{ id: string; post_id: string; schedule_id: string | null }>(db,
    `SELECT i.id, i.post_id, i.schedule_id FROM content_queue_items i JOIN idempotency_keys k ON k.workspace_id=i.workspace_id AND k.action='post.queue' AND k.key=$3
      WHERE i.workspace_id=$1 AND i.brand_id=$2 AND i.status='scheduled' AND (k.response_body->'schedule'->>'id')::uuid = i.schedule_id LIMIT 1`, [ctx.access.workspaceId, brand.id, `cq:${idemKey}`]);
  if (prior) return { item_id: prior.id, post_id: prior.post_id, schedule_id: prior.schedule_id, skipped: [], duplicate: true };
  const queued = await many<ItemRow>(db, `SELECT id, post_id, status, position::text, added_at, schedule_id, scheduled_at FROM content_queue_items
      WHERE workspace_id=$1 AND brand_id=$2 AND status='queued' ORDER BY position, added_at LIMIT 50`, [ctx.access.workspaceId, brand.id]);
  const skipped: Array<{ item_id: string; post_id: string; reasons: ReuseEligibility['reasons'] }> = [];
  for (const it of queued) {
    const post = await loadPost(ctx, it.post_id, db);
    const el = await eligibilityFor(db, ctx.access.workspaceId, post);
    if (!el.eligible) { skipped.push({ item_id: it.id, post_id: it.post_id, reasons: el.reasons }); continue; }
    const r = await queuePost(ctx, { post_id: post.id, expected_version: post.version }, `cq:${idemKey}`);
    const schedule = (r.body as { schedule: { id: string } }).schedule;
    const u = await db.query(`UPDATE content_queue_items SET status='scheduled', schedule_id=$2, scheduled_at=now() WHERE id=$1 AND status='queued'`, [it.id, schedule.id]);
    if (u.rowCount) {
      await audit(db, { workspaceId: ctx.access.workspaceId, brandId: brand.id, actorUserId: ctx.actor.userId, action: 'content_queue.scheduled', resourceType: 'post', resourceId: post.id,
        diff: { item_id: it.id, schedule_id: schedule.id }, correlationId: ctx.correlationId });
    }
    return { item_id: it.id, post_id: post.id, schedule_id: schedule.id, skipped, queue: (r.body as { queue?: unknown }).queue ?? null };
  }
  throw new AppError('invalid_state', queued.length ? 'No queued item is eligible right now.' : 'The queue is empty.', undefined, { reason: queued.length ? 'none_eligible' : 'empty', skipped });
}
