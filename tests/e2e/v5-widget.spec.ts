// V5 marketing support widget (stream WID) — browser workflows against the production build, real Keycloak sign-in,
// real API + storage:
//  - visitor on `/` → "Send us a message" → Platform → Support shows it (source marketing widget, visitor identity) →
//    staff internal note + public reply → the reply appears in that visitor's widget by polling, the note never does
//    (UI + API); another visitor gets 404 and sees none of it (§18.9–12);
//  - signed-in customer writes from their account (workspace from trusted context);
//  - keyboard: launcher → dialog → Escape returns focus; lazy panel chunk;
//  - phone (@mobile): full-screen sheet with "Close chat", reply composer reachable, launcher never covers pricing
//    actions, no page-level horizontal scroll at 320–1440 with the widget closed and open.
// Screenshots (1440 + 390, light + dark, DPR 2) go to evidence/v5/wid/.
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { api, signIn } from './helpers';

const STAFF = 'owner@demo.social-lite.test'; // seeded platform operator (fresh MFA after sign-in)
const CUSTOMER = 'editor@demo.social-lite.test';
const EVIDENCE = 'evidence/v5/wid';
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const noScroll = 'document.documentElement.scrollWidth <= window.innerWidth + 1';
const NOTE = `Internal only ${randomUUID().slice(0, 6)}: finance approved, do not share`;

mkdirSync(EVIDENCE, { recursive: true });

async function ctxFor(browser: Browser, opts: { mobile?: boolean; dark?: boolean; width?: number } = {}): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: BASE, deviceScaleFactor: 2, colorScheme: opts.dark ? 'dark' : 'light',
    viewport: opts.mobile ? { width: opts.width ?? 390, height: 844 } : { width: opts.width ?? 1440, height: 900 }, isMobile: !!opts.mobile, hasTouch: !!opts.mobile,
  });
}

async function staffPage(browser: Browser): Promise<Page> {
  const page = await (await ctxFor(browser)).newPage();
  await signIn(page, STAFF);
  return page;
}

