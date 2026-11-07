// Minimal JWS verification for identity-provider tokens (ID tokens, back-channel logout tokens) using
// node:crypto and the provider's published JWKS. Only asymmetric algorithms are accepted (RS256/PS256/ES256);
// "none" and HMAC algorithms are rejected so a public key can never be used as a shared secret.
import { createPublicKey, verify as cryptoVerify, constants, type JsonWebKey, type KeyObject } from 'node:crypto';

export interface Jwk extends JsonWebKey { kid?: string; alg?: string; use?: string; kty?: string }
export type KeyResolver = (kid: string | undefined, alg: string) => Promise<KeyObject | null>;

const ALGS: Record<string, { hash: string; pss?: boolean; ec?: boolean }> = {
  RS256: { hash: 'sha256' }, PS256: { hash: 'sha256', pss: true }, ES256: { hash: 'sha256', ec: true },
};

export class JwtError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'JwtError'; }
}

function b64json(part: string): Record<string, unknown> {
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>; } catch { throw new JwtError('malformed'); }
}

export interface VerifiedJwt { header: Record<string, unknown>; claims: Record<string, unknown> }

/** Verify signature + iss/aud/time claims. `aud` must contain `audience`. */
export async function verifyJwt(token: string, opts: { keys: KeyResolver; issuer: string; audience: string; now?: number; clockSkewS?: number; maxAgeS?: number }): Promise<VerifiedJwt> {
  if (typeof token !== 'string' || token.length > 16_384) throw new JwtError('malformed');
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed');
  const header = b64json(parts[0]!);
  const alg = String(header.alg ?? '');
  const spec = ALGS[alg];
  if (!spec) throw new JwtError('unsupported_alg');
  const key = await opts.keys(typeof header.kid === 'string' ? header.kid : undefined, alg);
  if (!key) throw new JwtError('unknown_key');
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = Buffer.from(parts[2]!, 'base64url');
  const ok = cryptoVerify(spec.hash, data, spec.pss ? { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 } : spec.ec ? { key, dsaEncoding: 'ieee-p1363' } : key, sig);
  if (!ok) throw new JwtError('bad_signature');
  const claims = b64json(parts[1]!);
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const skew = opts.clockSkewS ?? 60;
  if (claims.iss !== opts.issuer) throw new JwtError('bad_issuer');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(opts.audience)) throw new JwtError('bad_audience');
  if (typeof claims.exp === 'number' && claims.exp + skew < now) throw new JwtError('expired');
  if (typeof claims.iat !== 'number' || claims.iat - skew > now) throw new JwtError('bad_iat');
  if (opts.maxAgeS !== undefined && now - claims.iat > opts.maxAgeS + skew) throw new JwtError('too_old');
  return { header, claims };
}

/** Key resolver over a JWKS URL with refetch-on-unknown-kid (rate limited) and a short cache. */
export function jwksResolver(fetchJwks: () => Promise<{ keys: Jwk[] }>): KeyResolver {
  let cache: { at: number; keys: Jwk[] } | undefined;
  const load = async (force: boolean) => {
    if (!cache || (force && Date.now() - cache.at > 30_000) || Date.now() - cache.at > 10 * 60_000) cache = { at: Date.now(), keys: (await fetchJwks()).keys ?? [] };
    return cache.keys;
  };
  const pick = (keys: Jwk[], kid: string | undefined, alg: string) => keys.find((k) => (k.use === undefined || k.use === 'sig') && (!kid || k.kid === kid) && (!k.alg || k.alg === alg)
    && (alg.startsWith('ES') ? k.kty === 'EC' : k.kty === 'RSA'));
  return async (kid, alg) => {
    let jwk = pick(await load(false), kid, alg);
    if (!jwk) jwk = pick(await load(true), kid, alg);
    return jwk ? createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' }) : null;
  };
}
