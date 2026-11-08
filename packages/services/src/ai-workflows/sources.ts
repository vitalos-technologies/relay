// Authorized reads for workflow steps. Every source is loaded with the requester's CURRENT context through its normal
// access rule (content.read on the brand, inbox.read on a conversation, the person's own attachments). Imported
// documents, attachments and customer messages are untrusted content: quoted as data, never instructions.
import { AppError, PROVIDER_LABEL, notFound, type Provider } from '@social-lite/core';
import type { NormalizedSection } from '@social-lite/core/contracts/content-hub';
import { getPool, many, maybeOne, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { assertUuid, authorizeCtx, brandAllowed, requireAction } from '../tenancy.js';
import { sectionText } from '../content-hub/normalize.js';
import { loadKnowledge, retrieve } from '../assistant/retrieval.js';
import { loadPost } from '../posts/service.js';
import { brandConnections, capabilitiesFor, type ConnectionRow } from '../posts/shared.js';
import type { WfSource } from './model.js';

export type SourceRef = { kind: 'source_item' | 'knowledge' | 'post' | 'attachment'; id: string };

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export interface ReadSource extends WfSource { ref: SourceRef; approved: boolean }

/** Read one selected source with the requester's access. Throws not_found when it is not readable. */
export async function readSource(ctx: Ctx, brandId: string, ref: SourceRef, db: Queryable = getPool()): Promise<ReadSource> {
  assertUuid(ref.id, 'Source');
  if (!brandAllowed(ctx, brandId)) throw notFound('Source');
  switch (ref.kind) {
    case 'source_item': {
      requireAction(ctx, 'content.read', { brandId });
      const s = await maybeOne<{ title: string | null; state: string; content: { sections?: NormalizedSection[] } | null; imported_at: Date | null }>(db,
        `SELECT si.title, si.state, ss.content, ss.imported_at FROM source_items si LEFT JOIN source_snapshots ss ON ss.id = si.last_snapshot_id
          WHERE si.id=$1 AND si.workspace_id=$2 AND si.brand_id=$3`, [ref.id, ctx.access.workspaceId, brandId]);
      if (!s) throw notFound('Document');
      if (s.state !== 'linked') throw new AppError('invalid_state', 'This document is no longer available from its source.');
      const text = (s.content?.sections ?? []).map((x) => sectionText(x, { includeTitle: true })).join('\n\n').trim();
      if (!text) throw new AppError('invalid_state', 'This document has no imported text yet. Refresh it in the Content library.');
      return { ref, kind: 'document', id: ref.id, title: s.title || 'Document', link: `/library?item=${ref.id}`, freshness: iso(s.imported_at), trust: 'untrusted', stale: false, text, approved: false };
    }
    case 'knowledge': {
      const [k] = await loadKnowledge(ctx, brandId, { ids: [ref.id] }, db);
      if (!k) throw notFound('Knowledge source');
      return { ref, kind: k.kind, id: ref.id, title: k.title, link: k.link, freshness: k.freshness, trust: 'approved', stale: k.stale, text: k.text, approved: true };
    }
    case 'post': {
      const p = await loadPost(ctx, ref.id, db);
      if (p.brand_id !== brandId || !authorizeCtx(ctx, 'content.read', { brandId }).allowed) throw notFound('Post');
      // Approved material = the revision the latest approved review was for (never the mutable working draft).
      const ap = await maybeOne<{ base_text: string; revision_number: number; decided_at: Date | null }>(db,
        `SELECT r.base_text, r.revision_number, a.decided_at FROM approvals a JOIN post_revisions r ON r.id=a.revision_id
          WHERE a.post_id=$1 AND a.workspace_id=$2 AND a.decision='approved' ORDER BY a.decided_at DESC NULLS LAST LIMIT 1`, [p.id, ctx.access.workspaceId]);
      const text = ap ? ap.base_text : (p.draft.baseText ?? '');
      if (!text.trim()) throw new AppError('invalid_state', 'This post has no text to work from.');
      return { ref, kind: 'post', id: p.id, title: p.title || 'Post', link: `/posts/${p.id}`, freshness: iso(ap?.decided_at ?? p.updated_at), trust: 'observed', stale: false, text, approved: !!ap };
    }
    case 'attachment': {
      const a = await maybeOne<{ filename: string; text_content: string | null; created_at: Date }>(db,
        `SELECT filename, text_content, created_at FROM ai_attachments WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND brand_id=$4`, [ref.id, ctx.access.workspaceId, ctx.actor.userId, brandId]);
      if (!a) throw notFound('Attachment');
      if (!a.text_content) throw new AppError('invalid_state', 'This attachment was removed after 30 days. Attach it again.');
      return { ref, kind: 'attachment', id: ref.id, title: a.filename, link: null, freshness: iso(a.created_at), trust: 'untrusted', stale: false, text: a.text_content, approved: false };
    }
  }
}

/** Title of a source for summaries (access-checked, cheap). */
export async function sourceTitle(ctx: Ctx, brandId: string, ref: SourceRef, db: Queryable = getPool()): Promise<string> {
  assertUuid(ref.id, 'Source');
  const q: Record<SourceRef['kind'], string> = {
    source_item: `SELECT title FROM source_items WHERE id=$1 AND workspace_id=$2 AND brand_id=$3`,
    knowledge: `SELECT title FROM ai_knowledge_sources WHERE id=$1 AND workspace_id=$2 AND brand_id=$3 AND revoked_at IS NULL`,
    post: `SELECT coalesce(title, 'Post') AS title FROM posts WHERE id=$1 AND workspace_id=$2 AND brand_id=$3 AND deleted_at IS NULL`,
    attachment: `SELECT filename AS title FROM ai_attachments WHERE id=$1 AND workspace_id=$2 AND brand_id=$3 AND user_id=$4`,
  };
  if (!brandAllowed(ctx, brandId) || !authorizeCtx(ctx, 'content.read', { brandId }).allowed) throw notFound('Source');
  const r = await maybeOne<{ title: string | null }>(db, q[ref.kind], ref.kind === 'attachment' ? [ref.id, ctx.access.workspaceId, brandId, ctx.actor.userId] : [ref.id, ctx.access.workspaceId, brandId]);
  if (!r) throw notFound('Source');
  return r.title || 'Untitled';
}

/** Brand voice + chosen approved knowledge + attachments (the context every drafting step uses). */
export async function brandContext(ctx: Ctx, brandId: string, opts: { knowledgeIds?: string[]; attachmentIds?: string[] } = {}): Promise<WfSource[]> {
  const out: WfSource[] = [];
  const base = await retrieve(ctx, 'draft_copy', { type: 'brand', id: brandId }, brandId, { knowledgeIds: opts.knowledgeIds?.length ? opts.knowledgeIds : [] });
  for (const s of base) out.push({ kind: s.kind, id: s.id, title: s.title, link: s.link, trust: s.trust, stale: s.stale, freshness: s.freshness, text: s.text });
  for (const id of opts.attachmentIds ?? []) {
    try { out.push(await readSource(ctx, brandId, { kind: 'attachment', id })); } catch { /* not readable any more: skipped */ }
  }
  return out;
}

// ------------------------------------------------------------------ destinations
export interface Destination { id: string; provider: Provider; label: string; display_name: string; ready: boolean; simulated: boolean; max_length: number; requires_media: boolean; reason: string | null }

export function destinationOf(c: ConnectionRow): Destination {
  const caps = capabilitiesFor(c);
  const ready = c.status === 'ready' && !c.paused && !c.disconnected_at && (caps?.canPublish ?? true);
  const reason = c.disconnected_at ? 'Disconnected' : c.paused ? 'Paused' : c.status !== 'ready' ? `Needs attention (${c.status.replace(/_/g, ' ')})` : caps && !caps.canPublish ? 'Publishing is not available for this account' : null;
  return {
    id: c.id, provider: c.provider, label: PROVIDER_LABEL[c.provider], display_name: c.display_name, ready, simulated: c.is_mock, reason,
    max_length: caps?.constraints.maxTextLength ?? 2000, requires_media: !!caps?.constraints.requiresMedia,
  };
}

export async function brandDestinations(ctx: Ctx, brandId: string, db: Queryable = getPool()): Promise<Destination[]> {
  if (!brandAllowed(ctx, brandId)) throw notFound('Brand');
  return (await brandConnections(db, ctx.access.workspaceId, brandId)).map(destinationOf);
}

export async function conversationsOf(ctx: Ctx, brandId: string, ids: string[], db: Queryable = getPool()) {
  return many<{ id: string; kind: string; subject: string | null; preview: string | null; unanswered_since: Date | null; version: number; channel_kind: string }>(db,
    `SELECT c.id, c.kind, c.subject, c.preview, c.unanswered_since, c.version, ch.kind AS channel_kind FROM inbox_conversations c JOIN inbox_channels ch ON ch.id=c.channel_id
      WHERE c.workspace_id=$1 AND c.brand_id=$2 AND c.id = ANY($3::uuid[])`, [ctx.access.workspaceId, brandId, ids]);
}
