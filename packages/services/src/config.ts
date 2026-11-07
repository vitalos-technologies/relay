// Central configuration. Production fails closed on unsafe or missing settings.
import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

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
  EMAIL_FROM: z.string().default('Social Lite <no-reply@social-lite.invalid>'),
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
  AI_MODEL: z.string().default('claude-opus-5-5'),
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
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
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
