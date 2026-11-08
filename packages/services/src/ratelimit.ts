// Token-bucket rate limiting. enforceRateLimit uses a SHARED PostgreSQL store (one row per key,
// updated atomically under a row lock), so limits hold across web replicas and restarts.
// The in-process RateLimiter class remains for unit tests and as a pure algorithm reference.
import { AppError } from '@social-lite/core';
import { getPool, withTx } from '@social-lite/db';

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

/** Atomically take `cost` tokens from the shared bucket. */
export async function takeShared(key: string, p: RateLimitPolicy, cost = 1): Promise<{ allowed: boolean; retryAfterMs: number }> {
  return withTx(async (tx) => {
    await tx.query(`INSERT INTO rate_limit_buckets(key, tokens) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [key, p.capacity]);
    const r = await tx.query<{ refilled: number }>(
      `SELECT least($2::float8, tokens + extract(epoch FROM (clock_timestamp() - updated_at)) * $3::float8) AS refilled
         FROM rate_limit_buckets WHERE key=$1 FOR UPDATE`, [key, p.capacity, p.refillPerSecond]);
    const refilled = Number(r.rows[0]!.refilled);
    const allowed = refilled >= cost;
    await tx.query(`UPDATE rate_limit_buckets SET tokens=$2, updated_at=clock_timestamp() WHERE key=$1`, [key, allowed ? refilled - cost : refilled]);
    return { allowed, retryAfterMs: allowed ? 0 : Math.ceil(((cost - refilled) / p.refillPerSecond) * 1000) };
  }, getPool());
}

/** Throw 429 rate_limited when the key has exhausted its (shared) bucket. */
export async function enforceRateLimit(scope: keyof typeof RATE_LIMITS | string, key: string, policy?: RateLimitPolicy): Promise<void> {
  const p = policy ?? (RATE_LIMITS as Record<string, RateLimitPolicy>)[scope];
  if (!p) throw new Error(`unknown rate limit scope ${scope}`);
  const r = await takeShared(`${scope}:${key}`.slice(0, 300), p);
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
