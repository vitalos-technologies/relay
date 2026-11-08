// V4 stream ENT — entitlements, usage and restriction policy through the REAL services and Postgres (brief §12–13,
// acceptance §18 items 13, 14, 15, 16 and the enforcement half of 11/12). Billing facts are injected through the
// entitlement source seam (the billing stream's getBillingState shape); everything else is the production path.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { toLocalInput } from '@social-lite/core';
import type { BillingState } from '@social-lite/core/contracts/v4-billing';
import type { PlanId } from '@social-lite/core/contracts/v4-plans';
import { claimDelivery, createPost, processDelivery, publishNow, schedulePost, getApprovalPolicy, saveApprovalPolicy, type Ctx } from '@social-lite/services';
import { activityCsv, consumeUsage, readMeterUsage, reserveUsage, settleUsage, updateWorkspaceLimits, getWorkspaceLimits } from '@social-lite/services/product/index';
import { createUploadIntent } from '@social-lite/services/media/assets';
import { connectMock } from '@social-lite/services/connections/index';
import { createSearch } from '@social-lite/services/listening/searches';
import { createPolicy } from '@social-lite/services/automation/policies';
import { handleEvent } from '@social-lite/services/engine/notify';
import { setBillingStateSourceForTests, stubBillingState } from '@social-lite/services/entitlements/source';
import { entitlementsCore, invalidateEntitlements, deriveEntitlements } from '@social-lite/services/entitlements/resolve';
import { reevaluateHolds, sweepEntitlementHolds } from '@social-lite/services/entitlements/holds';
import { listSelections, setSelection, workspaceEntitlements } from '@social-lite/services/entitlements/usage';
import { chargeMcpCall } from '@social-lite/services/entitlements/actions';
import { applyOverride, platformEntitlements, revokeOverride } from '@social-lite/services/entitlements/overrides';
import type { PlatformCtx } from '@social-lite/services/admin/platform';
import { withTx } from '@social-lite/db';
import { closeTestPool, createUser, tenant, testPool, v2Ctx } from './helpers.js';
import { scriptedWorld, seedConnections } from './engine-helpers.js';

const db = () => testPool();

// ------------------------------------------------------------------ billing state injection (BIL contract shape)
const states = new Map<string, Partial<BillingState>>();
beforeAll(() => {
  testPool();
  setBillingStateSourceForTests(async (q, ws) => {
    const base = await stubBillingState(q, ws);
    const p = states.get(ws);
    return p ? { ...base, ...p, service_suspended: base.service_suspended || !!p.service_suspended } : base;
  });
});
afterEach(() => invalidateEntitlements());
afterAll(async () => { setBillingStateSourceForTests(null); await closeTestPool(); });

const DAY = 86_400_000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
function onPlan(ws: string, plan: PlanId, extra: Partial<BillingState> = {}) {
  states.set(ws, { plan_id: plan, status: 'active', seats: 1, current_period: { start: iso(-DAY), end: iso(29 * DAY) }, access: 'full', access_reason: null, ...extra });
}
function restrict(ws: string, plan: PlanId = 'professional', reason = 'A payment failed. Update your payment details to resume paid actions.') {
  onPlan(ws, plan, { status: 'past_due', access: 'restricted', access_reason: reason, grace_ends_at: iso(-DAY) });
}
function onTrial(ws: string, plan: PlanId) {
  states.set(ws, { plan_id: plan, status: 'trialing', seats: 1, trial: { started_at: iso(-2 * DAY), ends_at: iso(12 * DAY), plan_id: plan }, current_period: null, access: 'full', access_reason: null });
}

async function operator(role: 'operator' | 'support' | 'billing' = 'operator', fresh = true): Promise<PlatformCtx> {
  const u = await createUser(`op-${randomUUID().slice(0, 8)}@relay.test`);
  // 'billing' is added by the billing migration; until then operator rows are seeded as 'operator' and the ctx role is set.
  await db().query(`INSERT INTO platform_operators(user_id, role, granted_via) VALUES ($1,$2,'seed')`, [u.id, role === 'billing' ? 'operator' : role]).catch(() => undefined);
  return { actor: { userId: u.id, email: u.email, name: 'Op', sessionId: randomUUID() }, role: role as PlatformCtx['role'], assurance: { mfaVerified: fresh, authTime: fresh ? new Date() : null }, correlationId: randomUUID() };
}

