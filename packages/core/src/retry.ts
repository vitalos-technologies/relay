// Default safe retry schedule (spec §11): ~30s, 2m, 5m, 10m with jitter; max 5 attempts
// including the initial attempt. Provider Retry-After and publish-before deadlines win.
export const DEFAULT_MAX_ATTEMPTS = 5;
const BASE_DELAYS_MS = [30_000, 120_000, 300_000, 600_000];

export function retryDelayMs(attemptNumber: number, rand: () => number = Math.random): number {
  // attemptNumber: the attempt that just failed (1-based)
  const base = BASE_DELAYS_MS[Math.min(attemptNumber - 1, BASE_DELAYS_MS.length - 1)]!;
  const jitter = 0.8 + rand() * 0.4; // ±20%
  return Math.round(base * jitter);
}

export interface RetryDecision {
  retry: boolean;
  at?: Date;
  reason?: 'exhausted' | 'deadline';
}

export function decideRetry(p: {
  attemptNumber: number;
  maxAttempts: number;
  now: Date;
  publishBefore: Date;
  providerRetryAfterMs?: number;
  rand?: () => number;
}): RetryDecision {
  if (p.attemptNumber >= p.maxAttempts) return { retry: false, reason: 'exhausted' };
  const delay = Math.max(p.providerRetryAfterMs ?? 0, retryDelayMs(p.attemptNumber, p.rand));
  const at = new Date(p.now.getTime() + delay);
  if (at.getTime() >= p.publishBefore.getTime()) return { retry: false, reason: 'deadline' };
  return { retry: true, at };
}
