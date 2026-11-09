// Central configuration. Production fails closed on unsafe or missing settings.
import { BRAND } from '@social-lite/core';
import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

// AI model settings (D32): model ids and prices are deployment settings, never values in code. Messages never echo values.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : typeof v === 'string' ? v.trim() : v);
const MODEL_ID_HINT = 'must be a single model id (letters, digits, . _ : @ / -; no spaces)';
function parseModelList(v: string | undefined, ctx: z.RefinementCtx): string[] {
  const ids = (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (ids.some((id) => !MODEL_ID.test(id))) ctx.addIssue({ code: 'custom', message: 'must be a comma-separated list of model ids (no spaces inside an id)' });
  return [...new Set(ids)];
}
/** USD per million tokens [input, output] by model id. */
export type AiModelPrices = Record<string, [number, number]>;
function parseModelPrices(v: string | undefined, ctx: z.RefinementCtx): AiModelPrices {
  if (v === undefined) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(v); } catch {
    ctx.addIssue({ code: 'custom', message: 'must be JSON like {"<model id>": [input USD per million tokens, output USD per million tokens]}' });
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    ctx.addIssue({ code: 'custom', message: 'must be a JSON object keyed by model id' });
    return {};
  }
  const out: AiModelPrices = {};
  for (const [id, price] of Object.entries(parsed as Record<string, unknown>)) {
    const ok = MODEL_ID.test(id) && Array.isArray(price) && price.length === 2 && price.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
    if (!ok) { ctx.addIssue({ code: 'custom', message: 'each entry must be "<model id>": [input, output] with two non-negative numbers (USD per million tokens)' }); return {}; }
    out[id] = [price[0] as number, price[1] as number];
  }
  return out;
}

const schema = z.object({
  APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32).optional(),
  // Envelope encryption: "kid1:base64key,kid2:base64key"; first entry is the active key.
  KEY_ENCRYPTION_KEYS: z.string().min(1).optional(),
  // Production alternative: KEKs held as Cloud KMS ciphertext and unwrapped at boot (services/kms.ts).
  KMS_KEY_NAME: z.string().optional(),
  KMS_WRAPPED_KEKS: z.string().optional(),
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_ALLOW_INSECURE_HTTP: bool.default(false),
  S3_ENDPOINT: z.string().url().optional(),
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('social-lite-media'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default(true),
  SMTP_URL: z.string().optional(),
  EMAIL_FROM: z.string().default(BRAND.defaultEmailFrom),
  // Mock provider transport is a development/demo feature. Forbidden in production.
  ENABLE_MOCK_PROVIDERS: bool.default(false),
  // Provider app configuration (may also be set via the protected setup page).
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_GRAPH_VERSION: z.string().default('v26.0'),
  X_CLIENT_ID: z.string().optional(),
  X_CLIENT_SECRET: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  TIPSIGNAL_SIGNING_SECRET: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  // No default: AI is enabled only when the provider key AND AI_MODEL are set (otherwise "AI is not set up").
  AI_MODEL: z.preprocess(blankToUndefined, z.string().regex(MODEL_ID, MODEL_ID_HINT).optional()),
  // Optional: model ids for which Relay asks the provider for its server-side refusal fallback.
  AI_FALLBACK_MODELS: z.preprocess(blankToUndefined, z.string().optional()).transform(parseModelList),
  // Optional: JSON price table; without a price for a model its cost estimate is shown as unknown (never guessed).
  AI_MODEL_PRICES: z.preprocess(blankToUndefined, z.string().optional()).transform(parseModelPrices),
  // Deterministic, clearly labelled AI suggestions for demos/tests. Forbidden in production.
  AI_FIXTURE: bool.default(false),
  WORKER_ID: z.string().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type AppConfig = z.infer<typeof schema>;

let cached: AppConfig | undefined;

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Field names plus Relay-written reasons only; values are never echoed (they may be secrets).
    const fields = parsed.error.issues.map((i) => (i.code === 'custom' || i.code === 'invalid_format' ? `${i.path.join('.')} ${i.message}` : i.path.join('.'))).join(', ');
    throw new ConfigError(`Invalid configuration: ${fields}`);
  }
  const c = parsed.data;
  if (c.APP_ENV === 'production') assertProductionSafe(c);
  return c;
}

/** Live mode must fail closed if mock transport or development auth is configured. */
export function assertProductionSafe(c: AppConfig): void {
  const problems: string[] = [];
  if (c.ENABLE_MOCK_PROVIDERS) problems.push('ENABLE_MOCK_PROVIDERS must be false in production');
  if (c.AI_FIXTURE) problems.push('AI_FIXTURE must be false in production');
  if (c.OIDC_ALLOW_INSECURE_HTTP) problems.push('OIDC_ALLOW_INSECURE_HTTP must be false in production');
  if (!c.APP_BASE_URL.startsWith('https://')) problems.push('APP_BASE_URL must use https in production');
  if (!c.SESSION_SECRET) problems.push('SESSION_SECRET is required');
  if (!c.KEY_ENCRYPTION_KEYS && !(c.KMS_KEY_NAME && c.KMS_WRAPPED_KEKS)) problems.push('KEY_ENCRYPTION_KEYS or KMS_KEY_NAME + KMS_WRAPPED_KEKS is required');
  if (!c.OIDC_ISSUER || !c.OIDC_CLIENT_ID || !c.OIDC_CLIENT_SECRET) problems.push('OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET are required');
  if (c.OIDC_ISSUER && /localhost|127\.0\.0\.1|\/dex$/.test(c.OIDC_ISSUER)) problems.push('OIDC_ISSUER points at the local development identity provider');
  if (!c.S3_ENDPOINT || !c.S3_ACCESS_KEY_ID || !c.S3_SECRET_ACCESS_KEY) problems.push('S3_ENDPOINT, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required');
  if (c.S3_SECRET_ACCESS_KEY?.includes('not-for-production')) problems.push('S3 credentials are the local development defaults');
  if (!c.SMTP_URL) problems.push('SMTP_URL is required');
  if (c.SMTP_URL && /localhost:1025|127\.0\.0\.1:1025/.test(c.SMTP_URL)) problems.push('SMTP_URL points at local email capture');
  if (c.KEY_ENCRYPTION_KEYS?.includes('local-dev')) problems.push('KEY_ENCRYPTION_KEYS contains the local development key');
  if (problems.length) throw new ConfigError(`Refusing to start in production: ${problems.join('; ')}`);
}

export function config(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Tests only. */
export function resetConfigCache(): void {
  cached = undefined;
}

export function mockProvidersEnabled(): boolean {
  const c = config();
  return c.APP_ENV !== 'production' && c.ENABLE_MOCK_PROVIDERS;
}