const counter = async (ws: string, meter: string) => {
  const r = await db().query<{ used: string; reserved: string; period: string }>(`SELECT used, reserved, period FROM usage_counters WHERE workspace_id=$1 AND meter=$2 AND team_id IS NULL ORDER BY period DESC LIMIT 1`, [ws, meter]);
  return { used: Number(r.rows[0]?.used ?? 0), reserved: Number(r.rows[0]?.reserved ?? 0), period: r.rows[0]?.period ?? null };
};

async function scheduled(t: Awaited<ReturnType<typeof tenant>>, connectionId: string, text: string, inMs = 3600_000) {
  const { id } = await createPost(t.ownerCtx, t.brandId, { draft: { baseText: text, baseLink: null, baseAssetIds: [], variants: [{ connectionId, inheritText: true, inheritMedia: true }] } }, randomUUID());
  await schedulePost(t.ownerCtx, id, { expected_version: 1, connection_ids: [connectionId], input_local_time: toLocalInput(new Date(Date.now() + inMs), 'Europe/London'), timezone: 'Europe/London' }, randomUUID());
  return id;
}
const deliveryOf = async (postId: string) => (await db().query<{ id: string; state: string; last_error_code: string | null; blocked_reason: string | null }>(`SELECT id, state, last_error_code, blocked_reason FROM deliveries WHERE post_id=$1`, [postId])).rows[0]!;
const makeDue = (postId: string) => db().query(`UPDATE deliveries SET next_attempt_at=now() - interval '1 second' WHERE post_id=$1`, [postId]);

async function ownerTenant() {
  const t = await tenant();
  return { ...t, ctx: await v2Ctx(t.owner.id, t.workspaceId) };
}

// ======================================================================
describe('resolution: legacy keeps everything; plans map features + allowances', () => {
  it('a workspace without billing records is legacy: full access, Professional features, unmetered by plan, calendar period', async () => {
    const t = await ownerTenant();
    const core = await entitlementsCore(db(), t.workspaceId);
    expect(core.plan?.id).toBe('legacy');
    expect(core.access).toBe('full');
    expect(Object.values(core.features).every((f) => f.enabled)).toBe(true);
    expect(Object.values(core.limits).every((l) => l.limit === null)).toBe(true);
    expect(core.period.key).toBe(new Date().toISOString().slice(0, 7));
    // the pre-V4 AI safety default still applies (no plan ceiling)
    expect((await readMeterUsage(t.workspaceId, 'ai.tokens')).cap).toBe(200_000);
    const dto = await workspaceEntitlements(t.ctx);
    expect(dto.allowances.every((a) => a.overage === 'none')).toBe(true);
  });

  it('Standard vs Professional capability mapping; seats scale allowances; trial = bounded allowances in one bucket', async () => {
    const s = await ownerTenant();
    onPlan(s.workspaceId, 'standard', { seats: 3 });
    const core = await entitlementsCore(db(), s.workspaceId);
    expect(core.features.publishing.enabled).toBe(true);
    expect(core.features.listening.enabled).toBe(false);
    expect(core.features.mcp.enabled).toBe(false);
    expect(core.features.support).toEqual({ enabled: true, source: 'always' });
    expect(core.limits.social_accounts.limit).toBe(5 + 3 * 3);
    expect(core.period.key.startsWith('p:')).toBe(true);
    const tr = await ownerTenant();
    onTrial(tr.workspaceId, 'professional');
    const tc = await entitlementsCore(db(), tr.workspaceId);
    expect(tc.trialActive).toBe(true);
    expect(tc.limits.ai_tokens).toEqual({ limit: 100_000, included: 100_000, source: 'trial' });
    expect(tc.limits.x_writes.limit).toBe(0); // paid third-party API not included in trials
    expect(tc.period).toMatchObject({ kind: 'trial', resets_at: null });
    expect(tc.period.key.startsWith('trial:')).toBe(true);
  });

  it('a customer-supplied plan name or flag grants nothing: only billing state + audited overrides decide', () => {
    const b = { workspace_id: randomUUID(), plan_id: 'enterprise' as never, plan_version_id: null, status: 'active' as const, seats: 1, trial: null, current_period: null, cancel_at: null,
      scheduled_change: null, grace_ends_at: null, service_suspended: false, access: 'full' as const, access_reason: null, as_of: new Date().toISOString() };
    const core = deriveEntitlements(b, []);
    expect(core.plan).toBeNull();
    expect(core.access).toBe('restricted');
    expect(core.features.publishing.enabled).toBe(false);
  });
});

