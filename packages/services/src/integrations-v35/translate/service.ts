// Google Cloud Translation (brief §7). Off until a workspace admin enables it and acknowledges the per-character charge.
//  - Sources: inbox messages, reply drafts, post text/variants, listening results. The original is never modified; a
//    translation is a separate record labelled machine-translated with source/target languages.
//  - Customer content (inbox messages, reply drafts) is sent to the provider only when the workspace allows it.
//  - Nothing is ever sent or published by translating: the reply composer shows the exact outgoing text for review.
//  - Usage: characters and an estimated cost at the configured list price (not an invoice; the free tier is not
//    subtracted), monthly cap, failures. Identical source + target is served from the stored translation (no new cost).
import { createHash } from 'node:crypto';
import { AppError, notFound } from '@social-lite/core';
import type { TranslationJson, TranslationSettingsJson, TranslationSourceType } from '@social-lite/core/contracts/v35-integrations';
import { getPool, maybeOne, one, withTx } from '@social-lite/db';
import {
  TRANSLATE_DEFAULT_PRICE_PER_MILLION_USD, TRANSLATE_HOSTS, TRANSLATE_PRICE_CHECKED_ON, listGlossaries, parseServiceAccount, serviceAccountToken, supportedLanguages, translateText,
} from '@social-lite/providers/google-translate/client';
import { translateSim } from '@social-lite/providers/google-translate/sim';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { audit } from '../../audit.js';
import { getSetting } from '../../settings.js';
import { authorizeCtx, brandAllowed, requireAction } from '../../tenancy.js';
import { recordActivity } from '../../connectors/index.js';
import { appErrorFrom, openConn, operatorConfig } from '../core/runtime.js';
import type { Conn, HubAdapter } from '../core/types.js';

const tokenCache = new Map<string, { token: string; until: number }>();

export const translateAdapter: HubAdapter = {
  connector: 'google_translate', hosts: TRANSLATE_HOSTS, sim: translateSim, connect: 'operator', webhook: null,
  required: ['GOOGLE_TRANSLATE_PROJECT_ID', 'GOOGLE_TRANSLATE_SERVICE_ACCOUNT_JSON'], optional: ['GOOGLE_TRANSLATE_LOCATION', 'TRANSLATE_PRICE_PER_MILLION_USD'],
  simSettings: { project: 'mock-project', location: 'global' },
  capabilities: ['Translate inbox messages and reply drafts (when allowed)', 'Translate post text and listening results', 'Glossaries (Translation Advanced)', 'Usage and cost estimate'],
  async operatorConnect(t, cfg) {
    const key = parseServiceAccount(cfg.values.GOOGLE_TRANSLATE_SERVICE_ACCOUNT_JSON!);
    if (!key) throw new AppError('provider_not_configured', 'The service account key is not valid JSON for a service account.');
    const tok = await serviceAccountToken(t, key);
    const project = cfg.values.GOOGLE_TRANSLATE_PROJECT_ID!;
    const location = cfg.values.GOOGLE_TRANSLATE_LOCATION ?? 'global';
    const langs = await supportedLanguages({ t, token: tok.accessToken, project, location });
    return { externalAccountId: project, displayName: `Cloud Translation · ${project}`, grantedScopes: ['https://www.googleapis.com/auth/cloud-translation'],
      creds: { accessToken: tok.accessToken, refreshToken: null, expiresAt: tok.expiresAt }, settings: { project, location, service_account: key.client_email },
      health: { status: 'active', message: `${langs.length} languages available.` } };
  },
  async refresh(t, cfg, creds) {
    const key = parseServiceAccount(cfg.values.GOOGLE_TRANSLATE_SERVICE_ACCOUNT_JSON ?? '');
    if (!key) throw new AppError('provider_not_configured', 'Cloud Translation service account is not configured.');
    const hit = tokenCache.get(key.client_email);
    if (hit && hit.until - Date.now() > 5 * 60_000) return { ...creds, accessToken: hit.token };
    const tok = await serviceAccountToken(t, key);
    tokenCache.set(key.client_email, { token: tok.accessToken, until: Date.parse(tok.expiresAt) });
    return { accessToken: tok.accessToken, refreshToken: null, expiresAt: tok.expiresAt };
  },
  async verify(c) { const l = await supportedLanguages(call(c)); return { status: 'active', message: `${l.length} languages available.` }; },
  async discover(c) { return (await listGlossaries(call(c))).map((g) => ({ resource_type: 'glossary', external_id: g.name.split('/').pop()!, name: g.name.split('/').pop()!, url: null, detail: g.entryCount ? `${g.entryCount} entries` : null, selected: false })); },
};

