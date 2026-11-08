// Scoped retrieval for assistant runs (brief §16 "preserve source permissions", §20 revocation, acceptance tests 11–12).
//  - Runs execute with a context RE-LOADED from the requester's current membership and grants (no cached permissions):
//    a removed member or revoked grant retrieves nothing.
//  - Every source is loaded through its normal access check (inbox.read on the conversation's brand, content.read on a
//    post's brand, analytics.read, …). Knowledge = sources an administrator approved for THAT brand (ai_knowledge_sources);
//    text is read live from the Content Hub snapshot / saved reply — there is no shared, unscoped knowledge store.
//  - Customer content is marked untrusted; internal notes are not sent to the model.
import { AppError, notFound } from '@social-lite/core';
import type { AssistantContextRef, AssistantTask, SourceRefDto } from '@social-lite/core/contracts/v35-ai';
import type { NormalizedSection } from '@social-lite/core/contracts/content-hub';
import { getPool, many, maybeOne, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { assertBrand, authorizeCtx, brandAllowed, requireAction } from '../tenancy.js';
import { loadConversation } from '../inbox/shared.js';
import { loadPost } from '../posts/service.js';
import type { BrandVoice } from '../brands.js';
import { sectionText } from '../content-hub/normalize.js';

export interface RetrievedSource extends Omit<SourceRefDto, 'ref'> { text: string }

export type ListeningSourceProvider = (ctx: Ctx, queryId: string) => Promise<{ brandId: string; sources: RetrievedSource[] }>;
// Default: stream D's saved searches + mentions, read with the requester's context (listening-source.ts).
let listeningProvider: ListeningSourceProvider | null = async (ctx, id) => (await import('./listening-source.js')).listeningSourceProvider(ctx, id);
/** Replace (or disable with null) how a listening query's observations are read for the assistant. */
export function registerListeningSourceProvider(p: ListeningSourceProvider | null): void { listeningProvider = p; }
export const listeningSourcesAvailable = () => listeningProvider !== null;

const MAX_MESSAGES = 30;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Resolve the brand a context belongs to, with the context's own read permission. */
export async function contextBrand(ctx: Ctx, c: AssistantContextRef, db: Queryable = getPool()): Promise<string> {
  switch (c.type) {
    case 'conversation': return (await loadConversation(ctx, c.id, 'inbox.read', db)).brand_id;
    case 'post': {
      const p = await loadPost(ctx, c.id, db);
      if (!authorizeCtx(ctx, 'content.read', { brandId: p.brand_id }).allowed) throw notFound('Post');
      return p.brand_id;
    }
    case 'brand': {
      await assertBrand(ctx, c.id, db);
      if (!authorizeCtx(ctx, 'content.read', { brandId: c.id }).allowed) throw notFound('Brand');
      return c.id;
    }
    case 'analytics': {
      await assertBrand(ctx, c.brand_id, db);
      requireAction(ctx, 'analytics.read', { brandId: c.brand_id });
      return c.brand_id;
    }
    case 'listening_query': {
      if (!listeningProvider) throw new AppError('invalid_state', 'Listening is not available yet.', undefined, { reason: 'listening_unavailable' });
      return (await listeningProvider(ctx, c.id)).brandId;
    }
  }
}

function voiceText(v: BrandVoice): string {
  const lines: string[] = [];
  if (v.tone) lines.push(`Tone: ${v.tone}`);
  if (v.terminology?.length) lines.push(`Approved terminology: ${v.terminology.join('; ')}`);
  if (v.prohibited?.length) lines.push(`Never use: ${v.prohibited.join('; ')}`);
  if (v.default_cta) lines.push(`Default call to action: ${v.default_cta}`);
  if (v.hashtags?.length) lines.push(`Brand hashtags: ${v.hashtags.join(' ')}`);
  if (v.footer) lines.push(`Required footer: ${v.footer}`);
  return lines.join('\n');
}

async function brandVoice(db: Queryable, ctx: Ctx, brandId: string): Promise<RetrievedSource | null> {
  const b = await maybeOne<{ name: string; voice: BrandVoice | null; updated_at: Date | null }>(db, `SELECT name, voice, NULL::timestamptz AS updated_at FROM brands WHERE id=$1 AND workspace_id=$2`, [brandId, ctx.access.workspaceId]);
  const text = b?.voice ? voiceText(b.voice) : '';
  return b && text ? { kind: 'brand_voice', id: brandId, title: `${b.name} brand voice`, link: null, freshness: iso(b.updated_at), trust: 'approved', stale: false, text } : null;
}

export interface KnowledgeRow { id: string; brand_id: string; kind: 'source_item' | 'saved_reply'; ref_id: string; title: string; review_by: Date | null; approved_at: Date }

/** Approved knowledge for one brand, read live; only items the requester can currently read on that brand. */
export async function loadKnowledge(ctx: Ctx, brandId: string, opts: { ids?: string[] | null } = {}, db: Queryable = getPool()): Promise<RetrievedSource[]> {
  if (!brandAllowed(ctx, brandId)) return [];
  const canContent = authorizeCtx(ctx, 'content.read', { brandId }).allowed;
  const canInbox = authorizeCtx(ctx, 'inbox.read', { brandId }).allowed;
  const rows = await many<KnowledgeRow>(db,
    `SELECT id, brand_id, kind, ref_id, title, review_by, approved_at FROM ai_knowledge_sources
      WHERE workspace_id=$1 AND brand_id=$2 AND revoked_at IS NULL ${opts.ids ? 'AND id = ANY($3::uuid[])' : ''} ORDER BY approved_at DESC LIMIT 20`,
    opts.ids ? [ctx.access.workspaceId, brandId, opts.ids] : [ctx.access.workspaceId, brandId]);
  const out: RetrievedSource[] = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const k of rows) {
    const stale = !!k.review_by && k.review_by.toISOString().slice(0, 10) < today;
    if (k.kind === 'source_item') {
      if (!canContent) continue;
      const s = await maybeOne<{ title: string | null; state: string; content: { sections?: NormalizedSection[] }; imported_at: Date; item_id: string }>(db,
        `SELECT si.title, si.state, ss.content, ss.imported_at, si.id AS item_id FROM source_items si JOIN source_snapshots ss ON ss.id = si.last_snapshot_id
          WHERE si.id=$1 AND si.workspace_id=$2 AND si.brand_id=$3`, [k.ref_id, ctx.access.workspaceId, brandId]);
      if (!s || s.state !== 'linked') continue; // access lost / removed at the source ⇒ not used
      const text = (s.content.sections ?? []).map((x) => sectionText(x, { includeTitle: true })).join('\n\n').trim();
      if (!text) continue;
      out.push({ kind: 'knowledge', id: k.id, title: k.title, link: `/library?item=${s.item_id}`, freshness: iso(s.imported_at), trust: 'approved', stale, text });
    } else {
      if (!canInbox && !canContent) continue;
      const r = await maybeOne<{ body: string; updated_at: Date }>(db,
        `SELECT body, updated_at FROM inbox_saved_replies WHERE id=$1 AND workspace_id=$2 AND (brand_id IS NULL OR brand_id=$3) AND archived_at IS NULL`, [k.ref_id, ctx.access.workspaceId, brandId]);
      if (!r) continue;
      out.push({ kind: 'saved_reply', id: k.id, title: k.title, link: null, freshness: iso(r.updated_at), trust: 'approved', stale, text: r.body });
    }
  }
  return out;
}

