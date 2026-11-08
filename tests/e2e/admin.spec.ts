// V3.1 Admin browser workflows (real Keycloak sign-in, real API + worker, simulated destinations only, E2E Workspace +
// the seeded "Other Workspace"): shell/navigation/scope, filtered delivery list + drawer with preserved list state, live
// propagation between two tabs (change feed), mobile drawer + pause/resume + invite/revoke at 390 px, platform support
// access requested by an operator and approved/ended by the other workspace's owner, and server-side refusals (CSRF,
// non-operators, cross-workspace ids).
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { api, demoBrand, signIn, type Api } from './helpers';

const OWNER = 'owner@demo.social-lite.test';           // E2E Workspace owner + seeded platform operator
const OTHER_OWNER = 'owner@other.social-lite.test';    // owner of "Other Workspace" (no platform role)
const SEEDED_TG = /^Vitalos Telegram \(simulated\)$/;

async function scheduleOne(a: Api, title: string): Promise<{ postId: string; scheduleId: string }> {
  const brand = await demoBrand(a, /Vitalos/);
  const conns = (await a.get(`/api/brands/${brand.id}/connections`)).body.items;
  const tg = conns.find((c: { display_name: string; status: string }) => SEEDED_TG.test(c.display_name) && c.status === 'ready');
  expect(tg, 'seeded Telegram destination').toBeTruthy();
  const p = await a.send('POST', `/api/brands/${brand.id}/posts`, { title, draft: { baseText: `${title} text`, baseLink: null, baseAssetIds: [], variants: [{ connectionId: tg.id, inheritText: true, inheritMedia: true }] } });
  expect([200, 201]).toContain(p.status);
  const local = new Date(Date.now() + 26 * 3600_000).toISOString().slice(0, 16);
  const s = await a.send('POST', `/api/posts/${p.body.id}/schedule`, { expected_version: p.body.version, connection_ids: [tg.id], input_local_time: local, timezone: 'UTC' });
  expect([200, 201, 202], JSON.stringify(s.body).slice(0, 300)).toContain(s.status);
  return { postId: p.body.id, scheduleId: s.body.schedule.id };
}

const main = (page: Page) => page.locator('#admin-main');

