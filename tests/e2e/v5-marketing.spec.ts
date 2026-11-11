// V5 MKT — the public marketing page and the marketing → sign up → workspace → trial handoff (brief §18 items 1–7, 17, 18
// MKT part). Real browser against the running app; real local Keycloak (self-registration enabled in the LOCAL realm only,
// email verified through the local mail capture); deterministic billing test double. Screenshots → evidence/v5/mkt/.
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { KEYCLOAK, signIn } from './helpers';
import { waitForSignInEmail } from '../support/mailpit';

const EVIDENCE = 'evidence/v5/mkt';
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
    for (const h of leaving) expect(h, 'only account / support / help / legal links leave the page').toMatch(/^\/(signup(\?plan=(standard|professional)&seats=\d+|\?plan=free)?|login(\?returnTo=.*)?|overview|help|help\/contact)$|^mailto:|^https:/); // HC: footer links the public Help Centre
    // Explore Relay scrolls to the product demonstrations (no fake demo video).
    await page.goto('/');
    await page.getByTestId('mkt-hero-explore').click();
    await expect(page).toHaveURL(/#product$/);
    await inView(page, 'product');
    // Account routes.
    await page.getByTestId('mkt-login').click();
    // D34: "Log in" opens the passwordless sign-in page (Google when configured · or · email); no password field.
    await page.waitForURL((u) => u.origin === new URL(KEYCLOAK).origin);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in to Relay');
    await expect(page.locator('input[name=username]')).toBeVisible();
    await expect(page.locator('input[name=password]')).toHaveCount(0);
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
    await expect(page.getByRole('heading', { name: 'Works with the tools you already use.' })).toBeVisible();
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
    // Purple primary action (marketing palette, D24). Light only: same colours even when the OS asks for dark.
    await page.emulateMedia({ colorScheme: 'dark' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- no DOM lib in the test tsconfig
    expect(await page.evaluate(() => (globalThis as any).getComputedStyle((globalThis as any).document.body).backgroundColor)).toBe('rgb(255, 255, 255)');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(shot).toHaveAttribute('src', /overview-light/);
    expect(await page.locator('source[media*="prefers-color-scheme"]').count()).toBe(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- no DOM lib in the test tsconfig
    const bg = await page.getByTestId('mkt-hero-trial').evaluate((el: any) => (globalThis as any).getComputedStyle(el).backgroundColor as string);
    expect(bg).toBe('rgb(59, 31, 143)');
    // Integrations (2026-11-11 design): moving rows of icon-only tiles are decorative (aria-hidden); ONE screen-reader list names
    // every implemented network and tool once (name — one line, nothing else) with its honest status in data-status. The
    // intro keeps the disclosure that some go live after provider approval; no legend, badges, notes or disclaimer line.
    for (const p of ['instagram', 'facebook', 'x', 'tiktok']) await expect(page.getByTestId(`mkt-network-${p}`)).not.toHaveAttribute('data-status', 'available');
    await expect(page.getByTestId('mkt-network-telegram')).toHaveAttribute('data-status', 'available');
    await expect(page.getByTestId('mkt-integrations-lead')).toHaveText(/^\d+ social networks and \d+ work apps, built into Relay\. Some go live as each network approves Relay’s access\.$/);
    await expect(page.getByTestId('mkt-integrations-lead')).toBeVisible();
    await expect(page.getByTestId('mkt-integrations-cta')).toHaveAttribute('href', '/signup?plan=free');
    await expect(page.locator('#integrations [aria-label="Status labels"]')).toHaveCount(0);
    await expect(page.locator('#integrations')).not.toContainText(/Needs provider access|Meta app review|No endorsement or partnership|one click|\d+\+/);
    await expect(page.getByTestId('mkt-network-telegram')).toHaveText('Telegram — Channel posts · bot chats'); // name + one line, nothing after it
    const netItems = page.getByTestId('mkt-networks').locator(':scope > li');
    const toolItems = page.getByTestId('mkt-tools').locator(':scope > li');
    await expect(netItems).toHaveCount(10);
    await expect(toolItems).toHaveCount(11);
    const marquee = page.getByTestId('mkt-marquee');
    await expect(marquee).toHaveAttribute('aria-hidden', 'true');
    // Every listed entry has exactly one primary tile in the marquee (the loop copies carry no data-tile), and the marquee
    // adds no list items or names to the accessibility tree.
    const testIds = async (l: typeof netItems) => Promise.all((await l.all()).map(async (x) => (await x.getAttribute('data-testid'))!));
    const ids = [...(await testIds(netItems)).map((t) => t.replace('mkt-network-', '')), ...(await testIds(toolItems)).map((t) => t.replace('mkt-tool-', ''))];
    for (const id of ids) await expect(marquee.locator(`[data-tile="${id}"]`), id).toHaveCount(1);
    expect(await marquee.locator('[data-tile]').count()).toBe(ids.length);
    await expect(marquee.locator('li, a, button, [tabindex]')).toHaveCount(0);
    // Motion: rows drift (transform only) and the Pause button stops them.
    const firstTrack = marquee.locator('.mkt-marquee-track').first();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- no DOM lib in the test tsconfig
    await expect.poll(() => firstTrack.evaluate((el: any) => (globalThis as any).getComputedStyle(el).animationName as string)).toBe('mkt-marquee-left');
    const toggle = page.getByTestId('mkt-marquee-toggle');
    await expect(toggle).toHaveAccessibleName('Pause the moving logos');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(marquee).toHaveAttribute('data-paused', '');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- no DOM lib in the test tsconfig
    await expect.poll(() => firstTrack.evaluate((el: any) => (globalThis as any).getComputedStyle(el).animationPlayState as string)).toBe('paused');
    await toggle.click();
    await expect(marquee).not.toHaveAttribute('data-paused', '');
  });

  test('§18.5–6 + D33 three plans: Free £0, Standard £5 / Professional £15 per user / month (14 days free, no card); seats and totals; comparison', async ({ page }) => {
    await page.goto('/#pricing');
    await expect(page.getByRole('heading', { level: 2, name: 'Start free. Pay per user as you grow.' })).toBeVisible();
    const plans = page.getByTestId('mkt-plans').locator(':scope > li');
    await expect(plans).toHaveCount(3);
    // Cards: five catalogue-derived checklist lines each; later plans start with "Everything in <previous plan>"; the
    // highlighted plan's badge is factual (no popularity claim); no monthly/yearly switch (monthly billing only).
    for (const id of ['free', 'standard', 'professional']) await expect(page.getByTestId(`mkt-plan-${id}`).locator('ul > li')).toHaveCount(5);
    await expect(page.getByTestId('mkt-plan-standard').locator('ul > li').first()).toHaveText('Everything in Free');
    await expect(page.getByTestId('mkt-plan-professional').locator('ul > li').first()).toHaveText('Everything in Standard');
    await expect(page.getByTestId('mkt-plan-professional')).toContainText('All features');
    await expect(page.locator('#pricing')).not.toContainText(/yearly|annual|popular/i);
    await expect(page.getByTestId('mkt-price-free')).toHaveText('£0');
    await expect(page.getByTestId('mkt-price-standard')).toHaveText('£5');
    await expect(page.getByTestId('mkt-price-professional')).toHaveText('£15');
    for (const id of ['standard', 'professional']) {
      await expect(page.getByTestId(`mkt-plan-${id}`)).toContainText('per user / month');
      await expect(page.getByTestId(`mkt-plan-${id}`)).toContainText('14 days free');
      await expect(page.getByTestId(`mkt-plan-${id}`)).toContainText('No card required');
      await expect(page.getByTestId(`mkt-cta-${id}`)).toContainText('Start free trial');
    }
    // Free: one user, no trial wording, no seat estimate, "Start free".
    const free = page.getByTestId('mkt-plan-free');
    await expect(free).toContainText('for 1 user');
    await expect(free).not.toContainText(/trial|days free/i);
    await expect(page.getByTestId('mkt-total-free')).toContainText('1 user · £0 / month');
    await expect(page.getByTestId('mkt-cta-free')).toHaveText(/^Start free/);
    await expect(page.getByTestId('mkt-cta-free')).toHaveAttribute('href', '/signup?plan=free');
    await expect(page.getByTestId('mkt-hero-prices')).toHaveCount(0); // user request: no price line under the hero CTAs
    await expect(page.getByTestId('mkt-total-standard')).toContainText('3 users · £15 / month');
    await expect(page.getByTestId('mkt-total-professional')).toContainText('3 users · £45 / month');
    await page.getByTestId('mkt-seats').fill('5');
    await expect(page.getByTestId('mkt-total-standard')).toContainText('5 users · £25 / month');
    await expect(page.getByTestId('mkt-total-professional')).toContainText('5 users · £75 / month');
    await expect(page.getByTestId('mkt-total-free')).toContainText('1 user · £0 / month'); // the stepper is for paid plans only
    await expect(page.getByTestId('mkt-cta-free')).toHaveAttribute('href', '/signup?plan=free');
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
    // Free's limits, stated honestly (D33).
    for (const [row, v] of [['Users', '1'], ['Brands', '1'], ['Connected social accounts', '2'], ['Scheduled posts a month', '10'], ['Media storage', '500 MB'], ['AI usage a month (tokens)', '20k']] as const) {
      await expect(table.getByRole('row', { name: new RegExp(`^${row.replace(/[()]/g, '\\$&')}`) }).first().getByRole('cell').first()).toHaveText(v);
    }
    await expect(table).toContainText('Data export always works');
    await expect(table).toContainText('During the 14-day trial');
    await expect(table).toContainText('No overage charges');
    // Handoff: the selected plan + seat estimate reach /signup, which shows the same total before anything is bought.
    await page.getByTestId('mkt-cta-professional').click();
    await expect(page).toHaveURL(/\/signup\?plan=professional&seats=6$/);
    await expect(page.getByTestId('signup-plan-professional')).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('signup-total')).toContainText('6 users × £15 = £90 / month');
    await expect(page.getByTestId('signup-continue')).toHaveAttribute('href', '/signup/workspace?plan=professional');
  });

  test('FAQ accordion, Explore previews and reduced motion are keyboard and screen-reader friendly', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    // Reduced motion: nothing is hidden waiting for an animation.
    await page.evaluate("window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' })");
    const hidden = await page.evaluate<number>("[...document.querySelectorAll('[data-reveal]')].filter((e) => getComputedStyle(e).opacity !== '1').length");
    expect(hidden).toBe(0);
    // Reduced motion: the integrations rows do not move and the Pause button is not offered.
    expect(await page.evaluate<string[]>("[...document.querySelectorAll('.mkt-marquee-track')].map((e) => getComputedStyle(e).animationName)")).toEqual(['none', 'none', 'none']);
    await expect(page.getByTestId('mkt-marquee-toggle')).toBeHidden();
    // FAQ: real buttons with aria-expanded; Enter toggles; answers match the implementation.
    const trial = page.getByTestId('mkt-faq-trial').getByRole('button', { name: 'How does the free trial work?' });
    await trial.focus();
    await expect(trial).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Enter');
    await expect(trial).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('mkt-faq-trial')).toContainText('no card needed');
    await expect(page.getByTestId('mkt-faq-trial')).toContainText('first charge is on the day the trial ends');
    await expect(page.getByTestId('mkt-faq-trial')).toContainText('the workspace moves to Free');
    await expect(page.getByTestId('mkt-faq-trial')).toContainText('Nothing is deleted and data export always works');
    await page.getByTestId('mkt-faq-per-user').getByRole('button').click();
    await expect(page.getByTestId('mkt-faq-per-user')).toContainText('Three Standard users cost £15 a month; three Professional users cost £45');
    await page.getByTestId('mkt-faq-free').getByRole('button', { name: 'What’s included in Free?' }).click();
    await expect(page.getByTestId('mkt-faq-free')).toContainText('Free is £0 for one person: 1 brand, 2 social accounts, 10 scheduled posts a month, 500 MB of media');
    await page.getByTestId('mkt-faq-cancel').getByRole('button').click();
    await expect(page.getByTestId('mkt-faq-cancel')).toContainText('the workspace moves to Free');
    // Explore: an accessible inline preview; focus moves in, Escape closes, focus returns.
    const explore = page.getByTestId('mkt-explore-ai-assistant');
    await explore.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'AI assistant' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Publishing and replies always need approval');
    // A real screenshot of the matching app screen (synthetic showcase), lazy, with reserved size and a caption.
    const img = dialog.getByTestId('mkt-explore-shot-ai-assistant').locator('img');
    await expect(img).toHaveAttribute('alt', /AI workspace/);
    await expect(img).toHaveAttribute('loading', 'lazy');
    await expect(img).toHaveAttribute('width', '2560');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- no DOM lib in the test tsconfig
    await expect.poll(() => img.evaluate((el: any) => el.complete && el.naturalWidth > 0)).toBe(true);
    await expect(dialog).toContainText('Example workspace');
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
    await expect(page.getByTestId('mkt-total-standard')).toContainText('4 users · £20 / month');
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
  test('D33 /signup?plan=free shows Free with no trial copy and no seats; the picker shows all three plans', async ({ page }) => {
    await page.goto('/#pricing');
    await page.getByTestId('mkt-cta-free').click();
    await expect(page).toHaveURL(/\/signup\?plan=free$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Start on Free');
    for (const id of ['free', 'standard', 'professional']) await expect(page.getByTestId(`signup-plan-${id}`)).toBeVisible();
    await expect(page.getByTestId('signup-plan-free')).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('signup-plan-free')).toContainText('£0 for 1 user');
    await expect(page.getByTestId('signup-seats')).toHaveCount(0);
    await expect(page.getByTestId('signup-total')).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText(/14-day|Start free trial/); // paid cards still say "after the trial" for their own price
    await expect(page.getByTestId('signup-continue')).toHaveText(/Continue with Free/);
    await expect(page.getByTestId('signup-continue')).toHaveAttribute('href', '/signup/workspace?plan=free');
    // Paid plans unchanged: trial heading, seats × price.
    await page.getByTestId('signup-plan-standard').click();
    await expect(page).toHaveURL(/\/signup\?plan=standard$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Start your 14-day free trial');
    await expect(page.getByTestId('signup-total')).toContainText('1 user × £5 = £5 / month');
  });

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

  test('§18.6–7 new visitor (D34): pricing → sign-up page (email) → code from the email → workspace → 14-day Professional trial → Billing shows seats and total', async ({ page }) => {
    test.setTimeout(180_000);
    const email = `mkt-${randomUUID().slice(0, 8)}@test.social-lite.test`;
    await page.goto('/#pricing');
    await page.getByTestId('mkt-cta-professional').click();
    await expect(page).toHaveURL(/\/signup\?plan=professional/);
    await page.getByTestId('signup-continue').click();
    // /login forwards straight to the passwordless sign-in page, in sign-up mode, with the plan carried in the return path.
    await page.waitForURL((u) => u.origin === new URL(KEYCLOAK).origin);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Create your Relay account');
    await expect(page.locator('input[name=password]')).toHaveCount(0);
    const since = Date.now();
    await page.locator('input[name=username]').fill(email);
    await page.locator('#kc-login').click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Check your email');
    // One email with a sign-in link AND a 6-digit code; new accounts are created only because the local realm allows
    // self-registration, and the code/link proves the address (D20/D26 verified-email binding).
    const mail = await waitForSignInEmail(email, since);
    expect(mail.html).toContain(mail.code);
    await page.locator('input[name=code]').fill(mail.code);
    await page.locator('#relay-verify').click();
    await page.waitForURL(/\/signup\/workspace\?plan=professional/, { timeout: 45_000 });
    await expect(page.getByTestId('signup-ws-plan-professional')).toHaveAttribute('aria-checked', 'true');
    await page.getByLabel('Workspace name').fill(`Marketing E2E ${randomUUID().slice(0, 4)}`);
    await page.getByRole('button', { name: 'Start free trial' }).click();
    await page.waitForURL(/\/settings\/workspace\/billing\?welcome=1/, { timeout: 45_000 });
    const plan = page.getByTestId('billing-plan');
    await expect(plan).toContainText('Professional');
    await expect(plan).toContainText('£15 per user / month');
    await expect(plan).toContainText(/Free trial/);
    // Trial facts from the server: one 14-day trial on Professional.
    const ov = await (await page.request.get('/api/billing')).json() as { trial: { started_at: string; ends_at: string; plan_id: string }; seats: { billable: number }; recurring_total_minor: number | null };
    expect(ov.trial.plan_id).toBe('professional');
    expect(new Date(ov.trial.ends_at).getTime() - new Date(ov.trial.started_at).getTime()).toBe(14 * 86_400_000);
    expect(ov.seats.billable).toBe(1);
    await expect(page.getByTestId('plan-professional-total').or(page.getByTestId('billing-plan'))).toContainText('£15');
    // Choosing a paid plan needs billing.manage (sensitive → two-step verification by workspace policy): either the plan
    // choices or an explicit hint to set it up is shown — never a dead end.
    await expect(page.getByTestId('billing-mfa-hint').or(page.getByTestId('billing-choose')).first()).toBeVisible();
    await page.screenshot({ path: `${EVIDENCE}/e2e-signup-billing-${test.info().project.name}.png` });
  });
});
