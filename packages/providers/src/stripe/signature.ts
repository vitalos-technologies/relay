// Stripe webhook signatures (docs.stripe.com/webhooks "Verify webhook signatures manually", checked 2026-11-08):
//  1. Split `Stripe-Signature` on "," then each element on "=": `t` = timestamp, every `v1` = a signature. Ignore all other
//     schemes (v0 is a fake test scheme; ignoring it prevents downgrade attacks).
//  2. signed_payload = `${t}.${rawBody}` (the exact raw request body).
//  3. expected = HMAC-SHA256(endpoint secret, signed_payload), hex.
//  4. Constant-time compare against each v1 (several during secret rotation), and reject timestamps outside the tolerance
//     (Stripe libraries default to 300 s; 0 would disable the check, so it is refused).
// The same scheme signs locally generated test-double events, so the production verification path is what tests exercise.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const DEFAULT_TOLERANCE_SECONDS = 300;

export type SignatureFailure = 'missing_header' | 'malformed_header' | 'no_v1_signature' | 'timestamp_outside_tolerance' | 'no_matching_signature' | 'no_secret';

export class StripeSignatureError extends Error {
  constructor(public readonly reason: SignatureFailure) { super(`Stripe signature verification failed: ${reason}`); }
}

export function computeSignature(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
}

/** Build a `Stripe-Signature` header value for a payload (test double + fixtures). One v1 per secret, like rotation. */
export function signPayload(rawBody: string, secrets: string | string[], timestamp = Math.floor(Date.now() / 1000)): string {
  const list = Array.isArray(secrets) ? secrets : [secrets];
  return [`t=${timestamp}`, ...list.map((s) => `v1=${computeSignature(s, timestamp, rawBody)}`)].join(',');
}

export function parseSignatureHeader(header: string): { timestamp: number; v1: string[] } {
  let timestamp: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === 't') { if (!/^\d{1,12}$/.test(value)) throw new StripeSignatureError('malformed_header'); timestamp = Number(value); }
    else if (key === 'v1' && /^[0-9a-f]{64}$/i.test(value)) v1.push(value.toLowerCase());
  }
  if (timestamp === null) throw new StripeSignatureError('malformed_header');
  return { timestamp, v1 };
}

/**
 * Verify a webhook. `secrets` = active endpoint secrets (current + previous during rotation). Returns the timestamp.
 * Throws StripeSignatureError (never returns a partial result).
 */
export function verifySignature(rawBody: string, header: string | null | undefined, secrets: readonly string[], opts: { toleranceSeconds?: number; now?: number } = {}): number {
  const usable = secrets.filter((s) => typeof s === 'string' && s.length > 0);
  if (!usable.length) throw new StripeSignatureError('no_secret');
  if (!header) throw new StripeSignatureError('missing_header');
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (!(tolerance > 0)) throw new Error('tolerance must be positive');
  const { timestamp, v1 } = parseSignatureHeader(header);
  if (!v1.length) throw new StripeSignatureError('no_v1_signature');
  let matched = false;
  for (const secret of usable) {
    const expected = Buffer.from(computeSignature(secret, timestamp, rawBody), 'hex');
    for (const sig of v1) {
      const got = Buffer.from(sig, 'hex');
      if (got.length === expected.length && timingSafeEqual(got, expected)) matched = true;
    }
  }
  if (!matched) throw new StripeSignatureError('no_matching_signature');
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > tolerance) throw new StripeSignatureError('timestamp_outside_tolerance');
  return timestamp;
}
