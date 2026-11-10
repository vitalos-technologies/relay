// GET /api/platform/v1/status (ADR-044): contract validator, token check, tenant/subscription mapping, alerts, config.
import { describe, expect, it } from 'vitest';
import { validatePlatformStatus, type PlatformStatus } from '@social-lite/core/contracts/platform-status';
import {
  bearerToken, buildAlerts, platformLink, statusEnvironment, subscriptionBucket, summarize, superadminUrl, tenantBucket, tokenMatches,
  type StatusSignals, type TenantGroup,
} from '@social-lite/services/platform-status/policy';
import { ConfigError, loadConfig } from '@social-lite/services/config';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const HOSTS = ['relay.example.com'];

function valid(over: Partial<PlatformStatus> = {}): PlatformStatus {
  return {
    product: 'relay', environment: 'production', status: 'operational', checkedAt: '2026-11-10T11:59:30.000Z',
    tenants: { total: 10, active: 6, trial: 2, suspended: 1 }, subscriptions: { active: 4, trialing: 1, pastDue: 0 },
    alerts: [{ severity: 'warning', title: '2 outbox events dead-lettered', since: '2026-11-10T10:00:00+01:00', url: 'https://relay.example.com/admin/platform' }],
    superadminUrl: 'https://relay.example.com/admin/platform', ...over,
  };
}
const check = (p: unknown) => validatePlatformStatus(p, { now: NOW, trustedHosts: HOSTS });
const field = (p: unknown) => { const r = check(p); return r.ok ? null : r.field; };

describe('ADR-044 contract validator', () => {
  it('accepts a valid payload, unknown keys and null alert urls', () => {
    expect(check(valid()).ok).toBe(true);
    expect(check({ ...valid(), extra: { anything: 1 } }).ok).toBe(true);
    expect(check(valid({ alerts: [{ severity: 'info', title: 'x', since: '2026-11-10T11:00:00Z', url: null }] })).ok).toBe(true);
    expect(check(valid({ alerts: [] })).ok).toBe(true);
  });

  it('refuses wrong product, environment and status', () => {
    expect(field(null)).toBe('body');
    expect(field([])).toBe('body');
    expect(field(valid({ product: 'askbridge' as 'relay' }))).toBe('product');
    for (const e of ['Production', 'prod uction', '', '1prod', 'a'.repeat(33)]) expect(field(valid({ environment: e }))).toBe('environment');
    expect(field(valid({ status: 'ok' as 'operational' }))).toBe('status');
  });

  it('counts must be non-negative integers (no booleans, strings, fractions) and no breakdown exceeds the total', () => {
    const t = valid().tenants;
    expect(field(valid({ tenants: { ...t, total: -1 } }))).toBe('tenants.total');
    expect(field(valid({ tenants: { ...t, active: 1.5 } }))).toBe('tenants.active');
    expect(field(valid({ tenants: { ...t, trial: true as unknown as number } }))).toBe('tenants.trial');
    expect(field(valid({ tenants: { ...t, suspended: '1' as unknown as number } }))).toBe('tenants.suspended');
    expect(field(valid({ tenants: { ...t, total: 1e9 + 1 } }))).toBe('tenants.total');
    expect(field(valid({ tenants: { total: 3, active: 4, trial: 0, suspended: 0 } }))).toBe('tenants.active');
    expect(field(valid({ tenants: { total: 3, active: 2, trial: 2, suspended: 0 } }))).toBe('tenants');
    expect(field(valid({ subscriptions: { active: 1, trialing: 0 } as PlatformStatus['subscriptions'] }))).toBe('subscriptions.pastDue');
    expect(field({ ...valid(), tenants: undefined })).toBe('tenants');
  });

  it('times need an offset and are never in the future', () => {
    expect(field(valid({ checkedAt: '2026-11-10T11:59:30' }))).toBe('checkedAt');
    expect(field(valid({ checkedAt: '2026-11-10T12:00:01Z' }))).toBe('checkedAt');
    expect(field(valid({ checkedAt: 'yesterday' }))).toBe('checkedAt');
    expect(field(valid({ checkedAt: `2026-11-10T11:00:00.${'0'.repeat(40)}Z` }))).toBe('checkedAt');
    expect(field(valid({ alerts: [{ ...valid().alerts[0]!, since: '2026-11-10T13:30:00+01:00' }] }))).toBe('alerts[0].since');
  });

  it('alerts: severity, title, url key, https on Relay’s own host, at most 100', () => {
    const a = valid().alerts[0]!;
    expect(field(valid({ alerts: [{ ...a, severity: 'error' as 'info' }] }))).toBe('alerts[0].severity');
    expect(field(valid({ alerts: [{ ...a, title: '  ' }] }))).toBe('alerts[0].title');
    expect(field(valid({ alerts: [{ ...a, title: 'x'.repeat(201) }] }))).toBe('alerts[0].title');
    const { url: _u, ...noUrl } = a;
    expect(field(valid({ alerts: [noUrl as typeof a] }))).toBe('alerts[0].url');
    expect(field(valid({ alerts: [{ ...a, url: 'http://relay.example.com/admin/platform' }] }))).toBe('alerts[0].url');
    expect(field(valid({ alerts: [{ ...a, url: 'https://evil.example.net/admin' }] }))).toBe('alerts[0].url');
    expect(field(valid({ alerts: Array.from({ length: 101 }, () => a) }))).toBe('alerts');
    expect(field({ ...valid(), alerts: {} })).toBe('alerts');
  });

  it('superadminUrl must be https', () => {
    expect(field(valid({ superadminUrl: 'http://localhost:3000/admin/platform' }))).toBe('superadminUrl');
    expect(field(valid({ superadminUrl: 'not a url' }))).toBe('superadminUrl');
  });
});

