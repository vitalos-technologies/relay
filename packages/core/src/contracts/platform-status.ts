// Vitalos Super Admin status contract (vitalos-platform ADR-044, `product: "relay"`), served by
// GET /api/platform/v1/status (packages/services/src/platform-status/service.ts).
//
// validatePlatformStatus mirrors the Super Admin's validator (superadmin/apps/products/status.py) and is stricter where
// Relay can afford it (times never in the future, tenant buckets disjoint), so Relay never serves a payload the Super
// Admin would refuse. Aggregates only: no names, emails, ids or other tenant-identifying data, ever.

export const PLATFORM_STATUS_PRODUCT = 'relay';
export const PLATFORM_STATUSES = ['operational', 'degraded', 'down'] as const;
export const PLATFORM_ALERT_SEVERITIES = ['critical', 'warning', 'info'] as const;
export type PlatformStatusValue = (typeof PLATFORM_STATUSES)[number];
export type PlatformAlertSeverity = (typeof PLATFORM_ALERT_SEVERITIES)[number];

export interface PlatformStatusAlert {
  severity: PlatformAlertSeverity;
  title: string;
  /** ISO 8601 with offset; never in the future. */
  since: string;
  /** https URL on Relay's own host, or null. */
  url: string | null;
}

export interface PlatformStatus {
  product: typeof PLATFORM_STATUS_PRODUCT;
  environment: string;
  status: PlatformStatusValue;
  checkedAt: string;
  tenants: { total: number; active: number; trial: number; suspended: number };
  subscriptions: { active: number; trialing: number; pastDue: number };
  alerts: PlatformStatusAlert[];
  superadminUrl: string;
}

/** Limits from ADR-044 / status.py. */
export const PLATFORM_STATUS_LIMITS = {
  maxCount: 10 ** 9,
  maxAlerts: 100,
  maxTitle: 200,
  maxUrl: 500,
  maxTimeLength: 40,
  /** The Super Admin reads at most 64 KiB. */
  maxBytes: 64 * 1024,
} as const;

/** Same pattern as status.py ENVIRONMENT_PATTERN. */
export const ENVIRONMENT_SLUG = /^[a-z][a-z0-9-]{0,31}$/;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const TENANT_KEYS = ['total', 'active', 'trial', 'suspended'] as const;
const SUBSCRIPTION_KEYS = ['active', 'trialing', 'pastDue'] as const;

export type PlatformStatusCheck = { ok: true; value: PlatformStatus } | { ok: false; field: string };

class Invalid extends Error {}
const fail = (field: string): never => { throw new Invalid(field); };
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function count(v: unknown, field: string): number {
  // typeof excludes booleans and numeric strings; isInteger excludes NaN/Infinity/fractions.
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > PLATFORM_STATUS_LIMITS.maxCount) fail(field);
  return v as number;
}

function time(v: unknown, field: string, now: Date): string {
  if (typeof v !== 'string' || v.length > PLATFORM_STATUS_LIMITS.maxTimeLength || !ISO_WITH_OFFSET.test(v)) fail(field);
  const t = Date.parse(v as string);
  if (!Number.isFinite(t) || t > now.getTime()) fail(field);
  return v as string;
}

function httpsUrl(v: unknown, field: string): URL {
  if (typeof v !== 'string' || v.length > PLATFORM_STATUS_LIMITS.maxUrl) fail(field);
  let u: URL | null = null;
  try { u = new URL(v as string); } catch { fail(field); }
  if (!u || u.protocol !== 'https:' || !u.hostname || u.username || u.password) fail(field);
  return u!;
}

/**
 * Validate a status payload against ADR-044. `trustedHosts` are the hosts alert links may point to (Relay's own host).
 * Returns the first failing field name, never a value.
 */
export function validatePlatformStatus(payload: unknown, opts: { now?: Date; trustedHosts: readonly string[] }): PlatformStatusCheck {
  const now = opts.now ?? new Date();
  const hosts = new Set(opts.trustedHosts.map((h) => h.toLowerCase()));
  try {
    if (!isObject(payload)) fail('body');
    const p = payload as Record<string, unknown>;
    if (JSON.stringify(p).length > PLATFORM_STATUS_LIMITS.maxBytes) fail('body');
    if (p.product !== PLATFORM_STATUS_PRODUCT) fail('product');
    if (typeof p.environment !== 'string' || !ENVIRONMENT_SLUG.test(p.environment)) fail('environment');
    if (!PLATFORM_STATUSES.includes(p.status as PlatformStatusValue)) fail('status');
    time(p.checkedAt, 'checkedAt', now);
    if (!isObject(p.tenants)) fail('tenants');
    const t = p.tenants as Record<string, unknown>;
    const tenants = Object.fromEntries(TENANT_KEYS.map((k) => [k, count(t[k], `tenants.${k}`)])) as PlatformStatus['tenants'];
    for (const k of ['active', 'trial', 'suspended'] as const) if (tenants[k] > tenants.total) fail(`tenants.${k}`);
    // Relay's buckets are disjoint, so their sum can't exceed the total either.
    if (tenants.active + tenants.trial + tenants.suspended > tenants.total) fail('tenants');
    if (!isObject(p.subscriptions)) fail('subscriptions');
    const s = p.subscriptions as Record<string, unknown>;
    for (const k of SUBSCRIPTION_KEYS) count(s[k], `subscriptions.${k}`);
    if (!Array.isArray(p.alerts) || p.alerts.length > PLATFORM_STATUS_LIMITS.maxAlerts) fail('alerts');
    (p.alerts as unknown[]).forEach((a, i) => {
      const f = `alerts[${i}]`;
      if (!isObject(a)) fail(f);
      const alert = a as Record<string, unknown>;
      if (!PLATFORM_ALERT_SEVERITIES.includes(alert.severity as PlatformAlertSeverity)) fail(`${f}.severity`);
      if (typeof alert.title !== 'string' || !alert.title.trim() || alert.title.length > PLATFORM_STATUS_LIMITS.maxTitle) fail(`${f}.title`);
      time(alert.since, `${f}.since`, now);
      if (!('url' in alert)) fail(`${f}.url`);
      if (alert.url !== null && !hosts.has(httpsUrl(alert.url, `${f}.url`).hostname)) fail(`${f}.url`);
    });
    httpsUrl(p.superadminUrl, 'superadminUrl');
    return { ok: true, value: p as unknown as PlatformStatus };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, field: e.message };
    throw e;
  }
}
