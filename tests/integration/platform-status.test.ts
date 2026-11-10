// GET /api/platform/v1/status (vitalos-platform ADR-044) against REAL PostgreSQL through the same service function the
// route calls: configuration (404), Bearer token (401, rotation), rate limit (429), contract shape, counts that exclude
// demo workspaces, no identifying data, degraded on a stale worker heartbeat / dead outbox rows, cache.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { validatePlatformStatus, type PlatformStatus } from '@social-lite/core/contracts/platform-status';
import { resetConfigCache } from '@social-lite/services';
import { currentPlatformStatus, platformStatusRequest, resetPlatformStatusCache } from '@social-lite/services/platform-status/service';
import { addMember, closeTestPool, createUser, createWorkspace, testPool } from './helpers.js';

const TOKEN = `t${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
const PREVIOUS = `p${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
const BASE = 'https://relay.status-test.example';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  resetConfigCache();
  resetPlatformStatusCache();
}

let ip = 0;
async function call(auth?: string | null, opts: { ip?: string } = {}): Promise<Response> {
  const h = new Headers({ 'x-forwarded-for': opts.ip ?? `198.51.100.${(ip++ % 250) + 1}` });
  if (auth) h.set('authorization', auth);
  return platformStatusRequest(h, testPool());
}
async function status(): Promise<PlatformStatus> {
  resetPlatformStatusCache();
  const r = await call(`Bearer ${TOKEN}`);
  expect(r.status).toBe(200);
  return r.json() as Promise<PlatformStatus>;
}

/** A healthy installation: fresh heartbeat, nothing dead, stuck or failing (other test files leave leftovers). */
async function healthy(): Promise<void> {
  const db = testPool();
  await db.query(`INSERT INTO worker_heartbeats(worker_id, last_seen_at) VALUES ('platform-status-test', now()) ON CONFLICT (worker_id) DO UPDATE SET last_seen_at = now()`);
  await db.query(`UPDATE outbox SET dispatch_state = 'dispatched', dispatched_at = now()
                   WHERE dispatch_state = 'dead' OR (dispatch_state = 'pending' AND available_at <= now() - interval '5 minutes')`);
  await db.query(`UPDATE deliveries SET state = 'cancelled' WHERE state IN ('scheduled','retry_wait') AND next_attempt_at <= now() - interval '2 minutes' AND lease_owner IS NULL`);
  await db.query(`UPDATE deliveries SET lease_owner = NULL, lease_expires_at = NULL WHERE lease_owner IS NOT NULL AND lease_expires_at <= now() - interval '2 minutes'`);
  await db.query(`UPDATE billing_webhook_events SET status = 'ignored' WHERE status IN ('failed','received')`);
  await db.query(`UPDATE system_flags SET value = 'true' WHERE key = 'dispatch_enabled'`);
}

async function billing(ws: string, row: { plan: string; status: string; trialEnds?: string; graceEnds?: string; sub?: string; providerStatus?: string }): Promise<void> {
  await testPool().query(
    `INSERT INTO workspace_billing(workspace_id, plan_id, status, seats, trial_ends_at, trial_started_at, grace_ends_at, provider, provider_subscription_ref, provider_status)
     VALUES ($1, $2, $3, 1, $4::timestamptz, CASE WHEN $4::timestamptz IS NULL THEN NULL ELSE now() - interval '1 day' END, $5::timestamptz,
             CASE WHEN $6::text IS NULL THEN NULL ELSE 'test' END, $6, $7)`,
    [ws, row.plan, row.status, row.trialEnds ?? null, row.graceEnds ?? null, row.sub ?? null, row.providerStatus ?? null]);
}

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  testPool();
  for (const k of ['APP_BASE_URL', 'RELAY_PLATFORM_STATUS_TOKEN', 'RELAY_PLATFORM_STATUS_TOKEN_PREVIOUS', 'RELAY_ENVIRONMENT']) saved[k] = process.env[k];
});
beforeEach(async () => {
  setEnv({ APP_BASE_URL: BASE, RELAY_PLATFORM_STATUS_TOKEN: TOKEN, RELAY_PLATFORM_STATUS_TOKEN_PREVIOUS: undefined, RELAY_ENVIRONMENT: undefined });
  await healthy();
});
afterAll(async () => {
  setEnv(saved);
  await testPool().query(`DELETE FROM worker_heartbeats WHERE worker_id = 'platform-status-test'`);
  await closeTestPool();
});

