// V4 billing (stream BIL) browser workflows — real Keycloak sign-in, production build, real API, deterministic billing test
// double (Test mode; no Stripe keys exist here). Fixtures: "E2E Billing" / "E2E Billing Mobile" (scripts/seed-e2e.ts) are
// reset to a fresh 14-day no-card Standard trial on every seed.
//  - §18.8/§18.9: forged success redirect + forged webhook do nothing; hosted test checkout → signed webhook → subscribed,
//    first charge = trial end; card shown.
//  - §18.12 / §11: update payment details (portal), change plan with provider preview, cancel renewal (effects), resume.
//  - §14: staff inspect the tenant's billing record (provider refs), subscriptions list, plans catalogue.
//  - V5 handoff: /signup?plan=… public page.
//  - D33 Free: "E2E Free" (seeded on Free) shows £0, no portal/invoices, "Upgrade" cards (Standard £5, Professional £15),
//    "Free includes 1 user. Upgrade to add teammates."; Platform → Plans lists Free (no provider price); Downgrade to Free.
//  - @mobile §17: inspect plan, open hosted checkout, update payment details, cancel renewal, staff inspect tenant billing at
//    390 px; no page-level horizontal scroll at 320/360/390/430/768/1440.
// Screenshots (1440 + 390, light + dark, DPR 2) → evidence/v4/bil/.
import { mkdirSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { api, signIn } from './helpers';

const OWNER = 'owner@demo.social-lite.test'; // owns the billing fixtures; also the seeded platform operator
const EVIDENCE = 'evidence/v4/bil';
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const noScroll = 'document.documentElement.scrollWidth <= window.innerWidth + 1';
mkdirSync(EVIDENCE, { recursive: true });

async function switchTo(page: Page, name: string): Promise<string> {
  const res = await page.request.get('/api/session');
  const s = await res.json() as { csrf_token: string; workspace: { id: string } | null; workspaces: Array<{ id: string; name: string }> };
  const target = s.workspaces.find((w) => w.name === name);
  expect(target, `${name} exists (pnpm db:seed:e2e)`).toBeTruthy();
  if (s.workspace?.id !== target!.id) {
    await page.goto('/api/session');
    const r = await page.request.post('/api/session/workspace', {
      headers: { 'content-type': 'application/json', origin: BASE, 'x-csrf-token': s.csrf_token, 'idempotency-key': randomUUID() },
      data: JSON.stringify({ workspace_id: target!.id }),
    });
    expect(r.status()).toBeLessThan(300);
  }
  return target!.id;
}

async function as(browser: Browser, opts: { mobile?: boolean; dark?: boolean; workspace?: string } = {}): Promise<Page> {
  const ctx = await browser.newContext({
    baseURL: BASE, deviceScaleFactor: 2, colorScheme: opts.dark ? 'dark' : 'light',
    viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: !!opts.mobile, hasTouch: !!opts.mobile,
  });
  const page = await ctx.newPage();
  await signIn(page, OWNER);
  if (opts.workspace) await switchTo(page, opts.workspace);
  return page;
}

async function shot(page: Page, name: string, fullPage = true) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.screenshot({ path: `${EVIDENCE}/${name}.png`, fullPage });
}

async function billingPage(page: Page) {
  await page.goto('/settings/workspace/billing');
  await expect(page.getByTestId('billing-plan')).toBeVisible();
}

