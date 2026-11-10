// V2 stream D browser workflows (real Keycloak sign-in, real API): account health centre, readiness
// preflight + duplicate acknowledgement, activity centre export, budgets and client handover export.
// Self-contained: creates its own simulated destinations and posts through the API.
// Screenshots → evidence/v2/product-*.png. Run: E2E_BASE_URL=http://localhost:3100 pnpm test:e2e tests/e2e/v2-product.spec.ts
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { api, demoBrand, signIn, type Api } from './helpers';

const OUT = 'evidence/v2';

/** helpers.signIn (port-agnostic: the stream-D instance may run on :3100). */
async function signInHere(page: Page, email: string) {
  await signIn(page, email);
}

const inHours = (h: number) => {
  const d = new Date(Date.now() + h * 3600_000);
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d).replace(' ', 'T');
};

async function mock(a: Api, brandId: string, provider: string, name: string, scenario = 'success'): Promise<string> {
  const r = await a.send('POST', `/api/brands/${brandId}/connections/mock`, { provider, display_name: name, scenario });
  expect([200, 201], JSON.stringify(r.body).slice(0, 300)).toContain(r.status);
  return r.body.id;
}

async function post(a: Api, brandId: string, title: string, text: string, conns: string[]): Promise<string> {
  const r = await a.send('POST', `/api/brands/${brandId}/posts`, { title, draft: { baseText: text, baseLink: null, baseAssetIds: [], variants: conns.map((connectionId) => ({ connectionId, inheritText: true, inheritMedia: true })) } });
  expect([200, 201], JSON.stringify(r.body).slice(0, 300)).toContain(r.status);
  return r.body.id;
}

test.describe('V2 product & fairness', () => {
  test('account health centre explains problems, fixes and affected posts', async ({ page }) => {
    await signInHere(page, 'owner@demo.social-lite.test');
    const a = await api(page);
    const brand = await demoBrand(a, /Vitalos/);
    const tag = randomUUID().slice(0, 4);
    const fb = await mock(a, brand.id, 'facebook', `Health FB ${tag}`, 'missing_permission');
    const tg = await mock(a, brand.id, 'telegram', `Health TG ${tag}`, 'revoked');
    const p = await post(a, brand.id, `Affected launch ${tag}`, `Launch day reminder ${tag}`, [fb, tg]);
    expect((await a.send('POST', `/api/posts/${p}/schedule`, { expected_version: 1, connection_ids: [fb, tg], input_local_time: inHours(6), timezone: 'Europe/London' })).status).toBe(202);
    await a.send('POST', `/api/connections/${fb}/check`, {});
    await a.send('POST', `/api/connections/${tg}/check`, {});

    await page.goto('/accounts');
    await page.getByRole('link', { name: 'Health' }).click();
    await page.waitForURL(/\/accounts\/health/);
    const card = page.getByTestId(`health-${fb}`);
    await expect(card).toContainText('Missing permission');
    await expect(card).toContainText('1 upcoming post affected');
    await expect(page.getByTestId(`health-${tg}`)).toContainText('Access revoked');
    await page.screenshot({ path: `${OUT}/product-health.png`, fullPage: true });
    // The fix button really works: reconnecting the simulated destination clears the problem.
    await page.getByTestId(`health-${tg}`).getByRole('button', { name: 'Reconnect' }).click();
    await expect(page.getByTestId(`health-${tg}`)).toHaveCount(0, { timeout: 15_000 });
  });

  test('readiness preflight with a duplicate warning that must be acknowledged', async ({ page }) => {
    await signInHere(page, 'owner@demo.social-lite.test');
    const a = await api(page);
    const brand = await demoBrand(a, /Vitalos/);
    const tag = randomUUID().slice(0, 4);
    const x = await mock(a, brand.id, 'x', `Ready X ${tag}`);
    const first = await post(a, brand.id, `Weekend opening ${tag}`, `We are open this weekend from 9am — come and say hello! ${tag}`, [x]);
    expect((await a.send('POST', `/api/posts/${first}/schedule`, { expected_version: 1, connection_ids: [x], input_local_time: inHours(3), timezone: 'Europe/London' })).status).toBe(202);
    const second = await post(a, brand.id, `Weekend opening again ${tag}`, `We are open this weekend from 9am, come and say hello!! ${tag}`, [x]);

    await page.goto(`/posts/${second}`);
    await page.getByRole('button', { name: /^Schedule$/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('duplicate-warning')).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByTestId('duplicate-warning')).toContainText(`Weekend opening ${tag}`);
    // Soft-disabled (focusable, aria-disabled) with the reason in its accessible name.
    const schedule = dialog.getByRole('button', { name: /^Schedule/ });
    await expect(schedule).toHaveAttribute('aria-disabled', 'true');
    await expect(schedule).toHaveAccessibleName(/Confirm the duplicate warning/);
    await page.screenshot({ path: `${OUT}/product-readiness.png` });
    await dialog.getByLabel('Post anyway').check();
    await expect(schedule).not.toHaveAttribute('aria-disabled', 'true');
    await schedule.click();
    await expect(dialog).toHaveCount(0, { timeout: 15_000 });
  });

  test('activity centre filters and exports (CSV), budgets and client handover', async ({ page }) => {
    await signInHere(page, 'owner@demo.social-lite.test');
    await page.goto('/activity');
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
    await page.getByRole('radio', { name: 'Accounts' }).click();
    await expect(page.locator('tbody tr').first()).toContainText('connection.');
    await page.screenshot({ path: `${OUT}/product-activity.png`, fullPage: true });
    const [csv] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /CSV/ }).click()]);
    const text = readFileSync(await csv.path(), 'utf8');
    expect(text.split('\r\n')[0]).toBe('created_at_utc,category,action,actor,brand,resource_type,resource_id,details,correlation_id,event_id');
    expect(text).toContain('connection.');

    await page.goto('/settings?tab=budgets');
    await expect(page.getByText('Exports / month', { exact: true })).toBeVisible();
    await page.screenshot({ path: `${OUT}/product-budgets.png`, fullPage: true });

    await page.goto('/settings/operations/export'); // V3: Settings → Operations → Data export (was ?tab=brand)
    await expect(page.getByText('Client handover')).toBeVisible();
    const [zip] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export', exact: true }).click()]);
    expect(zip.suggestedFilename()).toMatch(/^handover-.*\.zip$/);
    const bytes = readFileSync(await zip.path());
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    await page.screenshot({ path: `${OUT}/product-handover.png`, fullPage: true });
  });

  test('viewer: no activity centre, health is read-only @mobile', async ({ page }) => {
    await signInHere(page, 'viewer@demo.social-lite.test');
    await page.goto('/activity');
    await expect(page.getByText('Owners and admins only')).toBeVisible();
    await page.goto('/accounts/health');
    await expect(page.getByRole('heading', { name: 'Connection health' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reconnect' })).toHaveCount(0);
    await page.screenshot({ path: `${OUT}/product-health-viewer-mobile.png`, fullPage: true });
  });
});
