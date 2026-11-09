// Protected setup page model (owner only). Shows grouped readiness of server configuration and
// lets the owner enter provider/AI/TipSignal keys (stored in app_settings; secrets encrypted).
// Secrets are WRITE-ONLY: responses carry is_set/source, never values. Env values take precedence
// and are read-only (source 'env').
import { BRAND } from '@social-lite/core';
import { AppError, notFound } from '@social-lite/core';
import { getPool, maybeOne, withTx, type Queryable } from '@social-lite/db';
import { audit } from './audit.js';
import { config } from './config.js';
import { aiModelSetupState } from './ai/models.js';
import type { Ctx } from './context.js';
import { envSetting, isSettingKey, setSetting, SETTING_DEFS, settingSource, type SettingKey } from './settings.js';
import { authorizeCtx, requireAction } from './tenancy.js';

export interface SetupItem {
  key: string; label: string; secret: boolean; is_set: boolean; source: 'env' | 'setup' | null; hint: string;
  value?: string; docs_url?: string;
  /** true when the value can be entered on the setup page (not env-provided, not env-only). */
  editable: boolean;
  /** Safety problem with the current value (e.g. development default in production). */
  warning?: string;
}

export interface SetupGroup { id: string; title: string; required: boolean; ready: boolean; items: SetupItem[] }

interface EnvItemDef { key: string; label: string; secret: boolean; hint: string; required?: boolean; defaultValue?: string; warn?: (v: string | undefined) => string | undefined }

const prod = () => config().APP_ENV === 'production';

const ENV_GROUPS: Array<{ id: string; title: string; items: EnvItemDef[] }> = [
  { id: 'core', title: 'Core', items: [
    { key: 'APP_BASE_URL', label: 'Public base URL', secret: false, required: true, defaultValue: 'http://localhost:3000',
      hint: 'The https:// address users reach the app at. Used for cookies, OAuth callbacks and email links.',
      warn: (v) => (!(v ?? 'http://localhost:3000').startsWith('https://') ? (prod() ? 'Must use https in production' : 'Uses http (development only)') : undefined) },
    { key: 'SESSION_SECRET', label: 'Session secret', secret: true, required: true, hint: '32+ random bytes (base64). Set in the server environment.' },
    { key: 'KEY_ENCRYPTION_KEYS', label: 'Key-encryption keys', secret: true, required: true,
      hint: '"<kid>:<base64 32-byte key>" (comma-separated for rotation; first is active). Keep outside the database.',
      warn: (v) => (v?.includes('local-dev') ? 'Contains the local development key — replace before production' : undefined) },
  ] },
  { id: 'identity', title: 'Sign-in (OIDC)', items: [
    { key: 'OIDC_ISSUER', label: 'Issuer URL', secret: false, required: true, hint: 'Your OpenID Connect provider issuer URL.',
      warn: (v) => (v && /localhost|127\.0\.0\.1|\/dex$/.test(v) ? 'Points at the local development identity provider' : undefined) },
    { key: 'OIDC_CLIENT_ID', label: 'Client ID', secret: false, required: true, hint: 'Client registered with redirect URI <APP_BASE_URL>/api/auth/callback.' },
    { key: 'OIDC_CLIENT_SECRET', label: 'Client secret', secret: true, required: true, hint: 'Confidential client secret.' },
  ] },
  { id: 'storage', title: 'Media storage', items: [
    { key: 'S3_ENDPOINT', label: 'S3 endpoint', secret: false, required: true, hint: 'S3-compatible endpoint used by the server.' },
    { key: 'S3_PUBLIC_ENDPOINT', label: 'Public S3 endpoint', secret: false, hint: 'Optional host used in signed URLs given to browsers and providers.' },
    { key: 'S3_BUCKET', label: 'Bucket', secret: false, required: true, defaultValue: 'social-lite-media', hint: 'Private bucket (public access blocked).' },
    { key: 'S3_REGION', label: 'Region', secret: false, defaultValue: 'us-east-1', hint: 'Bucket region.' },
    { key: 'S3_ACCESS_KEY_ID', label: 'Access key ID', secret: true, required: true, hint: 'Least-privilege key for this bucket only.' },
    { key: 'S3_SECRET_ACCESS_KEY', label: 'Secret access key', secret: true, required: true, hint: 'Stored only in the server environment.',
      warn: (v) => (v?.includes('not-for-production') ? 'Local development credentials' : undefined) },
  ] },
  { id: 'email', title: 'Email', items: [
    { key: 'SMTP_URL', label: 'SMTP URL', secret: true, required: true, hint: 'smtp(s)://user:pass@host:port — invitations and critical alerts.',
      warn: (v) => (v && /localhost:1025|127\.0\.0\.1:1025/.test(v) ? 'Points at local email capture (Mailpit)' : undefined) },
    { key: 'EMAIL_FROM', label: 'From address', secret: false, defaultValue: BRAND.defaultEmailFrom, hint: 'Sender shown on outgoing email.' },
  ] },
];