// ======================================================================
describe('allowances: plan ceilings under customer budgets, durable deduplicated usage, race-free last unit (§18.14)', () => {
  it('customer caps can lower but never raise the plan allowance; the binding limit is named', async () => {
    const t = await ownerTenant();
    onPlan(t.workspaceId, 'standard'); // exports: 20 / period
    await updateWorkspaceLimits(t.ctx, { monthly_exports: 1000 });
    const view = await getWorkspaceLimits(t.ctx);
    const ex = view.items.find((i) => i.key === 'monthly_exports')!;
    expect(ex).toMatchObject({ cap: 1000, plan_limit: 20, effective_cap: 20 });
    await db().query(`INSERT INTO usage_counters(workspace_id, meter, period, used) VALUES ($1,'exports.count',$2,20)`, [t.workspaceId, (await entitlementsCore(db(), t.workspaceId)).period.key]);
    await expect(reserveUsage({ workspaceId: t.workspaceId, meter: 'exports.count', amount: 1 })).rejects.toMatchObject({ code: 'budget_exhausted', details: { limit_source: 'plan', cap: 20 } });
    await updateWorkspaceLimits(t.ctx, { monthly_exports: 5 });
    await expect(reserveUsage({ workspaceId: t.workspaceId, meter: 'exports.count', amount: 1 })).rejects.toMatchObject({ code: 'budget_exhausted', details: { limit_source: 'customer', cap: 5 } });
  });

  it('concurrent consumers of the last units: exactly the allowance succeeds (no overage, no double count)', async () => {
    const t = await ownerTenant();
    onPlan(t.workspaceId, 'professional');
    const op = await operator('operator');
    await applyOverride(op, t.workspaceId, { kind: 'allowance', key: 'exports', limit: 3, reason: 'Test: three exports this period' });
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => reserveUsage({ workspaceId: t.workspaceId, meter: 'exports.count', amount: 1 })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason.code === 'budget_exhausted')).toBe(true);
    for (const r of results) if (r.status === 'fulfilled') await settleUsage(r.value.id, 1);
    expect(await counter(t.workspaceId, 'exports.count')).toMatchObject({ used: 3, reserved: 0 });
    // ledger: one durable event per settled reservation, in the billing period bucket
    const ev = await db().query<{ n: number; period: string }>(`SELECT count(*)::int n, min(period) period FROM usage_events WHERE workspace_id=$1 AND meter='exports.count'`, [t.workspaceId]);
    expect(ev.rows[0]).toMatchObject({ n: 3, period: expect.stringMatching(/^p:/) });
    // settling again is a no-op (idempotent) and writes no second event
    const first = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ id: string }>;
    expect(await settleUsage(first.value.id, 1)).toBe(false);
    expect((await db().query(`SELECT count(*)::int n FROM usage_events WHERE workspace_id=$1`, [t.workspaceId])).rows[0].n).toBe(3);
  });

  it('a gauge (connected accounts) admits exactly one of many concurrent connects for the last slot', async () => {
    const t = await ownerTenant();
    onPlan(t.workspaceId, 'professional');
    await connectMock(t.ctx, t.brandId, { provider: 'facebook', display_name: 'First' });
    await applyOverride(await operator(), t.workspaceId, { kind: 'allowance', key: 'social_accounts', limit: 2, reason: 'Test: two accounts allowed' });
    const tries = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => connectMock(t.ctx, t.brandId, { provider: 'telegram', display_name: `Try ${i}` })));
    expect(tries.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((tries.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'entitlement_required', details: { reason: 'allowance_exhausted', allowance: 'social_accounts' } });
    expect((await db().query(`SELECT count(*)::int n FROM connections WHERE workspace_id=$1 AND disconnected_at IS NULL`, [t.workspaceId])).rows[0].n).toBe(2);
  });

  it('deduplicated consumption: the same key is charged once (MCP retry with the same idempotency key)', async () => {
    const t = await ownerTenant();
    onPlan(t.workspaceId, 'professional');
    const key = randomUUID();
    await chargeMcpCall(t.workspaceId, { tool: 'create_draft', readOnly: false, userId: t.owner.id, dedupeKey: key });
    await chargeMcpCall(t.workspaceId, { tool: 'create_draft', readOnly: false, userId: t.owner.id, dedupeKey: key });
    await chargeMcpCall(t.workspaceId, { tool: 'list_posts', readOnly: true, userId: t.owner.id });
    expect((await counter(t.workspaceId, 'mcp.calls')).used).toBe(2);
    const r1 = await withTx((tx) => consumeUsage(tx, { workspaceId: t.workspaceId, meter: 'integration.jobs', amount: 1, dedupeKey: 'sync:abc' }));
    const r2 = await withTx((tx) => consumeUsage(tx, { workspaceId: t.workspaceId, meter: 'integration.jobs', amount: 1, dedupeKey: 'sync:abc' }));
    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual({ ok: true, duplicate: true });
    expect((await counter(t.workspaceId, 'integration.jobs')).used).toBe(1);
    // the ledger is append-only for the app role (roles.sql) — checked by the role test; here: unique per key
    await expect(db().query(`INSERT INTO usage_events(workspace_id, meter, period, amount, dedupe_key, source) VALUES ($1,'integration.jobs','x',1,'sync:abc','consume')`, [t.workspaceId]))
      .rejects.toMatchObject({ code: '23505' });
  });

  it('reset policy: trial usage is one bucket; the subscription period starts a fresh bucket', async () => {
    const t = await ownerTenant();
    onTrial(t.workspaceId, 'professional');
    const r = await reserveUsage({ workspaceId: t.workspaceId, meter: 'ai.tokens', amount: 1000 });
    await settleUsage(r.id, 900);
    expect((await counter(t.workspaceId, 'ai.tokens')).period).toMatch(/^trial:/);
    onPlan(t.workspaceId, 'professional', { current_period: { start: iso(0), end: iso(30 * DAY) } });
    const u = await readMeterUsage(t.workspaceId, 'ai.tokens');
    expect(u).toMatchObject({ used: 0, cap: 500_000 + 200_000 });
    expect(u.period).toMatch(/^p:/);
  });
});

