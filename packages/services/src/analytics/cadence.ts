// Quota-aware refresh cadence for post metrics (pure). Lifetime counters settle: young posts are read often, older
// posts rarely, and after the horizon a post's last observation is final (not "stale"). Billable reads (X) get a
// shorter horizon. Failures back off exponentially; permanent states stop until something changes (reconnect).
import type { Provider } from '@social-lite/core';
import type { FetchState } from './semantics.js';

const H = 3_600_000;

export interface CadencePolicy { youngHours: number; youngEvery: number; midDays: number; midEvery: number; horizonDays: number; lateEvery: number }

export const DEFAULT_CADENCE: CadencePolicy = { youngHours: 48, youngEvery: 6, midDays: 14, midEvery: 24, horizonDays: 90, lateEvery: 24 * 7 };
/** X reads are billable (x.read budget): fewer, shorter. */
export const BILLABLE_CADENCE: CadencePolicy = { youngHours: 48, youngEvery: 12, midDays: 14, midEvery: 48, horizonDays: 30, lateEvery: 24 * 7 };

export function cadenceFor(provider: Provider): CadencePolicy {
  return provider === 'x' ? BILLABLE_CADENCE : DEFAULT_CADENCE;
}

/** Bounded backfill horizon (days) for a provider: never beyond what the provider can still report. */
export function backfillDays(provider: Provider): number {
  const configured = Number(process.env.ANALYTICS_BACKFILL_DAYS ?? 90);
  const cap = Number.isFinite(configured) && configured > 0 ? Math.min(configured, 365) : 90;
  return Math.min(cap, cadenceFor(provider).horizonDays, provider === 'pinterest' ? 89 : Infinity);
}

/**
 * When to read this post again. null = do not schedule (final, unsupported, deleted, or waiting for a reconnect).
 */
export function nextAttemptAt(provider: Provider, publishedAt: Date | null, now: Date, state: FetchState, consecutiveFailures = 0, retryAfterMs: number | null = null): Date | null {
  switch (state) {
    case 'unsupported': case 'not_found': case 'access_revoked': case 'permission_missing': case 'reconnect_required':
      return null;
    case 'rate_limited':
      return new Date(now.getTime() + Math.max(retryAfterMs ?? H, 60_000));
    case 'budget_exhausted':
      return new Date(now.getTime() + 24 * H);
    case 'fetch_failed':
      return new Date(now.getTime() + Math.min(2 ** Math.min(consecutiveFailures, 6), 48) * H);
    default: break; // ok / provider_delayed
  }
  const c = cadenceFor(provider);
  const age = publishedAt ? now.getTime() - publishedAt.getTime() : 0;
  if (age < c.youngHours * H) return new Date(now.getTime() + c.youngEvery * H);
  if (age < c.midDays * 24 * H) return new Date(now.getTime() + c.midEvery * H);
  if (age < c.horizonDays * 24 * H) {
    const next = new Date(now.getTime() + c.lateEvery * H);
    // One final read at the horizon, then stop.
    const horizon = new Date((publishedAt?.getTime() ?? now.getTime()) + c.horizonDays * 24 * H);
    return next > horizon ? horizon : next;
  }
  return null;
}
