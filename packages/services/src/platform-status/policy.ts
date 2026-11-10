// Pure rules for GET /api/platform/v1/status (ADR-044): token check, tenant/subscription mapping, alerts. No IO.
//
// Tenant mapping (real workspaces only: `workspaces.is_demo` excludes demo, seed and E2E workspaces). Buckets are
// disjoint; a tenant in none of them still counts in `total`:
//   suspended  workspaces.state = 'suspended' (Relay staff suspension), whatever the billing state.
//   trial      billing access is full on a running trial: status 'trialing' (trial not ended, or a live provider trial)
//              or 'incomplete' while its trial still runs.
//   active     every other workspace with full access: paid ('active', 'cancel_scheduled', 'past_due' /
//              'payment_action_required' still inside the grace period), the Free plan (including trials and
//              subscriptions that ended and fall back to Free, D33) and legacy workspaces without a billing row.
//   (neither)  billing access is restricted: no plan chosen ('none') or an unpaid renewal past its grace period.
// Access is decided by the billing policy itself (billing/policy.ts deriveAccess), never re-implemented here.
//
// Subscriptions: provider-backed only (a provider subscription reference whose provider status is still live, as
// billing/policy.ts liveProviderSubscription), by Relay's verified billing status: active = 'active' or
// 'cancel_scheduled'; trialing = 'trialing'; pastDue = 'past_due' or 'payment_action_required'.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { PlatformStatus, PlatformStatusAlert, PlatformStatusValue } from '@social-lite/core/contracts/platform-status';
import { ENVIRONMENT_SLUG } from '@social-lite/core/contracts/platform-status';
import { deriveAccess, type BillingStatus } from '../billing/policy.js';

// ------------------------------------------------------------------ auth

const MAX_TOKEN = 512;

/** The token from `Authorization: Bearer <token>`, or null. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header || header.length > MAX_TOKEN + 16) return null;
  const m = /^Bearer[ \t]+([\x21-\x7e]+)[ \t]*$/i.exec(header);
  return m ? m[1]! : null;
}

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/**
 * Constant-time match against every configured token (current and, while rotating, previous). Both sides are hashed
 * first so neither the length nor the content leaks through timing, and every token is compared (no early exit).
 */
export function tokenMatches(presented: string | null, accepted: ReadonlyArray<string | null | undefined>): boolean {
  const tokens = accepted.filter((t): t is string => !!t);
  if (!tokens.length) return false;
  const got = digest(presented ?? '');
  let ok = false;
  for (const t of tokens) ok = timingSafeEqual(got, digest(t)) || ok;
  return ok && presented !== null;
}

// ------------------------------------------------------------------ environment and links

/** RELAY_ENVIRONMENT when set (staging deployments run APP_ENV=production and set it to `staging`), else APP_ENV. */
export function statusEnvironment(c: { RELAY_ENVIRONMENT?: string | undefined; APP_ENV: string }): string {
  if (c.RELAY_ENVIRONMENT && ENVIRONMENT_SLUG.test(c.RELAY_ENVIRONMENT)) return c.RELAY_ENVIRONMENT;
  return c.APP_ENV === 'production' ? 'production' : c.APP_ENV === 'test' ? 'test' : 'development';
}

const trimBase = (base: string) => base.replace(/\/+$/, '');

/** `${APP_BASE_URL}/admin/platform`. */
export function superadminUrl(base: string): string {
  return `${trimBase(base)}/admin/platform`;
}

/** Link to a Platform page on Relay's own host, or null unless APP_BASE_URL is https. */
export function platformLink(base: string, path: string): string | null {
  return base.startsWith('https://') ? `${trimBase(base)}${path}` : null;
}

// ------------------------------------------------------------------ tenants and subscriptions

export type Phase = 'none' | 'past' | 'future';

/** One row of the grouped aggregate (no identifiers): a combination of states and how many workspaces share it. */
export interface TenantGroup {
  /** workspaces.state */
  state: string;
  /** workspace_billing.status ('legacy' when the workspace has no billing row) */
  status: string;
  trial: Phase;
  grace: Phase;
  cancel: Phase;
  /** A live provider subscription (billing/policy.ts liveProviderSubscription). */
  live: boolean;
  n: number;
}

export type TenantBucket = 'active' | 'trial' | 'suspended' | 'other';

export function tenantBucket(g: Omit<TenantGroup, 'n'>, now: Date = new Date()): TenantBucket {
  if (g.state === 'suspended') return 'suspended';
  const at = (p: Phase) => (p === 'none' ? null : new Date(now.getTime() + (p === 'past' ? -1 : 1) * 86_400_000));
  // Unknown statuses (added later by billing) fall through to 'other' instead of guessing.
  const r = deriveAccess({ status: g.status as BillingStatus, serviceSuspended: false, graceEndsAt: at(g.grace), trialEndsAt: at(g.trial),
    cancelAt: at(g.cancel), now, liveSubscription: g.live }) as ReturnType<typeof deriveAccess> | undefined;
  if (!r) return 'other';
  if (r.free) return 'active';
  if (r.access !== 'full') return 'other';
  return g.status === 'trialing' || g.status === 'incomplete' ? 'trial' : 'active';
}

