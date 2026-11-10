// V4 billing (stream BIL) — brief §18 items 8–12 and 15 (billing part), V5 §5–8 (trial once, seats, handoff), against a real
// Postgres and the deterministic billing test double. Every activation goes through signed webhook ingestion.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '@social-lite/services/auth/session';
import { signPayload } from '@social-lite/providers/stripe/signature';
import { getBillingState, workspaceCommercialSummary } from '@social-lite/services/billing/state';
import { applyChange, billingOverview, cancelRenewal, previewChange, reactivateRenewal, refreshBilling, startCheckout, startTrial, changeTrialPlan, openPortal } from '@social-lite/services/billing/manage';
import { signupWorkspace } from '@social-lite/services/billing/signup';
import { ingestWebhook } from '@social-lite/services/billing/webhooks';
import { completeTestCheckout, deliverTestEvents, simulateSubscription, testWebhookSecret } from '@social-lite/services/billing/test-provider';
import { billingProviderStatus, setBillingProviderForTests } from '@social-lite/services/billing/provider';
import { runBillingSweeps } from '@social-lite/services/billing/reconcile';
import { billableSeats, seatCount } from '@social-lite/services/billing/seats';
import { sweepTrials } from '@social-lite/services/billing/trials';
import { platformBillingDetail, scheduleLifecycleAction, staffExtendTrial, listPlatformBilling } from '@social-lite/services/billing/platform';
import { catalogueHash, planVersionDefinition } from '@social-lite/services/billing/catalogue-def';
import { createInvitation } from '@social-lite/services/auth/invitations';
import type { PlatformCtx } from '@social-lite/services/admin/platform';
import { addMember, closeTestPool, createUser, createWorkspace, grant, testPool, v2Ctx } from './helpers.js';

beforeAll(() => { testPool(); delete process.env.RELAY_STRIPE_SECRET_KEY; delete process.env.RELAY_STRIPE_WEBHOOK_SECRET; setBillingProviderForTests(undefined); });
afterAll(async () => { await closeTestPool(); });

async function signupTenant(plan: 'free' | 'standard' | 'professional' = 'standard') {
  const u = await createUser();
  const { session } = await createSession(testPool(), u.id, {});
  const actor = { userId: u.id, email: u.email, name: 'Owner', sessionId: session.id };
  const r = await signupWorkspace(session, actor, { name: `Acme ${randomUUID().slice(0, 6)}`, timezone: 'Europe/London', plan });
  const ws = r.workspace.id;
  return { ws, owner: u, ctx: () => v2Ctx(u.id, ws) };
}

const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await testPool().query(sql, p)).rows as T[];
const billing = async (ws: string) => (await q<Record<string, unknown>>(`SELECT * FROM workspace_billing WHERE workspace_id=$1`, [ws]))[0]!;
const outboxCount = async (ws: string, type: string) => Number((await q<{ n: string }>(`SELECT count(*) n FROM outbox WHERE workspace_id=$1 AND event_type=$2`, [ws, type]))[0]!.n);
const sessionRef = (url: string) => new URL(url).searchParams.get('session')!;

async function subscribe(t: Awaited<ReturnType<typeof signupTenant>>, plan: 'standard' | 'professional' = 'standard', seats?: number) {
  const c = await startCheckout(await t.ctx(), { plan, ...(seats ? { seats } : {}) });
  await completeTestCheckout(sessionRef(c.url), 'paid');
  return c;
}

/** End the no-card trial without waiting 14 days (move the workspace's trial window into the past), then run the sweep. */
async function expireTrial(ws: string) {
  await testPool().query(`UPDATE workspace_billing SET trial_started_at=date_trunc('second', now()) - interval '14 days 1 second', trial_ends_at=date_trunc('second', now()) - interval '1 second' WHERE workspace_id=$1`, [ws]);
  await sweepTrials(testPool());
}

async function staff(role: 'operator' | 'support' | 'billing', fresh = true): Promise<PlatformCtx> {
  const u = await createUser(`staff-${randomUUID().slice(0, 8)}@relay.test`);
  await testPool().query(`INSERT INTO platform_operators(user_id, role, granted_via) VALUES ($1,$2,'seed')`, [u.id, role]);
  return { actor: { userId: u.id, email: u.email, name: 'Staff', sessionId: randomUUID() }, role, assurance: { mfaVerified: fresh, authTime: fresh ? new Date() : null }, correlationId: randomUUID() };
}