const call = (c: Conn) => ({ t: c.t, token: c.token, project: String(c.settings.project ?? ''), location: String(c.settings.location ?? 'global') });

async function pricePerMillion(): Promise<number> {
  const v = Number(await getSetting('TRANSLATE_PRICE_PER_MILLION_USD').catch(() => undefined));
  return Number.isFinite(v) && v > 0 ? v : TRANSLATE_DEFAULT_PRICE_PER_MILLION_USD;
}

async function activeInstallation(workspaceId: string): Promise<{ id: string; is_simulated: boolean } | null> {
  return maybeOne(getPool(), `SELECT id, is_simulated FROM integration_connections WHERE workspace_id=$1 AND connector='google_translate' AND disconnected_at IS NULL AND status <> 'reconnect_required' ORDER BY is_simulated, created_at DESC LIMIT 1`, [workspaceId]);
}

type SettingsRow = { enabled: boolean; allow_customer_content: boolean; monthly_char_cap: number; glossary_id: string | null; billing_acknowledged_at: Date | null };

async function settingsRow(workspaceId: string): Promise<SettingsRow> {
  return (await maybeOne<SettingsRow>(getPool(), `SELECT enabled, allow_customer_content, monthly_char_cap, glossary_id, billing_acknowledged_at FROM translation_settings WHERE workspace_id=$1`, [workspaceId]))
    ?? { enabled: false, allow_customer_content: false, monthly_char_cap: 500_000, glossary_id: null, billing_acknowledged_at: null };
}

export async function getTranslationSettings(ctx: Ctx): Promise<TranslationSettingsJson> {
  requireAction(ctx, 'integrations.read');
  const s = await settingsRow(ctx.access.workspaceId);
  const inst = await activeInstallation(ctx.access.workspaceId);
  const u = await one<{ chars: string; micros: string; n: number; fails: number }>(getPool(),
    `SELECT coalesce(sum(characters),0)::text chars, coalesce(sum(cost_estimate_micros),0)::text micros, count(*)::int n,
            (SELECT count(*)::int FROM integration_activity a JOIN integration_connections i ON i.id=a.integration_id WHERE a.workspace_id=$1 AND i.connector='google_translate' AND a.outcome='error' AND a.at > now() - interval '30 days') fails
       FROM translations WHERE workspace_id=$1 AND created_at >= date_trunc('month', now())`, [ctx.access.workspaceId]);
  return {
    enabled: s.enabled, allow_customer_content: s.allow_customer_content, monthly_char_cap: s.monthly_char_cap, glossary_id: s.glossary_id,
    billing_acknowledged_at: s.billing_acknowledged_at?.toISOString() ?? null, price_per_million_usd: await pricePerMillion(), price_checked_on: TRANSLATE_PRICE_CHECKED_ON,
    usage: { month_characters: Number(u.chars), month_cost_estimate_usd: Number(u.micros) / 1e6, month_requests: u.n, failures_30d: u.fails },
    connected: !!inst, is_simulated: !!inst?.is_simulated, can_manage: authorizeCtx(ctx, 'integrations.manage', { brandId: null }).allowed,
  };
}

export const translationSettingsSchema = z.object({
  enabled: z.boolean(), allow_customer_content: z.boolean(), monthly_char_cap: z.number().int().min(1000).max(100_000_000),
  glossary_id: z.string().regex(/^[\w-]{1,100}$/).nullable(), acknowledge_billing: z.boolean().optional(),
}).strict();

