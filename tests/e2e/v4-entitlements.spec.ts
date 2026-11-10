// V4 entitlements (stream ENT) browser workflows — real Keycloak sign-in, production build, real API:
//  - Admin → Usage: plan, allowances, budgets (legacy workspace keeps everything; no "no billing system" card);
//  - Platform (operator, step-up): apply audited overrides to Other Workspace (connected-account limit 1, listening off);
//    the customer sees "Adjusted by Relay", the over-limit chooser (nothing disconnected), the listening upgrade prompt,
//    and the server refuses the paid capability (402) — UI, API and the chooser agree; overrides revoked afterwards;
//  - @mobile: the usage page and chooser at 390 px; no page-level horizontal scroll at 320–1440.
//  - D33 Free ("E2E Free", owner@demo): Usage shows Free's limits; analytics and inbox show the upgrade prompt and their API
//    answers 402; a second brand and any teammate are refused with the upgrade reason (server-side, 402).
// Screenshots (1440 + 390, light + dark, DPR 2) go to evidence/v4/ent/.
import { mkdirSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { api, signIn, type Api } from './helpers';

const OPERATOR = 'owner@demo.social-lite.test'; // seeded platform operator (TOTP ⇒ fresh MFA session)
const CUSTOMER = 'owner@other.social-lite.test'; // owner of Other Workspace (no platform role)
const EVIDENCE = 'evidence/v4/ent';
const noScroll = 'document.documentElement.scrollWidth <= window.innerWidth + 1';
mkdirSync(EVIDENCE, { recursive: true });

async function as(browser: Browser, email: string, opts: { mobile?: boolean; dark?: boolean } = {}): Promise<Page> {
  const ctx = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000', deviceScaleFactor: 2, colorScheme: opts.dark ? 'dark' : 'light',
    viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: !!opts.mobile, hasTouch: !!opts.mobile,
  });
  const page = await ctx.newPage();
  await signIn(page, email);
  return page;
}
async function shot(page: Page, name: string, fullPage = false) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.screenshot({ path: `${EVIDENCE}/${name}.png`, fullPage });
}
async function otherWorkspaceId(op: Api): Promise<string> {
  const r = await op.get('/api/platform/workspaces?q=Other%20Workspace');
  const items = (r.body?.items ?? r.body) as Array<{ id: string; name: string }>;
  const w = items.find((x) => x.name === 'Other Workspace');
  expect(w, 'Other Workspace exists').toBeTruthy();
  return w!.id;
}

/** Overrides + two simulated accounts on Other Workspace; returns a cleanup that removes everything it added. */
async function setUp(browser: Browser) {
  const opPage = await as(browser, OPERATOR);
  const op = await api(opPage);
  const ws = await otherWorkspaceId(op);
  const cust = await as(browser, CUSTOMER);
  const c = await api(cust);
  const session = await c.get('/api/session');
  const brand = session.body.brands[0].id as string;
  const conns: string[] = [];
  for (const name of ['Café Facebook', 'Café Telegram']) {
    const r = await c.send('POST', `/api/brands/${brand}/connections/mock`, { provider: name.includes('Telegram') ? 'telegram' : 'facebook', display_name: name });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    conns.push(r.body.id);
  }
  const lim = await op.send('POST', `/api/platform/entitlements/${ws}`, { kind: 'allowance', key: 'social_accounts', limit: 1, reason: 'E2E: downgrade simulation', expires_at: new Date(Date.now() + 86_400_000).toISOString() });
  expect(lim.status, JSON.stringify(lim.body)).toBe(200);
  const feat = await op.send('POST', `/api/platform/entitlements/${ws}`, { kind: 'feature', key: 'listening', enabled: false, reason: 'E2E: feature not in plan', expires_at: new Date(Date.now() + 86_400_000).toISOString() });
  expect(feat.status, JSON.stringify(feat.body)).toBe(200);
  const cleanup = async () => {
    const view = await op.get(`/api/platform/entitlements/${ws}`);
    for (const o of (view.body?.overrides ?? []) as Array<{ id: string; status: string; reason: string }>) {
      if (o.status === 'active' && o.reason.startsWith('E2E:')) await op.send('POST', `/api/platform/entitlements/${ws}/overrides/${o.id}/revoke`, { reason: 'E2E finished, cleaning up' });
    }
    for (const id of conns) await c.send('POST', `/api/connections/${id}/disconnect`, {});
  };
  return { opPage, op, ws, cust, c, conns, cleanup };
}

