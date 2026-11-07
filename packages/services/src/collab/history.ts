// Version history + comparison + post activity (composer "Version history" and "Activity").
//  - Versions are paginated metadata (author, time, change summary); drafts are only loaded for the page being
//    summarised, and full content only when two versions are compared (lazy).
//  - Submitted revisions (immutable) carry their review decisions and publication references.
//  - Restoring creates a NEW version (posts/versions.ts restoreVersion → optimistic save): history is never rewritten,
//    published records are untouched and old approvals are never restored (the content change invalidates pending ones).
import { AppError, changeSummary, changedFields, notFound, type DraftContent, type DraftField } from '@social-lite/core';
import { getPool, many, maybeOne, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { assertUuid, authorizeCtx, isUuid, requireAction } from '../tenancy.js';
import { loadPost, type PostRow } from '../posts/service.js';
import { assetsByIds } from '../media/assets.js';

interface VRow { id: string; version: number | null; base_version: number; kind: string; title: string | null; saved_by: string | null; name: string | null; email: string | null; restored_from: string | null; created_at: Date }

/** One page of versions, newest first, each with a change summary against the version before it. */
export async function listVersionHistory(ctx: Ctx, postId: string, q: { cursor?: string | null; limit?: number | null } = {}) {
  requireAction(ctx, 'content.read');
  const db = getPool();
  const post = await loadPost(ctx, postId, db);
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 50);
  const params: unknown[] = [post.id, ctx.access.workspaceId];
  let where = 'v.post_id=$1 AND v.workspace_id=$2';
  if (q.cursor) {
    const [ts, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
    if (!ts || !isUuid(id)) throw new AppError('validation_failed', 'Invalid cursor');
    params.push(ts, id); where += ` AND (v.created_at, v.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(limit + 1);
  const rows = await many<VRow>(db,
    `SELECT v.id, v.version, v.base_version, v.kind, v.title, v.saved_by, u.name, u.email, v.restored_from, v.created_at
       FROM post_versions v LEFT JOIN users u ON u.id=v.saved_by WHERE ${where} ORDER BY v.created_at DESC, v.id DESC LIMIT $${params.length}`, params);
  const page = rows.slice(0, limit);
  // Drafts needed for summaries: the page's own versions, their predecessors and conflict copies' bases (bounded).
  const nums = page.flatMap((r) => (r.version ? [r.version] : [r.base_version]));
  const minV = nums.length ? Math.max(1, Math.min(...nums) - 25) : 1;
  const maxV = nums.length ? Math.max(...nums) : 0;
  const snaps = await many<{ id: string; version: number | null; title: string | null; draft: DraftContent }>(db,
    `SELECT id, version, title, draft FROM post_versions WHERE post_id=$1 AND (id = ANY($2::uuid[]) OR (version BETWEEN $3 AND $4))`,
    [post.id, page.map((r) => r.id), minV, maxV]);
  const byId = new Map(snaps.map((s) => [s.id, s]));
  const versioned = snaps.filter((s) => s.version !== null).sort((a, b) => b.version! - a.version!);
  const prevOf = (v: number) => versioned.find((s) => s.version! < v) ?? null;
  const atVersion = (v: number) => versioned.find((s) => s.version === v) ?? null;
  // Threads anchored to each version (comments that refer to older versions).
  const threads = await many<{ anchor_version: number; n: number }>(db,
    `SELECT anchor_version, count(*)::int n FROM comment_threads WHERE post_id=$1 AND anchor_version = ANY($2::int[]) AND resolved_at IS NULL
        AND ($3 OR visibility='shared') GROUP BY anchor_version`,
    [post.id, page.map((r) => r.version).filter((v): v is number => v !== null), authorizeCtx(ctx, 'comments.internal', { brandId: post.brand_id }).allowed]);
  const items = page.map((r) => {
    const cur = byId.get(r.id);
    const prev = r.version ? prevOf(r.version) : atVersion(r.base_version);
    const fields: DraftField[] = cur && prev ? changedFields({ title: prev.title, draft: prev.draft }, { title: cur.title, draft: cur.draft }) : [];
    return {
      id: r.id, version: r.version, base_version: r.base_version, kind: r.kind, current: r.version === post.version,
      author: r.saved_by ? { id: r.saved_by, name: r.name, email: r.email } : null, created_at: r.created_at.toISOString(),
      restored_from: r.restored_from,
      changed: fields, summary: r.kind === 'created' ? 'Created' : r.kind === 'conflict' ? `Unsaved copy (started from v${r.base_version})` : !prev ? 'Saved' : changeSummary(fields),
      open_threads: r.version ? threads.find((t) => t.anchor_version === r.version)?.n ?? 0 : 0,
    };
  });
  const last = page[page.length - 1];
  return {
    current_version: post.version,
    items,
    next_cursor: rows.length > limit && last ? Buffer.from(`${last.created_at.toISOString()}|${last.id}`).toString('base64url') : null,
    revisions: q.cursor ? [] : await revisionsFor(db, ctx, post),
    can_restore: authorizeCtx(ctx, 'content.edit', { brandId: post.brand_id }).allowed && !post.archived_at,
  };
}

/** Submitted revisions (immutable) with their review decisions and publication references. */
async function revisionsFor(db: Queryable, ctx: Ctx, post: PostRow) {
  const revs = await many<{ id: string; revision_number: number; created_at: Date; content_hash: string; name: string | null; email: string | null; post_version: number | null }>(db,
    `SELECT r.id, r.revision_number, r.created_at, r.content_hash, u.name, u.email,
            (SELECT max(v.version) FROM post_versions v WHERE v.post_id=r.post_id AND v.version IS NOT NULL AND v.created_at <= r.created_at) AS post_version
       FROM post_revisions r LEFT JOIN users u ON u.id=r.created_by WHERE r.post_id=$1 ORDER BY r.revision_number DESC LIMIT 20`, [post.id]);
  if (!revs.length) return [];
  const ids = revs.map((r) => r.id);
  const approvals = await many<{ id: string; revision_id: string; decision: string; requested_at: Date; decided_at: Date | null; reason: string | null; stage_count: number; current_stage: number }>(db,
    `SELECT id, revision_id, decision, requested_at, decided_at, reason, stage_count, current_stage FROM approvals WHERE post_id=$1 AND revision_id = ANY($2::uuid[]) ORDER BY requested_at DESC`, [post.id, ids]);
  const pubs = await many<{ revision_id: string; provider: string; display_name: string; state: string; provider_url: string | null; published_at: Date | null; is_mock: boolean }>(db,
    `SELECT s.revision_id, d.provider, c.display_name, d.state, d.provider_url, d.published_at, d.is_mock
       FROM deliveries d JOIN schedules s ON s.id=d.schedule_id JOIN connections c ON c.id=d.connection_id
      WHERE d.post_id=$1 AND s.revision_id = ANY($2::uuid[]) AND d.state IN ('published','processing','publishing','unknown') ORDER BY d.published_at DESC NULLS LAST LIMIT 100`, [post.id, ids]);
  const latestRevisionId = revs[0]!.id;
  return revs.map((r) => ({
    id: r.id, revision_number: r.revision_number, created_at: r.created_at.toISOString(), created_by: r.name || r.email, post_version: r.post_version,
    older_than_current: r.post_version !== null && r.post_version < post.version,
    approvals: approvals.filter((a) => a.revision_id === r.id).map((a) => ({
      id: a.id, decision: a.decision, requested_at: a.requested_at.toISOString(), decided_at: a.decided_at?.toISOString() ?? null,
      reason: a.decision === 'rejected' || a.decision === 'invalidated' ? a.reason : null, stage: a.current_stage, stage_count: a.stage_count,
      applies_to_current: r.id === latestRevisionId && a.decision !== 'invalidated' && r.post_version === post.version,
    })),
    publications: pubs.filter((p) => p.revision_id === r.id).map((p) => ({ provider: p.provider, account: p.display_name, state: p.state, url: p.provider_url, published_at: p.published_at?.toISOString() ?? null, simulated: p.is_mock })),
  }));
}

interface Snapshot { label: string; title: string | null; draft: DraftContent; version: number | null; revision_id?: string | null; schedule?: { due_at: string | null; status: string; timezone: string } | null }

async function snapshotOf(db: Queryable, post: PostRow, ref: string): Promise<Snapshot> {
  if (ref === 'current') return { label: `v${post.version} (current)`, title: post.title, draft: post.draft, version: post.version };
  if (ref.startsWith('revision:')) {
    const id = ref.slice('revision:'.length);
    assertUuid(id, 'Revision');
    const r = await maybeOne<{ id: string; revision_number: number; base_text: string; base_link: string | null; base_asset_ids: string[] }>(db,
      `SELECT id, revision_number, base_text, base_link, base_asset_ids FROM post_revisions WHERE id=$1 AND post_id=$2`, [id, post.id]);
    if (!r) throw notFound('Revision');
    const vs = await many<{ connection_id: string; inherit_text: boolean; rendered_text: string; link: string | null; asset_ids: string[]; buttons: unknown; options: Record<string, unknown> }>(db,
      `SELECT connection_id, inherit_text, rendered_text, link, asset_ids, buttons, options FROM variants WHERE revision_id=$1`, [r.id]);
    const s = await maybeOne<{ due_at: Date; status: string; input_timezone: string; is_immediate: boolean }>(db,
      `SELECT due_at, status, input_timezone, is_immediate FROM schedules WHERE revision_id=$1 ORDER BY generation DESC LIMIT 1`, [r.id]);
    return {
      label: `Submitted r${r.revision_number}`, title: post.title, version: null, revision_id: r.id,
      draft: {
        baseText: r.base_text, baseLink: r.base_link, baseAssetIds: r.base_asset_ids,
        variants: vs.map((v) => ({ connectionId: v.connection_id, inheritText: v.inherit_text, text: v.rendered_text, inheritMedia: false, assetIds: v.asset_ids,
          link: v.link, buttons: (v.buttons as Array<{ text: string; url: string }>) ?? [], options: v.options ?? {} })),
      },
      schedule: s ? { due_at: s.is_immediate ? null : s.due_at.toISOString(), status: s.status, timezone: s.input_timezone } : null,
    };
  }
  assertUuid(ref, 'Version');
  const v = await maybeOne<{ version: number | null; base_version: number; kind: string; title: string | null; draft: DraftContent }>(db,
    `SELECT version, base_version, kind, title, draft FROM post_versions WHERE id=$1 AND post_id=$2`, [ref, post.id]);
  if (!v) throw notFound('Version');
  return { label: v.version ? `v${v.version}` : `Unsaved copy (from v${v.base_version})`, title: v.title, draft: v.draft, version: v.version };
}

/**
 * Structured comparison of two versions ('current', a version id or 'revision:<id>'): base text, per-network versions,
 * media, links, destinations, publishing options and (for submitted revisions) scheduling.
 */
export async function compareVersions(ctx: Ctx, postId: string, fromRef: string, toRef: string) {
  requireAction(ctx, 'content.read');
  const db = getPool();
  const post = await loadPost(ctx, postId, db);
  const [a, b] = [await snapshotOf(db, post, fromRef || 'current'), await snapshotOf(db, post, toRef || 'current')];
  const conns = await many<{ id: string; provider: string; display_name: string }>(db, `SELECT id, provider, display_name FROM connections WHERE workspace_id=$1 AND brand_id=$2`, [ctx.access.workspaceId, post.brand_id]);
  const cn = (id: string) => conns.find((c) => c.id === id);
  const textOf = (d: DraftContent, id: string) => {
    const v = d.variants.find((x) => x.connectionId === id);
    return !v ? null : v.inheritText === false ? (v.text ?? '') : d.baseText;
  };
  const mediaOf = (d: DraftContent, id: string) => {
    const v = d.variants.find((x) => x.connectionId === id);
    return !v ? [] : v.inheritMedia === false ? (v.assetIds ?? []) : d.baseAssetIds;
  };
  const allConn = [...new Set([...a.draft.variants, ...b.draft.variants].map((v) => v.connectionId))];
  const assetIds = [...new Set([...a.draft.baseAssetIds, ...b.draft.baseAssetIds, ...[...a.draft.variants, ...b.draft.variants].flatMap((v) => v.assetIds ?? [])])];
  const assets = assetIds.length ? await assetsByIds(ctx, assetIds.slice(0, 40), db) : [];
  const fields = changedFields({ title: a.title, draft: a.draft }, { title: b.title, draft: b.draft });
  return {
    from: { ref: fromRef || 'current', label: a.label, version: a.version, schedule: a.schedule ?? null },
    to: { ref: toRef || 'current', label: b.label, version: b.version, schedule: b.schedule ?? null },
    changed: fields, summary: changeSummary(fields),
    title: { before: a.title ?? '', after: b.title ?? '' },
    text: { before: a.draft.baseText ?? '', after: b.draft.baseText ?? '' },
    link: { before: a.draft.baseLink ?? null, after: b.draft.baseLink ?? null },
    media: { before: a.draft.baseAssetIds, after: b.draft.baseAssetIds },
    destinations: {
      added: allConn.filter((id) => !a.draft.variants.some((v) => v.connectionId === id) && b.draft.variants.some((v) => v.connectionId === id)),
      removed: allConn.filter((id) => a.draft.variants.some((v) => v.connectionId === id) && !b.draft.variants.some((v) => v.connectionId === id)),
    },
    variants: allConn.map((id) => {
      const va = a.draft.variants.find((v) => v.connectionId === id);
      const vb = b.draft.variants.find((v) => v.connectionId === id);
      const ta = textOf(a.draft, id); const tb = textOf(b.draft, id);
      const optKeys = [...new Set([...Object.keys(va?.options ?? {}), ...Object.keys(vb?.options ?? {})])]
        .filter((k) => JSON.stringify(va?.options?.[k] ?? null) !== JSON.stringify(vb?.options?.[k] ?? null));
      return {
        connection_id: id, provider: cn(id)?.provider ?? null, account: cn(id)?.display_name ?? 'Removed account',
        before_text: ta, after_text: tb, custom_before: va ? va.inheritText === false : null, custom_after: vb ? vb.inheritText === false : null,
        link_before: va?.link ?? null, link_after: vb?.link ?? null,
        media_before: mediaOf(a.draft, id), media_after: mediaOf(b.draft, id),
        options_changed: optKeys,
        changed: ta !== tb || JSON.stringify(mediaOf(a.draft, id)) !== JSON.stringify(mediaOf(b.draft, id)) || (va?.link ?? null) !== (vb?.link ?? null) || optKeys.length > 0 || !va !== !vb,
      };
    }),
    assets: assets.map((x) => ({ id: x.id, thumb_url: x.thumb_url, alt_text: x.alt_text, media_kind: x.media_kind ?? 'image' })),
  };
}

const ACTIVITY_LABEL: Record<string, string> = {
  'post.created': 'Created the post', 'post.planning_updated': 'Updated planning', 'post.recovered_content_applied': 'Restored unsaved changes',
  'post.conflict_copy_saved': 'Kept an unsaved copy', 'post.archived': 'Archived the post', 'comment.created': 'Commented', 'comment.edited': 'Edited a comment',
  'comment.deleted': 'Deleted a comment', 'thread.resolved': 'Resolved a discussion', 'thread.reopened': 'Reopened a discussion',
  'thread.visibility_changed': 'Changed who sees a discussion', 'task.created': 'Created a task', 'task.updated': 'Updated a task',
  'task.flagged_for_reassignment': 'Task needs a new assignee', 'approval.approved': 'Approved', 'approval.rejected': 'Requested changes',
  'approval.invalidated': 'Review reset', 'approval.assigned': 'Assigned the review', 'approval.reviewers_requested': 'Requested reviewers',
  'schedule.created': 'Scheduled', 'schedule.cancelled': 'Cancelled the schedule', 'schedule.rescheduled': 'Rescheduled', 'review.shared': 'Shared with a client',
  'review.share_revoked': 'Stopped sharing with a client',
};

/** Post activity: who did what (no comment text). Internal-discussion events only for comments.internal holders. */
export async function postActivity(ctx: Ctx, postId: string, q: { cursor?: string | null; limit?: number | null } = {}) {
  requireAction(ctx, 'content.read');
  const db = getPool();
  const post = await loadPost(ctx, postId, db);
  const limit = Math.min(Math.max(q.limit ?? 30, 1), 100);
  const before = q.cursor && /^\d+$/.test(q.cursor) ? q.cursor : null;
  const refs = await many<{ id: string }>(db,
    `SELECT id::text FROM approvals WHERE post_id=$1 UNION ALL SELECT id::text FROM schedules WHERE post_id=$1 LIMIT 200`, [post.id]);
  const internal = authorizeCtx(ctx, 'comments.internal', { brandId: post.brand_id }).allowed;
  const rows = await many<{ id: string; action: string; actor_name: string | null; actor_email: string | null; actor_service: string | null; diff: Record<string, unknown>; created_at: Date; resource_type: string }>(db,
    `WITH ev AS (
       SELECT id FROM audit_events WHERE resource_id = ANY($2::text[]) AND workspace_id=$1 AND ($4::bigint IS NULL OR id < $4)
       UNION SELECT id FROM audit_events WHERE diff ? 'post_id' AND diff->>'post_id' = $3 AND workspace_id=$1 AND ($4::bigint IS NULL OR id < $4))
     SELECT e.id::text, e.action, u.name AS actor_name, u.email AS actor_email, e.actor_service, e.diff, e.created_at, e.resource_type
       FROM ev JOIN audit_events e ON e.id=ev.id LEFT JOIN users u ON u.id=e.actor_user_id
       LEFT JOIN comment_threads ct ON ct.id::text = coalesce(e.diff->>'thread_id', CASE WHEN e.resource_type='thread' THEN e.resource_id END)
      WHERE ($5 OR ct.id IS NULL OR ct.visibility='shared') AND ($5 OR coalesce(e.diff->>'visibility','shared') <> 'internal')
      ORDER BY e.id DESC LIMIT $6`,
    [ctx.access.workspaceId, [post.id, ...refs.map((r) => r.id)], post.id, before, internal, limit + 1]);
  const page = rows.slice(0, limit);
  return {
    items: page.map((r) => ({
      id: r.id, action: r.action, label: ACTIVITY_LABEL[r.action] ?? r.action.replace(/[._]/g, ' '),
      actor: r.actor_name || r.actor_email || (r.actor_service ? 'Relay' : 'Someone'), at: r.created_at.toISOString(),
      detail: safeDetail(r.action, r.diff),
    })),
    next_cursor: rows.length > limit ? page[page.length - 1]!.id : null,
  };
}

function safeDetail(action: string, d: Record<string, unknown>): string | null {
  if (action === 'thread.visibility_changed') return `${d.from} → ${d.to}`;
  if (action === 'approval.invalidated') return typeof d.reason === 'string' ? d.reason.replace(/_/g, ' ') : null;
  if (action === 'schedule.rescheduled' && typeof d.to === 'string') return `to ${d.to}`;
  if (action === 'task.updated' && d.status && typeof d.status === 'object') return `status ${(d.status as { to?: string }).to ?? ''}`.trim();
  return null;
}
