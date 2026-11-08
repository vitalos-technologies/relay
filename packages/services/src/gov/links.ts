// V3.1 §14 — campaign links: UTM defaults per brand/campaign with preview + override, URL validation, short links
// (NOT an open redirect: the target is only ever the stored, validated destination looked up by an unguessable code)
// and measurement that keeps four families apart: native social metrics, app-observed clicks, website events (only
// from an explicitly configured integration — none exists, so "not configured") and attributed conversions (no model
// is implemented, so "unavailable"). No revenue/ROI is derived from clicks.
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AppError, notFound, type Provider } from '@social-lite/core';
import { UTM_KEYS, type CampaignMeasurement, type LinkPreview, type TrackedLinkDto, type UtmDefaultsDto, type UtmKey, type UtmParams } from '@social-lite/core/contracts/v31-gov';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { assertBrand, assertUuid, brandAllowed, requireAction } from '../tenancy.js';
import { hostAllowed, normaliseDomain } from './rules-engine.js';

export const MAX_URL = 2048;
const VALUE_RE = /^[\p{L}\p{N} ._~+\-{}/|:]{1,150}$/u;

// ------------------------------------------------------------------ pure: validation + building
export function validateDestinationUrl(raw: string): { ok: true; url: URL; warnings: string[] } | { ok: false; errors: string[] } {
  const s = (raw ?? '').trim();
  if (!s) return { ok: false, errors: ['Enter a link.'] };
  if (s.length > MAX_URL) return { ok: false, errors: [`Links can be at most ${MAX_URL} characters.`] };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(s)) return { ok: false, errors: ['Links cannot contain spaces or control characters.'] };
  let u: URL;
  try { u = new URL(s); } catch { return { ok: false, errors: ['This is not a valid link. Include https://'] }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, errors: ['Only http(s) links are allowed.'] };
  if (u.username || u.password) return { ok: false, errors: ['Links cannot contain a username or password.'] };
  const host = u.hostname.toLowerCase();
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[');
  if (!isIp && !normaliseDomain(host)) return { ok: false, errors: ['The link needs a valid domain name.'] };
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return { ok: false, errors: ['Internal hosts are not allowed.'] };
  const warnings: string[] = [];
  if (isIp) warnings.push('The link points at an IP address; use a domain name.');
  if (u.protocol === 'http:') warnings.push('The link is not https.');
  return { ok: true, url: u, warnings };
}

export interface BuildInput {
  url: string;
  defaults: UtmParams;
  /** string = set/replace; null = remove; undefined = keep default/existing. */
  overrides?: Partial<Record<UtmKey, string | null>>;
  /** Placeholder values: {provider}, {campaign}, {brand}. */
  tokens?: Record<string, string>;
}

const fill = (v: string, tokens: Record<string, string>) => v.replace(/\{(provider|campaign|brand)\}/g, (_, k: string) => tokens[k] ?? '');
const slug = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);

/**
 * Apply UTM params: existing query params are preserved (non-UTM keys untouched, in order); an existing UTM key is kept
 * unless explicitly overridden; defaults only fill missing keys; every key appears exactly once.
 */
export function buildCampaignUrl(i: BuildInput): LinkPreview {
  const v = validateDestinationUrl(i.url);
  if (!v.ok) return { ok: false, url: null, params: [], preserved: [], errors: v.errors, warnings: [] };
  const u = v.url;
  const warnings = [...v.warnings];
  const errors: string[] = [];
  const tokens = i.tokens ?? {};
  const existingKeys = [...new Set([...u.searchParams.keys()])];
  const preserved = existingKeys.filter((k) => !(UTM_KEYS as readonly string[]).includes(k));
  const params: LinkPreview['params'] = [];
  for (const k of preserved) for (const val of u.searchParams.getAll(k)) params.push({ key: k, value: val, origin: 'existing' });
  for (const key of UTM_KEYS) {
    const existing = u.searchParams.getAll(key);
    if (existing.length > 1) warnings.push(`${key} appeared ${existing.length} times; kept one.`);
    const ov = i.overrides?.[key];
    let value: string | null = null;
    let origin: LinkPreview['params'][number]['origin'] = 'default';
    if (ov === null) { u.searchParams.delete(key); continue; }
    if (typeof ov === 'string' && ov.trim()) { value = fill(ov.trim(), tokens); origin = 'override'; }
    else if (existing.length) { value = existing[0]!; origin = 'existing'; }
    else if (i.defaults[key]) { const raw = i.defaults[key]!; value = fill(raw, tokens); origin = raw.includes('{') ? 'derived' : 'default'; }
    if (value === null || value === '') { u.searchParams.delete(key); continue; }
    if (!VALUE_RE.test(value)) { errors.push(`${key}: use letters, numbers, spaces and . _ - + only (max 150).`); continue; }
    u.searchParams.set(key, value);  // set() removes any duplicate of this key
    params.push({ key, value, origin });
  }
  const out = u.toString();
  if (out.length > MAX_URL) errors.push(`The final link is longer than ${MAX_URL} characters.`);
  return { ok: errors.length === 0, url: errors.length ? null : out, params, preserved, errors, warnings };
}