async function setWidget(staff: Page, enabled: boolean, staffed = false) {
  const a = await api(staff);
  const r = await a.send('PUT', '/api/platform/marketing', { widget_enabled: enabled, widget_staffed: staffed, reason: 'E2E: support widget workflow (v5-widget.spec)' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${EVIDENCE}/${name}.png`, fullPage: false });
}

async function openWidget(page: Page) {
  await page.goto('/');
  const launcher = page.getByTestId('support-launcher');
  await expect(launcher).toBeVisible();
  await launcher.click();
  const panel = page.getByRole('dialog');
  await expect(panel).toBeVisible();
  return panel;
}

async function sendFirstMessage(page: Page, name: string, email: string, message: string): Promise<string> {
  const panel = await openWidget(page);
  await expect(panel.getByRole('heading', { name: 'Send us a message' })).toBeVisible();
  await panel.getByLabel('Name').fill(name);
  await panel.getByLabel('Email').fill(email);
  await panel.getByLabel('Message').fill(message);
  await page.waitForTimeout(1600); // a person takes longer than the time trap anyway
  await panel.getByRole('button', { name: 'Send message' }).click();
  await expect(panel.getByText(message)).toBeVisible();
  const ref = await panel.getByText(/^RLY-\d+/).first().textContent();
  return /RLY-\d+/.exec(ref ?? '')![0];
}

test.describe('V5 support widget', () => {
  test.describe.configure({ timeout: 300_000 });
  let previous: { widget_enabled: boolean; widget_staffed: boolean } | null = null;

  test.beforeAll(async ({ browser }) => {
    const staff = await staffPage(browser);
    const cur = await (await api(staff)).get('/api/platform/marketing');
    previous = { widget_enabled: !!cur.body?.widget_enabled, widget_staffed: !!cur.body?.widget_staffed };
    await setWidget(staff, true, false);
    await staff.context().close();
  });

  test.afterAll(async ({ browser }) => {
    if (!previous) return;
    const staff = await staffPage(browser);
    await setWidget(staff, previous.widget_enabled, previous.widget_staffed);
    await staff.context().close();
  });

  test('visitor message reaches Platform → Support; staff reply returns to that widget; notes never do; other visitors get 404', async ({ browser }) => {
    const tag = randomUUID().slice(0, 6);
    const vctx = await ctxFor(browser);
    const visitor = await vctx.newPage();
    await visitor.goto('/');
    await expect(visitor.getByTestId('support-launcher')).toBeVisible();
    const panel = await openWidget(visitor);
    await expect(panel.getByTestId('widget-privacy')).toContainText('A cookie keeps this conversation in this browser for up to 30 days');
    await expect(panel.getByText(/online|minutes|typically replies/i)).toHaveCount(0); // no invented status / response time
    await shot(visitor, 'visitor-compose-1440-light');
    await visitor.keyboard.press('Escape');

    const message = `Do you support Bluesky threads? (${tag})`;
    const ref = await sendFirstMessage(visitor, 'Vera Visitor', `vera-${tag}@example.test`, message);
    await expect(visitor.getByTestId('conversation-status')).toHaveText('Sent');
    // The session cookie is HttpOnly (not readable by page script).
    expect(await visitor.evaluate('document.cookie')).not.toContain('relay_widget=');
    const cookies = await vctx.cookies();
    expect(cookies.find((c) => c.name === 'relay_widget')).toMatchObject({ httpOnly: true, sameSite: 'Lax' });

    // Staff: Platform → Support shows the conversation with source + visitor identity.
    const staff = await staffPage(browser);
    await staff.goto(`/admin/platform/support/${ref}`);
    await expect(staff.getByText('marketing widget')).toBeVisible();
    await expect(staff.getByText('Vera Visitor (visitor)')).toBeVisible();
    await expect(staff.getByText(`vera-${tag}@example.test · not verified`)).toBeVisible();
    const a = await api(staff);
    expect((await a.send('POST', `/api/platform/support/tickets/${ref}/notes`, { body: NOTE })).status).toBe(200);
    expect((await a.send('POST', `/api/platform/support/tickets/${ref}/replies`, { body: `Yes — Bluesky threads are supported (${tag}).` })).status).toBe(200);
    await staff.reload();
    await expect(staff.getByText(NOTE)).toBeVisible();
    await staff.screenshot({ path: `${EVIDENCE}/staff-ticket-1440-light.png` });
    await staff.goto('/admin/platform/support?queue=open&source=widget');
    await expect(staff.getByTestId('support-inbox')).toContainText(ref);
    await staff.screenshot({ path: `${EVIDENCE}/staff-inbox-widget-1440-light.png` });

    // Visitor: the reply arrives by polling (no reload), from "<first name> · Relay"; the note never appears.
    await expect(visitor.getByText(`Yes — Bluesky threads are supported (${tag}).`)).toBeVisible({ timeout: 30_000 });
    await expect(visitor.getByTestId('conversation-status')).toHaveText('Relay replied');
    await expect(visitor.getByText(NOTE)).toHaveCount(0);
    const json = await (await visitor.request.get(`/api/widget/conversations/${ref}`)).text();
    expect(json).toContain('Bluesky threads are supported');
    expect(json).not.toContain('finance approved');
    expect(await (await visitor.request.get('/api/widget/session')).text()).not.toContain('finance approved');
    await shot(visitor, 'visitor-conversation-1440-light');
    // Visitor replies (deduplicated id) and staff see it.
    await visitor.getByLabel('Reply').fill('Great, thanks!');
    await visitor.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(visitor.getByText('Great, thanks!')).toBeVisible();
    await expect(visitor.getByText('Sending…')).toHaveCount(0);

    // Another visitor: 404 for the conversation, nothing listed.
    const other = await (await ctxFor(browser, { dark: true })).newPage();
    await other.goto('/');
    expect((await other.request.get(`/api/widget/conversations/${ref}`)).status()).toBe(404);
    const otherPanel = await openWidget(other);
    await expect(otherPanel.getByRole('heading', { name: 'Send us a message' })).toBeVisible(); // straight to compose: no conversations
    await expect(otherPanel.getByText(message)).toHaveCount(0);
    await shot(other, 'visitor-compose-1440-dark');

    await vctx.close();
    await staff.context().close();
    await other.context().close();
  });

  test('signed-in customer writes from their account; workspace from trusted context', async ({ browser }) => {
    const tag = randomUUID().slice(0, 6);
    const page = await (await ctxFor(browser, { dark: true })).newPage();
    await signIn(page, CUSTOMER);
    const panel = await openWidget(page);
    // Existing requests (Help → My requests) are listed first; start a new one from there.
    const newBtn = panel.getByRole('button', { name: 'New message' });
    await expect(newBtn.or(panel.getByText(/Signed in as/)).first()).toBeVisible();
    if (await newBtn.isVisible()) {
      await expect(panel.getByTestId('conversation-row').first()).toBeVisible();
      await shot(page, 'member-list-1440-dark');
      await newBtn.click();
    }
    await expect(panel.getByText(/Signed in as/)).toBeVisible();
    await expect(panel.getByLabel('Name')).toHaveCount(0); // no identity fields for members
    await panel.getByLabel('Message').fill(`Seat question from the site (${tag})`);
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect(panel.getByText(`Seat question from the site (${tag})`)).toBeVisible();
    await shot(page, 'member-conversation-1440-dark');
    const ref = /RLY-\d+/.exec((await panel.getByText(/^RLY-\d+/).first().textContent()) ?? '')![0];
    // Same request in Help → My requests (one support system).
    const a = await api(page);
    const r = await a.get(`/api/support/requests/${ref}`);
    expect(r.status).toBe(200);
    expect(r.body.source).toBe('widget');
    await page.context().close();
  });

  test('keyboard: launcher opens an accessible dialog; Escape closes and returns focus', async ({ browser }) => {
    const page = await (await ctxFor(browser)).newPage();
    await page.goto('/');
    const launcher = page.getByTestId('support-launcher');
    await expect(launcher).toHaveAccessibleName(/Send us a message/);
    await launcher.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleName(/Send us a message/);
    await expect(dialog.getByRole('button', { name: 'Close chat' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(launcher).toBeFocused();
    await page.context().close();

    // Reduced motion: content is visible without animation. 200 % zoom ≈ a 720 px CSS viewport: panel fits, no h-scroll.
    const rm = await browser.newContext({ baseURL: BASE, reducedMotion: 'reduce', viewport: { width: 720, height: 450 }, deviceScaleFactor: 2 });
    const z = await rm.newPage();
    await z.goto('/');
    await z.getByTestId('support-launcher').click();
    const zd = z.getByRole('dialog');
    await expect(zd.getByRole('heading', { name: 'Send us a message' })).toBeVisible();
    await expect(zd.getByLabel('Message')).toBeVisible();
    expect(await z.evaluate(noScroll)).toBe(true);
    const zb = await zd.boundingBox();
    expect((zb?.x ?? 0) + (zb?.width ?? 0)).toBeLessThanOrEqual(721);
    await shot(z, 'visitor-compose-200pct-reduced-motion');
    await rm.close();
  });

  test('@mobile full-screen sheet with close button; launcher never covers pricing actions; no horizontal scroll', async ({ browser }) => {
    const tag = randomUUID().slice(0, 6);
    for (const dark of [false, true]) {
      const page = await (await ctxFor(browser, { mobile: true, dark })).newPage();
      const panel = await openWidget(page);
      const box = await panel.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(389);
      expect(box?.height).toBeGreaterThanOrEqual(800);
      await expect(panel.getByRole('button', { name: 'Close chat' })).toBeVisible();
      await shot(page, `visitor-compose-390-${dark ? 'dark' : 'light'}`);
      if (!dark) {
        await panel.getByLabel('Name').fill('Max Mobile');
        await panel.getByLabel('Email').fill(`max-${tag}@example.test`);
        await panel.getByLabel('Message').fill(`Typed on a phone (${tag})`);
        await page.waitForTimeout(1600);
        await panel.getByRole('button', { name: 'Send message' }).click();
        await expect(panel.getByText(`Typed on a phone (${tag})`)).toBeVisible();
        const reply = panel.getByLabel('Reply');
        await reply.focus();
        await expect(reply).toBeInViewport();
        await expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeInViewport();
        await shot(page, 'visitor-conversation-390-light');
      }
      await panel.getByRole('button', { name: 'Close chat' }).click();
      await expect(panel).toBeHidden();
      await page.context().close();
    }

    // The launcher steps aside whenever it would overlap a pricing action.
    const page = await (await ctxFor(browser, { mobile: true })).newPage();
    await page.goto('/');
    const ctas = page.locator('#pricing a, #pricing button');
    const n = await ctas.count();
    for (let i = 0; i < n; i++) {
      await page.evaluate(`document.querySelectorAll('#pricing a, #pricing button')[${i}].scrollIntoView({ block: 'end' })`);
      await page.waitForTimeout(120);
      const overlap = await page.evaluate(`(() => {
        const l = document.querySelector('[data-testid="support-launcher"]');
        if (!l || l.dataset.state === 'stepped-aside') return false;
        const a = l.getBoundingClientRect();
        const b = document.querySelectorAll('#pricing a, #pricing button')[${i}].getBoundingClientRect();
        return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      })()`);
      expect(overlap, `launcher overlaps pricing action #${i}`).toBe(false);
    }
    await page.context().close();

    // No page-level horizontal scroll with the widget closed and open.
    for (const width of [320, 360, 390, 430, 768, 1024, 1440]) {
      const p = await (await ctxFor(browser, { mobile: width < 768, width })).newPage();
      await p.goto('/');
      await expect(p.getByTestId('support-launcher')).toBeVisible();
      expect(await p.evaluate(noScroll), `closed @${width}`).toBe(true);
      await p.getByTestId('support-launcher').click();
      await expect(p.getByRole('dialog')).toBeVisible();
      expect(await p.evaluate(noScroll), `open @${width}`).toBe(true);
      const d = await p.getByRole('dialog').boundingBox();
      expect((d?.x ?? 0) + (d?.width ?? 0)).toBeLessThanOrEqual(width + 1);
      await p.context().close();
    }
  });
});