/** Workspace control (workspace-scope integrations.manage). Enabling needs an installation and the billing acknowledgement. */
export async function updateTranslationSettings(ctx: Ctx, input: z.infer<typeof translationSettingsSchema>): Promise<TranslationSettingsJson> {
  requireAction(ctx, 'integrations.manage', { brandId: null, message: 'Only workspace integration managers can change translation settings.' });
  const prev = await settingsRow(ctx.access.workspaceId);
  if (input.enabled && !(await activeInstallation(ctx.access.workspaceId))) throw new AppError('invalid_state', 'Connect Cloud Translation first.');
  if (input.enabled && !prev.billing_acknowledged_at && !input.acknowledge_billing) throw new AppError('validation_failed', 'Confirm that translation is billed per character.', { acknowledge_billing: 'Required' });
  await withTx(async (tx) => {
    await tx.query(
      `INSERT INTO translation_settings(workspace_id, enabled, allow_customer_content, monthly_char_cap, glossary_id, billing_acknowledged_by, billing_acknowledged_at, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (workspace_id) DO UPDATE SET enabled=EXCLUDED.enabled, allow_customer_content=EXCLUDED.allow_customer_content, monthly_char_cap=EXCLUDED.monthly_char_cap, glossary_id=EXCLUDED.glossary_id,
         billing_acknowledged_by=coalesce(translation_settings.billing_acknowledged_by, EXCLUDED.billing_acknowledged_by), billing_acknowledged_at=coalesce(translation_settings.billing_acknowledged_at, EXCLUDED.billing_acknowledged_at),
         updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [ctx.access.workspaceId, input.enabled, input.allow_customer_content, input.monthly_char_cap, input.glossary_id, input.acknowledge_billing ? ctx.actor.userId : null, input.acknowledge_billing ? new Date() : null, ctx.actor.userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'integration.translation_settings', resourceType: 'workspace', resourceId: ctx.access.workspaceId,
      diff: { enabled: input.enabled, allow_customer_content: input.allow_customer_content, monthly_char_cap: input.monthly_char_cap, glossary: !!input.glossary_id }, correlationId: ctx.correlationId });
  });
  return getTranslationSettings(ctx);
}

export const translateSchema = z.object({
  source_type: z.enum(['inbox_message', 'reply_draft', 'post_variant', 'listening_result', 'text']), source_id: z.string().uuid().optional(),
  text: z.string().min(1).max(5000).optional(), target_lang: z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/), source_lang: z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/).optional(),
}).strict();

const CUSTOMER_CONTENT: TranslationSourceType[] = ['inbox_message', 'reply_draft'];

/** Resolve the text + brand + permission for a source. The text is read server-side where Relay stores it. */
async function resolveSource(ctx: Ctx, i: z.infer<typeof translateSchema>): Promise<{ text: string; brandId: string | null }> {
  const ws = ctx.access.workspaceId;
  const need = (perm: Parameters<typeof requireAction>[1], brandId: string) => { if (!brandAllowed(ctx, brandId)) throw notFound('Item'); requireAction(ctx, perm, { brandId }); };
  switch (i.source_type) {
    case 'inbox_message': {
      if (!i.source_id) throw new AppError('validation_failed', 'source_id is required');
      const m = await maybeOne<{ body: string | null; brand_id: string }>(getPool(), `SELECT m.body, c.brand_id FROM inbox_messages m JOIN inbox_conversations c ON c.id=m.conversation_id WHERE m.id=$1 AND c.workspace_id=$2`, [i.source_id, ws]);
      if (!m) throw notFound('Message');
      need('inbox.read', m.brand_id);
      if (!m.body) throw new AppError('invalid_state', 'This message has no text (deleted or erased).');
      return { text: m.body, brandId: m.brand_id };
    }
    case 'reply_draft': {
      if (!i.source_id || !i.text) throw new AppError('validation_failed', 'conversation id and text are required');
      const c = await maybeOne<{ brand_id: string }>(getPool(), `SELECT brand_id FROM inbox_conversations WHERE id=$1 AND workspace_id=$2`, [i.source_id, ws]);
      if (!c) throw notFound('Conversation');
      need('inbox.reply', c.brand_id);
      return { text: i.text, brandId: c.brand_id };
    }
    case 'post_variant': {
      if (!i.source_id || !i.text) throw new AppError('validation_failed', 'post id and text are required');
      const p = await maybeOne<{ brand_id: string }>(getPool(), `SELECT brand_id FROM posts WHERE id=$1 AND workspace_id=$2`, [i.source_id, ws]);
      if (!p) throw notFound('Post');
      need('content.edit', p.brand_id);
      return { text: i.text, brandId: p.brand_id };
    }
    case 'listening_result': {
      if (!i.source_id) throw new AppError('validation_failed', 'source_id is required');
      const exists = await maybeOne<{ t: string | null }>(getPool(), `SELECT to_regclass('public.listening_observations')::text AS t`);
      const o = exists?.t ? await maybeOne<{ body: string | null; brand_id: string }>(getPool(), `SELECT body, brand_id FROM listening_observations WHERE id=$1 AND workspace_id=$2`, [i.source_id, ws]) : null;
      if (!o) throw notFound('Listening result');
      need('listening.read', o.brand_id);
      if (!o.body) throw new AppError('invalid_state', 'This result was removed at the source.');
      return { text: o.body, brandId: o.brand_id };
    }
    default:
      if (!i.text) throw new AppError('validation_failed', 'text is required');
      requireAction(ctx, 'ai.use');
      return { text: i.text, brandId: null };
  }
}

type TrRow = { id: string; source_type: TranslationSourceType; source_id: string | null; source_lang: string | null; detected: boolean; target_lang: string; translated_text: string; glossary_id: string | null; characters: number; cost_estimate_micros: string; is_simulated: boolean; created_at: Date };
const trJson = (r: TrRow, original: string): TranslationJson => ({
  id: r.id, source_type: r.source_type, source_id: r.source_id, source_lang: r.source_lang, detected: r.detected, target_lang: r.target_lang, original_text: original, translated_text: r.translated_text,
  machine_translated: true, glossary_id: r.glossary_id, characters: r.characters, cost_estimate_usd: Number(r.cost_estimate_micros) / 1e6, is_simulated: r.is_simulated, created_at: r.created_at.toISOString(),
});

export async function translate(ctx: Ctx, input: z.infer<typeof translateSchema>): Promise<TranslationJson> {
  const s = await settingsRow(ctx.access.workspaceId);
  if (!s.enabled) throw new AppError('invalid_state', 'Translation is off for this workspace. An admin can turn it on in Integrations.', undefined, { reason: 'translation_disabled' });
  if (CUSTOMER_CONTENT.includes(input.source_type) && !s.allow_customer_content) {
    throw new AppError('forbidden', 'This workspace does not send customer messages to the translation provider.', undefined, { reason: 'customer_content_not_allowed' });
  }
  const src = await resolveSource(ctx, input);
  const sha = createHash('sha256').update(`${input.source_lang ?? ''}|${src.text}`).digest('hex');
  const cached = await maybeOne<TrRow>(getPool(),
    `SELECT * FROM translations WHERE workspace_id=$1 AND source_type=$2 AND source_id IS NOT DISTINCT FROM $3 AND target_lang=$4 AND source_sha256=$5 AND glossary_id IS NOT DISTINCT FROM $6 ORDER BY created_at DESC LIMIT 1`,
    [ctx.access.workspaceId, input.source_type, input.source_id ?? null, input.target_lang, sha, s.glossary_id]);
  if (cached) return trJson(cached, src.text);
  const inst = await activeInstallation(ctx.access.workspaceId);
  if (!inst) throw new AppError('invalid_state', 'Connect Cloud Translation first.');
  const used = await one<{ chars: string }>(getPool(), `SELECT coalesce(sum(characters),0)::text chars FROM translations WHERE workspace_id=$1 AND created_at >= date_trunc('month', now())`, [ctx.access.workspaceId]);
  if (Number(used.chars) + src.text.length > s.monthly_char_cap) throw new AppError('budget_exhausted', 'The monthly translation limit for this workspace is reached.', undefined, { reason: 'monthly_cap' });
  const c = await openConn(inst.id);
  const brandTerms = src.brandId ? [(await maybeOne<{ name: string }>(getPool(), `SELECT name FROM brands WHERE id=$1`, [src.brandId]))?.name ?? ''] : [];
  let res;
  try {
    res = await translateText(call(c), { text: src.text, target: input.target_lang, source: input.source_lang ?? null, glossary: s.glossary_id, protectTerms: brandTerms });
  } catch (err) {
    await recordActivity(getPool(), { workspaceId: ctx.access.workspaceId, integrationId: inst.id, kind: 'sync', outcome: 'error', code: 'translate_failed', message: (err as Error).name });
    throw await appErrorFrom(err, c);
  }
  const micros = Math.ceil((res.characters / 1e6) * (await pricePerMillion()) * 1e6);
  const row = await one<TrRow>(getPool(),
    `INSERT INTO translations(workspace_id, brand_id, integration_id, source_type, source_id, source_sha256, source_lang, detected, target_lang, translated_text, glossary_id, characters, cost_estimate_micros, is_simulated, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [ctx.access.workspaceId, src.brandId, inst.id, input.source_type, input.source_id ?? null, sha, res.detectedSourceLang ?? input.source_lang ?? null, !input.source_lang, input.target_lang, res.text,
      res.glossaryApplied ? s.glossary_id : null, res.characters, micros, c.simulated, ctx.actor.userId]);
  await recordActivity(getPool(), { workspaceId: ctx.access.workspaceId, integrationId: inst.id, kind: 'sync', outcome: 'ok', code: 'translated', message: `${res.characters} characters` });
  await getPool().query(`UPDATE integration_connections SET last_success_at=now() WHERE id=$1`, [inst.id]);
  return trJson(row, src.text);
}

export async function supportedTargetLanguages(ctx: Ctx): Promise<{ items: Array<{ code: string; name: string }> }> {
  requireAction(ctx, 'integrations.read');
  const inst = await activeInstallation(ctx.access.workspaceId);
  if (!inst) return { items: [] };
  const c = await openConn(inst.id);
  try { return { items: (await supportedLanguages(call(c))).map((l) => ({ code: l.languageCode, name: l.displayName ?? l.languageCode })) }; } catch (err) { throw await appErrorFrom(err, c); }
}

export { operatorConfig };