// ------------------------------------------------------------------ UTM defaults
const utmParamsSchema = z.object(Object.fromEntries(UTM_KEYS.map((k) => [k, z.string().trim().max(150).regex(VALUE_RE, 'Letters, numbers, spaces and . _ - + only').optional()])) as Record<UtmKey, z.ZodOptional<z.ZodString>>).strict();
export const utmDefaultsSchema = z.object({ campaign_id: z.string().uuid().nullish(), params: utmParamsSchema }).strict();

async function brandCampaign(ctx: Ctx, db: Queryable, brandId: string, campaignId: string | null | undefined) {
  if (!campaignId) return null;
  assertUuid(campaignId, 'Campaign');
  const c = await maybeOne<{ id: string; name: string; ends_on: string | null }>(db, `SELECT id, name, to_char(ends_on,'YYYY-MM-DD') ends_on FROM campaigns WHERE id=$1 AND workspace_id=$2 AND brand_id=$3`,
    [campaignId, ctx.access.workspaceId, brandId]);
  if (!c) throw notFound('Campaign');
  return c;
}

async function layered(db: Queryable, workspaceId: string, brandId: string, campaignId: string | null) {
  const rows = await many<{ campaign_id: string | null; params: UtmParams; updated_at: Date }>(db,
    `SELECT campaign_id, params, updated_at FROM utm_defaults WHERE workspace_id=$1 AND brand_id=$2 AND (campaign_id IS NULL OR campaign_id=$3)`, [workspaceId, brandId, campaignId]);
  const brandRow = rows.find((r) => r.campaign_id === null);
  const campRow = campaignId ? rows.find((r) => r.campaign_id === campaignId) : undefined;
  const base: UtmParams = { utm_source: '{provider}', utm_medium: 'social', ...(campaignId ? { utm_campaign: '{campaign}' } : {}) };
  return { own: (campaignId ? campRow : brandRow), effective: { ...base, ...(brandRow?.params ?? {}), ...(campRow?.params ?? {}) } as UtmParams };
}

export async function getUtmDefaults(ctx: Ctx, brandId: string, campaignId: string | null = null, db: Queryable = getPool()): Promise<UtmDefaultsDto> {
  const brand = await assertBrand(ctx, brandId, db);
  requireAction(ctx, 'brands.read', { brandId: brand.id });
  await brandCampaign(ctx, db, brand.id, campaignId);
  const l = await layered(db, ctx.access.workspaceId, brand.id, campaignId);
  return { brand_id: brand.id, campaign_id: campaignId, params: l.own?.params ?? {}, effective: l.effective, updated_at: l.own?.updated_at.toISOString() ?? null };
}

export async function setUtmDefaults(ctx: Ctx, brandId: string, raw: unknown): Promise<UtmDefaultsDto> {
  const input = utmDefaultsSchema.parse(raw);
  const db = getPool();
  const brand = await assertBrand(ctx, brandId, db);
  requireAction(ctx, 'brands.manage', { brandId: brand.id });
  const camp = await brandCampaign(ctx, db, brand.id, input.campaign_id);
  const params = Object.fromEntries(Object.entries(input.params).filter(([, v]) => v));
  await withTx(async (tx) => {
    const upd = await tx.query(`UPDATE utm_defaults SET params=$4, updated_by=$5, updated_at=now() WHERE workspace_id=$1 AND brand_id=$2 AND campaign_id IS NOT DISTINCT FROM $3::uuid`,
      [ctx.access.workspaceId, brand.id, camp?.id ?? null, JSON.stringify(params), ctx.actor.userId]);
    if (!upd.rowCount) {
      await tx.query(`INSERT INTO utm_defaults(workspace_id, brand_id, campaign_id, params, updated_by) VALUES ($1,$2,$3,$4,$5)`,
        [ctx.access.workspaceId, brand.id, camp?.id ?? null, JSON.stringify(params), ctx.actor.userId]);
    }
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: brand.id, actorUserId: ctx.actor.userId, action: 'utm_defaults.updated', resourceType: camp ? 'campaign' : 'brand',
      resourceId: camp?.id ?? brand.id, diff: { keys: Object.keys(params) }, correlationId: ctx.correlationId });
  });
  return getUtmDefaults(ctx, brand.id, camp?.id ?? null);
}

