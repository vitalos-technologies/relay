// Provider / integration settings that may be supplied either through environment
// variables (take precedence, read-only in the UI) or through the protected setup page
// (stored in app_settings; secret values envelope-encrypted with settingAad(key)).
// Secret values are only ever decrypted server-side; they are never returned to clients.
import { AppError } from '@social-lite/core';
import { getPool, maybeOne, type Queryable } from '@social-lite/db';
import { encryptSecret, decryptSecret, settingAad, type EncryptedBlob } from './crypto.js';

export const SETTING_KEYS = [
  'META_APP_ID', 'META_APP_SECRET', 'META_GRAPH_VERSION',
  'X_CLIENT_ID', 'X_CLIENT_SECRET',
  'TELEGRAM_WEBHOOK_SECRET', 'TIPSIGNAL_SIGNING_SECRET', 'ANTHROPIC_API_KEY',
  // V3 social providers (docs/providers/<provider>.md). Bluesky needs none (app password per connection).
  'TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_DIRECT_POST_AUDITED',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
  'LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET', 'LINKEDIN_API_VERSION', 'LINKEDIN_ORGANIZATIONS',
  'THREADS_APP_ID', 'THREADS_APP_SECRET',
  'PINTEREST_APP_ID', 'PINTEREST_APP_SECRET', 'PINTEREST_ACCESS_TIER',
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export interface SettingDef {
  key: SettingKey;
  label: string;
  secret: boolean;
  group: 'meta' | 'x' | 'telegram' | 'ai' | 'tipsignal' | 'tiktok' | 'youtube' | 'linkedin' | 'threads' | 'pinterest';
  hint: string;
  /** Validates a value entered on the setup page. Returns an error message or null. */
  validate?: (v: string) => string | null;
  docsUrl?: string;
}

const noWhitespace = (v: string) => (/\s/.test(v) ? 'Must not contain spaces' : null);
const bool = (v: string) => (/^(true|false)$/.test(v) ? null : 'Use true or false');
const cb = (p: string) => `Redirect URI: <APP_BASE_URL>/api/oauth/${p}/callback.`;

export const SETTING_DEFS: Record<SettingKey, SettingDef> = {
  META_APP_ID: { key: 'META_APP_ID', label: 'Meta app ID', secret: false, group: 'meta', hint: 'Numeric App ID from developers.facebook.com → your app → Settings → Basic.',
    validate: (v) => (/^\d{5,25}$/.test(v) ? null : 'Meta app IDs are numeric'), docsUrl: 'https://developers.facebook.com/apps/' },
  META_APP_SECRET: { key: 'META_APP_SECRET', label: 'Meta app secret', secret: true, group: 'meta', hint: 'App Secret from the same page. Stored encrypted; never shown again.',
    validate: (v) => (/^[A-Za-z0-9]{16,128}$/.test(v) ? null : 'Meta app secrets are 16-128 alphanumeric characters') },
  META_GRAPH_VERSION: { key: 'META_GRAPH_VERSION', label: 'Graph API version', secret: false, group: 'meta', hint: 'Pinned Graph API version, e.g. v26.0.',
    validate: (v) => (/^v\d{1,3}\.\d$/.test(v) ? null : 'Use the form v26.0') },
  X_CLIENT_ID: { key: 'X_CLIENT_ID', label: 'X OAuth 2.0 client ID', secret: false, group: 'x', hint: 'From the X developer portal → your app → Keys and tokens → OAuth 2.0 Client ID.',
    validate: noWhitespace, docsUrl: 'https://developer.x.com/en/portal/dashboard' },
  X_CLIENT_SECRET: { key: 'X_CLIENT_SECRET', label: 'X OAuth 2.0 client secret', secret: true, group: 'x', hint: 'Confidential client secret. Stored encrypted; never shown again.', validate: noWhitespace },
  TELEGRAM_WEBHOOK_SECRET: { key: 'TELEGRAM_WEBHOOK_SECRET', label: 'Telegram webhook secret', secret: true, group: 'telegram',
    hint: 'Random secret (1-256 chars of A-Z a-z 0-9 _ -) sent by Telegram in X-Telegram-Bot-Api-Secret-Token.',
    validate: (v) => (/^[A-Za-z0-9_-]{16,256}$/.test(v) ? null : 'Use 16-256 characters of A-Z, a-z, 0-9, _ and -') },
  TIPSIGNAL_SIGNING_SECRET: { key: 'TIPSIGNAL_SIGNING_SECRET', label: 'TipSignal signing secret', secret: true, group: 'tipsignal',
    hint: 'Shared HMAC secret used to verify TipSignal event signatures.', validate: (v) => (v.length >= 16 ? null : 'Use at least 16 characters') },
  ANTHROPIC_API_KEY: { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', secret: true, group: 'ai',
    hint: 'Enables AI-assisted drafting. Stored encrypted; never shown again.', validate: (v) => (/^sk-ant-[A-Za-z0-9_-]{10,}$/.test(v) ? null : 'Anthropic API keys start with sk-ant-'),
    docsUrl: 'https://console.anthropic.com/settings/keys' },
  // ---- V3 social providers
  TIKTOK_CLIENT_KEY: { key: 'TIKTOK_CLIENT_KEY', label: 'TikTok client key', secret: false, group: 'tiktok', hint: `TikTok for Developers → your app → Credentials (Login Kit + Content Posting API). ${cb('tiktok')}`, validate: noWhitespace, docsUrl: 'https://developers.tiktok.com/apps/' },
  TIKTOK_CLIENT_SECRET: { key: 'TIKTOK_CLIENT_SECRET', label: 'TikTok client secret', secret: true, group: 'tiktok', hint: 'Stored encrypted; never shown again.', validate: noWhitespace },
  TIKTOK_DIRECT_POST_AUDITED: { key: 'TIKTOK_DIRECT_POST_AUDITED', label: 'TikTok Direct Post audit passed', secret: false, group: 'tiktok', hint: 'Set to true only after TikTok approved the Direct Post audit. Unaudited clients can only post SELF_ONLY to private accounts.', validate: bool },
  GOOGLE_CLIENT_ID: { key: 'GOOGLE_CLIENT_ID', label: 'Google OAuth client ID (YouTube)', secret: false, group: 'youtube', hint: `Google Cloud → APIs & Services → Credentials → OAuth client (Web application) with YouTube Data API v3 and YouTube Analytics API enabled. ${cb('youtube')}`,
    validate: (v) => (/^[\w-]+\.apps\.googleusercontent\.com$/.test(v) ? null : 'Google client IDs end with .apps.googleusercontent.com'), docsUrl: 'https://console.cloud.google.com/apis/credentials' },
  GOOGLE_CLIENT_SECRET: { key: 'GOOGLE_CLIENT_SECRET', label: 'Google OAuth client secret', secret: true, group: 'youtube', hint: 'Stored encrypted; never shown again.', validate: noWhitespace },
  LINKEDIN_CLIENT_ID: { key: 'LINKEDIN_CLIENT_ID', label: 'LinkedIn client ID', secret: false, group: 'linkedin', hint: `LinkedIn Developer Portal → your app → Auth (products: Share on LinkedIn, Sign In with LinkedIn using OpenID Connect). ${cb('linkedin')}`, validate: noWhitespace, docsUrl: 'https://www.linkedin.com/developers/apps' },
  LINKEDIN_CLIENT_SECRET: { key: 'LINKEDIN_CLIENT_SECRET', label: 'LinkedIn client secret', secret: true, group: 'linkedin', hint: 'Stored encrypted; never shown again.', validate: noWhitespace },
  LINKEDIN_API_VERSION: { key: 'LINKEDIN_API_VERSION', label: 'LinkedIn API version', secret: false, group: 'linkedin', hint: 'LinkedIn-Version header (YYYYMM). Default 202610.', validate: (v) => (/^\d{6}$/.test(v) ? null : 'Use the form 202610') },
  LINKEDIN_ORGANIZATIONS: { key: 'LINKEDIN_ORGANIZATIONS', label: 'LinkedIn organization posting', secret: false, group: 'linkedin', hint: 'Set to true only when the app is approved for the Community Management API (organization scopes).', validate: bool },
  THREADS_APP_ID: { key: 'THREADS_APP_ID', label: 'Threads app ID', secret: false, group: 'threads', hint: `Meta App Dashboard → Threads use case → Threads app ID (not the Facebook app ID). ${cb('threads')}`, validate: (v) => (/^\d{5,25}$/.test(v) ? null : 'Threads app IDs are numeric'), docsUrl: 'https://developers.facebook.com/apps/' },
  THREADS_APP_SECRET: { key: 'THREADS_APP_SECRET', label: 'Threads app secret', secret: true, group: 'threads', hint: 'Threads app secret. Stored encrypted; never shown again.', validate: noWhitespace },
  PINTEREST_APP_ID: { key: 'PINTEREST_APP_ID', label: 'Pinterest app ID', secret: false, group: 'pinterest', hint: `developers.pinterest.com → My apps. ${cb('pinterest')}`, validate: (v) => (/^\d{3,25}$/.test(v) ? null : 'Pinterest app IDs are numeric'), docsUrl: 'https://developers.pinterest.com/apps/' },
  PINTEREST_APP_SECRET: { key: 'PINTEREST_APP_SECRET', label: 'Pinterest app secret key', secret: true, group: 'pinterest', hint: 'Stored encrypted; never shown again.', validate: noWhitespace },
  PINTEREST_ACCESS_TIER: { key: 'PINTEREST_ACCESS_TIER', label: 'Pinterest access tier', secret: false, group: 'pinterest', hint: 'trial (default: Pins visible only to you) or standard (after Pinterest approved the upgrade).', validate: (v) => (/^(trial|standard)$/.test(v) ? null : 'Use trial or standard') },
};

export function isSettingKey(k: string): k is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(k);
}

