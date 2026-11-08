// Workspace context for the AI composer (V5 §11–12): which brands the person can work on, their connected accounts,
// documents and approved knowledge, inbox/analytics/listening availability, permissions and plan features — all read
// with the person's own access. Suggestions are derived from this (suggestions.ts). Counts and titles only.
import type { AiWorkspaceDto, WorkspaceBrandDto, WorkspaceDocumentDto } from '@social-lite/core/contracts/v5-ai';
import { getPool, many, maybeOne, one } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { canAnywhere } from '../access.js';
import { authorizeCtx, brandAllowed } from '../tenancy.js';
import { readUsage } from '../ai/usage.js';
import { assistantConfigured, NOT_CONFIGURED_MESSAGE } from '../assistant/client.js';
import { listKnowledge } from '../assistant/knowledge.js';
import { checkFeature, entitlementsCore, upgradeTarget } from '../entitlements/resolve.js';
import { approvalRequiredFor } from '../posts/approval-policy.js';
import { brandConnections } from '../posts/shared.js';
import { destinationOf } from './sources.js';
import { buildSuggestions, weekToPlan } from './suggestions.js';

export async function workspaceContext(ctx: Ctx, q: { brand_id?: string | null } = {}): Promise<AiWorkspaceDto> {
  const db = getPool();
  const ws = ctx.access.workspaceId;
  const [configured, usage, core] = await Promise.all([assistantConfigured(db), readUsage(ws, db), entitlementsCore(db, ws)]);
  const drafting = checkFeature(core, 'ai_drafting', { paid: true }).ok;
  const workflows = checkFeature(core, 'ai_workflows', { paid: true }).ok;
  const brandRows = await many<{ id: string; name: string; timezone: string }>(db, `SELECT id, name, timezone FROM brands WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY name`, [ws]);
  const usable = brandRows.filter((b) => brandAllowed(ctx, b.id) && authorizeCtx(ctx, 'ai.use', { brandId: b.id }).allowed);
  const brands: WorkspaceBrandDto[] = [];
  for (const b of usable) {
    const can = (p: Parameters<typeof authorizeCtx>[1]) => authorizeCtx(ctx, p, { brandId: b.id }).allowed;
    brands.push({
      id: b.id, name: b.name, timezone: b.timezone,
      accounts: (await brandConnections(db, ws, b.id)).map(destinationOf).map((d) => ({ id: d.id, provider: d.label, display_name: d.display_name, ready: d.ready, simulated: d.simulated })),
      can: { draft: can('content.edit'), schedule: can('content.schedule'), reply: can('inbox.reply'), read_inbox: can('inbox.read'), analytics: can('analytics.read'), listening: can('listening.read'), manage_knowledge: can('brands.manage') },
      approval_required: await approvalRequiredFor(db, ws, b.id),
    });
  }
  const brand = brands.find((b) => b.id === q.brand_id) ?? brands[0] ?? null;
  const documents: WorkspaceDocumentDto[] = [];
  let inbox: AiWorkspaceDto['inbox'] = null;
  let analytics: AiWorkspaceDto['analytics'] = null;
  let listening = { available: false, searches: 0 };
  let week = { calendar_posts: 0, ready_drafts: 0, slots: 0 };
  let knowledge: AiWorkspaceDto['knowledge'] = [];
  if (brand) {
    if (brand.can.draft || authorizeCtx(ctx, 'content.read', { brandId: brand.id }).allowed) {
      const items = await many<{ id: string; title: string | null; updated_at: Date }>(db,
        `SELECT si.id, si.title, coalesce(si.last_synced_at, si.updated_at) AS updated_at FROM source_items si
          WHERE si.workspace_id=$1 AND si.brand_id=$2 AND si.state='linked' AND si.last_snapshot_id IS NOT NULL AND si.parent_item_id IS NULL
          ORDER BY coalesce(si.last_synced_at, si.updated_at) DESC LIMIT 15`, [ws, brand.id]);
      for (const i of items) documents.push({ kind: 'source_item', id: i.id, title: i.title || 'Document', brand_id: brand.id, updated_at: i.updated_at.toISOString() });
      const atts = await many<{ id: string; filename: string; created_at: Date }>(db,
        `SELECT id, filename, created_at FROM ai_attachments WHERE workspace_id=$1 AND brand_id=$2 AND user_id=$3 AND text_content IS NOT NULL ORDER BY created_at DESC LIMIT 10`, [ws, brand.id, ctx.actor.userId]);
      for (const a of atts) documents.push({ kind: 'attachment', id: a.id, title: a.filename, brand_id: brand.id, updated_at: a.created_at.toISOString() });
      const posts = await many<{ id: string; title: string | null; updated_at: Date; approved: boolean }>(db,
        `SELECT p.id, p.title, p.updated_at, EXISTS (SELECT 1 FROM approvals a WHERE a.post_id=p.id AND a.decision='approved') AS approved FROM posts p
          WHERE p.workspace_id=$1 AND p.brand_id=$2 AND p.deleted_at IS NULL AND p.archived_at IS NULL AND coalesce(p.draft->>'baseText','') <> ''
          ORDER BY approved DESC, p.updated_at DESC LIMIT 15`, [ws, brand.id]);
      for (const p of posts) documents.push({ kind: 'post', id: p.id, title: p.title || 'Untitled post', brand_id: brand.id, approved: p.approved, updated_at: p.updated_at.toISOString() });
      knowledge = (await listKnowledge(ctx, { brand_id: brand.id })).items;
      for (const k of knowledge.filter((x) => x.available)) documents.unshift({ kind: 'knowledge', id: k.id, title: k.title, brand_id: brand.id, updated_at: k.approved_at });
      const tz = brand.timezone;
      const monday = weekToPlan(new Date());
      const w = await one<{ planned: number; ready: number; slots: number }>(db,
        `SELECT (SELECT count(*)::int FROM schedules s WHERE s.workspace_id=$1 AND s.brand_id=$2 AND s.status IN ('active','pending_approval')
                   AND s.due_at >= ($3::date)::timestamp AT TIME ZONE $4 AND s.due_at < ($3::date + 7)::timestamp AT TIME ZONE $4) AS planned,
                (SELECT count(*)::int FROM posts p WHERE p.workspace_id=$1 AND p.brand_id=$2 AND p.deleted_at IS NULL AND p.archived_at IS NULL
                   AND coalesce(p.draft->>'baseText','') <> '' AND jsonb_array_length(coalesce(p.draft->'variants','[]'::jsonb)) > 0
                   AND NOT EXISTS (SELECT 1 FROM schedules x WHERE x.post_id=p.id AND x.status IN ('active','pending_approval','completed'))) AS ready,
                (SELECT count(*)::int FROM posting_slots WHERE workspace_id=$1 AND brand_id=$2 AND archived_at IS NULL AND active) AS slots`, [ws, brand.id, monday, tz]);
      week = { calendar_posts: w.planned, ready_drafts: w.ready, slots: w.slots };
    }
    if (brand.can.read_inbox) {
      const rows = await many<{ id: string; subject: string | null; preview: string | null; unanswered_since: Date | null; channel: string }>(db,
        `SELECT c.id, c.subject, c.preview, c.unanswered_since, ch.kind AS channel FROM inbox_conversations c JOIN inbox_channels ch ON ch.id=c.channel_id
          WHERE c.workspace_id=$1 AND c.brand_id=$2 AND c.unanswered_since IS NOT NULL AND c.status NOT IN ('resolved','spam')
          ORDER BY c.unanswered_since ASC LIMIT 20`, [ws, brand.id]);
      const n = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM inbox_conversations WHERE workspace_id=$1 AND brand_id=$2 AND unanswered_since IS NOT NULL AND status NOT IN ('resolved','spam')`, [ws, brand.id]);
      inbox = { unanswered: n.n, conversations: rows.map((r) => ({ id: r.id, title: r.subject || r.preview?.slice(0, 60) || 'Conversation', waiting_since: r.unanswered_since?.toISOString() ?? null, channel: r.channel })) };
    }
    if (brand.can.analytics) {
      const a = await maybeOne<{ last: Date | null }>(db, `SELECT max(observed_at) AS last FROM metric_daily_facts WHERE workspace_id=$1 AND brand_id=$2 AND bucket_date > (now() - interval '120 days')::date`, [ws, brand.id]);
      analytics = { has_data: !!a?.last, last_data_at: a?.last?.toISOString() ?? null };
    }
    if (brand.can.listening && checkFeature(core, 'listening', { paid: false }).ok) {
      const l = await one<{ n: number; obs: boolean }>(db,
        `SELECT count(*)::int AS n, EXISTS (SELECT 1 FROM listening_matches m JOIN listening_searches s2 ON s2.id=m.search_id WHERE s2.brand_id=$2 AND s2.workspace_id=$1) AS obs
           FROM listening_searches WHERE workspace_id=$1 AND brand_id=$2 AND archived_at IS NULL`, [ws, brand.id]).catch(() => ({ n: 0, obs: false }));
      listening = { available: l.n > 0 && l.obs, searches: l.n };
    }
  }
  const base: Omit<AiWorkspaceDto, 'suggestions'> = {
    status: { configured, reason: configured ? null : NOT_CONFIGURED_MESSAGE, can_use: canAnywhere(ctx, 'ai.use') && (drafting || workflows) && brands.length > 0,
      budget: { period: usage.period, used: usage.used, cap: usage.cap, remaining: usage.remaining } },
    features: { ai_drafting: drafting, ai_workflows: workflows, upgrade_plan: workflows ? null : upgradeTarget('ai_workflows') },
    brand_id: brand?.id ?? null, brands, documents, knowledge, inbox, analytics, listening, week,
  };
  return { ...base, suggestions: buildSuggestions(base) };
}