// ------------------------------------------------------------------ preview + approved domains
export const linkPreviewSchema = z.object({
  brand_id: z.string().uuid(),
  campaign_id: z.string().uuid().nullish(),
  url: z.string().max(MAX_URL + 100),
  provider: z.string().max(32).nullish(),
  overrides: z.object(Object.fromEntries(UTM_KEYS.map((k) => [k, z.string().max(150).nullable().optional()])) as Record<UtmKey, z.ZodOptional<z.ZodNullable<z.ZodString>>>).strict().optional(),
}).strict();

async function approvedDomains(db: Queryable, workspaceId: string, brandId: string): Promise<{ domains: string[]; mandatory: boolean }> {
  const rows = await many<{ value: string; severity: string }>(db, `SELECT value, severity FROM brand_rules WHERE workspace_id=$1 AND brand_id=$2 AND kind='approved_link_domain' AND archived_at IS NULL`, [workspaceId, brandId]);
  return { domains: rows.map((r) => normaliseDomain(r.value)).filter((d): d is string => !!d), mandatory: rows.some((r) => r.severity === 'mandatory') };
}

export async function previewCampaignLink(ctx: Ctx, raw: unknown, db: Queryable = getPool()): Promise<LinkPreview> {
  const input = linkPreviewSchema.parse(raw);
  const brand = await assertBrand(ctx, input.brand_id, db);
  requireAction(ctx, 'content.read', { brandId: brand.id });
  const camp = await brandCampaign(ctx, db, brand.id, input.campaign_id);
  const { effective } = await layered(db, ctx.access.workspaceId, brand.id, camp?.id ?? null);
  const preview = buildCampaignUrl({ url: input.url, defaults: effective, overrides: input.overrides,
    tokens: { provider: slug(input.provider ?? 'social') || 'social', campaign: camp ? slug(camp.name) : '', brand: slug(brand.name) } });
  if (camp?.ends_on && camp.ends_on < new Date().toISOString().slice(0, 10)) preview.warnings.push(`The campaign ended on ${camp.ends_on}.`);
  const ad = await approvedDomains(db, ctx.access.workspaceId, brand.id);
  const host = preview.url ? new URL(preview.url).hostname.toLowerCase() : null;
  if (host && ad.domains.length && !hostAllowed(host, ad.domains)) {
    (ad.mandatory ? preview.errors : preview.warnings).push(`${host} is not an approved domain for ${brand.name}.`);
    if (ad.mandatory) { preview.ok = false; preview.url = null; }
  }
  return preview;
}

// ------------------------------------------------------------------ short links
export const trackedLinkSchema = z.object({
  brand_id: z.string().uuid(), campaign_id: z.string().uuid().nullish(), post_id: z.string().uuid().nullish(), url: z.string().max(MAX_URL),
}).strict();

const shortUrl = (code: string) => `${config().APP_BASE_URL.replace(/\/$/, '')}/api/l/${code}`;

interface LinkRow { id: string; brand_id: string; campaign_id: string | null; post_id: string | null; code: string; destination_url: string; disabled_at: Date | null; created_at: Date; clicks?: string | number }
const linkDto = (r: LinkRow): TrackedLinkDto => ({ id: r.id, brand_id: r.brand_id, campaign_id: r.campaign_id, post_id: r.post_id, code: r.code, short_url: shortUrl(r.code),
  destination_url: r.destination_url, disabled: !!r.disabled_at, created_at: r.created_at.toISOString(), clicks: Number(r.clicks ?? 0) });