// ======================================================================
describe('restriction: paid actions held, read/billing/support/exports kept (§18.11, §18.15)', () => {
  it('uploads, AI and publish-now are refused with the reason; timed scheduling, exports and reconciliation reads continue', async () => {
    const t = await ownerTenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    restrict(t.workspaceId);
    await expect(createUploadIntent(t.ctx, { brand_id: t.brandId, filename: 'a.png', content_type: 'image/png', bytes: 100 }))
      .rejects.toMatchObject({ code: 'entitlement_required', status: 402, details: { reason: 'access_restricted' } });
    await expect(reserveUsage({ workspaceId: t.workspaceId, meter: 'ai.tokens', amount: 10 })).rejects.toMatchObject({ code: 'entitlement_required' });
    const { id } = await createPost(t.ctx, t.brandId, { draft: { baseText: 'Hello', baseLink: null, baseAssetIds: [], variants: [{ connectionId: conns.facebook, inheritText: true, inheritMedia: true }] } }, randomUUID());
    await expect(publishNow(t.ctx, id, { expected_version: 1, connection_ids: [conns.facebook] }, randomUUID())).rejects.toMatchObject({ code: 'entitlement_required' });
    await schedulePost(t.ctx, id, { expected_version: 1, connection_ids: [conns.facebook], input_local_time: toLocalInput(new Date(Date.now() + 7200_000), 'Europe/London'), timezone: 'Europe/London' }, randomUUID());
    const csv = await activityCsv(t.ctx, {});
    expect(csv.rows).toBeGreaterThanOrEqual(0);
    expect(await withTx((tx) => consumeUsage(tx, { workspaceId: t.workspaceId, meter: 'x.read', amount: 1 }))).toEqual({ ok: true });
    const dto = await workspaceEntitlements(t.ctx);
    expect(dto.access).toBe('restricted');
    expect(dto.features.support.enabled).toBe(true);
    expect(dto.reasons[0]).toMatch(/payment failed/i);
  });

  it('a staff suspension stays a suspension (not overridable); an access override lifts only a billing restriction, with expiry', async () => {
    const t = await ownerTenant();
    restrict(t.workspaceId);
    const op = await operator();
    await expect(applyOverride(op, t.workspaceId, { kind: 'access', key: 'full', reason: 'Card update pending with customer', expires_at: iso(40 * DAY) })).rejects.toMatchObject({ code: 'validation_failed' });
    await applyOverride(op, t.workspaceId, { kind: 'access', key: 'full', reason: 'Card update pending with customer', expires_at: iso(3 * DAY) });
    expect((await entitlementsCore(db(), t.workspaceId)).access).toBe('full');
    await db().query(`UPDATE workspaces SET state='suspended' WHERE id=$1`, [t.workspaceId]);
    expect((await entitlementsCore(db(), t.workspaceId)).access).toBe('suspended');
    await db().query(`UPDATE workspaces SET state='active' WHERE id=$1`, [t.workspaceId]);
    // expired overrides stop applying without a job
    await db().query(`UPDATE entitlement_overrides SET expires_at=now() - interval '1 second', created_at=created_at - interval '1 day' WHERE workspace_id=$1`, [t.workspaceId]);
    expect((await entitlementsCore(db(), t.workspaceId)).access).toBe('restricted');
  });
});

