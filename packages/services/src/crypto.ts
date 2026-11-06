// Envelope encryption for provider credentials and setup secrets (spec §14).
// Each secret gets a fresh 256-bit data key (AES-256-GCM). The data key is wrapped with a
// key-encryption key (KEK) that lives OUTSIDE the database: KEY_ENCRYPTION_KEYS env var
// locally, or a KMS-backed provider in production (KeyProvider interface).
// Rotation: add a new KEK first in the list; old blobs still decrypt by kid; rewrap lazily.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from './config.js';

export interface EncryptedBlob {
  v: 1;
  kid: string;          // KEK id used to wrap the data key
  wk: string;           // wrapped data key: base64(iv|tag|ciphertext)
  iv: string;
  tag: string;
  ct: string;
  aad?: string;         // associated data label (binds blob to its purpose/owner)
}

export interface KeyProvider {
  activeKid(): string;
  wrap(kid: string, dataKey: Buffer): Buffer;
  unwrap(kid: string, wrapped: Buffer): Buffer;
}

export class EnvKeyProvider implements KeyProvider {
  private readonly keys = new Map<string, Buffer>();
  private readonly active: string;

  constructor(spec: string) {
    const entries = spec.split(',').map((s) => s.trim()).filter(Boolean);
    if (!entries.length) throw new Error('KEY_ENCRYPTION_KEYS is empty');
    for (const e of entries) {
      const idx = e.indexOf(':');
      if (idx < 1) throw new Error('KEY_ENCRYPTION_KEYS entries must be "<kid>:<base64key>"');
      const kid = e.slice(0, idx);
      const key = Buffer.from(e.slice(idx + 1), 'base64');
      if (key.length !== 32) throw new Error(`KEK ${kid} must be 32 bytes (base64)`);
      this.keys.set(kid, key);
    }
    this.active = entries[0]!.slice(0, entries[0]!.indexOf(':'));
  }

  activeKid(): string { return this.active; }

  wrap(kid: string, dataKey: Buffer): Buffer {
    return gcmEncrypt(this.key(kid), dataKey, Buffer.from(`kek:${kid}`));
  }

  unwrap(kid: string, wrapped: Buffer): Buffer {
    return gcmDecrypt(this.key(kid), wrapped, Buffer.from(`kek:${kid}`));
  }

  private key(kid: string): Buffer {
    const k = this.keys.get(kid);
    if (!k) throw new Error(`unknown key id ${kid}`);
    return k;
  }
}

function gcmEncrypt(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

function gcmDecrypt(key: Buffer, packed: Buffer, aad: Buffer): Buffer {
  const iv = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const ct = packed.subarray(28);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

let provider: KeyProvider | undefined;

export function keyProvider(): KeyProvider {
  if (!provider) {
    const spec = config().KEY_ENCRYPTION_KEYS;
    if (!spec) throw new Error('KEY_ENCRYPTION_KEYS is not configured');
    provider = new EnvKeyProvider(spec);
  }
  return provider;
}

export function setKeyProvider(p: KeyProvider | undefined): void {
  provider = p;
}

/** Encrypt a JSON-serialisable secret. aad binds the blob to its purpose (e.g. "credential:<workspaceId>"). */
export function encryptSecret(value: unknown, aad: string, kp: KeyProvider = keyProvider()): EncryptedBlob {
  const dataKey = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', dataKey, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(value), 'utf8')), c.final()]);
  const kid = kp.activeKid();
  const blob: EncryptedBlob = {
    v: 1, kid, wk: kp.wrap(kid, dataKey).toString('base64'),
    iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64'), aad,
  };
  dataKey.fill(0);
  return blob;
}

export function decryptSecret<T = unknown>(blob: EncryptedBlob, aad: string, kp: KeyProvider = keyProvider()): T {
  if (blob.v !== 1) throw new Error('unsupported secret blob version');
  if (blob.aad !== undefined && blob.aad !== aad) throw new Error('secret blob purpose mismatch');
  const dataKey = kp.unwrap(blob.kid, Buffer.from(blob.wk, 'base64'));
  try {
    const d = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(blob.iv, 'base64'));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(blob.tag, 'base64'));
    const pt = Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()]);
    return JSON.parse(pt.toString('utf8')) as T;
  } finally {
    dataKey.fill(0);
  }
}

export const credentialAad = (workspaceId: string) => `credential:${workspaceId}`;
export const settingAad = (key: string) => `setting:${key}`;
export const pkceAad = 'oauth-state';
