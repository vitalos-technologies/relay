// V3.1 §12 — brand profile, brand rules, rule evaluation for composer/preflight/scheduling, and the review list of
// content affected by rule changes. Rule/profile/asset-governance changes NEVER rewrite drafts or scheduled content:
// affected drafts and live schedules are listed (brand_rule_reviews) and need an explicit, audited decision.
// Permissions: read = brands.read (rules) / content.read (checks, reviews); write = brands.manage on the brand.
import { z } from 'zod';
import { AppError, notFound, resolveVariants, type DraftContent, type Provider } from '@social-lite/core';
import { BRAND_RULE_KINDS, type BrandCheckResult, type BrandFinding, type BrandProfileDto, type BrandRuleDto, type BrandRuleReviewDto, type ReviewDecision, type RuleChangeImpact, type RuleSeverity } from '@social-lite/core/contracts/v31-gov';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { assertBrand, assertUuid, authorizeCtx, requireAction, type BrandRow } from '../tenancy.js';
import { loadPost, type PostRow } from '../posts/service.js';
import { brandConnections } from '../posts/shared.js';
import { cancelSchedule } from '../posts/scheduling.js';
import { draftText, tipsignalEventSchema } from '../tipsignal.js';
import { evaluateBrandRules, normaliseDomain, splitFindings, type AssetGovernanceFacts, type RuleInput, type TipsignalFacts, type VariantInput } from './rules-engine.js';
import { releaseBrandRuleHold } from '../engine/process.js';

export const AFFECTED_SCAN_LIMIT = 500;

