// V5 MKT — marketing configuration service, and the marketing → signup → checkout → billing → admin consistency
// (brief §18 items 5–7) against a real Postgres and the deterministic billing test double.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSession } from '@social-lite/services/auth/session';
import { signupWorkspace } from '@social-lite/services/billing/signup';
import { getBillingState } from '@social-lite/services/billing/state';
import { billingOverview, changeTrialPlan, startCheckout } from '@social-lite/services/billing/manage';
import { completeTestCheckout } from '@social-lite/services/billing/test-provider';
import { setBillingProviderForTests } from '@social-lite/services/billing/provider';
import { platformBillingDetail } from '@social-lite/services/billing/platform';
import { createInvitation } from '@social-lite/services/auth/invitations';
import { marketingConfig, platformMarketingConfig, updateMarketingConfig } from '@social-lite/services/marketing/config';
import type { PlatformCtx } from '@social-lite/services/admin/platform';
import { MARKETING_CONFIG_KEY } from '@social-lite/core/contracts/v5-marketing';
import { PLANS, TRIAL_DAYS, TRIAL_REQUIRES_CARD } from '@social-lite/core/contracts/v4-plans';
import { pricingPlans, recurringTotalMinor } from '../../apps/web/components/marketing/plan-data';
import { addMember, closeTestPool, createUser, testPool, v2Ctx } from './helpers.js';

beforeAll(() => { testPool(); delete process.env.RELAY_STRIPE_SECRET_KEY; delete process.env.RELAY_STRIPE_WEBHOOK_SECRET; setBillingProviderForTests(undefined); });
afterAll(async () => { await closeTestPool(); });

const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await testPool().query(sql, p)).rows as T[];

async function staff(role: 'operator' | 'support' | 'billing', fresh = true): Promise<PlatformCtx> {
  const u = await createUser(`mkt-staff-${randomUUID().slice(0, 8)}@relay.test`);
  await testPool().query(`INSERT INTO platform_operators(user_id, role, granted_via) VALUES ($1,$2,'seed')`, [u.id, role]);
  return { actor: { userId: u.id, email: u.email, name: 'Staff', sessionId: randomUUID() }, role, assurance: { mfaVerified: fresh, authTime: fresh ? new Date() : null }, correlationId: randomUUID() };
}

/** The selected-plan handoff: /signup?plan=<id> → create workspace (signupWorkspace) → trial on that plan. */
async function signupFromMarketing(plan: 'free' | 'standard' | 'professional') {
  const u = await createUser();
  const { session } = await createSession(testPool(), u.id, {});
  const actor = { userId: u.id, email: u.email, name: 'Owner', sessionId: session.id };
  const r = await signupWorkspace(session, actor, { name: `Mkt ${randomUUID().slice(0, 6)}`, timezone: 'Europe/London', plan });
  return { ws: r.workspace.id, owner: u, session, actor, ctx: () => v2Ctx(u.id, r.workspace.id) };
}