async function conversationSources(ctx: Ctx, id: string, db: Queryable): Promise<RetrievedSource[]> {
  const conv = await loadConversation(ctx, id, 'inbox.read', db);
  const msgs = await many<{ direction: string; body: string | null; provider_created_at: Date; automated: boolean }>(db,
    `SELECT direction, body, provider_created_at, automated FROM inbox_messages WHERE conversation_id=$1 AND deleted_at IS NULL AND body IS NOT NULL
      ORDER BY provider_created_at DESC LIMIT $2`, [id, MAX_MESSAGES]);
  const lines = msgs.reverse().map((m) => `[${m.provider_created_at.toISOString()}] ${m.direction === 'inbound' ? 'Customer' : m.automated ? 'Business (automated)' : 'Business'}: ${m.body}`);
  return [{ kind: 'conversation', id, title: `${conv.kind === 'dm' ? 'Private conversation' : conv.kind === 'review' ? 'Review' : 'Public comment thread'}`, link: `/inbox?c=${id}`,
    freshness: iso(conv.last_message_at), trust: 'untrusted', stale: false, text: lines.join('\n') || '(no readable messages)' }];
}

async function postSource(ctx: Ctx, id: string, db: Queryable): Promise<RetrievedSource[]> {
  const p = await loadPost(ctx, id, db);
  const variants = p.draft.variants.filter((v) => !v.inheritText && v.text).map((v) => `Variant: ${v.text}`);
  const text = [p.title ? `Title: ${p.title}` : null, `Base copy: ${p.draft.baseText ?? ''}`, ...variants].filter(Boolean).join('\n\n');
  return [{ kind: 'post', id, title: p.title || 'Post draft', link: `/posts/${id}`, freshness: iso(p.updated_at), trust: 'observed', stale: false, text }];
}