// ------------------------------------------------------------------ schemas
const providerList = z.array(z.string().min(1).max(32)).max(20).default([]);
export const brandRuleInputSchema = z.object({
  kind: z.enum(BRAND_RULE_KINDS),
  value: z.string().trim().min(1).max(500),
  replacement: z.string().trim().max(200).nullish(),
  severity: z.enum(['mandatory', 'advisory']),
  providers: providerList,
  note: z.string().trim().max(500).nullish(),
}).strict();
export const brandRulePatchSchema = z.object({
  value: z.string().trim().min(1).max(500).optional(),
  replacement: z.string().trim().max(200).nullish(),
  severity: z.enum(['mandatory', 'advisory']).optional(),
  providers: z.array(z.string().min(1).max(32)).max(20).optional(),
  note: z.string().trim().max(500).nullish(),
}).strict();
export const brandProfilePatchSchema = z.object({
  tone: z.string().trim().max(1000).nullish(),
  colours: z.array(z.object({ name: z.string().trim().min(1).max(60), hex: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use #RRGGBB') }).strict()).max(20).optional(),
  logo_asset_ids: z.array(z.string().uuid()).max(20).optional(),
  cta_default: z.string().trim().max(300).nullish(),
}).strict();
export const reviewDecisionSchema = z.object({ decision: z.enum(['keep', 'will_edit', 'cancel_schedule']), note: z.string().trim().max(500).nullish() }).strict();

// ------------------------------------------------------------------ rows → DTOs
interface RuleRow { id: string; brand_id: string; kind: BrandRuleDto['kind']; value: string; replacement: string | null; severity: RuleSeverity; providers: string[]; note: string | null; created_at: Date; updated_at: Date }
interface ProfileRow { brand_id: string; rules_version: number; tone: string | null; colours: Array<{ name: string; hex: string }>; logo_asset_ids: string[]; cta_default: string | null; updated_at: Date }

const ruleDto = (r: RuleRow): BrandRuleDto => ({
  id: r.id, brand_id: r.brand_id, kind: r.kind, value: r.value, replacement: r.replacement, severity: r.severity,
  providers: r.providers as Provider[], note: r.note, created_at: r.created_at.toISOString(), updated_at: r.updated_at.toISOString(),
});

// ------------------------------------------------------------------ rule context (shared by every evaluation)
export interface RuleContext {
  version: number;
  rules: RuleInput[];
  allowedText: string;
  trustedHosts: string[];
}

export async function loadRuleContext(db: Queryable, workspaceId: string, brand: Pick<BrandRow, 'id' | 'voice'>): Promise<RuleContext> {
  const rows = await many<RuleRow>(db, `SELECT * FROM brand_rules WHERE workspace_id=$1 AND brand_id=$2 AND archived_at IS NULL ORDER BY created_at, id`, [workspaceId, brand.id]);
  const prof = await maybeOne<{ rules_version: number; cta_default: string | null }>(db, `SELECT rules_version, cta_default FROM brand_profiles WHERE brand_id=$1 AND workspace_id=$2`, [brand.id, workspaceId]);
  const voice = (brand.voice ?? {}) as { prohibited?: string[]; footer?: string; default_cta?: string; hashtags?: string[]; terminology?: string[] };
  const rules: RuleInput[] = rows.map((r) => ({ id: r.id, kind: r.kind, value: r.value, replacement: r.replacement, severity: r.severity, providers: r.providers, source: 'brand_rule' }));
  // Legacy brand voice "avoid terms" stay ADVISORY (the V1 composer only warned on them).
  for (const p of voice.prohibited ?? []) {
    if (!rows.some((r) => (r.kind === 'prohibited_phrase' || r.kind === 'discouraged_phrase') && r.value.toLowerCase() === p.toLowerCase())) {
      rules.push({ id: null, kind: 'discouraged_phrase', value: p, replacement: null, severity: 'advisory', providers: [], source: 'brand_voice' });
    }
  }
  const allowedText = [
    ...rows.filter((r) => r.kind === 'required_footer' || r.kind === 'required_disclaimer').map((r) => r.value),
    voice.footer, voice.default_cta, prof?.cta_default, ...(voice.hashtags ?? []), ...(voice.terminology ?? []),
  ].filter(Boolean).join('\n');
  let trustedHosts: string[] = [];
  try { trustedHosts = [new URL(config().APP_BASE_URL).hostname.toLowerCase()]; } catch { /* no base url in pure tests */ }
  return { version: prof?.rules_version ?? 0, rules, allowedText, trustedHosts };
}

/** TipSignal facts for a post created from a validated TipSignal event (null for any other post). */
export async function tipsignalFactsFor(db: Queryable, post: Pick<PostRow, 'workspace_id' | 'source'>, timezone: string): Promise<TipsignalFacts | null> {
  if (post.source?.kind !== 'tipsignal') return null;
  const ev = await maybeOne<{ payload: unknown }>(db, `SELECT payload FROM source_events WHERE workspace_id=$1 AND source='tipsignal' AND source_event_id=$2`,
    [post.workspace_id, String(post.source.event_id ?? '')]);
  const parsed = tipsignalEventSchema.safeParse(ev?.payload);
  if (!parsed.success) return null;
  const e = parsed.data;
  const f = e.data.fixture;
  const verdict = e.type === 'results.settled' ? (e.data.result === 'won' ? 'Won' : e.data.result === 'lost' ? 'Lost' : 'Void') : null;
  return {
    type: e.type, sourceText: draftText(e, timezone), kickoffAt: new Date(f.kickoff_at),
    requiredPhrases: [f.home, f.away, f.competition, e.data.market, e.data.selection, ...(verdict ? [verdict] : [])],
  };
}

async function assetFacts(db: Queryable, workspaceId: string, assetIds: string[]): Promise<AssetGovernanceFacts[]> {
  if (!assetIds.length) return [];
  return many<AssetGovernanceFacts>(db,
    `SELECT a.id, a.original_filename AS name, g.expires_at, g.lifecycle, g.superseded_by
       FROM assets a JOIN asset_governance g ON g.asset_id=a.id AND g.workspace_id=a.workspace_id
      WHERE a.workspace_id=$1 AND a.id = ANY($2::uuid[])`, [workspaceId, [...new Set(assetIds)]]);
}

/** Variants of the working draft for the given destinations (or the draft's own; base copy when none). */
export async function draftVariants(db: Queryable, workspaceId: string, post: Pick<PostRow, 'brand_id' | 'draft'>, connectionIds?: string[] | null): Promise<VariantInput[]> {
  const conns = await brandConnections(db, workspaceId, post.brand_id, true);
  const ids = connectionIds?.length ? connectionIds : post.draft.variants.map((v) => v.connectionId);
  const draft: DraftContent = { ...post.draft, variants: ids.map((id) => post.draft.variants.find((v) => v.connectionId === id) ?? { connectionId: id, inheritText: true, inheritMedia: true }) };
  const resolved = resolveVariants(draft, conns);
  if (!resolved.length) return [{ connectionId: null, provider: null, text: post.draft.baseText ?? '', link: post.draft.baseLink ?? null, assetIds: post.draft.baseAssetIds ?? [] }];
  return resolved.map((v) => ({ connectionId: v.connectionId, provider: v.provider, text: v.text, link: v.link, assetIds: v.assetIds }));
}

async function revisionVariants(db: Queryable, revisionId: string): Promise<VariantInput[]> {
  return many<VariantInput>(db,
    `SELECT v.connection_id AS "connectionId", c.provider, v.rendered_text AS text, v.link, v.asset_ids AS "assetIds"
       FROM variants v JOIN connections c ON c.id=v.connection_id WHERE v.revision_id=$1 ORDER BY c.provider, v.connection_id`, [revisionId]);
}

async function evaluate(db: Queryable, workspaceId: string, brand: Pick<BrandRow, 'id' | 'voice' | 'timezone'>, post: PostRow, variants: VariantInput[], at: Date, rc?: RuleContext): Promise<{ findings: BrandFinding[]; version: number }> {
  const ctxRules = rc ?? await loadRuleContext(db, workspaceId, brand);
  const assets = await assetFacts(db, workspaceId, variants.flatMap((v) => v.assetIds));
  const tipsignal = await tipsignalFactsFor(db, post, brand.timezone);
  const findings = evaluateBrandRules({ rules: ctxRules.rules, variants, assets, tipsignal, allowedText: ctxRules.allowedText, trustedHosts: ctxRules.trustedHosts, at });
  return { findings, version: ctxRules.version };
}

// ------------------------------------------------------------------ checks (composer + preflight + enforcement)
export const brandCheckSchema = z.object({
  connection_ids: z.array(z.string().uuid()).max(50).optional(),
  at: z.string().datetime({ offset: true }).optional(),
}).strict();

/** Composer validation / preflight: every finding, mandatory and advisory kept apart. Read-only. */
export async function checkPostBrandRules(ctx: Ctx, postId: string, raw: unknown = {}, db: Queryable = getPool()): Promise<BrandCheckResult> {
  const req = brandCheckSchema.parse(raw ?? {});
  const post = await loadPost(ctx, postId, db);
  if (!authorizeCtx(ctx, 'content.read', { brandId: post.brand_id }).allowed) throw notFound('Post');
  const brand = await assertBrand(ctx, post.brand_id, db);
  const at = req.at ? new Date(req.at) : new Date();
  const variants = await draftVariants(db, ctx.access.workspaceId, post, req.connection_ids ?? null);
  const { findings, version } = await evaluate(db, ctx.access.workspaceId, brand, post, variants, at);
  const s = splitFindings(findings);
  return { post_id: post.id, brand_id: post.brand_id, rules_version: version, ok: s.mandatory.length === 0, ...s, evaluated_at: new Date().toISOString() };
}

/**
 * Server-side enforcement used by submit/schedule/publish (posts/scheduling.ts): mandatory findings refuse the
 * request with validation_failed + details.brand_rules. Advisory findings never block.
 */
export async function enforceBrandRules(tx: Queryable, ctx: Ctx, post: PostRow, connectionIds: string[], at: Date): Promise<void> {
  const brand = await maybeOne<BrandRow>(tx, `SELECT * FROM brands WHERE id=$1 AND workspace_id=$2`, [post.brand_id, ctx.access.workspaceId]);
  if (!brand) throw notFound('Brand');
  const variants = await draftVariants(tx, ctx.access.workspaceId, post, connectionIds);
  const { findings, version } = await evaluate(tx, ctx.access.workspaceId, brand, post, variants, at);
  const s = splitFindings(findings);
  if (s.mandatory.length) {
    throw new AppError('validation_failed', `Brand rules: ${s.mandatory[0]!.message}${s.mandatory.length > 1 ? ` (+${s.mandatory.length - 1} more)` : ''}`, undefined,
      { reason: 'brand_rules', rules_version: version, brand_rules: s.mandatory, advisory: s.advisory });
  }
}

// ------------------------------------------------------------------ profile + rules CRUD
export async function getBrandProfile(ctx: Ctx, brandId: string, db: Queryable = getPool()): Promise<BrandProfileDto> {
  const brand = await assertBrand(ctx, brandId, db);
  requireAction(ctx, 'brands.read', { brandId: brand.id });
  if (brand.archived_at) throw notFound('Brand');
  const p = await maybeOne<ProfileRow>(db, `SELECT * FROM brand_profiles WHERE brand_id=$1 AND workspace_id=$2`, [brand.id, ctx.access.workspaceId]);
  const rules = await many<RuleRow>(db, `SELECT * FROM brand_rules WHERE workspace_id=$1 AND brand_id=$2 AND archived_at IS NULL ORDER BY kind, lower(value)`, [ctx.access.workspaceId, brand.id]);
  return {
    brand_id: brand.id, rules_version: p?.rules_version ?? 0, tone: p?.tone ?? null, colours: p?.colours ?? [], logo_asset_ids: p?.logo_asset_ids ?? [],
    cta_default: p?.cta_default ?? null, voice: (brand.voice ?? {}) as BrandProfileDto['voice'], rules: rules.map(ruleDto),
    can_edit: authorizeCtx(ctx, 'brands.manage', { brandId: brand.id }).allowed, updated_at: p?.updated_at.toISOString() ?? null,
  };
}

async function bumpVersion(tx: Queryable, ctx: Ctx, brandId: string): Promise<number> {
  const r = await one<{ rules_version: number }>(tx,
    `INSERT INTO brand_profiles(workspace_id, brand_id, rules_version, updated_by) VALUES ($1,$2,1,$3)
     ON CONFLICT (brand_id) DO UPDATE SET rules_version = brand_profiles.rules_version + 1, updated_by=$3, updated_at=now()
     RETURNING rules_version`, [ctx.access.workspaceId, brandId, ctx.actor.userId]);
  return r.rules_version;
}

/** Load the brand for a manage action (404 outside reach, 403 without brands.manage on it). */
async function manageBrand(ctx: Ctx, brandId: string, db: Queryable): Promise<BrandRow> {
  assertUuid(brandId, 'Brand');
  const visible = await assertBrand(ctx, brandId, db);
  requireAction(ctx, 'brands.manage', { brandId: visible.id, message: 'You cannot change this brand’s rules' });
  if (visible.archived_at) throw notFound('Brand');
  return visible;
}

export async function updateBrandProfile(ctx: Ctx, brandId: string, raw: unknown): Promise<BrandProfileDto & { impact: RuleChangeImpact }> {
  const patch = brandProfilePatchSchema.parse(raw);
  const db = getPool();
  const brand = await manageBrand(ctx, brandId, db);
  await withTx(async (tx) => {
    if (patch.logo_asset_ids?.length) {
      const ok = await many(tx, `SELECT id FROM assets WHERE workspace_id=$1 AND brand_id=$2 AND id = ANY($3::uuid[])`, [ctx.access.workspaceId, brand.id, [...new Set(patch.logo_asset_ids)]]);
      if (ok.length !== new Set(patch.logo_asset_ids).size) throw new AppError('validation_failed', 'Logos must be this brand’s assets', { logo_asset_ids: 'Choose assets from this brand’s library' });
    }
    await bumpVersion(tx, ctx, brand.id);
    await tx.query(
      `UPDATE brand_profiles SET tone = CASE WHEN $3 THEN $4 ELSE tone END, colours=coalesce($5::jsonb, colours), logo_asset_ids=coalesce($6::uuid[], logo_asset_ids),
              cta_default = CASE WHEN $7 THEN $8 ELSE cta_default END WHERE brand_id=$1 AND workspace_id=$2`,
      [brand.id, ctx.access.workspaceId, patch.tone !== undefined, patch.tone ?? null, patch.colours ? JSON.stringify(patch.colours) : null,
        patch.logo_asset_ids ? [...new Set(patch.logo_asset_ids)] : null, patch.cta_default !== undefined, patch.cta_default ?? null]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: brand.id, actorUserId: ctx.actor.userId, action: 'brand.profile_updated', resourceType: 'brand', resourceId: brand.id,
      diff: { fields: Object.keys(patch) }, correlationId: ctx.correlationId });
  });
  const impact = await flagAffectedContent(ctx, brand.id);
  return { ...(await getBrandProfile(ctx, brand.id)), impact };
}

export async function createBrandRule(ctx: Ctx, brandId: string, raw: unknown): Promise<{ rule: BrandRuleDto; impact: RuleChangeImpact }> {
  const input = brandRuleInputSchema.parse(raw);
  const db = getPool();
  const brand = await manageBrand(ctx, brandId, db);
  const value = input.kind === 'approved_link_domain' ? normaliseDomain(input.value) : input.value;
  if (!value) throw new AppError('validation_failed', 'Enter a domain such as example.com', { value: 'Enter a domain such as example.com' });
  if (input.kind === 'preferred_term' && !input.replacement) throw new AppError('validation_failed', 'Give the preferred term', { replacement: 'Required for a preferred term' });
  const id = await withTx(async (tx) => {
    const exists = await maybeOne(tx, `SELECT 1 FROM brand_rules WHERE brand_id=$1 AND kind=$2 AND lower(value)=lower($3) AND archived_at IS NULL`, [brand.id, input.kind, value]);
    if (exists) throw new AppError('conflict', 'This rule already exists', { value: 'Already exists' });
    const r = await one<{ id: string }>(tx,
      `INSERT INTO brand_rules(workspace_id, brand_id, kind, value, replacement, severity, providers, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [ctx.access.workspaceId, brand.id, input.kind, value, input.replacement ?? null, input.severity, input.providers, input.note ?? null, ctx.actor.userId]);
    const version = await bumpVersion(tx, ctx, brand.id);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: brand.id, actorUserId: ctx.actor.userId, action: 'brand_rule.created', resourceType: 'brand_rule', resourceId: r.id,
      diff: { kind: input.kind, severity: input.severity, rules_version: version }, correlationId: ctx.correlationId });
    return r.id;
  });
  const impact = await flagAffectedContent(ctx, brand.id);
  const row = (await maybeOne<RuleRow>(db, `SELECT * FROM brand_rules WHERE id=$1`, [id]))!;
  return { rule: ruleDto(row), impact };
}

async function loadRule(ctx: Ctx, ruleId: string, db: Queryable): Promise<RuleRow> {
  assertUuid(ruleId, 'Rule');
  const r = await maybeOne<RuleRow>(db, `SELECT * FROM brand_rules WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL`, [ruleId, ctx.access.workspaceId]);
  if (!r) throw notFound('Rule');
  return r;
}

export async function updateBrandRule(ctx: Ctx, ruleId: string, raw: unknown): Promise<{ rule: BrandRuleDto; impact: RuleChangeImpact }> {
  const patch = brandRulePatchSchema.parse(raw);
  const db = getPool();
  const rule = await loadRule(ctx, ruleId, db);
  await manageBrand(ctx, rule.brand_id, db);
  const value = patch.value === undefined ? null : rule.kind === 'approved_link_domain' ? normaliseDomain(patch.value) : patch.value;
  if (patch.value !== undefined && !value) throw new AppError('validation_failed', 'Enter a domain such as example.com', { value: 'Enter a domain such as example.com' });
  await withTx(async (tx) => {
    await tx.query(
      `UPDATE brand_rules SET value=coalesce($3,value), replacement=CASE WHEN $4 THEN $5 ELSE replacement END, severity=coalesce($6,severity),
              providers=coalesce($7,providers), note=CASE WHEN $8 THEN $9 ELSE note END, updated_at=now() WHERE id=$1 AND workspace_id=$2`,
      [rule.id, ctx.access.workspaceId, value, patch.replacement !== undefined, patch.replacement ?? null, patch.severity ?? null, patch.providers ?? null, patch.note !== undefined, patch.note ?? null]);
    const version = await bumpVersion(tx, ctx, rule.brand_id);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: rule.brand_id, actorUserId: ctx.actor.userId, action: 'brand_rule.updated', resourceType: 'brand_rule', resourceId: rule.id,
      diff: { before: { severity: rule.severity }, after: { severity: patch.severity ?? rule.severity }, fields: Object.keys(patch), rules_version: version }, correlationId: ctx.correlationId });
  }).catch((e) => { if ((e as { code?: string }).code === '23505') throw new AppError('conflict', 'This rule already exists', { value: 'Already exists' }); throw e; });
  const impact = await flagAffectedContent(ctx, rule.brand_id);
  return { rule: ruleDto((await maybeOne<RuleRow>(db, `SELECT * FROM brand_rules WHERE id=$1`, [rule.id]))!), impact };
}

export async function archiveBrandRule(ctx: Ctx, ruleId: string): Promise<{ ok: true; impact: RuleChangeImpact }> {
  const db = getPool();
  const rule = await loadRule(ctx, ruleId, db);
  await manageBrand(ctx, rule.brand_id, db);
  await withTx(async (tx) => {
    await tx.query(`UPDATE brand_rules SET archived_at=now(), updated_at=now() WHERE id=$1 AND workspace_id=$2`, [rule.id, ctx.access.workspaceId]);
    const version = await bumpVersion(tx, ctx, rule.brand_id);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: rule.brand_id, actorUserId: ctx.actor.userId, action: 'brand_rule.archived', resourceType: 'brand_rule', resourceId: rule.id,
      diff: { kind: rule.kind, severity: rule.severity, rules_version: version }, correlationId: ctx.correlationId });
  });
  return { ok: true, impact: await flagAffectedContent(ctx, rule.brand_id) };
}

// ------------------------------------------------------------------ affected content → review list
/**
 * Re-evaluate the brand's drafts and live schedules against the current rules. Content is NEVER changed: posts with
 * findings get one open review item (replacing an older open one); posts that now pass have their open item superseded.
 * Bounded (AFFECTED_SCAN_LIMIT each); `truncated` says when more exist.
 */
export async function flagAffectedContent(ctx: Ctx, brandId: string, db: Queryable = getPool()): Promise<RuleChangeImpact> {
  const ws = ctx.access.workspaceId;
  const brand = (await maybeOne<BrandRow>(db, `SELECT * FROM brands WHERE id=$1 AND workspace_id=$2`, [brandId, ws]))!;
  const rc = await loadRuleContext(db, ws, brand);
  const schedules = await many<{ id: string; post_id: string; revision_id: string; due_at: Date }>(db,
    `SELECT s.id, s.post_id, s.revision_id, s.due_at FROM schedules s
      WHERE s.workspace_id=$1 AND s.brand_id=$2 AND (s.status='pending_approval'
         OR (s.status='active' AND EXISTS (SELECT 1 FROM deliveries d WHERE d.schedule_id=s.id AND d.state IN ('scheduled','retry_wait','blocked','paused'))))
      ORDER BY s.due_at LIMIT $3`, [ws, brandId, AFFECTED_SCAN_LIMIT + 1]);
  const drafts = await many<PostRow>(db,
    `SELECT p.* FROM posts p WHERE p.workspace_id=$1 AND p.brand_id=$2 AND p.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM schedules s WHERE s.post_id=p.id AND s.status IN ('active','pending_approval','completed'))
      ORDER BY p.updated_at DESC LIMIT $3`, [ws, brandId, AFFECTED_SCAN_LIMIT + 1]);
  const truncated = schedules.length > AFFECTED_SCAN_LIMIT || drafts.length > AFFECTED_SCAN_LIMIT;
  let opened = 0; let nDrafts = 0; let nSchedules = 0;
  const now = new Date();
  const record = async (postId: string, kind: 'draft' | 'schedule', scheduleId: string | null, findings: BrandFinding[]) => {
    await withTx(async (tx) => {
      await tx.query(`UPDATE brand_rule_reviews SET status='superseded' WHERE post_id=$1 AND status='open'`, [postId]);
      if (!findings.length) return;
      const s = splitFindings(findings);
      await tx.query(
        `INSERT INTO brand_rule_reviews(workspace_id, brand_id, rules_version, post_id, schedule_id, kind, findings, mandatory_count, advisory_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [ws, brandId, rc.version, postId, scheduleId, kind, JSON.stringify(findings), s.mandatory.length, s.advisory.length]);
      opened++;
    });
  };
  const postsById = new Map<string, PostRow>();
  if (schedules.length) {
    for (const p of await many<PostRow>(db, `SELECT * FROM posts WHERE workspace_id=$1 AND id = ANY($2::uuid[])`, [ws, schedules.map((s) => s.post_id)])) postsById.set(p.id, p);
  }
  for (const s of schedules.slice(0, AFFECTED_SCAN_LIMIT)) {
    const post = postsById.get(s.post_id);
    if (!post) continue;
    const { findings } = await evaluate(db, ws, brand, post, await revisionVariants(db, s.revision_id), s.due_at > now ? s.due_at : now, rc);
    if (findings.length) nSchedules++;
    await record(post.id, 'schedule', s.id, findings);
  }
  for (const p of drafts.slice(0, AFFECTED_SCAN_LIMIT)) {
    const { findings } = await evaluate(db, ws, brand, p, await draftVariants(db, ws, p), now, rc);
    if (findings.length) nDrafts++;
    await record(p.id, 'draft', null, findings);
  }
  if (opened) {
    await audit(db, { workspaceId: ws, brandId, actorUserId: ctx.actor.userId, action: 'brand_rule.review_listed', resourceType: 'brand', resourceId: brandId,
      diff: { rules_version: rc.version, drafts: nDrafts, schedules: nSchedules, truncated }, correlationId: ctx.correlationId });
  }
  return { rules_version: rc.version, affected: { drafts: nDrafts, schedules: nSchedules, reviews_opened: opened, truncated } };
}

interface ReviewRow {
  id: string; brand_id: string; rules_version: number; post_id: string; schedule_id: string | null; kind: 'draft' | 'schedule'; findings: BrandFinding[];
  mandatory_count: number; advisory_count: number; status: 'open' | 'decided' | 'superseded'; decision: ReviewDecision | null; decided_by: string | null;
  decided_at: Date | null; created_at: Date; post_title: string | null; due_at: Date | null;
}

const reviewDto = (r: ReviewRow): BrandRuleReviewDto => ({
  id: r.id, brand_id: r.brand_id, rules_version: r.rules_version, post_id: r.post_id, post_title: r.post_title, schedule_id: r.schedule_id, kind: r.kind,
  due_at: r.due_at?.toISOString() ?? null, findings: r.findings, mandatory_count: r.mandatory_count, advisory_count: r.advisory_count, status: r.status,
  decision: r.decision, decided_by: r.decided_by, decided_at: r.decided_at?.toISOString() ?? null, created_at: r.created_at.toISOString(),
});

const REVIEW_SELECT = `SELECT r.*, p.title AS post_title, s.due_at FROM brand_rule_reviews r JOIN posts p ON p.id=r.post_id LEFT JOIN schedules s ON s.id=r.schedule_id`;

export async function listRuleReviews(ctx: Ctx, brandId: string, q: { status?: 'open' | 'decided' | 'all'; limit?: number } = {}, db: Queryable = getPool()): Promise<{ items: BrandRuleReviewDto[] }> {
  const brand = await assertBrand(ctx, brandId, db);
  requireAction(ctx, 'content.read', { brandId: brand.id });
  const status = q.status ?? 'open';
  const lim = Math.min(Math.max(q.limit ?? 100, 1), 200);
  const rows = await many<ReviewRow>(db,
    `${REVIEW_SELECT} WHERE r.workspace_id=$1 AND r.brand_id=$2 ${status === 'all' ? '' : 'AND r.status=$3'} ORDER BY r.mandatory_count DESC, s.due_at NULLS LAST, r.created_at DESC LIMIT ${lim}`,
    status === 'all' ? [ctx.access.workspaceId, brand.id] : [ctx.access.workspaceId, brand.id, status]);
  return { items: rows.map(reviewDto) };
}

/** Explicit, audited decision on an affected post. Never edits content; cancel uses the normal cancel path. */
export async function decideRuleReview(ctx: Ctx, reviewId: string, raw: unknown): Promise<BrandRuleReviewDto> {
  const input = reviewDecisionSchema.parse(raw);
  assertUuid(reviewId, 'Review');
  const db = getPool();
  const r = await maybeOne<ReviewRow>(db, `${REVIEW_SELECT} WHERE r.id=$1 AND r.workspace_id=$2`, [reviewId, ctx.access.workspaceId]);
  if (!r) throw notFound('Review');
  const brand = await assertBrand(ctx, r.brand_id, db).catch(() => { throw notFound('Review'); });
  if (r.status !== 'open') throw new AppError('invalid_state', 'This review was already decided or replaced by a newer one.');
  if (input.decision === 'cancel_schedule') {
    if (!r.schedule_id) throw new AppError('validation_failed', 'There is no schedule to cancel', { decision: 'Not scheduled' });
    await cancelSchedule(ctx, r.schedule_id);
  } else if (r.kind === 'schedule' && input.decision === 'keep') {
    // Keeping already-scheduled content that breaks a rule is a publishing decision.
    requireAction(ctx, 'content.schedule', { brandId: brand.id, message: 'Only someone who can schedule for this brand can keep it as scheduled' });
  } else {
    requireAction(ctx, 'content.edit', { brandId: brand.id });
  }
  await withTx(async (tx) => {
    const u = await tx.query(`UPDATE brand_rule_reviews SET status='decided', decision=$2, decided_by=$3, decided_at=now(), note=$4 WHERE id=$1 AND status='open'`,
      [r.id, input.decision, ctx.actor.userId, input.note ?? null]);
    if (!u.rowCount) throw new AppError('conflict', 'This review changed meanwhile. Reload.');
    // Keeping the schedule releases deliveries the engine held for this review (engine/process.ts BRAND_RULE_HOLD).
    if (input.decision === 'keep' && r.schedule_id) await releaseBrandRuleHold(tx, r.schedule_id);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: r.brand_id, actorUserId: ctx.actor.userId, action: 'brand_rule.review_decided', resourceType: 'post', resourceId: r.post_id,
      diff: { review_id: r.id, decision: input.decision, mandatory: r.mandatory_count, advisory: r.advisory_count, rules_version: r.rules_version, schedule_id: r.schedule_id }, correlationId: ctx.correlationId });
  });
  return reviewDto((await maybeOne<ReviewRow>(db, `${REVIEW_SELECT} WHERE r.id=$1`, [r.id]))!);
}