describe('Bearer token', () => {
  const current = 'c'.repeat(64);
  const previous = 'p'.repeat(64);
  it('parses only a well-formed Bearer header', () => {
    expect(bearerToken(`Bearer ${current}`)).toBe(current);
    expect(bearerToken(`bearer ${current}`)).toBe(current);
    expect(bearerToken(current)).toBeNull();
    expect(bearerToken(`Basic ${current}`)).toBeNull();
    expect(bearerToken(`Bearer ${current} extra`)).toBeNull();
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken(`Bearer ${'x'.repeat(600)}`)).toBeNull();
  });
  it('accepts the current or (while rotating) the previous token, nothing else', () => {
    expect(tokenMatches(current, [current, undefined])).toBe(true);
    expect(tokenMatches(previous, [current, previous])).toBe(true);
    expect(tokenMatches(previous, [current, undefined])).toBe(false);
    expect(tokenMatches(current.slice(1), [current, previous])).toBe(false);
    expect(tokenMatches(`${current}x`, [current])).toBe(false);
    expect(tokenMatches(null, [current])).toBe(false);
    expect(tokenMatches('', [current])).toBe(false);
    expect(tokenMatches(current, [undefined, null, ''])).toBe(false);
  });
});

describe('environment and links', () => {
  it('RELAY_ENVIRONMENT wins; otherwise derived from APP_ENV', () => {
    expect(statusEnvironment({ RELAY_ENVIRONMENT: 'staging', APP_ENV: 'production' })).toBe('staging');
    expect(statusEnvironment({ APP_ENV: 'production' })).toBe('production');
    expect(statusEnvironment({ APP_ENV: 'development' })).toBe('development');
    expect(statusEnvironment({ APP_ENV: 'test' })).toBe('test');
  });
  it('superadmin URL and alert links (https only)', () => {
    expect(superadminUrl('https://relay.example.com/')).toBe('https://relay.example.com/admin/platform');
    expect(platformLink('https://relay.example.com', '/admin/platform/billing')).toBe('https://relay.example.com/admin/platform/billing');
    expect(platformLink('http://localhost:3000', '/admin/platform')).toBeNull();
  });
});

describe('tenant and subscription mapping', () => {
  const g = (over: Partial<TenantGroup>): TenantGroup => ({ state: 'active', status: 'active', trial: 'none', grace: 'none', cancel: 'none', live: false, n: 1, ...over });
  it('maps billing states to active / trial / suspended / neither', () => {
    expect(tenantBucket(g({ state: 'suspended', status: 'trialing', trial: 'future' }), NOW)).toBe('suspended');
    expect(tenantBucket(g({ status: 'active', live: true }), NOW)).toBe('active');
    expect(tenantBucket(g({ status: 'legacy' }), NOW)).toBe('active');
    expect(tenantBucket(g({ status: 'free' }), NOW)).toBe('active');
    expect(tenantBucket(g({ status: 'cancel_scheduled', cancel: 'future', live: true }), NOW)).toBe('active');
    expect(tenantBucket(g({ status: 'cancel_scheduled', cancel: 'past' }), NOW)).toBe('active'); // fell back to Free
    expect(tenantBucket(g({ status: 'trialing', trial: 'future' }), NOW)).toBe('trial');
    expect(tenantBucket(g({ status: 'trialing', trial: 'past', live: true }), NOW)).toBe('trial'); // provider decides
    expect(tenantBucket(g({ status: 'trialing', trial: 'past' }), NOW)).toBe('active'); // no-card trial ended → Free
    expect(tenantBucket(g({ status: 'incomplete', trial: 'future' }), NOW)).toBe('trial');
    expect(tenantBucket(g({ status: 'past_due', grace: 'future', live: true }), NOW)).toBe('active');
    expect(tenantBucket(g({ status: 'past_due', grace: 'past', live: true }), NOW)).toBe('other'); // restricted
    expect(tenantBucket(g({ status: 'none' }), NOW)).toBe('other');
    expect(tenantBucket(g({ status: 'something_new' }), NOW)).toBe('other');
  });
  it('subscriptions count only live provider subscriptions', () => {
    expect(subscriptionBucket({ status: 'active', live: true })).toBe('active');
    expect(subscriptionBucket({ status: 'cancel_scheduled', live: true })).toBe('active');
    expect(subscriptionBucket({ status: 'trialing', live: true })).toBe('trialing');
    expect(subscriptionBucket({ status: 'payment_action_required', live: true })).toBe('pastDue');
    expect(subscriptionBucket({ status: 'trialing', live: false })).toBeNull(); // no-card trial
    expect(subscriptionBucket({ status: 'free', live: true })).toBeNull();
  });
  it('summarize: disjoint buckets within the total', () => {
    const r = summarize([g({ n: 3, live: true }), g({ status: 'trialing', trial: 'future', n: 2 }), g({ state: 'suspended', live: true, n: 1 }), g({ status: 'none', n: 4 }),
      g({ status: 'past_due', grace: 'past', live: true, n: 1 })], NOW);
    expect(r.tenants).toEqual({ total: 11, active: 3, trial: 2, suspended: 1 });
    expect(r.subscriptions).toEqual({ active: 4, trialing: 0, pastDue: 1 }); // suspended active row is still a subscription
  });
});

