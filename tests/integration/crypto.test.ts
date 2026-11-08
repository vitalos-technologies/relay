// Envelope encryption: round-trip, tamper detection, purpose (AAD) binding and KEK rotation,
// plus setup-page secrets stored encrypted in app_settings (real PostgreSQL).
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  EnvKeyProvider, credentialAad, decryptSecret, encryptSecret, resetConfigCache, setKeyProvider, settingAad, type EncryptedBlob,
} from '@social-lite/services';
import { getSetting, setSetting, settingSource } from '../../packages/services/src/settings.js';
import { closeTestPool, testPool } from './helpers.js';

const key = () => randomBytes(32).toString('base64');

const ENV_KEYS = ['X_CLIENT_SECRET', 'X_CLIENT_ID', 'TIPSIGNAL_SIGNING_SECRET', 'META_APP_ID'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  setKeyProvider(undefined);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetConfigCache();
});
afterAll(closeTestPool);

describe('envelope encryption', () => {
  const kp = new EnvKeyProvider(`k1:${key()}`);

  it('round-trips JSON values and never stores plaintext', () => {
    const value = { access_token: 'EAAB-secret-token', refresh: 'r-123', n: 42 };
    const blob = encryptSecret(value, credentialAad('ws-1'), kp);
    expect(JSON.stringify(blob)).not.toContain('EAAB-secret-token');
    expect(blob.kid).toBe('k1');
    expect(decryptSecret(blob, credentialAad('ws-1'), kp)).toEqual(value);
    // A fresh data key and IV per encryption.
    const again = encryptSecret(value, credentialAad('ws-1'), kp);
    expect(again.ct).not.toBe(blob.ct);
    expect(again.wk).not.toBe(blob.wk);
  });

  it('detects tampering with ciphertext, tag, IV or wrapped key', () => {
    const blob = encryptSecret('top secret', 'p', kp);
    const flip = (b64: string) => {
      const b = Buffer.from(b64, 'base64');
      b[b.length - 1] = b[b.length - 1]! ^ 1;
      return b.toString('base64');
    };
    for (const field of ['ct', 'tag', 'iv', 'wk'] as const) {
      const bad: EncryptedBlob = { ...blob, [field]: flip(blob[field]) };
      expect(() => decryptSecret(bad, 'p', kp), field).toThrow();
    }
  });

  it('binds blobs to their purpose (AAD): another tenant or purpose cannot decrypt', () => {
    const blob = encryptSecret('tok', credentialAad('workspace-A'), kp);
    expect(() => decryptSecret(blob, credentialAad('workspace-B'), kp)).toThrow(/purpose mismatch/);
    // Even if the stored label is stripped, the GCM AAD check still fails.
    const { aad: _aad, ...unlabelled } = blob;
    expect(() => decryptSecret(unlabelled as EncryptedBlob, credentialAad('workspace-B'), kp)).toThrow();
    expect(decryptSecret(unlabelled as EncryptedBlob, credentialAad('workspace-A'), kp)).toBe('tok');
  });

  it('supports KEK rotation: new blobs use the new active key, old blobs still decrypt', () => {
    const oldKey = key();
    const before = new EnvKeyProvider(`old:${oldKey}`);
    const oldBlob = encryptSecret('legacy', 'p', before);
    const rotated = new EnvKeyProvider(`new:${key()},old:${oldKey}`);
    expect(rotated.activeKid()).toBe('new');
    const newBlob = encryptSecret('fresh', 'p', rotated);
    expect(newBlob.kid).toBe('new');
    expect(decryptSecret(oldBlob, 'p', rotated)).toBe('legacy');
    expect(decryptSecret(newBlob, 'p', rotated)).toBe('fresh');
    // Removing the old key makes old blobs undecryptable (fail closed).
    const dropped = new EnvKeyProvider(`new:${key()}`);
    expect(() => decryptSecret(oldBlob, 'p', dropped)).toThrow(/unknown key id/);
  });

  it('rejects malformed key specs', () => {
    expect(() => new EnvKeyProvider('nokid')).toThrow();
    expect(() => new EnvKeyProvider(`short:${randomBytes(16).toString('base64')}`)).toThrow(/32 bytes/);
  });
});

describe('setup settings (app_settings)', () => {
  it('stores secrets encrypted, plain values plainly, and env takes precedence', async () => {
    const db = testPool();
    delete process.env.X_CLIENT_SECRET;
    delete process.env.X_CLIENT_ID;
    resetConfigCache();
    await setSetting('X_CLIENT_SECRET', 'x-secret-value-123', null, db);
    await setSetting('X_CLIENT_ID', 'client-id-abc', null, db);
    const rows = await db.query<{ key: string; value_plain: string | null; value_secret: EncryptedBlob | null }>(
      `SELECT key, value_plain, value_secret FROM app_settings WHERE key IN ('X_CLIENT_SECRET','X_CLIENT_ID') ORDER BY key`);
    const id = rows.rows.find((r) => r.key === 'X_CLIENT_ID')!;
    const secret = rows.rows.find((r) => r.key === 'X_CLIENT_SECRET')!;
    expect(id.value_plain).toBe('client-id-abc');
    expect(secret.value_plain).toBeNull();
    expect(JSON.stringify(secret.value_secret)).not.toContain('x-secret-value-123');
    expect(secret.value_secret!.aad).toBe(settingAad('X_CLIENT_SECRET'));
    expect(await getSetting('X_CLIENT_SECRET', db)).toBe('x-secret-value-123');
    expect(await settingSource('X_CLIENT_SECRET', db)).toBe('setup');

    process.env.X_CLIENT_SECRET = 'from-env';
    try {
      expect(await getSetting('X_CLIENT_SECRET', db)).toBe('from-env');
      expect(await settingSource('X_CLIENT_SECRET', db)).toBe('env');
      await expect(setSetting('X_CLIENT_SECRET', 'other', null, db)).rejects.toThrow(/server environment/);
    } finally {
      delete process.env.X_CLIENT_SECRET;
    }
    // A blob copied to another key fails the purpose check.
    await db.query(`INSERT INTO app_settings(key, value_secret) VALUES ('TIPSIGNAL_SIGNING_SECRET', $1)
                    ON CONFLICT (key) DO UPDATE SET value_secret = EXCLUDED.value_secret, value_plain = NULL`, [JSON.stringify(secret.value_secret)]);
    delete process.env.TIPSIGNAL_SIGNING_SECRET;
    await expect(getSetting('TIPSIGNAL_SIGNING_SECRET', db)).rejects.toThrow(/purpose mismatch/);
    // Clearing removes the stored value.
    await setSetting('X_CLIENT_SECRET', '', null, db);
    expect(await getSetting('X_CLIENT_SECRET', db)).toBeUndefined();
    await db.query(`DELETE FROM app_settings`);
  });

  it('validates values before storing', async () => {
    delete process.env.META_APP_ID;
    await expect(setSetting('META_APP_ID', 'not-numeric', null, testPool())).rejects.toThrow(/numeric/);
    expect(await getSetting('META_GRAPH_VERSION', testPool())).toBe(process.env.META_GRAPH_VERSION || 'v26.0');
  });
});