// ======================================================================
describe('dispatch-time re-check: scheduled posts held, released once, never duplicated (§18.13, §18.16)', () => {
  it('held while restricted (nothing sent); access returns via billing.access_changed ⇒ released and published exactly once', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const world = scriptedWorld();
    const a = await scheduled(t, conns.facebook, 'Held at dispatch');
    const b = await scheduled(t, conns.telegram, 'Held proactively');
    const c = await scheduled(t, conns.x, 'Already in flight');
    await db().query(`UPDATE deliveries SET state='unknown', needs_reconcile=true, unknown_since=now() WHERE post_id=$1`, [c]);
    restrict(t.workspaceId);
    await makeDue(a);
    expect(await processDelivery(world.deps, (await claimDelivery('w', { deliveryId: (await deliveryOf(a)).id }))!)).toBe('blocked');
    expect(await deliveryOf(a)).toMatchObject({ state: 'blocked', last_error_code: 'entitlement_hold', blocked_reason: expect.stringMatching(/^Held: .*payment failed/i) });
    expect(world.publishCalls.size).toBe(0);
    // proactive marking for waiting work; in-flight/unknown untouched (reconciliation rules preserved)
    const ev = await reevaluateHolds(t.workspaceId);
    expect(ev.held.deliveries).toBe(1);
    expect(await deliveryOf(b)).toMatchObject({ state: 'blocked', last_error_code: 'entitlement_hold' });
    expect((await deliveryOf(c)).state).toBe('unknown');
    // a reconnect of the account does NOT release an entitlement hold
    const { onConnectionRestored } = await import('@social-lite/services/engine/hooks');
    await withTx((tx) => onConnectionRestored(tx, conns.facebook));
    expect((await deliveryOf(a)).state).toBe('blocked');
    // the usage page shows the held work
    expect((await workspaceEntitlements(await v2Ctx(t.owner.id, t.workspaceId))).held.scheduled_posts).toBe(2);

    // access returns: BIL's outbox event reaches the worker's event router
    states.delete(t.workspaceId);
    await handleEvent({ event_type: 'billing.access_changed', workspace_id: t.workspaceId, aggregate_id: t.workspaceId, payload: {} });
    expect((await deliveryOf(a)).state).toBe('scheduled');
    expect((await deliveryOf(b)).state).toBe('scheduled');
    const wake = await db().query(`SELECT count(*)::int n FROM outbox WHERE workspace_id=$1 AND event_type='delivery.due'`, [t.workspaceId]);
    expect(wake.rows[0].n).toBeGreaterThanOrEqual(2);
    for (const p of [a, b]) {
      await makeDue(p);
      const d = await claimDelivery('w', { deliveryId: (await deliveryOf(p)).id });
      expect(await processDelivery(world.deps, d!)).toBe('published');
      // a second claim finds nothing to send
      expect(await claimDelivery('w2', { deliveryId: (await deliveryOf(p)).id })).toBeNull();
    }
    expect([...world.publishCalls.values()]).toEqual([1, 1]);
    expect((await deliveryOf(c)).state).toBe('unknown');
    const audited = await db().query(`SELECT count(*)::int n FROM audit_events WHERE workspace_id=$1 AND action='entitlements.reevaluated'`, [t.workspaceId]);
    expect(audited.rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it('a hold past its publish-before deadline becomes Missed (never published late); the sweep releases after a missed event', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const late = await scheduled(t, conns.facebook, 'Too late now');
    const ok = await scheduled(t, conns.telegram, 'Still timely');
    restrict(t.workspaceId);
    await reevaluateHolds(t.workspaceId);
    await db().query(`UPDATE deliveries SET publish_before=now() - interval '1 minute' WHERE post_id=$1`, [late]);
    states.delete(t.workspaceId); // access returned but the event was lost
    expect(await sweepEntitlementHolds()).toBeGreaterThanOrEqual(1);
    expect(await deliveryOf(late)).toMatchObject({ state: 'expired', last_error_code: 'deadline_passed' });
    expect((await deliveryOf(ok)).state).toBe('scheduled');
  });
});

// ======================================================================
describe('plan features enforced server-side: Standard (§18.13)', () => {
  it('listening, automations, multi-step approvals and MCP are refused with an upgrade target; MCP read tools too', async () => {
    const t = await ownerTenant();
    onPlan(t.workspaceId, 'standard');
    await expect(createSearch(t.ctx, { brand_id: t.brandId, name: 'Comp', role: 'competitor', terms: ['acme'], keywords: [], exclusions: [], boolean: null, languages: [], sources: [], kinds: [] } as never))
      .rejects.toMatchObject({ code: 'entitlement_required', details: { reason: 'feature_not_in_plan', feature: 'listening', upgrade_to: 'professional' } });
    await expect(createPolicy(t.ctx, { name: 'Auto', brand_ids: [t.brandId], channel_ids: [randomUUID()], allowed_actions: ['assign'], reply_categories: [],
      limits: { max_actions_per_hour: 10, max_auto_replies_per_day: 1, monthly_token_budget: 0 }, escalation: { negative_sentiment: true, keywords: [] }, expires_at: iso(10 * DAY) }))
      .rejects.toMatchObject({ code: 'entitlement_required', details: { feature: 'automation' } });
    const cur = await getApprovalPolicy(t.ctx, t.brandId);
    const stage = { name: 'Review', quorum: 1, eligible_roles: [], eligible_team_ids: [], allow_guests: false };
    await expect(saveApprovalPolicy(t.ctx, t.brandId, { expected_generation: cur.generation, separation_of_duties: false, stages: [stage, { ...stage, name: 'Legal' }] } as never))
      .rejects.toMatchObject({ code: 'entitlement_required', details: { feature: 'approvals_advanced' } });
    await saveApprovalPolicy(t.ctx, t.brandId, { expected_generation: cur.generation, separation_of_duties: false, stages: [stage] } as never); // single stage is Standard
    await expect(chargeMcpCall(t.workspaceId, { tool: 'list_posts', readOnly: true, userId: t.owner.id })).rejects.toMatchObject({ code: 'entitlement_required', details: { feature: 'mcp' } });
  });

  it('a feature override (audited, step-up, operator/billing staff only) grants exactly that feature until revoked', async () => {
    const t = await ownerTenant();
    onPlan(t.workspaceId, 'standard');
    const sup = await operator('support');
    await expect(applyOverride(sup, t.workspaceId, { kind: 'feature', key: 'listening', enabled: true, reason: 'Pilot for a customer' })).rejects.toMatchObject({ code: 'forbidden' });
    const stale = await operator('operator', false);
    await expect(applyOverride(stale, t.workspaceId, { kind: 'feature', key: 'listening', enabled: true, reason: 'Pilot for a customer' })).rejects.toMatchObject({ code: 'step_up_required' });
    const bill = await operator('billing');
    await expect(applyOverride(bill, t.workspaceId, { kind: 'feature', key: 'listening', enabled: true, reason: 'short' })).rejects.toMatchObject({ name: 'ZodError' });
    const { id } = await applyOverride(bill, t.workspaceId, { kind: 'feature', key: 'listening', enabled: true, reason: 'Pilot for a customer', expires_at: iso(7 * DAY) });
    await createSearch(t.ctx, { brand_id: t.brandId, name: 'Pilot', role: 'own', terms: ['pilot'], keywords: [], exclusions: [], boolean: null, languages: [], sources: [], kinds: [] } as never);
    expect((await entitlementsCore(db(), t.workspaceId)).features.automation.enabled).toBe(false);
    const pa = await db().query(`SELECT action, reason FROM platform_audit_events WHERE workspace_id=$1 AND action LIKE 'entitlement.%'`, [t.workspaceId]);
    expect(pa.rows).toEqual([{ action: 'entitlement.override_applied', reason: 'Pilot for a customer' }]);
    const wa = await db().query(`SELECT count(*)::int n FROM audit_events WHERE workspace_id=$1 AND action='entitlement.override_applied'`, [t.workspaceId]);
    expect(wa.rows[0].n).toBe(1);
    const view = await platformEntitlements(sup, t.workspaceId); // support may read, not change
    expect(view).toMatchObject({ can_override: false, overrides: [expect.objectContaining({ id, status: 'active', created_by_email: bill.actor.email })] });
    await revokeOverride(bill, t.workspaceId, id, { reason: 'Pilot finished as agreed' });
    expect((await entitlementsCore(db(), t.workspaceId)).features.listening.enabled).toBe(false);
  });
});

// ======================================================================
describe('downgrade over the limit: the customer chooses what stays active; nothing deleted or disconnected', () => {
  it('oldest accounts stay active by default; held accounts hold publishing; choosing others moves the hold', async () => {
    const t = await ownerTenant();
    const conns = await seedConnections(t.workspaceId, t.brandId); // 4 accounts, created in order facebook, instagram?, telegram, x
    onPlan(t.workspaceId, 'professional');
    const p1 = await scheduled(t, conns.facebook, 'To facebook');
    const p2 = await scheduled(t, conns.x, 'To x');
    await applyOverride(await operator(), t.workspaceId, { kind: 'allowance', key: 'social_accounts', limit: 2, reason: 'Downgrade simulation in test' });
    const sel = (await listSelections(t.ctx)).items.find((i) => i.allowance === 'social_accounts')!;
    expect(sel).toMatchObject({ limit: 2, active_count: 2, over_limit: true });
    const activeIds = sel.items.filter((i) => i.active).map((i) => i.id);
    const heldId = sel.items.find((i) => !i.active)!.id;
    expect(activeIds).toHaveLength(2);
    // nothing disconnected
    expect((await db().query(`SELECT count(*)::int n FROM connections WHERE workspace_id=$1 AND disconnected_at IS NULL`, [t.workspaceId])).rows[0].n).toBe(4);
    // scheduling to a held account is refused with the reason
    const { id } = await createPost(t.ctx, t.brandId, { draft: { baseText: 'x', baseLink: null, baseAssetIds: [], variants: [{ connectionId: heldId, inheritText: true, inheritMedia: true }] } }, randomUUID());
    await expect(schedulePost(t.ctx, id, { expected_version: 1, connection_ids: [heldId], input_local_time: toLocalInput(new Date(Date.now() + 3600_000), 'Europe/London'), timezone: 'Europe/London' }, randomUUID()))
      .rejects.toMatchObject({ code: 'entitlement_required', details: { reason: 'over_limit_held' } });
    // the customer keeps x + telegram instead
    await setSelection(t.ctx, { allowance: 'social_accounts', resource_ids: [conns.x, conns.telegram] });
    expect((await deliveryOf(p1)).state).toBe('blocked');
    expect((await deliveryOf(p1)).last_error_code).toBe('entitlement_hold');
    expect((await deliveryOf(p2)).state).toBe('scheduled');
    await expect(setSelection(t.ctx, { allowance: 'social_accounts', resource_ids: [conns.x, conns.telegram, conns.facebook] })).rejects.toMatchObject({ code: 'validation_failed' });
    const audit = await db().query(`SELECT count(*)::int n FROM audit_events WHERE workspace_id=$1 AND action='entitlements.selection_updated'`, [t.workspaceId]);
    expect(audit.rows[0].n).toBe(1);
  });

  it('only billing managers choose (viewer refused)', async () => {
    const t = await ownerTenant();
    const viewer = await createUser();
    await db().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, [t.workspaceId, viewer.id]);
    await db().query(`INSERT INTO scoped_role_grants(workspace_id, principal_type, user_id, role, scope_type, source) VALUES ($1,'user',$2,'viewer','workspace','test')`, [t.workspaceId, viewer.id]);
    const v: Ctx = await v2Ctx(viewer.id, t.workspaceId);
    await expect(setSelection(v, { allowance: 'social_accounts', resource_ids: [] })).rejects.toMatchObject({ code: 'forbidden' });
    const dto = await workspaceEntitlements(v);
    expect(dto.allowances).toEqual([]); // members see plan/features/access only
    expect(dto.features.publishing.enabled).toBe(true);
  });
});