describe('catalogue and migration behaviour', () => {
  it('persisted plan versions match the catalogue file (Free £0, Standard £5, Professional £15); old versions retired, not changed; versions immutable', async () => {
    const rows = await q<{ plan_id: string; catalogue_hash: string; unit_amount_minor: number | null; purchasable: boolean }>(`SELECT plan_id, catalogue_hash, unit_amount_minor, purchasable FROM billing_plan_versions WHERE retired_at IS NULL ORDER BY plan_id`);
    expect(rows.map((r) => r.plan_id).sort()).toEqual(['free', 'legacy', 'professional', 'standard']);
    for (const r of rows) expect(r.catalogue_hash).toBe(catalogueHash(planVersionDefinition(r.plan_id as 'standard')));
    expect(rows.find((r) => r.plan_id === 'free')).toMatchObject({ unit_amount_minor: 0, purchasable: false });
    expect(rows.find((r) => r.plan_id === 'standard')!.unit_amount_minor).toBe(500);
    expect(rows.find((r) => r.plan_id === 'professional')!.unit_amount_minor).toBe(1500);
    expect(rows.find((r) => r.plan_id === 'legacy')!.unit_amount_minor).toBeNull();
    // the V4 prices stay as retired versions (subscriptions bound to them keep them)
    const old = await q<{ plan_id: string; version: number; unit_amount_minor: number }>(`SELECT plan_id, version, unit_amount_minor FROM billing_plan_versions WHERE retired_at IS NOT NULL AND plan_id IN ('standard','professional') ORDER BY plan_id`);
    expect(old.map((o) => [o.plan_id, o.version, o.unit_amount_minor])).toEqual([['professional', 1, 2500], ['standard', 1, 1000]]);
    await expect(testPool().query(`UPDATE billing_plan_versions SET unit_amount_minor=1 WHERE plan_id='standard'`)).rejects.toThrow(/immutable/);
    // test-double prices for every purchasable version; Free never has a provider price
    expect((await q(`SELECT 1 FROM billing_provider_prices WHERE provider='test'`)).length).toBe(4);
    expect((await q(`SELECT 1 FROM billing_provider_prices p JOIN billing_plan_versions v ON v.id=p.plan_version_id WHERE v.plan_id='free'`)).length).toBe(0);
  });

  it('a generic STRIPE_SECRET_KEY from the host environment is never used (only RELAY_STRIPE_* configure Stripe)', () => {
    const prev = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = 'sk_test_not_this_projects_key';
    try { expect(billingProviderStatus()).toMatchObject({ provider: 'test', configured: true, test_mode: true }); } finally {
      if (prev === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = prev;
    }
    process.env.RELAY_STRIPE_SECRET_KEY = 'sk_test_relay_unit';
    try { expect(billingProviderStatus()).toMatchObject({ provider: 'stripe', configured: false, missing: ['RELAY_STRIPE_WEBHOOK_SECRET'] }); } finally { delete process.env.RELAY_STRIPE_SECRET_KEY; }
  });

  it('a workspace created outside signup reads as legacy with full access (nothing existing changes)', async () => {
    const ws = await createWorkspace('Pre-V4');
    const s = await getBillingState(testPool(), ws);
    expect(s).toMatchObject({ plan_id: 'legacy', status: 'legacy', access: 'full', trial: null, service_suspended: false });
  });
});

describe('trials (V5 §7)', () => {
  it('signup starts exactly one 14-day no-card trial on the selected plan; joins, plan switches and replays never restart or extend it', async () => {
    const t = await signupTenant('professional');
    const b = await billing(t.ws);
    expect(b).toMatchObject({ status: 'trialing', plan_id: 'professional', trial_plan_id: 'professional' });
    const len = (b.trial_ends_at as Date).getTime() - (b.trial_started_at as Date).getTime();
    expect(len).toBe(14 * 86400_000);
    const red = (await q(`SELECT * FROM billing_trial_redemptions WHERE workspace_id=$1`, [t.ws]))[0]!;
    expect(red).toMatchObject({ plan_id: 'professional', redeemed_by: t.owner.id, source: 'signup' });
    // replay / refresh: a second start is refused
    await expect(startTrial(await t.ctx(), { plan: 'standard' })).rejects.toMatchObject({ code: 'conflict' });
    // a member joining does not touch the trial
    const m = await createUser(); await addMember(t.ws, m.id, 'editor');
    // switching plan keeps the end date
    await changeTrialPlan(await t.ctx(), { plan: 'standard' });
    const after = await billing(t.ws);
    expect(after.plan_id).toBe('standard');
    expect((after.trial_ends_at as Date).getTime()).toBe((b.trial_ends_at as Date).getTime());
    expect((await q(`SELECT count(*)::int n FROM billing_trial_redemptions WHERE workspace_id=$1`, [t.ws]))[0]!.n).toBe(1);
    // the redemption row cannot be moved backwards or deleted
    await expect(testPool().query(`UPDATE billing_trial_redemptions SET ends_at=started_at + interval '1 day' WHERE workspace_id=$1`, [t.ws])).rejects.toThrow();
    await expect(testPool().query(`DELETE FROM billing_trial_redemptions WHERE workspace_id=$1`, [t.ws])).rejects.toThrow();
  });

  it('D33: trial expiry moves the workspace to Free (full access within Free limits, nothing deleted); trial_expired emitted once', async () => {
    const t = await signupTenant();
    await expireTrial(t.ws);
    await expireTrial(t.ws); // idempotent
    const s = await getBillingState(testPool(), t.ws);
    expect(s).toMatchObject({ status: 'free', plan_id: 'free', access: 'full', access_reason: null, seats: 0, current_period: null });
    expect(s.trial).toMatchObject({ plan_id: 'standard' }); // history kept
    expect(await billing(t.ws)).toMatchObject({ status: 'free', plan_id: 'free', provider_customer_ref: null, provider_subscription_ref: null });
    expect(await outboxCount(t.ws, 'billing.trial_expired')).toBe(1);
    expect(await outboxCount(t.ws, 'billing.subscription_changed')).toBeGreaterThanOrEqual(1); // entitlements re-evaluate holds
    // billing remains available; upgrade = checkout straight to paid (the trial was used)
    const ov = await billingOverview(await t.ctx());
    expect(ov.state.access).toBe('full');
    expect(ov.plan).toMatchObject({ id: 'free', unit_amount_minor: 0 });
    expect(ov.recurring_total_minor).toBe(0);
    expect(ov.actions).toMatchObject({ checkout: true, start_trial: false, portal: false, cancel: false });
    expect(ov.upgrade_trial_days).toBe(0);
    const c = await startCheckout(await t.ctx(), { plan: 'standard' });
    expect(new Date(c.first_charge_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('a stale trialing row past its end already reads as Free before the sweep runs', async () => {
    const t = await signupTenant('professional');
    await testPool().query(`UPDATE workspace_billing SET trial_ends_at=now() - interval '1 second' WHERE workspace_id=$1`, [t.ws]);
    expect(await getBillingState(testPool(), t.ws)).toMatchObject({ status: 'free', plan_id: 'free', access: 'full' });
  });

  it('the trial-ending notice is emitted once, three days before the end', async () => {
    const t = await signupTenant();
    const b = await billing(t.ws);
    const twoDaysBefore = new Date((b.trial_ends_at as Date).getTime() - 2 * 86400_000);
    await sweepTrials(testPool(), twoDaysBefore);
    await sweepTrials(testPool(), twoDaysBefore);
    expect(await outboxCount(t.ws, 'billing.trial_ending')).toBe(1);
  });
});

describe('checkout (§18 items 8, 9)', () => {
  it('§18.8 a trial becomes active only after a verified test checkout; first charge = trial end; repeated clicks reuse one session', async () => {
    const t = await signupTenant();
    const c1 = await startCheckout(await t.ctx(), { plan: 'standard' });
    const c2 = await startCheckout(await t.ctx(), { plan: 'standard' });
    expect(c2.url).toBe(c1.url);
    expect(c2.reused).toBe(true);
    expect((await q(`SELECT count(*)::int n FROM billing_checkout_sessions WHERE workspace_id=$1 AND status='open'`, [t.ws]))[0]!.n).toBe(1);
    const b = await billing(t.ws);
    expect(new Date(c1.first_charge_at).getTime()).toBe((b.trial_ends_at as Date).getTime());
    expect(c1.recurring_total_minor).toBe(500); // 1 billable user × £5
    expect((await billing(t.ws)).provider_subscription_ref).toBeNull();
    await completeTestCheckout(sessionRef(c1.url), 'paid');
    const after = await billing(t.ws);
    expect(after.provider_subscription_ref).toMatch(/^sub_test_/);
    expect(after.status).toBe('trialing'); // free period preserved: provider trial until the original end
    expect((after.current_period_end as Date).getTime()).toBe((b.trial_ends_at as Date).getTime());
    expect(after.payment_method).toMatchObject({ brand: 'visa', last4: '4242' });
    // the provider trial ends → first charge → active
    await simulateSubscription(String(after.provider_subscription_ref), 'renew');
    expect((await billing(t.ws)).status).toBe('active');
    expect(await outboxCount(t.ws, 'billing.subscription_activated')).toBe(1);
    // a second checkout is refused while subscribed
    await expect(startCheckout(await t.ctx(), { plan: 'standard' })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('after the trial, checkout charges immediately and activates (3 Professional users = £45)', async () => {
    const t = await signupTenant('professional');
    for (let i = 0; i < 2; i++) { const m = await createUser(); await addMember(t.ws, m.id, 'editor'); }
    await expireTrial(t.ws);
    const c = await startCheckout(await t.ctx(), { plan: 'professional' });
    expect(c.seats).toBe(3);
    expect(c.recurring_total_minor).toBe(4500);
    await completeTestCheckout(sessionRef(c.url), 'paid');
    const s = await getBillingState(testPool(), t.ws);
    expect(s).toMatchObject({ status: 'active', plan_id: 'professional', seats: 3, access: 'full' });
    const inv = await q<{ amount_paid_minor: number }>(`SELECT amount_paid_minor FROM billing_invoices WHERE workspace_id=$1`, [t.ws]);
    expect(inv[0]!.amount_paid_minor).toBe(4500);
  });

  it('§18.9 a forged checkout redirect / unsigned or mis-signed events never activate a plan', async () => {
    const t = await signupTenant();
    await expireTrial(t.ws);
    const c = await startCheckout(await t.ctx(), { plan: 'standard' });
    // the customer "returns" to the success URL without paying: the page reconciles from the provider → still open
    await refreshBilling(await t.ctx());
    expect((await getBillingState(testPool(), t.ws)).status).toBe('free');
    // forged events: unsigned, wrong secret, stale timestamp
    const sub = { id: 'sub_test_forged000000000000', object: 'subscription', customer: (await billing(t.ws)).provider_customer_ref, status: 'active', items: { data: [{ id: 'si_x', price: { id: 'price_test_standard_v1' }, quantity: 1, current_period_start: 1, current_period_end: 2 }] }, metadata: { relay_workspace_id: t.ws } };
    const evt = { id: `evt_test_forged${randomUUID().slice(0, 8)}`, object: 'event', type: 'customer.subscription.created', created: Math.floor(Date.now() / 1000), livemode: false, data: { object: sub } };
    const raw = JSON.stringify(evt);
    await expect(ingestWebhook(raw, null)).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(ingestWebhook(raw, signPayload(raw, 'whsec_attacker'))).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(ingestWebhook(raw, signPayload(raw, testWebhookSecret(), Math.floor(Date.now() / 1000) - 3600))).rejects.toMatchObject({ code: 'unauthenticated' });
    expect((await q(`SELECT 1 FROM billing_webhook_events WHERE provider_event_id=$1`, [evt.id])).length).toBe(0);
    // even a correctly signed event is not trusted for its payload: the subscription is re-fetched and does not exist
    const r = await ingestWebhook(raw, signPayload(raw, testWebhookSecret()));
    expect(r.status).toBe('ignored');
    expect((await getBillingState(testPool(), t.ws)).status).toBe('free');
    // the real completion still works
    await completeTestCheckout(sessionRef(c.url), 'paid');
    expect((await getBillingState(testPool(), t.ws)).status).toBe('active');
  });

  it('a declined first payment leaves the subscription incomplete, never active — the workspace keeps Free meanwhile (D33)', async () => {
    const t = await signupTenant();
    await expireTrial(t.ws);
    const c = await startCheckout(await t.ctx(), { plan: 'standard' });
    await completeTestCheckout(sessionRef(c.url), 'declined');
    const s = await getBillingState(testPool(), t.ws);
    expect(s.status).toBe('incomplete');
    expect(s).toMatchObject({ plan_id: 'free', access: 'full' });
  });

  it('concurrent checkout clicks never create two sessions', async () => {
    const t = await signupTenant();
    const results = await Promise.allSettled([1, 2, 3].map(async () => startCheckout(await t.ctx(), { plan: 'standard' })));
    const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof startCheckout>>> => r.status === 'fulfilled').map((r) => r.value.url);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok).size).toBe(1);
    expect((await q(`SELECT count(*)::int n FROM billing_checkout_sessions WHERE workspace_id=$1 AND status IN ('open','pending')`, [t.ws]))[0]!.n).toBe(1);
  });
});

describe('§18.10 duplicate and out-of-order webhooks', () => {
  it('produce one consistent state and one activation event', async () => {
    const t = await signupTenant();
    await expireTrial(t.ws);
    const c = await startCheckout(await t.ctx(), { plan: 'standard' });
    const events = await completeTestCheckout(sessionRef(c.url), 'paid', { deliver: false });
    const reversed = [...events].reverse();
    await deliverTestEvents(reversed);
    await deliverTestEvents(events); // duplicates
    await deliverTestEvents([events[1]!, events[1]!]);
    const s = await getBillingState(testPool(), t.ws);
    expect(s).toMatchObject({ status: 'active', plan_id: 'standard', seats: 1 });
    expect((await q(`SELECT count(*)::int n FROM billing_webhook_events WHERE workspace_id=$1`, [t.ws]))[0]!.n).toBe(3);
    expect(await outboxCount(t.ws, 'billing.subscription_activated')).toBe(1);
    const dup = await ingestWebhook(JSON.stringify(events[0]), signPayload(JSON.stringify(events[0]), testWebhookSecret()));
    expect(dup.duplicate).toBe(true);
    // an OLD "active" snapshot delivered after a newer failure still converges on provider truth (re-fetch)
    const sub = String((await billing(t.ws)).provider_subscription_ref);
    const failed = await simulateSubscription(sub, 'fail_payment', { deliver: false });
    await deliverTestEvents(failed);
    await deliverTestEvents([events[1]!]); // replayed (already processed) — no effect
    const stale = { ...events[1]!, id: `evt_test_${randomUUID().replace(/-/g, '').slice(0, 20)}` }; // a distinct late event with an old snapshot
    await deliverTestEvents([stale]);
    expect((await billing(t.ws)).status).toBe('past_due');
  });
});

describe('§18.11 failed payment and recovery policy', () => {
  it('past due keeps access through the 7-day grace, then restricts; recovery restores access', async () => {
    const t = await signupTenant();
    await expireTrial(t.ws);
    await subscribe(t);
    const sub = String((await billing(t.ws)).provider_subscription_ref);
    await simulateSubscription(sub, 'fail_payment');
    let b = await billing(t.ws);
    expect(b.status).toBe('past_due');
    expect((b.grace_ends_at as Date).getTime() - (b.past_due_since as Date).getTime()).toBe(7 * 86400_000);
    expect((await getBillingState(testPool(), t.ws)).access).toBe('full');
    expect(await outboxCount(t.ws, 'billing.payment_failed')).toBe(1);
    // grace runs out → the sweep persists restricted + access_changed
    await testPool().query(`UPDATE workspace_billing SET grace_ends_at=now() - interval '1 minute' WHERE workspace_id=$1`, [t.ws]);
    const before = await outboxCount(t.ws, 'billing.access_changed');
    await runBillingSweeps();
    b = await billing(t.ws);
    expect(b.access_level).toBe('restricted');
    expect(await outboxCount(t.ws, 'billing.access_changed')).toBe(before + 1);
    // the customer fixes payment → recovered, grace cleared, full access
    await simulateSubscription(sub, 'recover');
    b = await billing(t.ws);
    expect(b).toMatchObject({ status: 'active', access_level: 'full', grace_ends_at: null, past_due_since: null });
    expect(await outboxCount(t.ws, 'billing.payment_recovered')).toBe(1);
  });

  it('an authentication request (SCA) shows payment_action_required; paying clears it', async () => {
    const t = await signupTenant();
    await expireTrial(t.ws);
    await subscribe(t);
    const sub = String((await billing(t.ws)).provider_subscription_ref);
    await simulateSubscription(sub, 'require_action');
    expect((await billing(t.ws)).status).toBe('payment_action_required');
    await simulateSubscription(sub, 'recover');
    expect((await billing(t.ws)).status).toBe('active');
  });
});

describe('§18.12 upgrade, downgrade, seats, cancellation, reactivation', () => {
  it('upgrade applies now with a provider proration preview; downgrade is scheduled for period end and keeps access until then', async () => {
    const t = await signupTenant();
    await expireTrial(t.ws);
    await subscribe(t, 'standard');
    const ctx = await t.ctx();
    const pv = await previewChange(ctx, { plan: 'professional', seats: 1 });
    expect(pv.kind).toBe('immediate');
    expect(pv.to.recurring_minor).toBe(1500);
    expect(pv.proration_minor).toBeGreaterThan(0);
    expect(pv.proration_minor).toBeLessThanOrEqual(1000);
    const b0 = await billing(t.ws);
    await applyChange(ctx, { plan: 'professional', seats: 1, proration_date: pv.proration_date, expected_version: b0.version as number }, randomUUID());
    expect((await getBillingState(testPool(), t.ws)).plan_id).toBe('professional');
    // stale expected_version is refused
    await expect(applyChange(await t.ctx(), { plan: 'standard', seats: 1, expected_version: b0.version as number }, randomUUID())).rejects.toMatchObject({ code: 'conflict' });
    // downgrade
    const pd = await previewChange(await t.ctx(), { plan: 'standard', seats: 1 });
    expect(pd.kind).toBe('scheduled');
    expect(pd.proration_minor).toBe(0);
    const b1 = await billing(t.ws);
    await applyChange(await t.ctx(), { plan: 'standard', seats: 1, expected_version: b1.version as number }, randomUUID());
    let s = await getBillingState(testPool(), t.ws);
    expect(s.plan_id).toBe('professional'); // until period end
    expect(s.scheduled_change).toMatchObject({ plan_id: 'standard' });
    expect(new Date(s.scheduled_change!.effective_at).getTime()).toBe((b1.current_period_end as Date).getTime());
    // the provider already bills the lower price at renewal; at the boundary Relay switches the plan
    const sub = String(b1.provider_subscription_ref);
    await simulateSubscription(sub, 'renew');
    await testPool().query(`UPDATE workspace_billing SET scheduled_effective_at=now() - interval '1 second' WHERE workspace_id=$1`, [t.ws]);
    s = await getBillingState(testPool(), t.ws);
    expect(s.plan_id).toBe('standard'); // derived on read at the effective instant
    const sw = await runBillingSweeps();
    expect(sw, JSON.stringify(sw)).toMatchObject({ reconcile: expect.any(Number) });
    expect((await billing(t.ws)), JSON.stringify(await billing(t.ws))).toMatchObject({ plan_id: 'standard', scheduled_effective_at: null });
  });

  it('mixed changes are refused; seat increases charge prorated now; seats never drop below billable users', async () => {
    const t = await signupTenant();
    await expireTrial(t.ws);
    await subscribe(t, 'standard', 2);
    const ctx = await t.ctx();
    await expect(previewChange(ctx, { plan: 'professional', seats: 1 })).rejects.toMatchObject({ code: 'validation_failed' });
    const pv = await previewChange(ctx, { plan: 'standard', seats: 3 });
    expect(pv.kind).toBe('immediate');
    expect(pv.to.recurring_minor).toBe(1500);
    const b = await billing(t.ws);
    await applyChange(ctx, { plan: 'standard', seats: 3, proration_date: pv.proration_date, expected_version: b.version as number }, randomUUID());
    expect((await billing(t.ws)).seats).toBe(3);
    const m = await createUser(); await addMember(t.ws, m.id, 'editor');
    await expect(previewChange(await t.ctx(), { plan: 'standard', seats: 1 })).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('cancel at period end keeps service until then, reactivation undoes it, and the end moves to Free without deleting (D33)', async () => {
    const t = await signupTenant();
    await expireTrial(t.ws);
    await subscribe(t);
    await cancelRenewal(await t.ctx());
    let s = await getBillingState(testPool(), t.ws);
    expect(s.status).toBe('cancel_scheduled');
    expect(s.access).toBe('full');
    expect(s.cancel_at).toBeTruthy();
    await reactivateRenewal(await t.ctx());
    expect((await getBillingState(testPool(), t.ws)).status).toBe('active');
    await cancelRenewal(await t.ctx());
    await simulateSubscription(String((await billing(t.ws)).provider_subscription_ref), 'renew'); // period ends → provider cancels
    s = await getBillingState(testPool(), t.ws);
    expect(s).toMatchObject({ status: 'free', plan_id: 'free', access: 'full' });
    expect(await billing(t.ws)).toMatchObject({ status: 'free', provider_status: 'canceled' }); // provider refs kept as history
    expect(await outboxCount(t.ws, 'billing.subscription_ended')).toBe(1);
    expect((await q(`SELECT 1 FROM workspaces WHERE id=$1 AND state='active'`, [t.ws])).length).toBe(1); // not deleted, not suspended
    // resubscribe later (no new trial)
    const c = await startCheckout(await t.ctx(), { plan: 'standard' });
    expect(new Date(c.first_charge_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('portal links are provider-hosted and only for billing managers', async () => {
    const t = await signupTenant();
    await subscribe(t);
    const p = await openPortal(await t.ctx(), { flow: 'payment_method_update' });
    expect(p.url).toMatch(/\/billing-test\/portal\?session=bps_test_/);
    const viewer = await createUser(); await addMember(t.ws, viewer.id, 'viewer');
    await expect(openPortal(await v2Ctx(viewer.id, t.ws), {})).rejects.toMatchObject({ code: 'forbidden' });
    await expect(billingOverview(await v2Ctx(viewer.id, t.ws))).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('seats (V5 §5)', () => {
  it('counts owner + active members; excludes pending invites, support operators, disabled accounts; guests free up to 5', async () => {
    const t = await signupTenant();
    const ed = await createUser(); await addMember(t.ws, ed.id, 'editor');
    const dis = await createUser(); await addMember(t.ws, dis.id, 'viewer');
    await testPool().query(`UPDATE users SET disabled_at=now() WHERE id=$1`, [dis.id]);
    const brand = (await q<{ id: string }>(`SELECT id FROM brands WHERE workspace_id=$1`, [t.ws]))[0]!.id;
    const guests: string[] = [];
    for (let i = 0; i < 6; i++) {
      const g = await createUser();
      await testPool().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, [t.ws, g.id]);
      await grant(t.ws, g.id, 'guest', brand, new Date(Date.now() + 86400_000));
      guests.push(g.id);
    }
    const op = await createUser();
    await testPool().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, [t.ws, op.id]);
    await testPool().query(`INSERT INTO support_access_grants(workspace_id, operator_user_id, reason, duration_minutes, status, request_expires_at, starts_at, expires_at, created_membership)
                            VALUES ($1,$2,'Investigating a ticket',60,'active',now()+interval '1 day',now(),now()+interval '1 hour',true)`, [t.ws, op.id]);
    const c = await seatCount(testPool(), t.ws);
    expect(c).toMatchObject({ members: 2, free_guests: 5, billable_guests: 1, support_operators: 1, billable: 3 });
    expect(await billableSeats(testPool(), t.ws)).toBe(3);
  });

  it('with a paid subscription and no free seat, invitations are refused (cost shown in Billing), never silently billed', async () => {
    const t = await signupTenant();
    await expireTrial(t.ws);
    await subscribe(t, 'standard', 2);
    const ctx = await t.ctx();
    const ok = await createInvitation(ctx, { email: `a-${randomUUID().slice(0, 6)}@test.social-lite.test`, role: 'editor' } as never, randomUUID());
    expect(ok.status).toBe(201);
    await expect(createInvitation(await t.ctx(), { email: `b-${randomUUID().slice(0, 6)}@test.social-lite.test`, role: 'editor' } as never, randomUUID()))
      .rejects.toMatchObject({ code: 'conflict', details: { reason: 'seat_limit', paid_seats: 2 } });
    expect((await billing(t.ws)).seats).toBe(2);
  });
});

describe('platform billing administration (§14)', () => {
  it('billing staff read the record with provider references; support staff cannot; summary for support has no provider refs', async () => {
    const t = await signupTenant();
    await subscribe(t);
    const bil = await staff('billing');
    const d = await platformBillingDetail(bil, t.ws);
    expect(d.provider.subscription_ref).toMatch(/^sub_test_/);
    expect(d.lifecycle.some((e) => e.kind === 'trial_started')).toBe(true);
    expect(d.trial?.redeemed_by).toBe(t.owner.email);
    await expect(platformBillingDetail(await staff('support'), t.ws)).rejects.toMatchObject({ code: 'forbidden' });
    const list = await listPlatformBilling(bil, { status: 'trialing' });
    expect(list.items.some((i) => i.workspace_id === t.ws)).toBe(true);
    const sum = await workspaceCommercialSummary(t.ws);
    expect(JSON.stringify(sum)).not.toMatch(/sub_test_|cus_test_|4242/);
    expect(sum.plan.name).toBe('Standard');
  });

  it('trial extension needs a fresh sign-in, is bounded, audited twice, and never applies to a subscribed workspace', async () => {
    const t = await signupTenant();
    await expireTrial(t.ws);
    await expect(staffExtendTrial(await staff('billing', false), t.ws, { days: 7, reason: 'Customer asked for more time' })).rejects.toMatchObject({ code: 'step_up_required' });
    await expect(staffExtendTrial(await staff('support'), t.ws, { days: 7, reason: 'Customer asked for more time' })).rejects.toMatchObject({ code: 'forbidden' });
    const r = await staffExtendTrial(await staff('billing'), t.ws, { days: 7, reason: 'Customer asked for more time' });
    expect(new Date(r.trial_ends_at).getTime()).toBeGreaterThan(Date.now() + 6 * 86400_000);
    expect((await getBillingState(testPool(), t.ws))).toMatchObject({ status: 'trialing', access: 'full' });
    expect((await q(`SELECT 1 FROM platform_audit_events WHERE workspace_id=$1 AND action='billing.trial_extended'`, [t.ws])).length).toBe(1);
    expect((await q(`SELECT 1 FROM audit_events WHERE workspace_id=$1 AND action='platform.billing_trial_extended'`, [t.ws])).length).toBe(1);
    await subscribe(t);
    await expect(staffExtendTrial(await staff('operator'), t.ws, { days: 3, reason: 'Customer asked for more time' })).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('a scheduled service suspension runs from the sweep and does not cancel billing (suspension ≠ cancellation)', async () => {
    const t = await signupTenant();
    await expireTrial(t.ws);
    await subscribe(t);
    const op = await staff('operator');
    await expect(scheduleLifecycleAction(await staff('billing'), t.ws, { action: 'suspend', run_at: new Date(Date.now() + 3600_000).toISOString(), reason: 'Unpaid invoices for 30 days' })).rejects.toMatchObject({ code: 'forbidden' });
    const r = await scheduleLifecycleAction(op, t.ws, { action: 'suspend', run_at: new Date(Date.now() + 3600_000).toISOString(), reason: 'Unpaid invoices for 30 days' });
    await testPool().query(`UPDATE billing_scheduled_actions SET run_at=now() - interval '1 second' WHERE id=$1`, [r.id]);
    await runBillingSweeps();
    expect((await q(`SELECT state FROM workspaces WHERE id=$1`, [t.ws]))[0]!.state).toBe('suspended');
    const s = await getBillingState(testPool(), t.ws);
    expect(s).toMatchObject({ status: 'active', service_suspended: true, access: 'suspended' });
    expect((await q(`SELECT 1 FROM platform_audit_events WHERE workspace_id=$1 AND action='workspace.suspended' AND actor_service='lifecycle-scheduler'`, [t.ws])).length).toBe(1);
  });
});

describe('retention', () => {
  it('a redemption cannot be deleted directly, but deleting the workspace cascades its billing records', async () => {
    const t = await signupTenant();
    await subscribe(t);
    await expect(testPool().query(`DELETE FROM billing_trial_redemptions WHERE workspace_id=$1`, [t.ws])).rejects.toThrow(/permanent/);
    await testPool().query(`DELETE FROM workspaces WHERE id=$1`, [t.ws]);
    for (const tbl of ['workspace_billing', 'billing_trial_redemptions', 'billing_lifecycle_events', 'billing_invoices', 'billing_checkout_sessions']) {
      expect((await q(`SELECT 1 FROM ${tbl} WHERE workspace_id=$1`, [t.ws])).length, tbl).toBe(0);
    }
  });
});

describe('getBillingState contract', () => {
  beforeEach(() => setBillingProviderForTests(undefined));
  it('returns every contract field with ISO dates', async () => {
    const t = await signupTenant();
    const s = await getBillingState(testPool(), t.ws);
    expect(Object.keys(s).sort()).toEqual(['access', 'access_reason', 'as_of', 'cancel_at', 'current_period', 'grace_ends_at', 'plan_id', 'plan_version_id', 'scheduled_change', 'seats', 'service_suspended', 'status', 'trial', 'workspace_id'].sort());
    expect(s.trial!.ends_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(s.plan_version_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('Free plan in billing (D33)', () => {
  it('/signup?plan=free creates the workspace on Free: no trial, no card, no provider objects; Free is never checked out', async () => {
    const t = await signupTenant('free');
    expect(await billing(t.ws)).toMatchObject({ status: 'free', plan_id: 'free', seats: 0, provider: null, provider_customer_ref: null, provider_subscription_ref: null, trial_started_at: null });
    expect((await q(`SELECT 1 FROM billing_trial_redemptions WHERE workspace_id=$1`, [t.ws])).length).toBe(0);
    expect((await q(`SELECT kind, source FROM billing_lifecycle_events WHERE workspace_id=$1`, [t.ws]))).toEqual([{ kind: 'free_started', source: 'signup' }]);
    const s = await getBillingState(testPool(), t.ws);
    expect(s).toMatchObject({ plan_id: 'free', status: 'free', access: 'full', trial: null, current_period: null, cancel_at: null });
    const ov = await billingOverview(await t.ctx());
    expect(ov).toMatchObject({ recurring_total_minor: 0, invoices: [], trial_used: false, upgrade_trial_days: 14, next_charge_at: null });
    expect(ov.actions).toMatchObject({ start_trial: true, checkout: true, portal: false, cancel: false, change_subscription: false, downgrade_to_free: false });
    expect(ov.catalogue.map((p) => p.id)).toEqual(['free', 'standard', 'professional']);
    // (ZodError = 422 validation_failed at the API)
    await expect(startCheckout(await t.ctx(), { plan: 'free' })).rejects.toMatchObject({ name: 'ZodError' });
    await expect(startTrial(await t.ctx(), { plan: 'free' })).rejects.toMatchObject({ name: 'ZodError' });
    await expect(previewChange(await t.ctx(), { plan: 'free', seats: 1 })).rejects.toMatchObject({ code: 'invalid_state' });
    expect((await q(`SELECT 1 FROM billing_test_objects WHERE kind='customer' AND data->'metadata'->>'relay_workspace_id'=$1`, [t.ws])).length).toBe(0);
    expect((await workspaceCommercialSummary(t.ws))).toMatchObject({ plan: { id: 'free', name: 'Free' }, status: 'free', renews_at: null, payment_issue: false });
  });

  it('onboarding without a plan starts on Free (documented default)', async () => {
    const { createWorkspace: createWs } = await import('@social-lite/services/workspaces');
    const u = await createUser();
    const { session } = await createSession(testPool(), u.id, {});
    const r = await createWs(session, { userId: u.id, email: u.email, name: 'Owner', sessionId: session.id }, { name: `Solo ${randomUUID().slice(0, 6)}`, timezone: 'Europe/London' });
    expect(await getBillingState(testPool(), r.workspace.id)).toMatchObject({ plan_id: 'free', status: 'free', access: 'full' });
  });

  it('upgrade from Free: checkout includes the never-used 14-day trial (first charge at its end) and redeems it once', async () => {
    const t = await signupTenant('free');
    const c = await startCheckout(await t.ctx(), { plan: 'professional' });
    const firstCharge = new Date(c.first_charge_at).getTime();
    expect(firstCharge).toBeGreaterThan(Date.now() + 13.9 * 86400_000);
    expect(c.recurring_total_minor).toBe(1500);
    expect((await q(`SELECT 1 FROM billing_trial_redemptions WHERE workspace_id=$1`, [t.ws])).length).toBe(0); // not used until confirmed
    await completeTestCheckout(sessionRef(c.url), 'paid');
    const s = await getBillingState(testPool(), t.ws);
    expect(s).toMatchObject({ status: 'trialing', plan_id: 'professional', access: 'full' });
    const red = (await q<{ source: string; redeemed_by: string; plan_id: string }>(`SELECT source, redeemed_by, plan_id FROM billing_trial_redemptions WHERE workspace_id=$1`, [t.ws]))[0]!;
    expect(red).toMatchObject({ source: 'settings', redeemed_by: t.owner.id, plan_id: 'professional' });
    const ov = await billingOverview(await t.ctx());
    expect(ov).toMatchObject({ trial_used: true, upgrade_trial_days: 0 });
    // the provider trial ends → first charge → active; a later return to Free never gets a second trial
    await simulateSubscription(String((await billing(t.ws)).provider_subscription_ref), 'renew');
    expect((await getBillingState(testPool(), t.ws)).status).toBe('active');
    await expect(startTrial(await t.ctx(), { plan: 'standard' })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('upgrade from Free with a no-card trial (Settings) also works once; at its end the workspace is back on Free', async () => {
    const t = await signupTenant('free');
    await startTrial(await t.ctx(), { plan: 'standard' });
    expect(await getBillingState(testPool(), t.ws)).toMatchObject({ status: 'trialing', plan_id: 'standard' });
    await expireTrial(t.ws);
    expect(await getBillingState(testPool(), t.ws)).toMatchObject({ status: 'free', plan_id: 'free' });
    await expect(startTrial(await t.ctx(), { plan: 'professional' })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('downgrade to Free = cancel renewal at period end: paid plan until then, Free after; nothing charged for Free', async () => {
    const t = await signupTenant();
    await expireTrial(t.ws);
    await subscribe(t, 'professional');
    const pv = await previewChange(await t.ctx(), { plan: 'free', seats: 1 });
    expect(pv).toMatchObject({ kind: 'scheduled', to: { plan_id: 'free', recurring_minor: 0 }, proration_minor: 0 });
    const b0 = await billing(t.ws);
    expect(new Date(pv.effective_at).getTime()).toBe((b0.current_period_end as Date).getTime());
    expect((await billingOverview(await t.ctx())).actions.downgrade_to_free).toBe(true);
    const r = await applyChange(await t.ctx(), { plan: 'free', seats: 1, expected_version: b0.version as number }, randomUUID());
    expect(r).toMatchObject({ kind: 'scheduled', plan_id: 'free' });
    let s = await getBillingState(testPool(), t.ws);
    expect(s).toMatchObject({ status: 'cancel_scheduled', plan_id: 'professional', access: 'full' });
    // at the period end the provider ends the subscription → Free (the clock alone already reads Free)
    await testPool().query(`UPDATE workspace_billing SET cancel_at=now() - interval '1 second' WHERE workspace_id=$1`, [t.ws]);
    expect(await getBillingState(testPool(), t.ws)).toMatchObject({ status: 'free', plan_id: 'free', access: 'full' });
    await simulateSubscription(String(b0.provider_subscription_ref), 'renew');
    s = await getBillingState(testPool(), t.ws);
    expect(s).toMatchObject({ status: 'free', plan_id: 'free', access: 'full' });
    const invoicesAfter = await q<{ total_minor: number }>(`SELECT total_minor FROM billing_invoices WHERE workspace_id=$1 AND provider_created_at > $2`, [t.ws, b0.current_period_end]);
    expect(invoicesAfter.every((i) => i.total_minor === 0)).toBe(true);
  });

  it('an existing subscription keeps its plan version and price (no silent repricing): a V4 Standard subscription still bills £10', async () => {
    const t = await signupTenant();
    await expireTrial(t.ws);
    await subscribe(t, 'standard');
    // simulate a subscription bought before migration 040: bound to Standard v1 (£10) and its provider price
    const v1 = (await q<{ id: string }>(`SELECT id FROM billing_plan_versions WHERE plan_id='standard' AND version=1`))[0]!.id;
    const sub = String((await billing(t.ws)).provider_subscription_ref);
    await testPool().query(`UPDATE billing_test_objects SET data=jsonb_set(data, '{items,data,0,price,id}', '"price_test_standard_v1"') WHERE kind='subscription' AND ref=$1`, [sub]);
    await testPool().query(`UPDATE workspace_billing SET plan_version_id=$2, provider_price_ref='price_test_standard_v1' WHERE workspace_id=$1`, [t.ws, v1]);
    await simulateSubscription(sub, 'renew'); // a renewal re-applies provider state
    expect(await billing(t.ws)).toMatchObject({ plan_version_id: v1, provider_price_ref: 'price_test_standard_v1' });
    const ov = await billingOverview(await t.ctx());
    expect(ov.plan).toMatchObject({ id: 'standard', unit_amount_minor: 1000, version: 1 });
    expect(ov.recurring_total_minor).toBe(1000);
    // new checkouts use the current version (£5)
    expect((await q<{ unit_amount_minor: number }>(`SELECT unit_amount_minor FROM billing_plan_versions WHERE plan_id='standard' AND retired_at IS NULL`))[0]!.unit_amount_minor).toBe(500);
  });

  it('Platform → Billing lists Free workspaces; staff can extend an ended trial from Free back to the trial plan', async () => {
    const t = await signupTenant('free');
    const bil = await staff('billing');
    const list = await listPlatformBilling(bil, { status: 'free' });
    expect(list.items.find((i) => i.workspace_id === t.ws)).toMatchObject({ plan_id: 'free', status: 'free', access: 'full', seats: 0 });
    const d = await platformBillingDetail(bil, t.ws);
    expect(d).toMatchObject({ plan_name: 'Free', trial: null, payment_issue: null, provider: { customer_ref: null } });
    const t2 = await signupTenant('professional');
    await expireTrial(t2.ws);
    expect((await platformBillingDetail(bil, t2.ws)).trial?.eligible_for_extension).toBe(true);
    await staffExtendTrial(bil, t2.ws, { days: 5, reason: 'Customer asked for more time' });
    expect(await getBillingState(testPool(), t2.ws)).toMatchObject({ status: 'trialing', plan_id: 'professional', access: 'full' });
  });
});