export async function createTrackedLink(ctx: Ctx, raw: unknown): Promise<TrackedLinkDto> {
  const input = trackedLinkSchema.parse(raw);
  const db = getPool();
  const brand = await assertBrand(ctx, input.brand_id, db);
  requireAction(ctx, 'content.edit', { brandId: brand.id });
  const camp = await brandCampaign(ctx, db, brand.id, input.campaign_id);
  if (input.post_id) {
    const p = await maybeOne(db, `SELECT 1 FROM posts WHERE id=$1 AND workspace_id=$2 AND brand_id=$3`, [input.post_id, ctx.access.workspaceId, brand.id]);
    if (!p) throw notFound('Post');
  }
  const v = validateDestinationUrl(input.url);
  if (!v.ok) throw new AppError('validation_failed', v.errors[0]!, { url: v.errors[0]! });
  const dest = v.url.toString();
  if (new URL(dest).hostname.toLowerCase() === new URL(config().APP_BASE_URL).hostname.toLowerCase() && v.url.pathname.startsWith('/api/l/')) {
    throw new AppError('validation_failed', 'A short link cannot point at another short link.', { url: 'Use the final destination' });
  }
  const ad = await approvedDomains(db, ctx.access.workspaceId, brand.id);
  if (ad.mandatory && ad.domains.length && !hostAllowed(v.url.hostname.toLowerCase(), ad.domains)) {
    throw new AppError('validation_failed', `${v.url.hostname} is not an approved domain for ${brand.name}.`, { url: 'Not an approved domain' }, { reason: 'brand_rules' });
  }
  const code = randomBytes(9).toString('base64url'); // 12 chars, 72 bits: unguessable
  const row = await withTx(async (tx) => {
    const r = await one<LinkRow>(tx,
      `INSERT INTO tracked_links(workspace_id, brand_id, campaign_id, post_id, code, destination_url, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [ctx.access.workspaceId, brand.id, camp?.id ?? null, input.post_id ?? null, code, dest, ctx.actor.userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: brand.id, actorUserId: ctx.actor.userId, action: 'tracked_link.created', resourceType: 'tracked_link', resourceId: r.id,
      diff: { host: v.url.hostname, campaign_id: camp?.id ?? null }, correlationId: ctx.correlationId });
    return r;
  });
  return linkDto(row);
}

export async function listTrackedLinks(ctx: Ctx, brandId: string, q: { campaign_id?: string | null } = {}): Promise<{ items: TrackedLinkDto[] }> {
  const db = getPool();
  const brand = await assertBrand(ctx, brandId, db);
  requireAction(ctx, 'content.read', { brandId: brand.id });
  if (q.campaign_id) await brandCampaign(ctx, db, brand.id, q.campaign_id);
  const rows = await many<LinkRow>(db,
    `SELECT l.*, coalesce((SELECT sum(clicks) FROM tracked_link_clicks_daily c WHERE c.link_id=l.id),0) AS clicks FROM tracked_links l
      WHERE l.workspace_id=$1 AND l.brand_id=$2 ${q.campaign_id ? 'AND l.campaign_id=$3' : ''} ORDER BY l.created_at DESC LIMIT 200`,
    q.campaign_id ? [ctx.access.workspaceId, brand.id, q.campaign_id] : [ctx.access.workspaceId, brand.id]);
  return { items: rows.map(linkDto) };
}

export async function disableTrackedLink(ctx: Ctx, linkId: string): Promise<TrackedLinkDto> {
  assertUuid(linkId, 'Link');
  const db = getPool();
  const l = await maybeOne<LinkRow>(db, `SELECT * FROM tracked_links WHERE id=$1 AND workspace_id=$2`, [linkId, ctx.access.workspaceId]);
  if (!l || !brandAllowed(ctx, l.brand_id)) throw notFound('Link');
  requireAction(ctx, 'content.edit', { brandId: l.brand_id });
  const r = await withTx(async (tx) => {
    const u = await one<LinkRow>(tx, `UPDATE tracked_links SET disabled_at=coalesce(disabled_at, now()), disabled_by=$2 WHERE id=$1 RETURNING *`, [l.id, ctx.actor.userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: l.brand_id, actorUserId: ctx.actor.userId, action: 'tracked_link.disabled', resourceType: 'tracked_link', resourceId: l.id, correlationId: ctx.correlationId });
    return u;
  });
  return linkDto(r);
}

export const SHORT_CODE_RE = /^[A-Za-z0-9_-]{10,32}$/;

/**
 * Public redirect resolution. Only codes are accepted; the target is the stored destination (re-validated), never
 * anything from the request. Unknown/disabled codes → null (the route answers 404, no redirect). Counts one click per
 * request in a daily counter (no IP / user agent stored; includes bots and link previews).
 */
export async function resolveTrackedLink(code: string, db: Queryable = getPool(), now = new Date()): Promise<string | null> {
  if (!SHORT_CODE_RE.test(code)) return null;
  const l = await maybeOne<{ id: string; workspace_id: string; destination_url: string; disabled_at: Date | null }>(db,
    `SELECT l.id, l.workspace_id, l.destination_url, l.disabled_at FROM tracked_links l JOIN workspaces w ON w.id=l.workspace_id AND w.state='active' WHERE l.code=$1`, [code]);
  if (!l || l.disabled_at) return null;
  const v = validateDestinationUrl(l.destination_url);
  if (!v.ok) return null;
  await db.query(`INSERT INTO tracked_link_clicks_daily(link_id, workspace_id, day, clicks) VALUES ($1,$2,$3,1)
                  ON CONFLICT (link_id, day) DO UPDATE SET clicks = tracked_link_clicks_daily.clicks + 1`, [l.id, l.workspace_id, now.toISOString().slice(0, 10)]);
  return v.url.toString();
}

// ------------------------------------------------------------------ measurement (four separate families)
export async function campaignMeasurement(ctx: Ctx, campaignId: string, db: Queryable = getPool()): Promise<CampaignMeasurement> {
  assertUuid(campaignId, 'Campaign');
  const c = await maybeOne<{ id: string; brand_id: string }>(db, `SELECT id, brand_id FROM campaigns WHERE id=$1 AND workspace_id=$2`, [campaignId, ctx.access.workspaceId]);
  if (!c || !brandAllowed(ctx, c.brand_id)) throw notFound('Campaign');
  requireAction(ctx, 'analytics.read', { brandId: c.brand_id });
  const native = await many<{ provider: Provider; metric_id: string; value: string; posts: number; freshest: Date | null }>(db,
    `SELECT m.provider, m.metric_id, sum(m.value)::text AS value, count(DISTINCT m.resource_id)::int AS posts, max(m.observed_at) AS freshest
       FROM metric_resource_latest m JOIN deliveries d ON d.id=m.resource_id AND d.workspace_id=m.workspace_id JOIN posts p ON p.id=d.post_id
      WHERE m.workspace_id=$1 AND m.resource_type='post' AND m.source='provider' AND p.campaign_id=$2 AND m.dimension=''
      GROUP BY m.provider, m.metric_id`, [ctx.access.workspaceId, c.id]);
  const byProvider = new Map<Provider, { metrics: Record<string, number>; posts: number }>();
  let fresh: Date | null = null;
  for (const r of native) {
    const e = byProvider.get(r.provider) ?? { metrics: {}, posts: 0 };
    e.metrics[r.metric_id] = Number(r.value);
    e.posts = Math.max(e.posts, r.posts);
    byProvider.set(r.provider, e);
    if (r.freshest && (!fresh || r.freshest > fresh)) fresh = r.freshest;
  }
  const clicks = await many<{ day: string; clicks: string }>(db,
    `SELECT to_char(c.day,'YYYY-MM-DD') AS day, sum(c.clicks)::text AS clicks FROM tracked_link_clicks_daily c JOIN tracked_links l ON l.id=c.link_id
      WHERE l.workspace_id=$1 AND l.campaign_id=$2 GROUP BY c.day ORDER BY c.day`, [ctx.access.workspaceId, c.id]);
  const links = await maybeOne<{ n: number }>(db, `SELECT count(*)::int n FROM tracked_links WHERE workspace_id=$1 AND campaign_id=$2`, [ctx.access.workspaceId, c.id]);
  return {
    campaign_id: c.id,
    native_social: { label: 'Native social metrics (reported by each network)', by_provider: [...byProvider.entries()].map(([provider, v]) => ({ provider, ...v })), freshness: fresh?.toISOString() ?? null },
    app_clicks: { label: 'Clicks observed by Relay short links', status: links?.n ? 'available' : 'no_links', total: clicks.reduce((s, r) => s + Number(r.clicks), 0),
      by_day: clicks.map((r) => ({ day: r.day, clicks: Number(r.clicks) })), caveat: 'Counts every request to a Relay short link, including bots and link previews. Not unique visitors; not website sessions.' },
    website_events: { label: 'Website events', status: 'not_configured', reason: 'No website analytics integration is configured. Relay never infers website events from clicks.' },
    conversions: { label: 'Attributed conversions', status: 'unavailable', model: null, reason: 'Conversion tracking is not implemented. No revenue or ROI is derived from clicks.' },
  };
}