export type SubscriptionBucket = keyof PlatformStatus['subscriptions'] | null;

export function subscriptionBucket(g: Pick<TenantGroup, 'status' | 'live'>): SubscriptionBucket {
  if (!g.live) return null;
  switch (g.status) {
    case 'active': case 'cancel_scheduled': return 'active';
    case 'trialing': return 'trialing';
    case 'past_due': case 'payment_action_required': return 'pastDue';
    default: return null;
  }
}

export interface StatusCounts { tenants: PlatformStatus['tenants']; subscriptions: PlatformStatus['subscriptions'] }

export function summarize(groups: readonly TenantGroup[], now: Date = new Date()): StatusCounts {
  const tenants = { total: 0, active: 0, trial: 0, suspended: 0 };
  const subscriptions = { active: 0, trialing: 0, pastDue: 0 };
  for (const g of groups) {
    const n = Math.max(0, Math.trunc(g.n));
    tenants.total += n;
    const b = tenantBucket(g, now);
    if (b !== 'other') tenants[b] += n;
    const s = subscriptionBucket(g);
    if (s) subscriptions[s] += n;
  }
  return { tenants, subscriptions };
}

// ------------------------------------------------------------------ health signals → status + alerts

export interface StatusSignals {
  database: boolean;
  /** Aggregate queries failed or timed out although the database answered. */
  queriesFailed: boolean;
  /** When the database was first seen failing by this process. */
  databaseDownSince: Date | null;
  migrationsApplied: boolean;
  workerLastSeen: Date | null;
  workerStale: boolean;
  dispatchEnabled: boolean;
  dispatchChangedAt: Date | null;
  outboxDead: number;
  outboxDeadSince: Date | null;
  outboxBacklog: number;
  outboxBacklogSince: Date | null;
  deliveriesStuck: number;
  deliveriesStuckSince: Date | null;
  billingWebhooksFailing: number;
  billingWebhooksSince: Date | null;
}

/** Thresholds (documented in content/help/developers/environment-variables.md "Platform status"). */
export const STATUS_THRESHOLDS = {
  outboxBacklogMinutes: 5,
  deliveryStuckMinutes: 2,
  billingWebhookUnprocessedMinutes: 15,
  billingWebhookFailedDays: 7,
} as const;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 } as const;
const MAX_ALERTS = 10;

export function buildAlerts(s: StatusSignals, opts: { now: Date; base: string }): { status: PlatformStatusValue; alerts: PlatformStatusAlert[] } {
  const { now, base } = opts;
  const since = (d: Date | null) => new Date(Math.min(d && Number.isFinite(d.getTime()) ? d.getTime() : now.getTime(), now.getTime())).toISOString();
  const overview = platformLink(base, '/admin/platform');
  const alerts: PlatformStatusAlert[] = [];
  const add = (severity: PlatformStatusAlert['severity'], title: string, at: Date | null, url: string | null = overview) =>
    alerts.push({ severity, title, since: since(at), url });

  if (!s.database) add('critical', 'Database unreachable', s.databaseDownSince);
  else {
    if (!s.migrationsApplied) add('critical', 'Database migrations not applied', null);
    if (s.queriesFailed) add('critical', 'Status queries failed or timed out', null);
  }
  if (s.database && !s.queriesFailed) {
    if (s.workerStale) add('critical', s.workerLastSeen ? 'No worker heartbeat in the last 2 minutes' : 'No worker has reported a heartbeat', s.workerLastSeen);
    if (!s.dispatchEnabled) add('critical', 'Publishing dispatch is off for the installation', s.dispatchChangedAt);
    if (s.deliveriesStuck > 0) add('warning', `${plural(s.deliveriesStuck, 'publication', 'publications')} stuck for over ${STATUS_THRESHOLDS.deliveryStuckMinutes} minutes`, s.deliveriesStuckSince);
    if (s.outboxDead > 0) add('warning', `${plural(s.outboxDead, 'outbox event', 'outbox events')} dead-lettered`, s.outboxDeadSince);
    if (s.outboxBacklog > 0) add('warning', `${plural(s.outboxBacklog, 'outbox event', 'outbox events')} waiting over ${STATUS_THRESHOLDS.outboxBacklogMinutes} minutes`, s.outboxBacklogSince);
    if (s.billingWebhooksFailing > 0) add('warning', `${plural(s.billingWebhooksFailing, 'billing webhook', 'billing webhooks')} failing`, s.billingWebhooksSince, platformLink(base, '/admin/platform/billing'));
  }
  alerts.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const status: PlatformStatusValue = !s.database ? 'down' : alerts.length ? 'degraded' : 'operational';
  return { status, alerts: alerts.slice(0, MAX_ALERTS) };
}