async function analyticsSource(ctx: Ctx, brandId: string, days: number): Promise<RetrievedSource[]> {
  const { filtersFromQuery } = await import('../analytics/api.js');
  const { overview } = await import('../analytics/query.js');
  const to = new Date();
  const from = new Date(to.getTime() - (Math.min(Math.max(days, 7), 90) - 1) * 86_400_000);
  const filters = await filtersFromQuery(ctx, new URLSearchParams({ brand: brandId, from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }));
  const o = await overview(ctx, filters);
  const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
  const lines = [`Period: ${o.meta.period.from} to ${o.meta.period.to}${o.meta.previous_period ? ` (compared with ${o.meta.previous_period.from} to ${o.meta.previous_period.to})` : ''}`];
  if (o.meta.synthetic) lines.push('Note: demo data (not reported by a network).');
  for (const k of o.kpis) lines.push(`${k.label}: ${k.value ?? 'no data'} (previous: ${k.comparison.previous ?? 'n/a'}, change: ${pct(k.comparison.change_pct)}) — ${k.basis_label}`);
  for (const i of o.insights ?? []) lines.push(`Observed: ${(i as { text?: string; title?: string }).text ?? (i as { title?: string }).title ?? ''}`);
  return [{ kind: 'analytics', id: null, title: `Analytics overview (${days} days)`, link: `/analytics?brand=${brandId}`, freshness: o.meta.generated_at, trust: 'observed', stale: false, text: lines.join('\n') }];
}

/** Which knowledge a task uses. */
const USES_KNOWLEDGE: ReadonlySet<AssistantTask | 'auto_reply'> = new Set(['suggest_reply', 'answer_question', 'draft_copy', 'campaign_brief', 'auto_reply', 'suggest_triage', 'insight_to_draft']);

export async function retrieve(ctx: Ctx, task: AssistantTask | 'auto_reply', c: AssistantContextRef, brandId: string, opts: { knowledgeIds?: string[] | null } = {}, db: Queryable = getPool()): Promise<RetrievedSource[]> {
  const out: RetrievedSource[] = [];
  switch (c.type) {
    case 'conversation': out.push(...await conversationSources(ctx, c.id, db)); break;
    case 'post': out.push(...await postSource(ctx, c.id, db)); break;
    case 'analytics': out.push(...await analyticsSource(ctx, c.brand_id, c.range_days)); break;
    case 'listening_query': {
      if (!listeningProvider) throw new AppError('invalid_state', 'Listening is not available yet.', undefined, { reason: 'listening_unavailable' });
      out.push(...(await listeningProvider(ctx, c.id)).sources);
      break;
    }
    case 'brand': break;
  }
  const v = await brandVoice(db, ctx, brandId);
  if (v && task !== 'translate' && task !== 'summarize_conversation') out.push(v);
  if (USES_KNOWLEDGE.has(task)) out.push(...await loadKnowledge(ctx, brandId, { ids: opts.knowledgeIds ?? null }, db));
  return out;
}