/** Non-empty environment value, if any. Empty strings (e.g. `META_APP_ID=` in .env) count as unset. */
export function envSetting(key: SettingKey, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env[key];
  return v !== undefined && v.trim() !== '' ? v.trim() : undefined;
}

interface SettingRow { value_plain: string | null; value_secret: EncryptedBlob | null }

/**
 * Resolve a setting: environment first, then app_settings (decrypting secrets server-side).
 * Returns undefined when not configured anywhere.
 */
export async function getSetting(key: SettingKey, db: Queryable = getPool()): Promise<string | undefined> {
  const env = envSetting(key);
  if (env !== undefined) return env;
  const row = await maybeOne<SettingRow>(db, `SELECT value_plain, value_secret FROM app_settings WHERE key = $1`, [key]);
  if (row?.value_secret) return decryptSecret<string>(row.value_secret, settingAad(key));
  if (row?.value_plain) return row.value_plain;
  return SETTING_DEFAULTS[key];
}

/** Built-in defaults used when neither env nor setup provides a value. */
const SETTING_DEFAULTS: Partial<Record<SettingKey, string>> = { META_GRAPH_VERSION: 'v26.0' };

/** Where a setting currently comes from (no values). */
export async function settingSource(key: SettingKey, db: Queryable = getPool()): Promise<'env' | 'setup' | null> {
  if (envSetting(key) !== undefined) return 'env';
  const row = await maybeOne<{ is_set: boolean }>(db,
    `SELECT (value_plain IS NOT NULL OR value_secret IS NOT NULL) AS is_set FROM app_settings WHERE key = $1`, [key]);
  return row?.is_set ? 'setup' : null;
}