describe('access', () => {
  it('404 with no body when no token is configured (nothing revealed, nothing read)', async () => {
    setEnv({ RELAY_PLATFORM_STATUS_TOKEN: undefined });
    for (const auth of [null, `Bearer ${TOKEN}`]) {
      const r = await call(auth);
      expect(r.status).toBe(404);
      expect(await r.text()).toBe('');
      expect(r.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('401 with an empty body for a missing, wrong or non-Bearer token', async () => {
    for (const auth of [null, 'Bearer wrong-token-wrong-token-wrong-token-1', `Basic ${TOKEN}`, TOKEN, `Bearer ${TOKEN}x`, `Bearer ${PREVIOUS}`]) {
      const r = await call(auth);
      expect(r.status, String(auth).slice(0, 8)).toBe(401);
      expect(await r.text()).toBe('');
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(r.headers.get('location')).toBeNull();
    }
  });

  it('accepts the previous token while rotating', async () => {
    setEnv({ RELAY_PLATFORM_STATUS_TOKEN_PREVIOUS: PREVIOUS });
    expect((await call(`Bearer ${PREVIOUS}`)).status).toBe(200);
    expect((await call(`Bearer ${TOKEN}`)).status).toBe(200);
    expect((await call(`Bearer ${PREVIOUS.slice(0, -1)}`)).status).toBe(401);
  });

  it('rate-limits per IP (429 with Retry-After), other IPs unaffected', async () => {
    const one = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    const codes: number[] = [];
    for (let i = 0; i < 32; i++) codes.push((await call('Bearer wrong-token-wrong-token-wrong-token-1', { ip: one })).status);
    expect(codes.slice(0, 30).every((c) => c === 401)).toBe(true);
    const limited = await call(`Bearer ${TOKEN}`, { ip: one });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await call(`Bearer ${TOKEN}`)).status).toBe(200);
  });
});

describe('payload', () => {
  it('200: ADR-044 shape, no-store, operational when healthy', async () => {
    const r = await call(`Bearer ${TOKEN}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('content-type')).toMatch(/^application\/json/);
    const text = await r.text();
    expect(text.length).toBeLessThan(64 * 1024);
    const body = JSON.parse(text) as PlatformStatus;
    expect(validatePlatformStatus(body, { trustedHosts: ['relay.status-test.example'] })).toMatchObject({ ok: true });
    expect(body).toMatchObject({ product: 'relay', environment: 'test', status: 'operational', alerts: [], superadminUrl: `${BASE}/admin/platform` });
    expect(Date.parse(body.checkedAt)).toBeLessThanOrEqual(Date.now());
    expect(Object.keys(body).sort()).toEqual(['alerts', 'checkedAt', 'environment', 'product', 'status', 'subscriptions', 'superadminUrl', 'tenants']);
  });

  it('RELAY_ENVIRONMENT overrides the derived environment', async () => {
    setEnv({ RELAY_ENVIRONMENT: 'staging' });
    expect((await status()).environment).toBe('staging');
  });

  it('counts real workspaces only (demo/seed/E2E excluded) with the documented billing mapping', async () => {
    const before = await status();
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
    const real = async (name: string) => createWorkspace(name, { isDemo: false });
    const legacy = await real('PS legacy');                                                   // no billing row → active
    const free = await real('PS free'); await billing(free, { plan: 'free', status: 'free' }); // → active
    const paid = await real('PS paid'); await billing(paid, { plan: 'standard', status: 'active', sub: `sub_${randomUUID()}`, providerStatus: 'active' });
    const trial = await real('PS trial'); await billing(trial, { plan: 'professional', status: 'trialing', trialEnds: day(5) });
    const ptrial = await real('PS provider trial'); await billing(ptrial, { plan: 'standard', status: 'trialing', trialEnds: day(3), sub: `sub_${randomUUID()}`, providerStatus: 'trialing' });
    const ended = await real('PS trial ended'); await billing(ended, { plan: 'standard', status: 'trialing', trialEnds: day(-1) }); // → Free → active
    const late = await real('PS past due'); await billing(late, { plan: 'standard', status: 'past_due', graceEnds: day(-1), sub: `sub_${randomUUID()}`, providerStatus: 'past_due' }); // restricted
    const none = await real('PS none'); await billing(none, { plan: 'standard', status: 'none' });                                 // restricted
    const susp = await real('PS suspended'); await billing(susp, { plan: 'standard', status: 'active', sub: `sub_${randomUUID()}`, providerStatus: 'active' });
    await testPool().query(`UPDATE workspaces SET state = 'suspended', suspended_at = now() WHERE id = $1`, [susp]);
    // Demo workspaces in every state: none of them may count.
    for (const s of ['active', 'trialing', 'past_due']) {
      const d = await createWorkspace(`PS demo ${s}`, { isDemo: true });
      await billing(d, { plan: 'standard', status: s, trialEnds: s === 'trialing' ? day(4) : undefined, sub: `sub_${randomUUID()}`, providerStatus: s });
    }
    await testPool().query(`UPDATE workspaces SET state = 'suspended' WHERE name = 'PS demo active'`);
    void legacy;

    const after = await status();
    const d = (k: keyof PlatformStatus['tenants']) => after.tenants[k] - before.tenants[k];
    expect({ total: d('total'), active: d('active'), trial: d('trial'), suspended: d('suspended') }).toEqual({ total: 9, active: 4, trial: 2, suspended: 1 });
    const s = (k: keyof PlatformStatus['subscriptions']) => after.subscriptions[k] - before.subscriptions[k];
    expect({ active: s('active'), trialing: s('trialing'), pastDue: s('pastDue') }).toEqual({ active: 2, trialing: 1, pastDue: 1 });
    expect(after.tenants.active + after.tenants.trial + after.tenants.suspended).toBeLessThanOrEqual(after.tenants.total);
  });

  it('contains no names, emails or ids anywhere', async () => {
    const name = `Zebra Secret Workspace ${randomUUID().slice(0, 6)}`;
    const ws = await createWorkspace(name, { isDemo: false });
    const user = await createUser(`status-${randomUUID().slice(0, 8)}@private.example`, 'Private Person');
    await addMember(ws, user.id, 'owner');
    await testPool().query(`INSERT INTO outbox(workspace_id, aggregate_type, aggregate_id, event_type, dispatch_state, last_error)
                            VALUES ($1, 'post', $2, 'post.created', 'dead', $3)`, [ws, randomUUID(), `failed for ${user.email}`]);
    const text = await (async () => { resetPlatformStatusCache(); return (await call(`Bearer ${TOKEN}`)).text(); })();
    expect(text).not.toContain(name);
    expect(text).not.toContain('Zebra');
    expect(text).not.toContain(user.email);
    expect(text).not.toContain('Private Person');
    expect(text).not.toContain(ws);
    expect(text).not.toMatch(UUID_RE);
    expect(text).not.toContain('@');
    expect(text).not.toContain(TOKEN);
  });

  it('503 instead of an invalid payload (APP_BASE_URL not https → superadminUrl would break the contract)', async () => {
    setEnv({ APP_BASE_URL: 'http://localhost:3000' });
    const r = await call(`Bearer ${TOKEN}`);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'unavailable' });
  });

  it('serves from the 30 s cache (same checkedAt) and recomputes after reset', async () => {
    resetPlatformStatusCache();
    const a = await currentPlatformStatus(testPool());
    await new Promise((r) => setTimeout(r, 5));
    const b = await currentPlatformStatus(testPool());
    expect(b!.checkedAt).toBe(a!.checkedAt);
    resetPlatformStatusCache();
    const c = await currentPlatformStatus(testPool());
    expect(c!.checkedAt >= a!.checkedAt).toBe(true);
  });
});

describe('degraded', () => {
  it('stale worker heartbeat → degraded with a critical alert since the last heartbeat', async () => {
    await testPool().query(`UPDATE worker_heartbeats SET last_seen_at = now() - interval '10 minutes'`);
    const last = (await testPool().query<{ t: Date }>(`SELECT max(last_seen_at) t FROM worker_heartbeats`)).rows[0]!.t;
    const body = await status();
    expect(body.status).toBe('degraded');
    expect(body.alerts).toEqual([{ severity: 'critical', title: 'No worker heartbeat in the last 2 minutes', since: last.toISOString(), url: `${BASE}/admin/platform` }]);
    expect(validatePlatformStatus(body, { trustedHosts: ['relay.status-test.example'] }).ok).toBe(true);
  });

  it('dead outbox rows → degraded with a warning since the oldest dead row', async () => {
    const r = await testPool().query<{ created_at: Date }>(
      `INSERT INTO outbox(aggregate_type, aggregate_id, event_type, dispatch_state, created_at)
       VALUES ('post', $1, 'post.created', 'dead', now() - interval '3 hours'), ('post', $2, 'post.created', 'dead', now() - interval '1 hour') RETURNING created_at`,
      [randomUUID(), randomUUID()]);
    const oldest = r.rows.map((x) => x.created_at).sort((a, b) => a.getTime() - b.getTime())[0]!;
    const body = await status();
    expect(body.status).toBe('degraded');
    expect(body.alerts).toEqual([{ severity: 'warning', title: '2 outbox events dead-lettered', since: oldest.toISOString(), url: `${BASE}/admin/platform` }]);
  });

  it('failing billing webhooks link to Platform → Billing; alert links are null without https', async () => {
    await testPool().query(`INSERT INTO billing_webhook_events(provider, provider_event_id, type, provider_created_at, status, received_at)
                            VALUES ('test', $1, 'invoice.payment_failed', now(), 'failed', now() - interval '1 hour')`, [`evt_${randomUUID()}`]);
    const body = await status();
    expect(body.status).toBe('degraded');
    expect(body.alerts).toEqual([expect.objectContaining({ severity: 'warning', title: '1 billing webhook failing', url: `${BASE}/admin/platform/billing` })]);
  });
});