test.describe('V4 entitlements', () => {
  test.describe.configure({ timeout: 300_000 });

  test('Admin → Usage on a legacy workspace: plan, allowances, budgets; no placeholder billing card', async ({ browser }) => {
    for (const dark of [false, true]) {
      const page = await as(browser, OPERATOR, { dark });
      await page.goto('/admin/usage');
      await expect(page.getByRole('heading', { name: 'Usage and limits' })).toBeVisible();
      await expect(page.getByTestId('workspace-usage')).toBeVisible();
      await expect(page.getByText('Legacy', { exact: true })).toBeVisible();
      await expect(page.getByText('Your budgets')).toBeVisible();
      await expect(page.getByText(/no billing system yet/i)).toHaveCount(0);
      expect(await page.evaluate(noScroll)).toBe(true);
      await shot(page, `usage-legacy-1440-${dark ? 'dark' : 'light'}`);
      const r = await (await api(page)).get('/api/entitlements');
      expect(r.body).toMatchObject({ plan: { id: 'legacy' }, access: 'full' });
      await page.context().close();
    }
  });

  test('operator overrides → customer sees adjusted limits, chooses what stays active, gets an upgrade prompt; server refuses (402)', async ({ browser }) => {
    const s = await setUp(browser);
    try {
      // Platform panel (operator)
      await s.opPage.goto(`/admin/platform/workspaces/${s.ws}`);
      const panel = s.opPage.getByTestId('platform-entitlements');
      await expect(panel).toBeVisible();
      await expect(panel.getByText('E2E: downgrade simulation').first()).toBeVisible();
      await panel.scrollIntoViewIfNeeded();
      await shot(s.opPage, 'platform-entitlements-1440-light');
      // platform + workspace audits recorded
      const audit = await s.op.get(`/api/platform/audit?workspace_id=${s.ws}`);
      expect(JSON.stringify(audit.body)).toContain('entitlement.override_applied');

      // Customer usage page: adjusted limit, chooser, nothing disconnected
      await s.cust.goto('/admin/usage');
      await expect(s.cust.getByText('Adjusted by Relay').first()).toBeVisible();
      const chooser = s.cust.getByTestId('selection-social_accounts');
      await expect(chooser).toBeVisible();
      await expect(chooser.getByText('Paused', { exact: true })).toHaveCount(1);
      await shot(s.cust, 'usage-over-limit-1440-light');
      // keep the second account instead (step-up per policy: the session is MFA-fresh)
      await chooser.getByLabel(/Café Facebook/).uncheck();
      await chooser.getByLabel(/Café Telegram/).check();
      const saved = s.cust.waitForResponse((r) => r.url().endsWith('/api/entitlements/selections') && r.request().method() === 'PUT');
      await chooser.getByRole('button', { name: 'Save choice' }).click();
      const res = await saved;
      expect(res.status(), await res.text()).toBe(200);
      await expect(chooser.getByText('Paused', { exact: true })).toHaveCount(1);
      const sel = await s.c.get('/api/entitlements/selections');
      const accounts = sel.body.items.find((i: { allowance: string }) => i.allowance === 'social_accounts');
      expect(accounts.items.find((i: { name: string }) => i.name === 'Café Telegram').active).toBe(true);
      expect(accounts.items.find((i: { name: string }) => i.name === 'Café Facebook').active).toBe(false);
      const conns = await s.c.get('/api/session');
      expect(conns.status).toBe(200);
      // a third account is refused by the server (limit), with the reason
      const brand = conns.body.brands[0].id;
      const third = await s.c.send('POST', `/api/brands/${brand}/connections/mock`, { provider: 'x', display_name: 'One too many' });
      expect(third.status).toBe(402);
      expect(third.body.error).toMatchObject({ code: 'entitlement_required', details: { reason: 'allowance_exhausted', allowance: 'social_accounts' } });

      // Listening turned off: concise prompt in the UI, 402 from the API
      await s.cust.goto('/listening');
      await expect(s.cust.getByText('Not in your plan')).toBeVisible();
      await expect(s.cust.getByText(/Listening is turned off for this workspace/)).toBeVisible();
      await shot(s.cust, 'listening-upgrade-prompt-1440-light');
      const search = await s.c.send('POST', '/api/listening/searches', { brand_id: brand, name: 'Blocked', role: 'own', terms: ['coffee'], keywords: [], exclusions: [], boolean: null, languages: [], sources: [], kinds: [] });
      expect(search.status).toBe(402);
      expect(search.body.error.code).toBe('entitlement_required');

      // dark theme of the over-limit page
      const dark = await as(browser, CUSTOMER, { dark: true });
      await dark.goto('/admin/usage');
      await expect(dark.getByTestId('selection-social_accounts')).toBeVisible();
      await shot(dark, 'usage-over-limit-1440-dark');
      await dark.context().close();
    } finally {
      await s.cleanup();
    }
    const after = await s.c.get('/api/entitlements');
    expect(after.body.features.listening.enabled).toBe(true);
  });

  test('D33 Free: usage shows Free limits; analytics/inbox prompt + 402; second brand and teammates refused', async ({ browser }, info) => {
    test.skip(info.project.name === 'mobile', 'desktop project');
    for (const dark of [false, true]) {
      const page = await as(browser, OPERATOR, { dark });
      const a = await api(page);
      const s = await a.get('/api/session');
      const ws = (s.body.workspaces as Array<{ id: string; name: string }>).find((w) => w.name === 'E2E Free');
      expect(ws, 'E2E Free exists (pnpm db:seed:e2e)').toBeTruthy();
      if (s.body.workspace?.id !== ws!.id) expect((await a.send('POST', '/api/session/workspace', { workspace_id: ws!.id })).status).toBeLessThan(300);
      await page.goto('/admin/usage');
      await expect(page.getByTestId('workspace-usage')).toBeVisible();
      await expect(page.getByText('Scheduled posts', { exact: true }).first()).toBeVisible();
      expect(await page.evaluate(noScroll)).toBe(true);
      await shot(page, `usage-free-1440-${dark ? 'dark' : 'light'}`, true);
      await page.goto('/analytics');
      await expect(page.getByText('Not in your plan')).toBeVisible();
      await expect(page.getByText(/Standard analytics isn’t included in Free/)).toBeVisible();
      await shot(page, `analytics-free-prompt-1440-${dark ? 'dark' : 'light'}`);
      if (!dark) {
        const e = (await a.get('/api/entitlements')).body;
        expect(e).toMatchObject({ plan: { id: 'free' }, status: 'free', access: 'full', member_hold: null });
        expect(e.allowances.find((x: { key: string }) => x.key === 'scheduled_posts')).toMatchObject({ hard_limit: 10 });
        expect(e.allowances.find((x: { key: string }) => x.key === 'members')).toMatchObject({ hard_limit: 1, used: 1 });
        const ov = await a.get('/api/analytics/overview');
        expect(ov.status).toBe(402);
        expect(ov.body.error).toMatchObject({ code: 'entitlement_required', details: { feature: 'analytics_standard', upgrade_to: 'standard' } });
        expect((await a.get('/api/inbox/conversations')).status).toBe(402);
        await page.goto('/inbox');
        await expect(page.getByText('Not in your plan')).toBeVisible();
        const brand = await a.send('POST', '/api/brands', { name: `Second ${Date.now()}` });
        expect(brand.status).toBe(402);
        expect(brand.body.error).toMatchObject({ code: 'entitlement_required', details: { allowance: 'brands', limit: 1 } });
        const inv = await a.send('POST', '/api/invitations', { email: `free-${Date.now()}@test.social-lite.test`, role: 'editor' });
        expect(inv.status).toBe(402);
        expect(inv.body.error.message).toContain('Upgrade to add teammates');
      }
      await page.context().close();
    }
  });

  test('usage page and chooser on a phone; no horizontal scroll 320–1440 @mobile', async ({ browser }) => {
    const s = await setUp(browser);
    try {
      for (const dark of [false, true]) {
        const page = await as(browser, CUSTOMER, { mobile: true, dark });
        await page.goto('/admin/usage');
        await expect(page.getByTestId('selection-social_accounts')).toBeVisible();
        expect(await page.evaluate(noScroll)).toBe(true);
        await shot(page, `usage-over-limit-390-${dark ? 'dark' : 'light'}`);
        if (!dark) {
          for (const width of [320, 360, 390, 430, 768, 1440]) {
            await page.setViewportSize({ width, height: 900 });
            await page.goto('/admin/usage');
            await expect(page.getByTestId('workspace-usage')).toBeVisible();
            expect(await page.evaluate(noScroll), `no horizontal scroll at ${width}px`).toBe(true);
          }
        }
        await page.context().close();
      }
      const op = await as(browser, OPERATOR, { mobile: true });
      await op.goto(`/admin/platform/workspaces/${s.ws}`);
      await expect(op.getByTestId('platform-entitlements')).toBeVisible();
      await op.getByTestId('platform-entitlements').scrollIntoViewIfNeeded();
      expect(await op.evaluate(noScroll)).toBe(true);
      await shot(op, 'platform-entitlements-390-light');
      await op.context().close();
    } finally {
      await s.cleanup();
    }
  });
});