/**
 * Store a setting entered on the setup page. Env-provided settings are read-only.
 * Passing an empty value clears the stored setting. Authorization is the caller's job
 * (setup.ts requires the `setup.manage` permission).
 */
export async function setSetting(key: SettingKey, value: string, userId: string | null, db: Queryable = getPool()): Promise<void> {
  const def = SETTING_DEFS[key];
  if (envSetting(key) !== undefined) {
    throw new AppError('conflict', `${def.label} is set by the server environment and cannot be changed here.`);
  }
  const v = value.trim();
  if (v === '') {
    await db.query(`DELETE FROM app_settings WHERE key = $1`, [key]);
    return;
  }
  if (v.length > 4096) throw new AppError('validation_failed', 'Value is too long', { value: 'Value is too long' });
  const problem = def.validate?.(v);
  if (problem) throw new AppError('validation_failed', `${def.label}: ${problem}`, { value: problem });
  const plain = def.secret ? null : v;
  const secret = def.secret ? JSON.stringify(encryptSecret(v, settingAad(key))) : null;
  await db.query(
    `INSERT INTO app_settings(key, value_plain, value_secret, updated_at, updated_by) VALUES ($1,$2,$3,now(),$4)
     ON CONFLICT (key) DO UPDATE SET value_plain = EXCLUDED.value_plain, value_secret = EXCLUDED.value_secret,
       updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, plain, secret, userId]);
}
