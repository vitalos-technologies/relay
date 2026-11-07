// AI caption assistance (V1.1, spec §16). Returns structured SUGGESTIONS only — this module never
// writes a draft. Authorization: drafts.edit on the post's brand, rechecked after generation.
// Safety: the model sees only post text, brand voice, destination limits and validated source text;
// no tools, no credentials, no asset bytes. Logs carry IDs and token counts, never content.
import { AppError, PROVIDER_LABEL, forbidden, notFound, resolveVariants, type DraftContent } from '@social-lite/core';
import { getPool, maybeOne, type Queryable } from '@social-lite/db';
import { config } from '../config.js';
import type { Ctx } from '../context.js';
import { log } from '../log.js';
import { settingSource, getSetting } from '../settings.js';
import { assertBrand, authorizeCtx, loadAccess, requireAction } from '../tenancy.js';
import { canAnywhere } from '../access.js';
import { loadPost, type PostRow } from '../posts/service.js';
import { brandConnections, capabilitiesFor, type ConnectionRow } from '../posts/shared.js';
import type { BrandVoice } from '../brands.js';
import { AnthropicModelClient, FixtureModelClient, type AiModelClient } from './client.js';
import { checkSuggestion, type LimitTarget } from './fidelity.js';
import { SYSTEM_PROMPT, buildUserPrompt, type PromptInput, type PromptTarget } from './prompt.js';
import { SOURCE_MAX_CHARS, fetchSourceUrl, sanitizeText } from './source.js';
import { readUsage, reserveTokens, settleTokens } from './usage.js';
import { suggestRequestSchema, type AiStatus, type Suggestion, type SuggestRequest, type SuggestResponse } from './types.js';

export const AI_MAX_OUTPUT_TOKENS = 16_000;
/** Longest post text (per scope) accepted for assistance. Longer text is refused, not cut. */
export const POST_TEXT_MAX_CHARS = 8_000;
const MAX_TARGETS = 10;
export const NOT_CONFIGURED = 'AI not configured';

// ---------------------------------------------------------------- client selection

let clientOverride: AiModelClient | null = null;
/** Tests inject a fake model client (no network). Pass null to restore normal resolution. */
export function setAiModelClient(c: AiModelClient | null): void {
  clientOverride = c;
}

/** Deterministic fixture suggestions: development/test only (production config rejects AI_FIXTURE). */
export function aiFixtureEnabled(): boolean {
  const c = config();
  return c.APP_ENV !== 'production' && c.AI_FIXTURE;
}

async function resolveClient(): Promise<AiModelClient> {
  if (clientOverride) return clientOverride;
  if (aiFixtureEnabled()) return new FixtureModelClient();
  const key = await getSetting('ANTHROPIC_API_KEY');
  if (!key) throw new AppError('provider_not_configured', `${NOT_CONFIGURED}. An owner can add an Anthropic API key in Setup.`);
  return new AnthropicModelClient(key);
}

export async function aiStatus(ctx: Ctx, db: Queryable = getPool()): Promise<AiStatus> {
  const fixture = !clientOverride && aiFixtureEnabled();
  const configured = !!clientOverride || fixture || (await settingSource('ANTHROPIC_API_KEY', db)) !== null;
  const u = await readUsage(ctx.access.workspaceId, db);
  return {
    configured, reason: configured ? null : NOT_CONFIGURED, fixture,
    model: fixture ? 'test-fixture' : config().AI_MODEL,
    can_use: configured && canAnywhere(ctx, 'content.edit'),
    period: u.period, used: u.used, cap: u.cap, remaining: u.remaining,
  };
}

// ---------------------------------------------------------------- helpers

interface Dest { conn: ConnectionRow; label: string; text: string; link: string | null; hasMedia: boolean; inherits: boolean }