describe('alerts and status', () => {
  const ok: StatusSignals = {
    database: true, queriesFailed: false, databaseDownSince: null, migrationsApplied: true, workerLastSeen: new Date(NOW.getTime() - 10_000), workerStale: false,
    dispatchEnabled: true, dispatchChangedAt: null, outboxDead: 0, outboxDeadSince: null, outboxBacklog: 0, outboxBacklogSince: null,
    deliveriesStuck: 0, deliveriesStuckSince: null, billingWebhooksFailing: 0, billingWebhooksSince: null,
  };
  const base = 'https://relay.example.com';
  it('operational with no alerts', () => {
    expect(buildAlerts(ok, { now: NOW, base })).toEqual({ status: 'operational', alerts: [] });
  });
  it('degraded: one alert per reason, since from the data (clamped to now), critical first, own-host links', () => {
    const r = buildAlerts({ ...ok, outboxDead: 2, outboxDeadSince: new Date('2026-11-09T08:00:00Z'), workerStale: true, workerLastSeen: new Date('2026-11-10T11:50:00Z'),
      billingWebhooksFailing: 1, billingWebhooksSince: new Date('2026-11-10T13:00:00Z') }, { now: NOW, base });
    expect(r.status).toBe('degraded');
    expect(r.alerts.map((a) => a.severity)).toEqual(['critical', 'warning', 'warning']);
    expect(r.alerts[0]).toEqual({ severity: 'critical', title: 'No worker heartbeat in the last 2 minutes', since: '2026-11-10T11:50:00.000Z', url: `${base}/admin/platform` });
    expect(r.alerts[1]!.since).toBe('2026-11-09T08:00:00.000Z');
    expect(r.alerts[2]).toMatchObject({ url: `${base}/admin/platform/billing`, since: NOW.toISOString() });
    const payload = valid({ status: r.status, alerts: r.alerts, checkedAt: NOW.toISOString() });
    expect(check(payload).ok).toBe(true);
  });
  it('down when the database fails; links null without https', () => {
    const r = buildAlerts({ ...ok, database: false, databaseDownSince: new Date('2026-11-10T11:58:00Z') }, { now: NOW, base: 'http://localhost:3000' });
    expect(r).toEqual({ status: 'down', alerts: [{ severity: 'critical', title: 'Database unreachable', since: '2026-11-10T11:58:00.000Z', url: null }] });
  });
  it('dispatch off, stuck deliveries, backlog, migrations', () => {
    const r = buildAlerts({ ...ok, dispatchEnabled: false, deliveriesStuck: 1, outboxBacklog: 5, migrationsApplied: false }, { now: NOW, base });
    expect(r.alerts.map((a) => a.title)).toEqual(['Database migrations not applied', 'Publishing dispatch is off for the installation',
      '1 publication stuck for over 2 minutes', '5 outbox events waiting over 5 minutes']);
  });
});

describe('config', () => {
  const env = { APP_ENV: 'development', DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv;
  it('tokens and environment are optional and validated without echoing values', () => {
    expect(loadConfig(env).RELAY_PLATFORM_STATUS_TOKEN).toBeUndefined();
    expect(loadConfig({ ...env, RELAY_PLATFORM_STATUS_TOKEN: '' }).RELAY_PLATFORM_STATUS_TOKEN).toBeUndefined();
    expect(loadConfig({ ...env, RELAY_PLATFORM_STATUS_TOKEN: 'a'.repeat(64), RELAY_ENVIRONMENT: 'staging' })).toMatchObject({ RELAY_ENVIRONMENT: 'staging' });
    const short = 'short-secret-value';
    try { loadConfig({ ...env, RELAY_PLATFORM_STATUS_TOKEN: short }); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain('RELAY_PLATFORM_STATUS_TOKEN');
      expect((e as Error).message).not.toContain(short);
    }
    expect(() => loadConfig({ ...env, RELAY_ENVIRONMENT: 'Staging' })).toThrow(/RELAY_ENVIRONMENT/);
    expect(() => loadConfig({ ...env, RELAY_PLATFORM_STATUS_TOKEN_PREVIOUS: 'b'.repeat(64) })).toThrow(/PREVIOUS is set without/);
  });
});