const PROVIDER_GROUPS: Array<{ id: string; title: string; group: string }> = [
  { id: 'meta', title: 'Meta (Facebook & Instagram)', group: 'meta' },
  { id: 'telegram', title: 'Telegram', group: 'telegram' },
  { id: 'x', title: 'X', group: 'x' },
  // V3 social providers (Bluesky connects per account with an app password — no server setting).
  { id: 'tiktok', title: 'TikTok', group: 'tiktok' },
  { id: 'youtube', title: 'YouTube (Google)', group: 'youtube' },
  { id: 'linkedin', title: 'LinkedIn', group: 'linkedin' },
  { id: 'threads', title: 'Threads', group: 'threads' },
  { id: 'pinterest', title: 'Pinterest', group: 'pinterest' },
  // V3 Content Hub sources (not social destinations).
  { id: 'google_content', title: 'Google Drive & Docs', group: 'google_content' },
  { id: 'notion', title: 'Notion', group: 'notion' },
  { id: 'ai', title: 'AI assistance', group: 'ai' },
  { id: 'tipsignal', title: 'TipSignal', group: 'tipsignal' },
  // V3.5 business integrations (stream C).
  { id: 'asana', title: 'Asana', group: 'asana' },
  { id: 'monday', title: 'monday.com', group: 'monday' },
  { id: 'hubspot', title: 'HubSpot', group: 'hubspot' },
  { id: 'gbp', title: 'Google Business Profile', group: 'gbp' },
  { id: 'translate', title: 'Google Cloud Translation', group: 'translate' },
  { id: 'slack', title: 'Slack', group: 'slack' },
  { id: 'mailchimp', title: 'Mailchimp', group: 'mailchimp' },
];

const envValue = (key: string): string | undefined => {
  const v = process.env[key];
  return v !== undefined && v.trim() !== '' ? v : undefined;
};

function envItem(d: EnvItemDef): SetupItem {
  const v = envValue(d.key);
  const effective = v ?? d.defaultValue;
  const item: SetupItem = { key: d.key, label: d.label, secret: d.secret, is_set: effective !== undefined, source: v !== undefined ? 'env' : null, hint: d.hint, editable: false };
  if (!d.secret && effective !== undefined) item.value = effective;
  if (v === undefined && d.defaultValue !== undefined) item.hint = `${d.hint} (default in use)`;
  const w = d.warn?.(v);
  if (w) item.warning = w;
  return item;
}

async function settingItem(key: SettingKey, db: Queryable): Promise<SetupItem> {
  const def = SETTING_DEFS[key];
  const source = await settingSource(key, db);
  const item: SetupItem = { key, label: def.label, secret: def.secret, is_set: source !== null, source, hint: def.hint, editable: source !== 'env', docs_url: def.docsUrl };
  if (!def.secret) {
    if (source === 'env') item.value = envSetting(key);
    else if (source === 'setup') item.value = (await maybeOne<{ value_plain: string | null }>(db, `SELECT value_plain FROM app_settings WHERE key=$1`, [key]))?.value_plain ?? undefined;
  }
  if (key === 'META_APP_ID' || key === 'X_CLIENT_ID') {
    const provider = key === 'META_APP_ID' ? 'facebook' : 'x';
    item.hint = `${def.hint} OAuth redirect URI: ${config().APP_BASE_URL.replace(/\/$/, '')}/api/oauth/${provider}/callback`;
  }
  if (key === 'META_GRAPH_VERSION' && source === null) { item.value = 'v26.0'; item.is_set = true; item.hint = `${def.hint} (default in use)`; }
  return item;
}

/** Non-throwing: may this person see instance setup details (setup values, redirect/webhook URLs)? Instance owner
 *  (setup.manage in the primary workspace in production; any setup.manage holder in development) or a platform operator. */