function destinations(draft: DraftContent, conns: ConnectionRow[], ids: string[]): Dest[] {
  const d: DraftContent = { ...draft, variants: ids.map((id) => draft.variants.find((v) => v.connectionId === id) ?? { connectionId: id, inheritText: true, inheritMedia: true }) };
  const resolved = resolveVariants(d, conns);
  return ids.flatMap((id) => {
    const conn = conns.find((c) => c.id === id);
    const v = resolved.find((r) => r.connectionId === id);
    if (!conn || !v) return [];
    const hasMedia = v.assetIds.length > 0;
    const linkSeparate = conn.provider === 'facebook' && !hasMedia; // mirrors validateDraft
    return [{ conn, label: `${PROVIDER_LABEL[conn.provider]} · ${conn.display_name}`, text: v.text, link: linkSeparate ? null : v.link, hasMedia, inherits: v.inheritText }];
  });
}

function limitTarget(d: Dest): LimitTarget | null {
  const caps = capabilitiesFor(d.conn);
  return caps ? { label: d.label, constraints: caps.constraints, hasMedia: d.hasMedia, link: d.link } : null;
}

function tightest(ds: Dest[]): Dest | null {
  let best: { d: Dest; n: number } | null = null;
  for (const d of ds) {
    const c = capabilitiesFor(d.conn)?.constraints;
    if (!c) continue;
    const n = d.hasMedia ? c.maxCaptionLength : c.maxTextLength;
    if (!best || n < best.n) best = { d, n };
  }
  return best?.d ?? null;
}

