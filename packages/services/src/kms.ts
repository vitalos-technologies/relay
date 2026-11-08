// KMS custody for key-encryption keys (KEKs).
// Production option: KMS_KEY_NAME + KMS_WRAPPED_KEKS ("kid:<base64 KMS ciphertext>,…"). At boot the
// process asks Google Cloud KMS to decrypt each wrapped KEK (service-account token from the GCE metadata
// server), keeps the plaintext KEKs only in memory, and installs them as the active KeyProvider.
// The database never sees KEKs; env/config hold only KMS ciphertext. Without KMS settings the
// existing KEY_ENCRYPTION_KEYS path is used (local/dev, or a secret manager mounting the value).
import { EnvKeyProvider, setKeyProvider } from './crypto.js';

export interface KmsDeps {
  fetch: typeof fetch;
  /** OAuth access token for Cloud KMS (default: GCE metadata server). */
  accessToken?: () => Promise<string>;
}

const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const KEY_NAME_RE = /^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/keyRings\/[A-Za-z0-9_-]+\/cryptoKeys\/[A-Za-z0-9_-]+$/;

async function metadataToken(f: typeof fetch): Promise<string> {
  const r = await f(METADATA_TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5_000) });
  if (!r.ok) throw new Error(`metadata token request failed (${r.status})`);
  const j = (await r.json()) as { access_token?: string };
  if (!j.access_token) throw new Error('metadata token missing');
  return j.access_token;
}

/** Decrypt wrapped KEKs with Cloud KMS and install them. Returns the kids loaded. Throws (fail closed) on any error. */
export async function initKmsKeyProvider(env: NodeJS.ProcessEnv = process.env, deps: KmsDeps = { fetch }): Promise<string[] | null> {
  const name = env.KMS_KEY_NAME;
  const wrapped = env.KMS_WRAPPED_KEKS;
  if (!name && !wrapped) return null;
  if (!name || !wrapped) throw new Error('KMS_KEY_NAME and KMS_WRAPPED_KEKS must be set together');
  if (!KEY_NAME_RE.test(name)) throw new Error('KMS_KEY_NAME must be projects/…/locations/…/keyRings/…/cryptoKeys/…');
  const token = await (deps.accessToken ?? (() => metadataToken(deps.fetch)))();
  const entries: string[] = [];
  for (const item of wrapped.split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = item.indexOf(':');
    if (i < 1) throw new Error('KMS_WRAPPED_KEKS entries must be "<kid>:<base64 ciphertext>"');
    const kid = item.slice(0, i);
    const r = await deps.fetch(`https://cloudkms.googleapis.com/v1/${name}:decrypt`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ciphertext: item.slice(i + 1), additionalAuthenticatedData: Buffer.from(`social-lite-kek:${kid}`).toString('base64') }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`Cloud KMS decrypt failed for ${kid} (${r.status})`);
    const plaintext = ((await r.json()) as { plaintext?: string }).plaintext;
    if (!plaintext || Buffer.from(plaintext, 'base64').length !== 32) throw new Error(`KEK ${kid} must decrypt to 32 bytes`);
    entries.push(`${kid}:${plaintext}`);
  }
  setKeyProvider(new EnvKeyProvider(entries.join(',')));
  return entries.map((e) => e.slice(0, e.indexOf(':')));
}