export async function canSeeInstanceSetup(ctx: Ctx, db: Queryable = getPool()): Promise<boolean> {
  if (authorizeCtx(ctx, 'setup.manage').allowed) {
    if (!prod()) return true;
    const first = await maybeOne<{ id: string }>(db, `SELECT id FROM workspaces WHERE NOT is_demo ORDER BY created_at, id LIMIT 1`);
    if (first?.id === ctx.access.workspaceId) return true;
  }
  const op = await maybeOne(db, `SELECT 1 FROM platform_operators o JOIN users u ON u.id=o.user_id WHERE o.user_id=$1 AND o.role='operator' AND o.revoked_at IS NULL AND u.disabled_at IS NULL`, [ctx.actor.userId]);
  return !!op;
}

/** In production only the owner of the first (bootstrap) workspace manages instance-wide settings. */
async function assertInstanceOwner(ctx: Ctx, db: Queryable): Promise<void> {
  requireAction(ctx, 'setup.manage');
  if (!prod()) return;
  const first = await maybeOne<{ id: string }>(db, `SELECT id FROM workspaces WHERE NOT is_demo ORDER BY created_at, id LIMIT 1`);
  if (first?.id !== ctx.access.workspaceId) {
    throw new AppError('forbidden', 'Server settings can only be changed by the owner of the primary workspace.');
  }
}

export async function getSetup(ctx: Ctx, db: Queryable = getPool()): Promise<{ groups: SetupGroup[] }> {
  await assertInstanceOwner(ctx, db);
  const groups: SetupGroup[] = ENV_GROUPS.map((g) => {
    const items = g.items.map(envItem);
    const ready = g.items.every((d, i) => !d.required || items[i]!.is_set) && !(prod() && items.some((i) => i.warning));
    return { id: g.id, title: g.title, required: true, ready, items };
  });
  for (const g of PROVIDER_GROUPS) {
    const keys = (Object.keys(SETTING_DEFS) as SettingKey[]).filter((k) => SETTING_DEFS[k].group === g.group);
    const items = await Promise.all(keys.map((k) => settingItem(k, db)));
    let ready = items.every((i, n) => i.is_set || SETTING_DEFS[keys[n]!].optional === true);
    if (g.group === 'ai') {
      const extra = aiModelItems();
      items.push(...extra);
      ready = ready && extra[0]!.is_set;
    }
    groups.push({ id: g.id, title: g.title, required: false, ready, items });
  }
  return { groups };
}

const AI_ENV_KEYS: readonly string[] = ['AI_MODEL', 'AI_MODEL_PRICES', 'AI_FALLBACK_MODELS'];

/** D32: AI model settings are environment-only; the page shows set / not set, never the values. */
function aiModelItems(): SetupItem[] {
  const a = aiModelSetupState();
  const env = (on: boolean) => (on ? 'env' as const : null);
  const model: SetupItem = { key: 'AI_MODEL', label: 'Model', secret: false, is_set: a.model, source: env(a.model), editable: false,
    hint: 'Model id from your AI provider. Required with the provider key; without it AI stays off.' };
  const prices: SetupItem = { key: 'AI_MODEL_PRICES', label: 'Model prices', secret: false, is_set: a.priced_models > 0, source: env(a.priced_models > 0), editable: false,
    hint: 'Optional JSON: {"<model id>": [input, output]} in USD per million tokens. Without a price, cost estimates show as unknown.' };
  if (a.model && !a.price) prices.warning = 'No price for the configured model: cost estimates show as unknown. Token budgets still apply.';
  const fallbacks: SetupItem = { key: 'AI_FALLBACK_MODELS', label: 'Fallback-enabled models', secret: false, is_set: a.fallback_models > 0, source: env(a.fallback_models > 0), editable: false,
    hint: 'Optional comma-separated model ids for which Relay asks the provider for its server-side refusal fallback.' };
  return [model, prices, fallbacks];
}

export async function putSetup(ctx: Ctx, key: string, value: string): Promise<SetupItem> {
  if (!isSettingKey(key)) {
    requireAction(ctx, 'setup.manage');
    if (ENV_GROUPS.some((g) => g.items.some((i) => i.key === key)) || AI_ENV_KEYS.includes(key)) {
      throw new AppError('invalid_state', 'This setting can only be changed in the server environment.');
    }
    throw notFound('Setting');
  }
  if (typeof value !== 'string') throw new AppError('validation_failed', 'Value must be text', { value: 'Value must be text' });
  return withTx(async (tx) => {
    await assertInstanceOwner(ctx, tx);
    await setSetting(key, value, ctx.actor.userId, tx);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: value.trim() ? 'setup.updated' : 'setup.cleared',
      resourceType: 'app_setting', resourceId: key, diff: { key, secret: SETTING_DEFS[key].secret }, correlationId: ctx.correlationId });
    return settingItem(key, tx);
  });
}