const cleanTag = (h: string) => {
  const t = h.trim().replace(/^#+/, '');
  return /^[\p{L}\p{N}_]{1,100}$/u.test(t) ? `#${t}` : null;
};

/** Validated TipSignal names/terms for strict checks (only when this post came from a TipSignal event). */
async function tipsignalPhrases(db: Queryable, post: PostRow): Promise<string[] | null> {
  if (post.source?.kind !== 'tipsignal') return null;
  const ev = await maybeOne<{ payload: { data?: { market?: string; selection?: string; fixture?: { home?: string; away?: string; competition?: string } } } }>(db,
    `SELECT payload FROM source_events WHERE workspace_id=$1 AND source='tipsignal' AND source_event_id=$2`, [post.workspace_id, String(post.source.event_id ?? '')]);
  const d = ev?.payload?.data;
  return [d?.fixture?.home, d?.fixture?.away, d?.fixture?.competition, d?.market, d?.selection].filter((x): x is string => typeof x === 'string' && x.length > 0);
}

/** Conservative input-token estimate (≈3 chars/token) plus structured-output/system overhead. */
export function estimateInputTokens(system: string, prompt: string): number {
  return Math.ceil((system.length + prompt.length) / 3) + 1_500;
}

// ---------------------------------------------------------------- main entry point

export async function suggestForPost(ctx: Ctx, postId: string, rawInput: unknown): Promise<SuggestResponse> {
  requireAction(ctx, 'drafts.edit');
  const input: SuggestRequest = suggestRequestSchema.parse(rawInput);
  const client = await resolveClient();
  const db = getPool();
  const post = await loadPost(ctx, postId, db);
  if (post.archived_at) throw new AppError('invalid_state', 'This post is archived');
  const brand = await assertBrand(ctx, post.brand_id, db);
  if (brand.archived_at) throw new AppError('invalid_state', 'This brand is archived');
  const voice = (brand.voice ?? {}) as BrandVoice;
  const notices: string[] = [];

  // Destinations: explicit ids must belong to this brand; otherwise the draft's destinations.
  const conns = await brandConnections(db, ctx.access.workspaceId, post.brand_id);
  if (input.connection_ids?.some((id) => !conns.some((c) => c.id === id))) {
    throw new AppError('validation_failed', 'One or more destinations do not belong to this brand', { connection_ids: 'Choose destinations connected to this brand' });
  }
  const draftIds = post.draft.variants.map((v) => v.connectionId).filter((id) => conns.some((c) => c.id === id));
  const selected = destinations(post.draft, conns, input.connection_ids?.length ? [...new Set(input.connection_ids)] : draftIds);
  const perDestination = input.task === 'variants' || !!input.connection_ids?.length;
  if (perDestination && !selected.length) throw new AppError('validation_failed', 'Pick at least one destination first.', { connection_ids: 'Pick a destination' });
  if (selected.length > MAX_TARGETS) throw new AppError('validation_failed', `Assistance works on up to ${MAX_TARGETS} destinations at a time.`);

  // Source (repurpose only).
  let source: PromptInput['source'];
  if (input.task === 'repurpose') {
    if (!!input.source_url === !!input.source_post_id) {
      throw new AppError('validation_failed', 'Give either a source link or a source post.', { source: 'Give a link or a post' });
    }
    if (input.source_url) {
      const f = await fetchSourceUrl(input.source_url);
      if (f.truncated) notices.push(`Only the first ${SOURCE_MAX_CHARS.toLocaleString('en')} characters of the page were used.`);
      source = { kind: 'url', text: f.text, url: input.source_url };
    } else {
      const sp = await loadPost(ctx, input.source_post_id!, db);
      if (sp.brand_id !== post.brand_id) throw notFound('Source post');
      const rev = sp.current_revision_id
        ? await maybeOne<{ base_text: string }>(db, `SELECT base_text FROM post_revisions WHERE id=$1 AND workspace_id=$2`, [sp.current_revision_id, ctx.access.workspaceId])
        : null;
      let text = sanitizeText(rev?.base_text ?? sp.draft.baseText ?? '').trim();
      if (!text) throw new AppError('validation_failed', 'The source post has no text.', { source_post_id: 'Pick a post with text' });
      if (text.length > SOURCE_MAX_CHARS) {
        text = text.slice(0, SOURCE_MAX_CHARS);
        notices.push(`Only the first ${SOURCE_MAX_CHARS.toLocaleString('en')} characters of the source post were used.`);
      }
      source = { kind: 'post', text };
    }
  } else if (input.source_url || input.source_post_id) {
    throw new AppError('validation_failed', 'A source is only used when repurposing.', { source: 'Only for repurpose' });
  }

  // Targets (scopes) the model must answer.
  const inheriting = selected.filter((d) => d.inherits);
  const targets: Array<PromptTarget & { limits: LimitTarget[]; before: string }> = [];
  if (perDestination) {
    selected.forEach((d, i) => {
      const caps = capabilitiesFor(d.conn);
      const lt = limitTarget(d);
      targets.push({ key: `d${i + 1}`, scope: d.conn.id, label: d.label, provider: d.conn.provider, constraints: caps?.constraints ?? null,
        hasMedia: d.hasMedia, text: d.text, limits: lt ? [lt] : [], before: d.text });
    });
  } else {
    const t = tightest(inheriting);
    const caps = t ? capabilitiesFor(t.conn) : null;
    const label = inheriting.length ? `Base copy, shared by ${inheriting.map((d) => d.label).join(', ')}` : 'Base copy';
    targets.push({ key: 'base', scope: 'base', label, provider: t?.conn.provider ?? null, constraints: caps?.constraints ?? null,
      hasMedia: post.draft.baseAssetIds.length > 0, text: post.draft.baseText ?? '', limits: inheriting.map(limitTarget).filter((x): x is LimitTarget => !!x),
      before: post.draft.baseText ?? '' });
  }
  for (const t of targets) {
    if (t.text.length > POST_TEXT_MAX_CHARS) {
      throw new AppError('validation_failed', `The text is too long for assistance (over ${POST_TEXT_MAX_CHARS.toLocaleString('en')} characters).`, { text: 'Too long for assistance' });
    }
    if (input.task !== 'repurpose' && !t.text.trim()) throw new AppError('validation_failed', 'Write some text first.', { text: 'Write some text first' });
  }

  // Prompt + atomic reservation BEFORE the call.
  const promptInput: PromptInput = { task: input.task, voice, tone: input.tone, targets, source };
  const prompt = buildUserPrompt(promptInput);
  const model = config().AI_MODEL;
  const reservation = await reserveTokens(ctx.access.workspaceId, AI_MAX_OUTPUT_TOKENS + estimateInputTokens(SYSTEM_PROMPT, prompt), { userId: ctx.actor.userId, ref: `ai:${ctx.correlationId.slice(0, 64)}` });
  const base = { brandId: post.brand_id, postId: post.id, userId: ctx.actor.userId, task: input.task, correlationId: ctx.correlationId };

  let result;
  try {
    result = await client.generate({ model, maxTokens: AI_MAX_OUTPUT_TOKENS, system: SYSTEM_PROMPT, prompt, input: promptInput });
  } catch (err) {
    await settleTokens(reservation, { ...base, model, status: 'failed', inputTokens: 0, outputTokens: 0 })
      .catch((e) => log.error('ai.release_failed', { workspaceId: ctx.access.workspaceId, correlationId: ctx.correlationId, err: e as Error }));
    log.warn('ai.suggest_failed', { workspaceId: ctx.access.workspaceId, brandId: post.brand_id, postId: post.id, task: input.task, model, correlationId: ctx.correlationId, code: err instanceof AppError ? err.code : 'unexpected' });
    if (err instanceof AppError) throw err;
    throw new AppError('provider_error', 'The AI provider is unavailable. Try again shortly.');
  }

  const status = client.fixture ? 'fixture' : result.stopReason === 'refusal' ? 'refused' : result.output ? 'ok' : 'failed';
  const settled = await settleTokens(reservation, { ...base, model: result.model || model, status, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
  log.info('ai.suggest', { workspaceId: ctx.access.workspaceId, brandId: post.brand_id, postId: post.id, userId: ctx.actor.userId, task: input.task,
    model: result.model || model, status, input_tokens: result.inputTokens, output_tokens: result.outputTokens, correlationId: ctx.correlationId });

  // Recheck authorization after generation (membership/role/brand grant may have changed meanwhile).
  const access = await loadAccess(ctx.actor.userId, ctx.access.workspaceId, db);
  if (!access) throw forbidden();
  if (access.brandIds !== null && !access.brandIds.includes(post.brand_id)) throw notFound('Post');
  if (!authorizeCtx({ ...ctx, access }, 'content.edit', { brandId: post.brand_id }).allowed) throw forbidden();

  if (status === 'refused') throw new AppError('provider_error', 'The AI declined to make suggestions for this post.');
  if (!result.output) throw new AppError('provider_error', 'The AI response was incomplete. Try again.');

  // Map, sanitise and check suggestions. Nothing is written to the draft.
  const strictPhrases = await tipsignalPhrases(db, post);
  const strict = strictPhrases !== null;
  const allowedText = [voice.footer, voice.default_cta, ...(voice.hashtags ?? []), ...(voice.terminology ?? []), source?.kind === 'url' ? source.url : null]
    .filter(Boolean).join('\n');
  const suggestions: Suggestion[] = [];
  for (const t of targets) {
    const s = result.output.suggestions.find((x) => x.scope === t.key);
    if (!s) {
      notices.push(`No suggestion was returned for ${t.label}.`);
      continue;
    }
    const text = sanitizeText(s.text.normalize('NFC')).replace(/[ \t]+$/gm, '').trim();
    const issues = checkSuggestion({
      sourceText: input.task === 'repurpose' ? (source?.text ?? '') : t.text,
      allowedText, text, prohibited: voice.prohibited ?? [], strict, allowDrops: input.task === 'repurpose',
      requiredPhrases: strictPhrases ?? [], targets: t.limits,
    });
    if (text === t.before.trim() && input.task !== 'hashtags') notices.push(`${t.label}: no changes suggested.`);
    suggestions.push({
      scope: t.scope, before: t.before, text,
      hashtags: [...new Set(s.hashtags.map(cleanTag).filter((x): x is string => !!x))].slice(0, 30),
      note: s.note.trim().slice(0, 300) || null,
      issues, rejected: issues.some((i) => i.severity === 'block'),
    });
  }

  return {
    suggestions,
    usage: { input: result.inputTokens, output: result.outputTokens, remaining: settled.remaining, cap: reservation.cap },
    fixture: client.fixture, model: result.model || model, post_version: post.version, notices,
  };
}