test.describe('V3.1 Admin', () => {
  test.describe.configure({ timeout: 180_000 });

  test('overview → deliveries: filters live in the URL, drawer keeps list state, jump palette navigates', async ({ page }) => {
    await signIn(page, OWNER);
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
    await expect(main(page).getByRole('link', { name: /Scheduled · 7 days/ })).toBeVisible();
    // Sidebar: grouped, collapsible, active route.
    const nav = page.getByRole('navigation', { name: 'Workspace admin' });
    await nav.getByRole('button', { name: 'Publishing' }).click();
    await nav.getByRole('link', { name: 'Deliveries' }).click();
    await expect(page).toHaveURL(/\/admin\/publishing$/);
    await expect(nav.getByRole('link', { name: 'Deliveries' })).toHaveAttribute('aria-current', 'page');
    // Quick filter → URL; open a row → drawer; close → same filtered list.
    await page.getByRole('button', { name: /^Scheduled/ }).click();
    await expect(page).toHaveURL(/state=scheduled/);
    const a = await api(page);
    const s = await scheduleOne(a, `Admin list ${randomUUID().slice(0, 6)}`);
    await page.reload();
    await page.getByRole('button', { name: 'Open details' }).first().click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByRole('heading', { name: 'Attempts (0)' }).or(drawer.getByRole('heading', { name: /^Attempts/ })).first()).toBeVisible();
    await expect(page).toHaveURL(/delivery=/);
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/state=scheduled/);
    await expect(page).not.toHaveURL(/delivery=/);
    await a.send('POST', `/api/schedules/${s.scheduleId}/cancel`, {});
    // Jump palette (Ctrl+K): keyboard only.
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox', { name: 'Jump to' }).fill('dead letter');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/admin\/operations/);
    await expect(page.getByRole('heading', { name: 'Dead-lettered events' })).toBeVisible();
  });

  test('a change made elsewhere reaches an open admin page without reload (change feed)', async ({ page, context }) => {
    await signIn(page, OWNER);
    const a = await api(page);
    const title = `Live sync ${randomUUID().slice(0, 6)}`;
    await page.goto('/admin/publishing?state=scheduled');
    await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
    // Another tab (same user) schedules a post through the main app's API.
    const other = await context.newPage();
    await other.goto('/');
    const b = await api(other);
    const s = await scheduleOne(b, title);
    const t0 = Date.now();
    await expect(main(page).getByText(title).first()).toBeVisible({ timeout: 30_000 });
    const seen = Date.now() - t0;
    test.info().annotations.push({ type: 'sync_ms', description: String(seen) });
    expect(seen).toBeLessThan(25_000);
    // ... and a cancellation made here shows in the main app.
    await b.send('POST', `/api/schedules/${s.scheduleId}/cancel`, {});
    await expect(main(page).getByText(title)).toHaveCount(0, { timeout: 30_000 });
    const detail = await a.get(`/api/posts/${s.postId}`);
    expect(detail.body.status).toBe('cancelled');
  });

  test('@mobile 390 px: drawer navigation with focus management, pause + resume a brand, invite + revoke', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, OWNER);
    await page.goto('/admin');
    expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')).toBe(true);
    const menu = page.getByRole('button', { name: 'Open navigation' });
    await menu.click();
    const drawer = page.getByRole('dialog', { name: 'Admin navigation' });
    await expect(drawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(menu).toBeFocused();
    await menu.click();
    await drawer.getByRole('button', { name: 'Operations' }).click();
    await drawer.getByRole('link', { name: 'Queues and workers' }).click();
    await expect(page).toHaveURL(/\/admin\/operations/);
    // Pause one brand (reason recorded), verify it persists across reload, then resume.
    const row = main(page).getByRole('listitem').filter({ hasText: /Vitalos/ }).first();
    await row.getByRole('button', { name: /^Pause/ }).click();
    await page.getByRole('textbox', { name: 'Reason' }).fill('Mobile E2E pause');
    await page.getByRole('button', { name: 'Pause brand' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.reload();
    await expect(main(page).getByRole('listitem').filter({ hasText: /Vitalos/ }).first().getByText('Paused')).toBeVisible();
    await main(page).getByRole('listitem').filter({ hasText: /Vitalos/ }).first().getByRole('button', { name: /^Resume/ }).click();
    await page.getByRole('button', { name: 'Resume brand' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(main(page).getByRole('listitem').filter({ hasText: /Vitalos/ }).first().getByText('Publishing')).toBeVisible();
    // Invite then revoke (local mail capture only).
    await page.goto('/admin/people/invitations');
    await page.getByRole('button', { name: 'Invite' }).click();
    const email = `admin-e2e-${randomUUID().slice(0, 6)}@example.test`;
    await page.getByRole('textbox', { name: 'Email' }).fill(email);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(main(page).getByText(email).first()).toBeVisible();
    await page.getByRole('button', { name: `Revoke invitation for ${email}` }).click();
    await page.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(main(page).getByText(email)).toHaveCount(0);
    expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')).toBe(true);
  });

  test('platform support access: operator requests, the workspace approves (read-only, time-boxed), either side ends it', async ({ browser }) => {
    const opCtx = await browser.newContext();
    const op = await opCtx.newPage();
    await signIn(op, OWNER);
    const oa = await api(op);
    // Clean slate from earlier runs (Other Workspace persists in the dev database).
    for (const g of (await oa.get('/api/platform/support-access')).body.items) {
      if (g.status === 'requested' || g.status === 'active') await oa.send('POST', `/api/platform/support-access/${g.id}/end`, {});
    }
    await op.goto('/admin/platform/workspaces?q=Other');
    await op.getByRole('link', { name: 'Other Workspace' }).first().click();
    await expect(op.getByRole('heading', { name: 'Other Workspace', level: 1 })).toBeVisible();
    // Metadata only: no post text on the platform page.
    await op.getByRole('button', { name: 'Request support access' }).click();
    await op.getByRole('textbox', { name: 'Reason' }).fill('E2E: customer reported failed posts');
    await op.getByRole('button', { name: 'Send request' }).click();
    await expect(op.getByText('Your request is waiting for the workspace')).toBeVisible();
    const before = (await oa.get('/api/session')).body.workspaces.map((w: { name: string }) => w.name);
    expect(before).not.toContain('Other Workspace');

    const wsCtx = await browser.newContext();
    const owner = await wsCtx.newPage();
    await signIn(owner, OTHER_OWNER);
    await owner.goto('/admin/security/support');
    const card = owner.getByRole('listitem').filter({ hasText: 'E2E: customer reported failed posts' }).first();
    await card.getByRole('button', { name: 'Approve' }).click();
    await owner.getByRole('dialog').getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(card.getByText('active', { exact: true })).toBeVisible();
    await expect(owner.getByText(/Support access is active/)).toBeVisible();

    // The operator now has a read-only viewer grant through the normal policy path.
    const after = (await oa.get('/api/session')).body.workspaces.map((w: { name: string }) => w.name);
    expect(after).toContain('Other Workspace');
    await card.getByRole('button', { name: 'End now' }).click();
    await owner.getByRole('dialog').getByRole('button', { name: 'End access' }).click();
    await expect(card.getByText('ended', { exact: true })).toBeVisible();
    expect((await oa.get('/api/session')).body.workspaces.map((w: { name: string }) => w.name)).not.toContain('Other Workspace');
    await opCtx.close();
    await wsCtx.close();
  });

  test('server refuses: CSRF, non-operators on platform APIs, editors on admin APIs, cross-workspace ids', async ({ browser }) => {
    const c1 = await browser.newContext();
    const owner = await c1.newPage();
    await signIn(owner, OWNER);
    const a = await api(owner);
    expect((await a.send('POST', '/api/platform/dispatch', { enabled: true, reason: 'no csrf token here' }, { csrf: false })).status).toBe(403);
    const s = await scheduleOne(a, `Refusal ${randomUUID().slice(0, 6)}`);
    const delivery = (await a.get(`/api/posts/${s.postId}/deliveries`)).body.items[0].id as string;
    await a.send('POST', `/api/schedules/${s.scheduleId}/cancel`, {});

    const c2 = await browser.newContext();
    const editor = await c2.newPage();
    await signIn(editor, 'editor@demo.social-lite.test');
    const e = await api(editor);
    expect((await e.get('/api/platform/overview')).status).toBe(404);              // not discoverable
    expect((await e.get('/api/admin/overview')).status).toBe(403);
    await editor.goto('/admin');
    await expect(editor.getByText('Workspace admins only')).toBeVisible();

    const c3 = await browser.newContext();
    const outsider = await c3.newPage();
    await signIn(outsider, OTHER_OWNER);
    const o = await api(outsider);
    expect((await o.get(`/api/admin/deliveries/${delivery}`)).status).toBe(404);
    expect((await o.send('POST', `/api/deliveries/${delivery}/retry`, {})).status).toBe(404);
    await Promise.all([c1.close(), c2.close(), c3.close()]);
  });
});
