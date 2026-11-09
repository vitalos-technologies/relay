// V5 MKT — the public marketing page and the marketing → sign up → workspace → trial handoff (brief §18 items 1–7, 17, 18
// MKT part). Real browser against the running app; real local Keycloak (self-registration enabled in the LOCAL realm only,
// email verified through the local mail capture); deterministic billing test double. Screenshots → evidence/v5/mkt/.
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { KEYCLOAK, signIn } from './helpers';

const EVIDENCE = 'evidence/v5/mkt';
const MAILPIT = process.env.E2E_MAILPIT_URL ?? 'http://localhost:8025';
const OWNER = 'owner@demo.social-lite.test';
const overflow = (p: Page) => p.evaluate<number>('document.documentElement.scrollWidth - document.documentElement.clientWidth');
mkdirSync(EVIDENCE, { recursive: true });

const SECTIONS = ['product', 'ai', 'integrations', 'pricing', 'faq'] as const;

async function inView(page: Page, id: string) {
  // String expressions: the test tsconfig has no DOM lib (same convention as the other specs).
  await expect.poll(() => page.evaluate<boolean>(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return r.top < window.innerHeight * 0.6 && r.bottom > 0; })()`), { timeout: 5000 }).toBe(true);
}

test.describe('marketing page (public)', () => {
  test('§18.1 section navigation stays on the page; §18.2 account links reach the right routes', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Relay/);
    const nav = page.getByRole('navigation', { name: 'Sections' }).first();
    await expect(nav.getByRole('link')).toHaveText(['Product', 'AI', 'Integrations', 'Pricing', 'FAQ']);
    for (const id of SECTIONS) {
      await page.getByTestId(`mkt-nav-${id}`).click();
      await expect(page).toHaveURL(new RegExp(`/#${id}$`));
      await inView(page, id);
      expect(new URL(page.url()).pathname).toBe('/');
    }
    // Every in-page link targets an element that exists; links that leave the page are only account/legal/support routes.
    const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')!));
    for (const h of hrefs.filter((x) => x.startsWith('#') && x !== '#support' /* opens the support widget (WID) */)) expect(await page.locator(h === '#' ? 'body' : h).count(), h).toBeGreaterThan(0);
    const leaving = [...new Set(hrefs.filter((h) => !h.startsWith('#')))];
    for (const h of leaving) expect(h, 'only account / support / help / legal links leave the page').toMatch(/^\/(signup(\?plan=(standard|professional)&seats=\d+)?|login(\?returnTo=.*)?|overview|help|help\/contact)$|^mailto:|^https:/); // HC: footer links the public Help Centre
    // Explore Relay scrolls to the product demonstrations (no fake demo video).
    await page.goto('/');
    await page.getByTestId('mkt-hero-explore').click();
    await expect(page).toHaveURL(/#product$/);
    await inView(page, 'product');
    // Account routes.
    await page.getByTestId('mkt-login').click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('link', { name: 'Start a free trial' })).toHaveAttribute('href', '/signup');
    await page.goto('/');
    await page.getByTestId('mkt-header-trial').click();
    await expect(page).toHaveURL(/\/signup$/);
    await expect(page.getByRole('heading', { name: 'Start your 14-day free trial' })).toBeVisible();
  });

  test('§18.3–4 Relay branding and visual direction; no fabricated endorsements or outcomes', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your social world. Working together.');
    await expect(page.getByRole('link', { name: /Relay — back to top/ })).toBeVisible();
    const text = await page.locator('body').innerText();
    expect(text).not.toMatch(/SocialFlow|Social Lite/i);
    for (const bad of [/trusted by/i, /testimonial/i, /loved by/i, /\b\d(\.\d)?\s*\/\s*5\b/, /\b\d+[KM]\+/, /join thousands/i, /most popular/i, /enterprise/i, /watch demo/i]) expect(text, String(bad)).not.toMatch(bad);
    expect(text.replace(/nothing is unlimited/gi, '')).not.toMatch(/unlimited/i);
    await expect(page.getByRole('heading', { name: 'Connect your tools' })).toBeVisible();
    // Example content is labelled as such.
    await expect(page.getByText('Illustrative preview with example content.')).toBeVisible();
    expect(await page.getByText('Example', { exact: true }).count()).toBeGreaterThanOrEqual(4);
    // Hero visual: real Overview capture via next/image — described, reserved dimensions, loaded, modern format.
    const shot = page.getByTestId('mkt-hero-shot').locator('img');
    await expect(shot).toHaveAttribute('alt', /Overview dashboard/);
    await expect(shot).toHaveAttribute('width', '2560');
    await expect(shot).toHaveAttribute('height', '1600');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- no DOM lib in the test tsconfig
    await expect.poll(() => shot.evaluate((el: any) => el.complete && el.naturalWidth > 0 ? (el.currentSrc as string) : '')).toMatch(/\/_next\/image\?url=%2Fmarketing%2Foverview-(light|dark)\.webp/);
    const imgRes = await page.request.get(await shot.evaluate((el: any) => el.currentSrc as string), { headers: { accept: 'image/avif,image/webp,*/*' } }); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(imgRes.headers()['content-type']).toMatch(/image\/(avif|webp)/);
    // Purple primary action (marketing palette, D24) in light mode.
    await page.emulateMedia({ colorScheme: 'light' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- no DOM lib in the test tsconfig
    const bg = await page.getByTestId('mkt-hero-trial').evaluate((el: any) => (globalThis as any).getComputedStyle(el).backgroundColor as string);
    expect(bg).toBe('rgb(59, 31, 143)');
    // Integrations carry honest statuses; nothing that needs provider review is "Available".
    for (const p of ['instagram', 'facebook', 'x', 'tiktok']) await expect(page.getByTestId(`mkt-network-${p}`).locator('[data-status]')).not.toHaveAttribute('data-status', 'available');
    await expect(page.getByTestId('mkt-network-telegram').locator('[data-status]')).toHaveAttribute('data-status', 'available');
    await expect(page.getByText(/No endorsement or partnership is implied/)).toBeVisible();
  });

  test('§18.5–6 exactly two plans at £10 / £25 per user / month, 14 days free, no card; seats and totals; comparison', async ({ page }) => {
    await page.goto('/#pricing');
    const plans = page.getByTestId('mkt-plans').locator(':scope > li');
    await expect(plans).toHaveCount(2);
    await expect(page.getByTestId('mkt-price-standard')).toHaveText('£10');
    await expect(page.getByTestId('mkt-price-professional')).toHaveText('£25');
    for (const id of ['standard', 'professional']) {
      await expect(page.getByTestId(`mkt-plan-${id}`)).toContainText('per user / month');
      await expect(page.getByTestId(`mkt-plan-${id}`)).toContainText('14 days free');
      await expect(page.getByTestId(`mkt-plan-${id}`)).toContainText('No card required');
    }
    await expect(page.getByTestId('mkt-total-standard')).toContainText('3 users · £30 / month');
    await expect(page.getByTestId('mkt-total-professional')).toContainText('3 users · £75 / month');
    await page.getByTestId('mkt-seats').fill('5');
    await expect(page.getByTestId('mkt-total-standard')).toContainText('5 users · £50 / month');
    await expect(page.getByTestId('mkt-total-professional')).toContainText('5 users · £125 / month');
    await page.getByRole('button', { name: 'One user more' }).click();
    await expect(page.getByTestId('mkt-cta-professional')).toHaveAttribute('href', '/signup?plan=professional&seats=6');
    // Expandable comparison (features + allowances + bounded trial allowances).
    const compare = page.getByTestId('mkt-compare');
    await expect(compare).toHaveAttribute('aria-expanded', 'false');
    await compare.click();
    await expect(compare).toHaveAttribute('aria-expanded', 'true');
    const table = page.getByTestId('mkt-comparison');
    await expect(table.getByRole('rowheader', { name: 'Multi-step AI workflows' })).toBeVisible();
    await expect(table).toContainText('100k + 50k per user');
    await expect(table).toContainText('During the 14-day trial');
    await expect(table).toContainText('No overage charges');
    // Handoff: the selected plan + seat estimate reach /signup, which shows the same total before anything is bought.
    await page.getByTestId('mkt-cta-professional').click();
    await expect(page).toHaveURL(/\/signup\?plan=professional&seats=6$/);
    await expect(page.getByTestId('signup-plan-professional')).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('signup-total')).toContainText('6 users × £25 = £150 / month');
    await expect(page.getByTestId('signup-continue')).toHaveAttribute('href', '/signup/workspace?plan=professional');
  });

  test('FAQ accordion, Explore previews and reduced motion are keyboard and screen-reader friendly', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    // Reduced motion: nothing is hidden waiting for an animation.
    await page.evaluate("window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' })");
    const hidden = await page.evaluate<number>("[...document.querySelectorAll('[data-reveal]')].filter((e) => getComputedStyle(e).opacity !== '1').length");
    expect(hidden).toBe(0);
    // FAQ: real buttons with aria-expanded; Enter toggles; answers match the implementation.
    const trial = page.getByTestId('mkt-faq-trial').getByRole('button', { name: 'How does the free trial work?' });
    await trial.focus();
    await expect(trial).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Enter');
    await expect(trial).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('mkt-faq-trial')).toContainText('no card needed');
    await expect(page.getByTestId('mkt-faq-trial')).toContainText('first charge is on the day the trial ends');
    await page.getByTestId('mkt-faq-per-user').getByRole('button').click();
    await expect(page.getByTestId('mkt-faq-per-user')).toContainText('Three Standard users cost £30 a month; three Professional users cost £75');
    // Explore: an accessible inline preview; focus moves in, Escape closes, focus returns.
    const explore = page.getByTestId('mkt-explore-ai-assistant');
    await explore.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'AI assistant' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Publishing and replies always need approval');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(explore).toBeFocused();
    // Skip link is the first tab stop.
    await page.goto('/');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  });

  test('marketing on mobile: menu sheet, section scroll, seat entry with the keyboard, no horizontal scroll @mobile', async ({ page, browser }, info) => {
    test.skip(info.project.name !== 'mobile', 'mobile project only');
    await page.goto('/');
    await page.getByTestId('mkt-menu-open').click();
    const menu = page.getByTestId('mkt-menu');
    await expect(menu).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Menu' })).toBeVisible();
    await page.screenshot({ path: `${EVIDENCE}/e2e-menu-mobile.png` });
    await menu.getByRole('link', { name: 'Pricing' }).click();
    await expect(menu).toBeHidden();
    await inView(page, 'pricing');
    await expect(page).toHaveURL(/#pricing$/);
    await expect(page.locator('#pricing-title')).toBeFocused();
    // On-screen keyboard: the seat field takes typed input and the totals follow.
    const seats = page.getByTestId('mkt-seats');
    await seats.tap();
    await seats.fill('4');
    await expect(page.getByTestId('mkt-total-standard')).toContainText('4 users · £40 / month');
    await expect(page.getByTestId('mkt-cta-standard')).toBeVisible();
    await page.screenshot({ path: `${EVIDENCE}/e2e-pricing-mobile.png` });
    // Plain (non-emulated-mobile) contexts, so the browser cannot zoom out to hide an overflow; comparison table opened.
    for (const width of [320, 360, 390, 430, 768, 1024, 1440]) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, baseURL: info.project.use.baseURL });
      const p = await ctx.newPage();
      await p.goto('/');
      await p.getByTestId('mkt-compare').click();
      await expect(p.getByTestId('mkt-comparison')).toBeVisible();
      expect(await overflow(p), `no page-level horizontal scroll at ${width}px`).toBeLessThanOrEqual(1);
      await ctx.close();
    }
  });
});

