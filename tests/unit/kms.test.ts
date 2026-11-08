import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { initKmsKeyProvider } from '@social-lite/services/kms';
import { decryptSecret, encryptSecret, keyProvider, setKeyProvider } from '@social-lite/services/crypto';

const NAME = 'projects/p1/locations/europe-west2/keyRings/ring/cryptoKeys/kek';

describe('Cloud KMS key custody', () => {
  it('unwraps KEKs via KMS decrypt with kid-bound AAD and uses them for envelope encryption', async () => {
    const kek = randomBytes(32).toString('base64');
    const calls: Array<{ url: string; body: { ciphertext: string; additionalAuthenticatedData: string }; auth: string }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).authorization ?? '' });
      return new Response(JSON.stringify({ plaintext: kek }), { status: 200 });
    }) as unknown as typeof fetch;
    const kids = await initKmsKeyProvider({ KMS_KEY_NAME: NAME, KMS_WRAPPED_KEKS: 'prod-1:Y2lwaGVy' } as NodeJS.ProcessEnv, { fetch: fakeFetch, accessToken: async () => 'tok' });
    expect(kids).toEqual(['prod-1']);
    expect(calls[0]!.url).toBe(`https://cloudkms.googleapis.com/v1/${NAME}:decrypt`);
    expect(calls[0]!.auth).toBe('Bearer tok');
    expect(Buffer.from(calls[0]!.body.additionalAuthenticatedData, 'base64').toString()).toBe('social-lite-kek:prod-1');
    expect(keyProvider().activeKid()).toBe('prod-1');
    const blob = encryptSecret({ a: 1 }, 'credential:ws');
    expect(blob.kid).toBe('prod-1');
    expect(decryptSecret(blob, 'credential:ws')).toEqual({ a: 1 });
    setKeyProvider(undefined);
  });

  it('fails closed on misconfiguration or KMS errors and is a no-op without settings', async () => {
    const bad = (async () => new Response('denied', { status: 403 })) as unknown as typeof fetch;
    await expect(initKmsKeyProvider({ KMS_KEY_NAME: NAME, KMS_WRAPPED_KEKS: 'k:x' } as NodeJS.ProcessEnv, { fetch: bad, accessToken: async () => 't' })).rejects.toThrow(/403/);
    await expect(initKmsKeyProvider({ KMS_KEY_NAME: NAME } as NodeJS.ProcessEnv, { fetch: bad })).rejects.toThrow(/together/);
    await expect(initKmsKeyProvider({ KMS_KEY_NAME: 'bogus', KMS_WRAPPED_KEKS: 'k:x' } as NodeJS.ProcessEnv, { fetch: bad })).rejects.toThrow(/projects/);
    expect(await initKmsKeyProvider({} as NodeJS.ProcessEnv, { fetch: bad })).toBeNull();
  });
});
