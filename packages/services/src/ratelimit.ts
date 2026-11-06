// In-process token-bucket rate limiter.
// NOTE: state is per Node.js process. With N web replicas the effective limit is N× the
// configured rate, and limits reset on restart. That is acceptable as an abuse brake for auth
// and upload-intent endpoints; a shared store (e.g. Postgres/Redis) is needed for strict quotas.
import { AppError } from '@social-lite/core';

export interface RateLimitPolicy {
  /** Bucket size (burst). */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
}

export const RATE_LIMITS = {
  authLogin: { capacity: 20, refillPerSecond: 20 / 60 },        // per IP: 20 burst, 20/min
  authCallback: { capacity: 20, refillPerSecond: 20 / 60 },     // per IP
  uploadIntent: { capacity: 30, refillPerSecond: 30 / 60 },     // per user: 30 burst, 30/min
  invitationPreview: { capacity: 30, refillPerSecond: 30 / 60 },// per IP
  invitationCreate: { capacity: 20, refillPerSecond: 20 / 3600 },// per user: 20/hour
} satisfies Record<string, RateLimitPolicy>;

interface Bucket { tokens: number; updated: number }

const MAX_BUCKETS = 50_000;

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Consume one token. Returns whether allowed and, if not, how long until a token is available. */
  take(key: string, policy: RateLimitPolicy, cost = 1): { allowed: boolean; retryAfterMs: number; remaining: number } {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= MAX_BUCKETS) this.sweep(t);
      b = { tokens: policy.capacity, updated: t };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(policy.capacity, b.tokens + ((t - b.updated) / 1000) * policy.refillPerSecond);
      b.updated = t;
    }
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { allowed: true, retryAfterMs: 0, remaining: Math.floor(b.tokens) };
    }
    const retryAfterMs = Math.ceil(((cost - b.tokens) / policy.refillPerSecond) * 1000);
    return { allowed: false, retryAfterMs, remaining: 0 };
  }

  /** Drop buckets idle for over 10 minutes (they would be full again anyway for typical policies). */
  sweep(t = this.now()): void {
    for (const [k, b] of this.buckets) if (t - b.updated > 10 * 60_000) this.buckets.delete(k);
    if (this.buckets.size >= MAX_BUCKETS) {
      // Still full: evict oldest entries (Map iterates in insertion order).
      let n = this.buckets.size - Math.floor(MAX_BUCKETS * 0.9);
      for (const k of this.buckets.keys()) { if (n-- <= 0) break; this.buckets.delete(k); }
    }
  }

  reset(): void { this.buckets.clear(); }
}

const shared = new RateLimiter();

export function rateLimiter(): RateLimiter { return shared; }

/** Throw 429 rate_limited when the key has exhausted its bucket. */
export function enforceRateLimit(scope: keyof typeof RATE_LIMITS | string, key: string, policy?: RateLimitPolicy): void {
  const p = policy ?? (RATE_LIMITS as Record<string, RateLimitPolicy>)[scope];
  if (!p) throw new Error(`unknown rate limit scope ${scope}`);
  const r = shared.take(`${scope}:${key}`, p);
  if (!r.allowed) {
    throw new AppError('rate_limited', 'Too many requests. Please wait a moment and try again.', undefined,
      { retry_after_seconds: Math.ceil(r.retryAfterMs / 1000) });
  }
}

/**
 * Best-effort client IP. Only the first X-Forwarded-For hop is used, which is meaningful only when
 * the app runs behind a proxy that overwrites the header (documented in DEPLOYMENT.md).
 */
export function clientIp(headers: Headers): string {
  const xff = headers.get('x-forwarded-for');
  const first = xff?.split(',')[0]?.trim();
  return (first || headers.get('x-real-ip') || 'unknown').slice(0, 64);
}