test.describe('signed in and signup handoff', () => {
  test('§18.2 a signed-in visitor sees "Open dashboard" on / (no redirect) and reaches /overview', async ({ page }) => {
    await signIn(page, OWNER);
    await page.goto('/');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('mkt-hero-dashboard')).toBeVisible();
    await expect(page.getByTestId('mkt-login')).toHaveCount(0);
    await page.getByTestId('mkt-hero-dashboard').click();
    await expect(page).toHaveURL(/\/overview$/);
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
    // The app shell's home links point at /overview, not the marketing page.
    await expect(page.getByRole('link', { name: 'Relay home' }).first()).toHaveAttribute('href', '/overview');
  });

  test('§18.6–7 new visitor: pricing → register (local realm) → verify email → workspace → 14-day Professional trial → Billing shows seats and total', async ({ page }) => {
    test.setTimeout(180_000);
    const email = `mkt-${randomUUID().slice(0, 8)}@test.social-lite.test`;
    await page.goto('/#pricing');
    await page.getByTestId('mkt-cta-professional').click();
    await expect(page).toHaveURL(/\/signup\?plan=professional/);
    await page.getByTestId('signup-continue').click();
    await page.waitForURL(/\/login\?returnTo=/);
    await page.locator('a[href^="/api/auth/login"]').first().click();
    await page.waitForURL((u) => u.origin === new URL(KEYCLOAK).origin);
    await page.getByRole('link', { name: /register/i }).click();
    await page.locator('input[name=email]').fill(email);
    for (const [name, v] of [['firstName', 'Mia'], ['lastName', 'Tester']] as const) {
      const f = page.locator(`input[name=${name}]`);
      if (await f.count()) await f.fill(v);
    }
    const pwd = `Relay-${randomUUID()}`;
    await page.locator('input[name=password]').fill(pwd);
    await page.locator('input[name=password-confirm]').fill(pwd);
    await page.locator('[type=submit]').first().click();
    // Keycloak requires a verified email (self-registration never bypasses D20's verified-email binding).
    await expect(page.locator('body')).toContainText(/verify your email/i, { timeout: 20_000 });
    let link: string | null = null;
    for (let i = 0; i < 30 && !link; i++) {
      const r = await page.request.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
      const list = await r.json() as { messages?: Array<{ ID: string }> };
      if (list.messages?.length) {
        const m = await (await page.request.get(`${MAILPIT}/api/v1/message/${list.messages[0]!.ID}`)).json() as { Text: string };
        link = m.Text.match(/https?:\/\/\S+action-token\S+/)?.[0] ?? null;
      }
      if (!link) await page.waitForTimeout(1000);
    }
    expect(link, 'verification email arrives in the local mail capture').toBeTruthy();
    await page.goto(link!.replace(/[)>\]]+$/, ''));
    await page.waitForURL(/\/signup\/workspace\?plan=professional/, { timeout: 45_000 });
    await expect(page.getByTestId('signup-ws-plan-professional')).toHaveAttribute('aria-checked', 'true');
    await page.getByLabel('Workspace name').fill(`Marketing E2E ${randomUUID().slice(0, 4)}`);
    await page.getByRole('button', { name: 'Start free trial' }).click();
    await page.waitForURL(/\/settings\/workspace\/billing\?welcome=1/, { timeout: 45_000 });
    const plan = page.getByTestId('billing-plan');
    await expect(plan).toContainText('Professional');
    await expect(plan).toContainText('£25 per user / month');
    await expect(plan).toContainText(/Free trial/);
    // Trial facts from the server: one 14-day trial on Professional.
    const ov = await (await page.request.get('/api/billing')).json() as { trial: { started_at: string; ends_at: string; plan_id: string }; seats: { billable: number }; recurring_total_minor: number | null };
    expect(ov.trial.plan_id).toBe('professional');
    expect(new Date(ov.trial.ends_at).getTime() - new Date(ov.trial.started_at).getTime()).toBe(14 * 86_400_000);
    expect(ov.seats.billable).toBe(1);
    await expect(page.getByTestId('plan-professional-total').or(page.getByTestId('billing-plan'))).toContainText('£25');
    // Choosing a paid plan needs billing.manage (sensitive → two-step verification by workspace policy): either the plan
    // choices or an explicit hint to set it up is shown — never a dead end.
    await expect(page.getByTestId('billing-mfa-hint').or(page.getByTestId('billing-choose')).first()).toBeVisible();
    await page.screenshot({ path: `${EVIDENCE}/e2e-signup-billing-${test.info().project.name}.png` });
  });
});