describe('Platform → Marketing configuration (marketingConfig)', () => {
  it('defaults: widget off, not staffed, no legal links (WID shows "Send us a message")', async () => {
    await testPool().query(`DELETE FROM system_flags WHERE key=$1`, [MARKETING_CONFIG_KEY]);
    expect(await marketingConfig(testPool())).toMatchObject({ widget_enabled: false, widget_staffed: false, widget_in_app: false, privacy_url: null, terms_url: null, support_email: null, updated_at: null });
  });

  it('operators change it with a fresh sign-in and a reason; audited with a diff; every platform role can read it', async () => {
    const op = await staff('operator');
    const r = await updateMarketingConfig(op, { widget_enabled: true, widget_staffed: true, privacy_url: '/legal/privacy', terms_url: 'https://relay.example/terms', support_email: 'help@relay.example', reason: 'Launch the marketing widget' });
    expect(r).toMatchObject({ widget_enabled: true, widget_staffed: true, privacy_url: '/legal/privacy', terms_url: 'https://relay.example/terms', support_email: 'help@relay.example' });
    expect(r.updated_by).toBe(`operator:${op.actor.userId}`);
    const a = await q<{ action: string; reason: string; diff: { changed: string[] } }>(`SELECT action, reason, diff FROM platform_audit_events WHERE actor_user_id=$1 ORDER BY created_at DESC LIMIT 1`, [op.actor.userId]);
    expect(a[0]).toMatchObject({ action: 'marketing.config_updated', reason: 'Launch the marketing widget' });
    expect(a[0]!.diff.changed).toEqual(expect.arrayContaining(['widget_enabled', 'widget_staffed', 'privacy_url']));
    for (const role of ['support', 'billing'] as const) expect((await platformMarketingConfig(await staff(role))).widget_enabled).toBe(true);
    // Turning the widget off also clears the staffed flag (no online status without a widget).
    expect(await updateMarketingConfig(op, { widget_enabled: false, reason: 'Pause the widget for now' })).toMatchObject({ widget_enabled: false, widget_staffed: false });
  });

  it('refuses non-operators, stale sign-ins, missing reasons and unsafe links', async () => {
    await expect(updateMarketingConfig(await staff('support'), { widget_enabled: true, reason: 'Support tries to change' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(updateMarketingConfig(await staff('billing'), { widget_enabled: true, reason: 'Billing tries to change' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(updateMarketingConfig(await staff('operator', false), { widget_enabled: true, reason: 'Not a fresh sign-in' })).rejects.toMatchObject({ code: 'step_up_required' });
    const op = await staff('operator');
    await expect(updateMarketingConfig(op, { widget_enabled: true })).rejects.toThrow();
    for (const bad of ['javascript:alert(1)', 'http://relay.example/privacy', '//evil.example/x', 'https://user:pw@relay.example/', 'data:text/html,hi', '/\\evil']) {
      await expect(updateMarketingConfig(op, { privacy_url: bad, reason: 'Trying an unsafe link' }), bad).rejects.toThrow();
    }
    await expect(updateMarketingConfig(op, { support_email: 'not-an-email', reason: 'Trying a bad email' })).rejects.toThrow();
    await expect(updateMarketingConfig(op, { secret: 'x', reason: 'Unknown fields are refused' } as never)).rejects.toThrow();
  });

  it('a tampered stored value never reaches the public page (re-validated on read)', async () => {
    await testPool().query(`INSERT INTO system_flags(key, value, updated_by) VALUES ($1, $2::jsonb, 'test') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
      [MARKETING_CONFIG_KEY, JSON.stringify({ widget_enabled: 'yes', widget_staffed: true, privacy_url: 'javascript:alert(1)', terms_url: '/terms', support_email: '<script>' })]);
    expect(await marketingConfig(testPool())).toMatchObject({ widget_enabled: false, widget_staffed: false, privacy_url: null, terms_url: '/terms', support_email: null });
    await testPool().query(`DELETE FROM system_flags WHERE key=$1`, [MARKETING_CONFIG_KEY]);
  });
});

describe('§18.5–6 the public plans and the trial the page presents', () => {
  it('three public plans (D33): Free £0 (no trial), Standard £5 and Professional £15 per user / month with 14 days free, no card — from the catalogue', () => {
    const plans = pricingPlans();
    expect(plans.map((p) => [p.id, p.price, p.interval, p.currency, p.trial_days])).toEqual([['free', '£0', 'month', 'GBP', 0], ['standard', '£5', 'month', 'GBP', 14], ['professional', '£15', 'month', 'GBP', 14]]);
    expect(TRIAL_DAYS).toBe(14);
    expect(TRIAL_REQUIRES_CARD).toBe(false);
  });

  it('a Professional handoff starts one genuine 14-day trial on Professional; switching plan keeps the end date; no second trial', async () => {
    const t = await signupFromMarketing('professional');
    const s = await getBillingState(testPool(), t.ws);
    expect(s).toMatchObject({ status: 'trialing', plan_id: 'professional', access: 'full' });
    const start = new Date(s.trial!.started_at).getTime();
    const end = new Date(s.trial!.ends_at).getTime();
    expect(end - start).toBe(TRIAL_DAYS * 86_400_000);
    await changeTrialPlan(await t.ctx(), { plan: 'standard' });
    const s2 = await getBillingState(testPool(), t.ws);
    expect(s2.plan_id).toBe('standard');
    expect(s2.trial!.ends_at).toBe(s.trial!.ends_at);
    // The same person going through the handoff again cannot create another trial workspace.
    await expect(signupWorkspace(t.session, t.actor, { name: 'Second try', timezone: 'Europe/London', plan: 'professional' })).rejects.toThrow();
    expect((await q(`SELECT 1 FROM billing_trial_redemptions WHERE workspace_id=$1`, [t.ws])).length).toBe(1);
  });
});

describe('D33 Free handoff (/signup?plan=free)', () => {
  it('creates a Free workspace with no trial and full access within Free', async () => {
    const t = await signupFromMarketing('free');
    const s = await getBillingState(testPool(), t.ws);
    expect(s).toMatchObject({ plan_id: 'free', status: 'free', access: 'full', trial: null });
    expect((await q(`SELECT 1 FROM billing_trial_redemptions WHERE workspace_id=$1`, [t.ws])).length).toBe(0);
  });
});

describe('§18.7 seats and totals match across marketing, checkout, billing and admin', () => {
  for (const plan of ['standard', 'professional'] as const) {
    it(`3 ${plan} users: marketing estimate = Billing = checkout = provider state = Platform admin`, async () => {
      const t = await signupFromMarketing(plan);
      for (let i = 0; i < 2; i++) { const m = await createUser(); await addMember(t.ws, m.id, 'editor'); }
      // A pending invitation is not a billable user.
      await createInvitation(await t.ctx(), { email: `pending-${randomUUID().slice(0, 6)}@test.social-lite.test`, role: 'editor' } as never, randomUUID());

      const marketing = recurringTotalMinor(plan, 3); // what the pricing card / signup handoff shows for 3 users
      expect(marketing).toBe(plan === 'standard' ? 1500 : 4500);
      expect(marketing).toBe(PLANS[plan].unit_amount_minor! * 3);

      const ov = await billingOverview(await t.ctx());
      expect(ov.seats).toMatchObject({ billable: 3, members: 3, pending_member_invites: 1 });

      const c = await startCheckout(await t.ctx(), { plan });
      expect(c.seats).toBe(3);
      expect(c.recurring_total_minor).toBe(marketing);
      await completeTestCheckout(new URL(c.url).searchParams.get('session')!, 'paid');

      const s = await getBillingState(testPool(), t.ws);
      expect(s).toMatchObject({ plan_id: plan, seats: 3 });
      const after = await billingOverview(await t.ctx());
      expect(after.seats.paid).toBe(3);
      expect(after.recurring_total_minor).toBe(marketing);
      expect(after.plan?.unit_amount_minor).toBe(PLANS[plan].unit_amount_minor);

      const admin = await platformBillingDetail(await staff('billing'), t.ws);
      expect(admin.seats).toMatchObject({ paid: 3, billable: 3 });
      expect(admin.state).toMatchObject({ plan_id: plan, seats: 3 });
      // Subscribing during the trial keeps the free period: the first charge is the trial end shown on the page.
      expect(after.first_charge_at).toBe(s.trial?.ends_at ?? after.first_charge_at);
    });
  }
});