test.describe.serial('V4 billing — desktop', () => {
  test.skip(({ isMobile }) => !!isMobile, 'desktop project');
  let page: Page;
  let wsId = '';

  test('§18.9 forged redirect and forged webhook never activate; §18.8 verified test checkout subscribes and keeps the trial', async ({ browser }) => {
    page = await as(browser, { workspace: 'E2E Billing' });
    wsId = (await (await api(page)).get('/api/session')).body.workspace.id;
    await billingPage(page);
    const plan = page.getByTestId('billing-plan');
    await expect(plan).toContainText('Free trial');
    await expect(plan).toContainText('Not needed for the trial');
    await expect(page.getByText('Test mode · no real payments')).toBeVisible();
    await expect(page.getByTestId('plan-standard-total')).toContainText('1 user × £5 = £5');
    await expect(page.getByTestId('plan-professional-total')).toContainText('£15');
    await expect(page.getByTestId('plan-free')).toHaveCount(0); // Free is never bought
    await shot(page, 'settings-billing-trial-1440-light');

    // Forged success redirect: the page asks the provider; nothing changes.
    const a = await api(page);
    await page.goto('/settings/workspace/billing?checkout=returned&session=cs_test_forged0000000000');
    await expect(page.getByText(/Confirming with the payment provider|Not confirmed yet/).first()).toBeVisible();
    expect((await a.send('POST', '/api/billing/refresh', {})).status).toBe(200);
    const after = (await a.get('/api/billing')).body;
    expect(after.payment_method).toBeNull();
    expect(after.next_charge_at).toBeNull();
    // Forged webhook: rejected before anything is stored.
    const forged = await page.request.post('/api/webhooks/stripe', { headers: { 'content-type': 'application/json', 'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` },
      data: JSON.stringify({ id: 'evt_forged_e2e', object: 'event', type: 'checkout.session.completed', created: 1, livemode: false, data: { object: { id: 'cs_x' } } }) });
    expect(forged.status()).toBe(400);

    // Real (test) hosted checkout.
    await billingPage(page);
    await page.getByTestId('plan-standard').getByRole('button', { name: 'Continue to checkout' }).click();
    await page.waitForURL(/\/billing-test\/checkout\?session=cs_test_/);
    await expect(page.getByRole('note')).toContainText('Test mode');
    await expect(page.getByText('Due today')).toBeVisible();
    await shot(page, 'test-checkout-1440-light', false);
    await page.getByRole('button', { name: /Pay with test card/ }).click();
    await page.waitForURL(/\/settings\/workspace\/billing\?checkout=returned/);
    await expect(plan).toContainText('visa •••• 4242', { timeout: 30_000 });
    await expect(plan).toContainText('First charge');
    await expect(plan).toContainText('Free trial'); // free period preserved
    await shot(page, 'settings-billing-subscribed-1440-light');
  });

  test('§11/§18.12 update payment details, change plan with a provider preview, cancel and resume renewal', async () => {
    const plan = page.getByTestId('billing-plan');
    await page.getByRole('button', { name: 'Update payment details' }).click();
    await page.waitForURL(/\/billing-test\/portal\?session=bps_test_/);
    await page.getByRole('button', { name: /Update card/ }).click();
    await expect(page.getByText('Card updated')).toBeVisible();
    await page.getByTestId('test-portal-return').click();
    await page.waitForURL(/\/settings\/workspace\/billing/);
    await expect(plan).toContainText('mastercard •••• 4444', { timeout: 20_000 });

    await page.getByRole('button', { name: 'Change plan or seats' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('radio', { name: /Professional/ }).click();
    await expect(dialog.getByTestId('billing-preview')).toContainText('£15');
    await shot(page, 'change-plan-preview-1440-light', false);
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(plan).toContainText('Professional');

    await page.getByRole('button', { name: 'Downgrade to Free' }).click();
    const confirm = page.getByRole('dialog');
    await expect(confirm).toContainText('Then the workspace moves to Free');
    await expect(confirm).toContainText('Your content, settings and data export are kept');
    await confirm.getByRole('button', { name: 'Downgrade at period end' }).click();
    await expect(plan).toContainText('Ends at period end');
    await expect(plan).toContainText('Service ends');
    await shot(page, 'settings-billing-cancel-scheduled-1440-light');
    await page.getByRole('button', { name: 'Resume renewal' }).click();
    await expect(plan).toContainText('Free trial');
  });

  test('§14 staff inspect the tenant billing record, the subscriptions list and the plan catalogue', async () => {
    await page.goto('/admin/platform/billing?status=trialing');
    await expect(page.getByTestId('platform-billing-list')).toContainText('E2E Billing');
    await page.goto(`/admin/platform/workspaces/${wsId}`);
    const panel = page.getByTestId('platform-billing');
    await expect(panel).toContainText(/sub_test_/);
    await expect(panel).toContainText('Professional');
    await expect(page.getByTestId('platform-billing-lifecycle')).toContainText('checkout_completed');
    await panel.scrollIntoViewIfNeeded();
    await shot(page, 'platform-workspace-billing-1440-light');
    await page.goto('/admin/platform/plans');
    await expect(page.getByTestId('platform-plan-standard')).toContainText('£5 per user / month');
    await expect(page.getByTestId('platform-plan-professional')).toContainText('£15 per user / month');
    await expect(page.getByTestId('platform-plan-standard')).toContainText('£10 per user / month'); // retired v1 kept for its subscriptions
    await expect(page.getByTestId('platform-plan-free')).toContainText('£0 (Free)');
    await expect(page.getByTestId('platform-plan-free')).toContainText('Free has no provider product or price');
    await expect(page.getByTestId('platform-plan-legacy')).toContainText('Not purchasable');
    await shot(page, 'platform-plans-1440-light');
  });

  test('D33 Free workspace: £0, no portal or invoices, upgrade cards at £5 / £15, no teammates; listed as Free for staff', async ({ browser }) => {
    for (const dark of [false, true]) {
      const free = await as(browser, { dark, workspace: 'E2E Free' });
      const freeId = (await (await api(free)).get('/api/session')).body.workspace.id as string;
      await billingPage(free);
      const plan = free.getByTestId('billing-plan');
      await expect(plan).toContainText('Free');
      await expect(plan).toContainText('£0 · no card, no invoices');
      await expect(plan.getByRole('button', { name: 'Update payment details' })).toHaveCount(0);
      await expect(free.getByRole('heading', { name: 'Upgrade', exact: true })).toBeVisible();
      await expect(free.getByTestId('plan-standard')).toContainText('£5');
      await expect(free.getByTestId('plan-professional')).toContainText('£15');
      await expect(free.getByTestId('plan-standard').getByRole('button', { name: 'Start free trial' })).toBeVisible();
      await expect(free.getByText('Free includes 1 user. Upgrade to add teammates.')).toBeVisible();
      await expect(free.getByText('No invoices yet')).toHaveCount(0);
      expect(await free.evaluate(noScroll)).toBe(true);
      await shot(free, `settings-billing-free-1440-${dark ? 'dark' : 'light'}`);
      if (!dark) {
        const a = await api(free);
        const ov = (await a.get('/api/billing')).body;
        expect(ov).toMatchObject({ state: { plan_id: 'free', status: 'free', access: 'full' }, recurring_total_minor: 0, upgrade_trial_days: 14, actions: { portal: false } });
        expect((await a.send('POST', '/api/billing/checkout', { plan: 'free' })).status).toBe(422);
        await free.goto('/admin/platform/billing?status=free');
        await expect(free.getByTestId('platform-billing-list')).toContainText('E2E Free');
        await free.goto(`/admin/platform/workspaces/${freeId}`);
        await expect(free.getByTestId('platform-billing')).toContainText('Free · 1 user (1 included)');
        await free.getByTestId('platform-billing').scrollIntoViewIfNeeded();
        await shot(free, 'platform-workspace-billing-free-1440-light');
      }
      await free.context().close();
    }
  });

  test('dark theme screens', async ({ browser }) => {
    const dark = await as(browser, { dark: true, workspace: 'E2E Billing' });
    await billingPage(dark);
    await shot(dark, 'settings-billing-1440-dark');
    await dark.goto(`/admin/platform/workspaces/${wsId}`);
    await expect(dark.getByTestId('platform-billing')).toBeVisible();
    await shot(dark, 'platform-workspace-billing-1440-dark');
    await dark.context().close();
  });

  test('V5 handoff: /signup?plan=professional preselects the plan from the shared catalogue (public)', async ({ browser }) => {
    for (const dark of [false, true]) {
      const ctx = await browser.newContext({ baseURL: BASE, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light', viewport: { width: 1440, height: 900 } });
      const p = await ctx.newPage();
      await p.goto('/signup?plan=professional');
      await expect(p.getByTestId('signup-plan-professional')).toHaveAttribute('aria-current', 'true');
      await expect(p.getByTestId('signup-plan-standard')).toContainText('£5');
      await expect(p.getByTestId('signup-continue')).toHaveAttribute('href', '/signup/workspace?plan=professional');
      await shot(p, `signup-1440-${dark ? 'dark' : 'light'}`, false);
      await ctx.close();
    }
    await page.context().close();
  });
});

test.describe.serial('V4 billing — mobile @mobile', () => {
  test('§17 at 390 px: inspect plan, open hosted checkout, update payment details, cancel renewal, staff inspect tenant billing', async ({ browser }, info) => {
    test.skip(info.project.name !== 'mobile', 'runs in the mobile project (fresh "E2E Billing Mobile" fixture)');
    const page = await as(browser, { mobile: true, workspace: 'E2E Billing Mobile' });
    const wsId = (await (await api(page)).get('/api/session')).body.workspace.id;
    await billingPage(page);
    const plan = page.getByTestId('billing-plan');
    await expect(plan).toContainText('Free trial');
    await shot(page, 'settings-billing-trial-390-light');
    for (const w of [320, 360, 390, 430, 768, 1440]) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(150);
      expect(await page.evaluate(noScroll), `no horizontal scroll at ${w}px`).toBe(true);
    }
    await page.setViewportSize({ width: 390, height: 844 });

    await page.getByTestId('plan-standard').getByRole('button', { name: 'Continue to checkout' }).click();
    await page.waitForURL(/\/billing-test\/checkout/);
    await shot(page, 'test-checkout-390-light', false);
    await page.getByRole('button', { name: /Pay with test card/ }).click();
    await page.waitForURL(/\/settings\/workspace\/billing\?checkout=returned/);
    await expect(plan).toContainText('visa •••• 4242', { timeout: 30_000 });
    await shot(page, 'settings-billing-subscribed-390-light');

    await page.getByRole('button', { name: 'Update payment details' }).click();
    await page.waitForURL(/\/billing-test\/portal/);
    await page.getByRole('button', { name: /Update card/ }).click();
    await expect(page.getByText('Card updated')).toBeVisible();
    await shot(page, 'test-portal-390-light', false);
    await page.getByTestId('test-portal-return').click();
    await expect(plan).toContainText('mastercard •••• 4444', { timeout: 20_000 });

    await page.getByRole('button', { name: 'Downgrade to Free' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Downgrade at period end' }).click();
    await expect(plan).toContainText('Ends at period end');
    expect(await page.evaluate(noScroll)).toBe(true);

    await page.goto(`/admin/platform/workspaces/${wsId}`);
    await expect(page.getByTestId('platform-billing')).toContainText(/sub_test_/);
    expect(await page.evaluate(noScroll)).toBe(true);
    await page.getByTestId('platform-billing').scrollIntoViewIfNeeded();
    await shot(page, 'platform-workspace-billing-390-light');
    await page.context().close();

    const dark = await as(browser, { mobile: true, dark: true, workspace: 'E2E Billing Mobile' });
    await billingPage(dark);
    await shot(dark, 'settings-billing-390-dark');
    // D33 Free at 390 px (read-only fixture)
    await switchTo(dark, 'E2E Free');
    await billingPage(dark);
    await expect(dark.getByTestId('billing-plan')).toContainText('£0 · no card, no invoices');
    expect(await dark.evaluate(noScroll)).toBe(true);
    await shot(dark, 'settings-billing-free-390-dark');
    await dark.setViewportSize({ width: 390, height: 844 });
    await dark.goto('/signup?plan=standard');
    expect(await dark.evaluate(noScroll)).toBe(true);
    await shot(dark, 'signup-390-dark', false);
    await dark.context().close();
  });
});
