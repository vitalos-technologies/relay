// V4 Relay support (stream SUP) browser workflows — real Keycloak sign-in, production build, real API + storage:
//  - customer Help → Contact support (screenshot attached) → Platform → Support (staff) → internal note + public reply →
//    the customer sees the reply, never the note (page, API, transcript); another tenant gets 404 for ticket and file;
//  - problem report → review → "Send to Relay support";
//  - phone (@mobile): create with a screenshot, read + reply; staff triage + reply; no page-level horizontal scroll at
//    320–1440 on the support pages.
// Screenshots (1440 + 390, light + dark, DPR 2) go to evidence/v4/sup/.
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { api, signIn } from './helpers';

const CUSTOMER = 'editor@demo.social-lite.test';
const STAFF = 'owner@demo.social-lite.test'; // seeded platform operator
const OUTSIDER = 'owner@other.social-lite.test';
const EVIDENCE = 'evidence/v4/sup';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cf00000301010018dd8db00000000049454e44ae426082', 'hex');
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

async function shot(page: Page, name: string) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.screenshot({ path: `${EVIDENCE}/${name}.png`, fullPage: false });
}

async function createViaForm(page: Page, subject: string, message: string) {
  await page.goto('/help/contact');
  await expect(page.getByRole('heading', { name: 'Contact support' })).toBeVisible();
  await page.getByTestId('support-category').selectOption('publishing');
  await page.getByLabel('Subject').fill(subject);
  await page.getByLabel('Message').fill(message);
  await page.getByTestId('support-file-input').setInputFiles({ name: 'screenshot.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByRole('list', { name: 'Attachments' })).toContainText('screenshot.png');
  await expect(page.getByText('Checking…')).toHaveCount(0, { timeout: 20_000 });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForURL(/\/help\/requests\/RLY-\d+/);
  return /RLY-\d+/.exec(page.url())![0];
}

test.describe('V4 Relay support', () => {
  test.describe.configure({ timeout: 300_000 });

  test('customer request → Platform → Support → reply reaches the customer; internal note never does; other tenants get 404', async ({ browser }) => {
    const tag = randomUUID().slice(0, 6);
    const customer = await as(browser, CUSTOMER);
    const ref = await createViaForm(customer, `Queue stuck ${tag}`, 'Scheduled posts did not go out this morning.');
    await expect(customer.getByText('Scheduled posts did not go out this morning.')).toBeVisible();
    await expect(customer.getByRole('link', { name: 'screenshot.png' })).toBeVisible();
    const fileUrl = await customer.getByRole('link', { name: 'screenshot.png' }).getAttribute('href');
    expect(fileUrl).toMatch(/^\/api\/support\/attachments\//);

    // Staff inbox: the request is there with workspace context.
    const staff = await as(browser, STAFF);
    await staff.goto('/admin/platform/support?queue=unassigned');
    await expect(staff.getByRole('heading', { name: 'Support' })).toBeVisible();
    await expect(staff.getByTestId('support-inbox')).toContainText(ref);
    await shot(staff, 'staff-inbox-1440-light');
    await staff.getByTestId('support-inbox').getByRole('link', { name: new RegExp(ref) }).click();
    await staff.waitForURL(new RegExp(`/admin/platform/support/${ref}`));
    await expect(staff.getByText('Scheduled posts did not go out this morning.')).toBeVisible();
    await expect(staff.getByText('E2E Workspace').first()).toBeVisible();

    const NOTE = `INTERNAL-${tag} customer may be on the legacy plan`;
    await staff.getByRole('radio', { name: 'Internal note' }).click();
    await expect(staff.getByText('Staff only — never shown to the customer')).toBeVisible();
    await staff.getByLabel('Internal note').fill(NOTE);
    await staff.getByRole('button', { name: 'Add note' }).click();
    await expect(staff.getByText(NOTE)).toBeVisible();
    await staff.getByRole('radio', { name: 'Reply to customer' }).click();
    await staff.getByLabel('Reply to customer').fill(`Thanks — we are on it (${tag}).`);
    await staff.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(staff.getByText(`Thanks — we are on it (${tag}).`)).toBeVisible();
    await expect(staff.getByText(/notified 1/)).toBeVisible({ timeout: 30_000 }); // worker delivered the customer notification
    await shot(staff, 'staff-ticket-1440-light');

    // Customer: reply visible (live refresh), note absent everywhere.
    await expect(customer.getByText(`Thanks — we are on it (${tag}).`)).toBeVisible({ timeout: 20_000 });
    await expect(customer.getByText(`INTERNAL-${tag}`)).toHaveCount(0);
    const ca = await api(customer);
    const detail = await ca.get(`/api/support/requests/${ref}`);
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toContain(`INTERNAL-${tag}`);
    const transcript = await customer.request.get(`/api/support/requests/${ref}/transcript`);
    expect(await transcript.text()).not.toContain(`INTERNAL-${tag}`);
    const feed = await ca.get('/api/notifications?category=support');
    expect(JSON.stringify(feed.body)).toContain(ref);
    expect(JSON.stringify(feed.body)).not.toContain('we are on it');
    await shot(customer, 'customer-request-1440-light');

    // Reply as the customer; staff see it.
    await customer.getByLabel('Reply').fill('Still stuck for one account.');
    await customer.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(customer.getByText('Still stuck for one account.')).toBeVisible();
    await staff.reload();
    await expect(staff.getByText('Still stuck for one account.')).toBeVisible();

    // Another tenant: ticket, events and file are 404.
    const outsider = await as(browser, OUTSIDER);
    const oa = await api(outsider);
    expect((await oa.get(`/api/support/requests/${ref}`)).status).toBe(404);
    expect((await oa.get(`/api/support/requests/${ref}/events`)).status).toBe(404);
    expect((await outsider.request.get(fileUrl!)).status()).toBe(404);
    // A non-staff user can't reach the staff API (platform surface is not discoverable).
    expect((await oa.get('/api/platform/support/tickets')).status).toBe(404);

    // Dark-mode screenshots of the same screens.
    const darkC = await as(browser, CUSTOMER, { dark: true });
    await darkC.goto(`/help/requests/${ref}`);
    await expect(darkC.getByText('Still stuck for one account.')).toBeVisible();
    await shot(darkC, 'customer-request-1440-dark');
    const darkS = await as(browser, STAFF, { dark: true });
    await darkS.goto(`/admin/platform/support/${ref}`);
    await expect(darkS.getByText(NOTE)).toBeVisible();
    await shot(darkS, 'staff-ticket-1440-dark');
    await darkC.goto('/help/contact');
    await shot(darkC, 'contact-1440-dark');
    await customer.goto('/help/contact');
    await shot(customer, 'contact-1440-light');
    await customer.goto('/help/requests');
    await shot(customer, 'my-requests-1440-light');
  });

  test('problem report is shared only through the explicit review flow', async ({ browser }) => {
    const tag = randomUUID().slice(0, 6);
    const owner = await as(browser, STAFF);
    const a = await api(owner);
    const r = await a.send('POST', '/api/support/reports', { category: 'publishing', summary: `Report ${tag}: calendar froze`, route: '/planner?secret=1', app_version: '4.0.0', correlation_ids: [], browser_family: 'chrome' });
    expect(r.status).toBe(200);
    // Nothing reached Relay yet.
    expect(JSON.stringify((await a.get('/api/platform/support/tickets?queue=open&q=' + encodeURIComponent(`Report ${tag}`))).body.items)).toBe('[]');
    await owner.goto('/admin/security/reports');
    const card = owner.locator('li', { hasText: `Report ${tag}` });
    await card.getByRole('button', { name: 'Send to Relay support' }).click();
    const dlg = owner.getByRole('dialog', { name: 'Send to Relay support' });
    await expect(dlg.getByText(`Report ${tag}: calendar froze`)).toBeVisible();
    await expect(dlg.getByRole('checkbox', { name: /Page \(path only\)/ })).toBeChecked();
    await expect(dlg.getByText('/planner', { exact: true })).toBeVisible(); // path only, query dropped
    await dlg.getByRole('checkbox', { name: /Browser/ }).uncheck();
    await shot(owner, 'share-report-1440-light');
    await dlg.getByRole('button', { name: 'Send to Relay' }).click();
    await expect(dlg.getByTestId('report-shared')).toContainText(/RLY-\d+/);
    const ref = /RLY-\d+/.exec(await dlg.getByTestId('report-shared').innerText())![0];
    const t = await a.get(`/api/support/requests/${ref}`);
    expect(t.body.source).toBe('problem_report');
    expect(t.body.diagnostics).toEqual({ app_version: '4.0.0', route: '/planner' });
    await dlg.getByRole('button', { name: 'Done' }).click();
    await expect(card.getByText(ref)).toBeVisible();
  });

  test('phone: create with a screenshot, read and reply; staff triage and reply; no horizontal scroll @mobile', async ({ browser }) => {
    const tag = randomUUID().slice(0, 6);
    const customer = await as(browser, CUSTOMER, { mobile: true });
    const ref = await createViaForm(customer, `Phone ${tag}`, 'Sent from my phone.');
    await expect(customer.getByRole('link', { name: 'screenshot.png' })).toBeVisible();
    await shot(customer, 'customer-request-390-light');

    const staff = await as(browser, STAFF, { mobile: true });
    await staff.goto(`/admin/platform/support?queue=open&q=${ref}`);
    await expect(staff.getByTestId('support-inbox')).toContainText(ref);
    await shot(staff, 'staff-inbox-390-light');
    await staff.getByTestId('support-inbox').getByRole('link', { name: new RegExp(ref) }).click();
    await staff.waitForURL(new RegExp(`/admin/platform/support/${ref}`));
    await expect(staff.getByText('Sent from my phone.')).toBeVisible();
    await staff.getByLabel('Priority').selectOption('high');
    await expect(staff.getByText('Priority: high')).toBeVisible();
    await staff.getByLabel('Reply to customer').fill(`Phone reply ${tag}`);
    await staff.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(staff.getByText(`Phone reply ${tag}`)).toBeVisible();
    await shot(staff, 'staff-ticket-390-light');

    await customer.reload();
    await expect(customer.getByText(`Phone reply ${tag}`)).toBeVisible();
    await customer.getByLabel('Reply').fill('Thanks!');
    await customer.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(customer.getByText('Thanks!')).toBeVisible();

    const dark = await as(browser, CUSTOMER, { mobile: true, dark: true });
    await dark.goto(`/help/requests/${ref}`);
    await expect(dark.getByText('Thanks!')).toBeVisible();
    await shot(dark, 'customer-request-390-dark');
    await dark.goto('/help/contact');
    await shot(dark, 'contact-390-dark');
    const darkStaff = await as(browser, STAFF, { mobile: true, dark: true });
    await darkStaff.goto(`/admin/platform/support/${ref}`);
    await expect(darkStaff.getByText(`Phone reply ${tag}`)).toBeVisible();
    await shot(darkStaff, 'staff-ticket-390-dark');

    for (const w of [320, 360, 390, 430, 768, 1440]) {
      for (const [p, path] of [[customer, '/help/contact'], [customer, '/help/requests'], [customer, `/help/requests/${ref}`], [staff, '/admin/platform/support'], [staff, `/admin/platform/support/${ref}`]] as const) {
        await p.setViewportSize({ width: w, height: 800 });
        await p.goto(path);
        await p.waitForLoadState('networkidle').catch(() => undefined);
        expect(await p.evaluate(noScroll), `${path} at ${w}px`).toBe(true);
      }
    }
  });
});
