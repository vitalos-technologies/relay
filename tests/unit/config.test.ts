// Production must fail closed on development auth, mock transport and local defaults.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '@social-lite/services';

const good = {
  APP_ENV: 'production', APP_BASE_URL: 'https://social.example.com', DATABASE_URL: 'postgres://x', SESSION_SECRET: 'x'.repeat(40),
  KEY_ENCRYPTION_KEYS: `prod-1:${Buffer.alloc(32, 1).toString('base64')}`, OIDC_ISSUER: 'https://id.example.com', OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's',
  S3_ENDPOINT: 'https://s3.example.com', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 'b', SMTP_URL: 'smtps://u:p@smtp.example.com:465',
} as NodeJS.ProcessEnv;

describe('production configuration', () => {
  it('accepts a complete production configuration', () => {
    expect(() => loadConfig(good)).not.toThrow();
  });
  it.each([
    ['mock providers', { ENABLE_MOCK_PROVIDERS: 'true' }, /ENABLE_MOCK_PROVIDERS/],
    ['insecure OIDC', { OIDC_ALLOW_INSECURE_HTTP: 'true' }, /OIDC_ALLOW_INSECURE_HTTP/],
    ['local Dex issuer', { OIDC_ISSUER: 'http://localhost:5556/dex' }, /development identity provider/],
    ['http base URL', { APP_BASE_URL: 'http://social.example.com' }, /https/],
    ['local S3 secret', { S3_SECRET_ACCESS_KEY: 'socialite-local-secret-not-for-production' }, /local development defaults/],
    ['local SMTP capture', { SMTP_URL: 'smtp://localhost:1025' }, /local email capture/],
    ['dev KEK', { KEY_ENCRYPTION_KEYS: `local-dev-1:${Buffer.alloc(32, 1).toString('base64')}` }, /local development key/],
    ['missing secrets', { SESSION_SECRET: undefined }, /SESSION_SECRET/],
  ])('refuses %s', (_n, patch, msg) => {
    expect(() => loadConfig({ ...good, ...patch } as NodeJS.ProcessEnv)).toThrow(msg);
  });
});
