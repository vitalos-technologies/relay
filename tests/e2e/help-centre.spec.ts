import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers';

// HC — in-app Help Centre: public access without sign-in, server-side audience filtering, search (keyboard + mobile),
// navigation, breadcrumbs, a contextual help link, the offline bundle, V4 Contact support / My requests kept, and no
// page-level horizontal scroll on phones. Articles used here are HC's own (getting-started) plus the HelpLink targets.

const ADMIN_ARTICLE = '/help/getting-started/first-steps-for-workspace-admins';
const MEMBER_ARTICLE = '/help/getting-started/find-your-way-around';
const PUBLIC_ARTICLE = '/help/getting-started/what-is-relay';
const overflow = (p: Page) => p.evaluate<number>('document.documentElement.scrollWidth - document.documentElement.clientWidth');

test.describe('signed out (public articles only)', () => {
  test('home, public article, sign-in prompt for member and admin articles, search and bundle are filtered', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto('/help');
    await expect(page.getByRole('heading', { level: 1, name: 'How can we help?' })).toBeVisible();
    await expect(page.getByText('Sign in to see every article for your role.')).toBeVisible();
    await expect(page.getByRole('link', { name: /Getting started/ }).first()).toBeVisible();

    await page.goto('/help/getting-started');
    const list = page.getByRole('main');
    await expect(list.getByRole('link', { name: /What Relay does/ }).first()).toBeVisible();
    await expect(list.getByRole('link', { name: /Find your way around/ })).toHaveCount(0);
    await expect(list.getByRole('link', { name: /Set up a workspace for your team/ })).toHaveCount(0);

    await page.goto(PUBLIC_ARTICLE);
    await expect(page.getByRole('heading', { level: 1, name: 'What Relay does' })).toBeVisible();
    await expect(page.getByText(/Reviewed \d+ \w+ \d{4}/)).toBeVisible();

    for (const href of [MEMBER_ARTICLE, ADMIN_ARTICLE]) {
      await page.goto(href);
      await expect(page.getByRole('heading', { name: 'Sign in to read this article' })).toBeVisible();
      await expect(page.locator('.help-prose')).toHaveCount(0);
    }

    const search = await (await ctx.request.get('/api/help/search?q=workspace')).json() as { results: Array<{ slug: string }> };
    expect(search.results.length).toBeGreaterThan(0);
    expect(search.results.map((r) => r.slug)).not.toContain('first-steps-for-workspace-admins');
    expect(search.results.map((r) => r.slug)).not.toContain('find-your-way-around');
    expect((await ctx.request.get('/api/help/bundle')).status()).toBe(401);
    expect((await ctx.request.get('/help/getting-started/no-such-article')).status()).toBe(404);
    await ctx.close();
  });
});

test.describe('signed in', () => {
  test('member: search with the keyboard, breadcrumbs, sidebar, related; never admin articles', async ({ page }) => {
    await signIn(page, 'editor@demo.social-lite.test');
    await page.goto('/help');
    await expect(page.getByRole('heading', { level: 1, name: 'How can we help?' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Contact support/ }).last()).toBeVisible();

    // "/" focuses search; suggestions are a listbox; ↓ + Enter opens the first one.
    await page.keyboard.press('/');
    const box = page.getByRole('combobox', { name: 'Search help' });
    await expect(box).toBeFocused();
    await box.pressSequentially('time zone', { delay: 30 });
    const listbox = page.getByRole('listbox', { name: 'Suggested articles' });
    await expect(listbox.getByRole('option').first()).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect(listbox.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/help\/[a-z-]+\/[a-z0-9-]+$/);
    await expect(page.locator('.help-prose')).toBeVisible();

    // Full results page (Enter without a suggestion; also works without JavaScript).
    await page.goto('/help?q=roles+permissions');
    await expect(page.getByRole('heading', { level: 1, name: 'Search results' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Understand roles and permissions/ })).toBeVisible();

    // Breadcrumbs + sidebar.
    await page.goto(MEMBER_ARTICLE);
    const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(crumbs.locator('[aria-current="page"]')).toHaveText('Find your way around');
    const sidebar = page.getByRole('complementary', { name: 'Help sections' });
    await expect(sidebar.locator('a[aria-current="page"]')).toHaveText('Find your way around');
    await expect(page.getByRole('heading', { name: 'Related articles' })).toBeVisible();
    await crumbs.getByRole('link', { name: 'Getting started' }).click();
    await page.waitForURL(/\/help\/getting-started$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Getting started' })).toBeVisible();
    await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Help' }).click();
    await page.waitForURL(/\/help$/);

    // Audience filtering on the server: a member gets the not-found page (no content), and search/bundle leave it out.
    // (Inside the signed-in app shell the response is streamed, so the HTTP status stays 200; signed out it is 404.)
    await page.goto(ADMIN_ARTICLE);
    await expect(page.getByRole('heading', { name: 'Article not available' })).toBeVisible();
    await expect(page.locator('.help-prose')).toHaveCount(0);
    const s = await (await page.request.get('/api/help/search?q=set+up+a+workspace+for+your+team')).json() as { results: Array<{ slug: string }> };
    expect(s.results.map((r) => r.slug)).not.toContain('first-steps-for-workspace-admins');
    const zip = await page.request.get('/api/help/bundle');
    expect(zip.status()).toBe(200);
    expect(zip.headers()['content-type']).toBe('application/zip');
    const bytes = await zip.body();
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    expect(bytes.includes(Buffer.from('getting-started/find-your-way-around.html'))).toBe(true);
    expect(bytes.includes(Buffer.from('first-steps-for-workspace-admins'))).toBe(false);
  });

  test('contextual help link opens the article; V4 Contact support and My requests still work', async ({ page }) => {
    await signIn(page, 'editor@demo.social-lite.test');
    await page.goto('/planner');
    const link = page.locator('a[data-help-slug="time-zones-and-dst"]').first();
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAccessibleName(/time zones.*opens in a new tab/i);
    const [tab] = await Promise.all([page.context().waitForEvent('page'), link.click()]);
    await tab.waitForURL(/\/help\/calendar-and-scheduling\/time-zones-and-dst/);
    await expect(tab.locator('.help-prose')).toBeVisible();
    await tab.close();

    await page.goto('/help/contact');
    await expect(page.getByRole('link', { name: 'Help Centre' }).first()).toBeVisible();
    await expect(page.locator('form, [role=form]').first()).toBeVisible();
    await page.goto('/help/requests');
    await expect(page).toHaveURL(/\/help\/requests/);
  });

  test('admin reads admin articles; /admin/help lists them', async ({ page }) => {
    await signIn(page, 'owner@demo.social-lite.test');
    await page.goto(ADMIN_ARTICLE);
    await expect(page.getByRole('heading', { level: 1, name: 'Set up a workspace for your team' })).toBeVisible();
    await expect(page.getByText('Workspace admins', { exact: true })).toBeVisible();
    await page.goto('/admin/help');
    await expect(page.getByRole('heading', { name: 'Admin articles' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Set up a workspace for your team/ })).toBeVisible();
  });
});

test.describe('phones', () => {
  test('browse + search on a phone; no horizontal scroll at 320–430 @mobile', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(PUBLIC_ARTICLE);
    const browse = page.locator('details summary', { hasText: 'Getting started' });
    await expect(browse).toBeVisible();
    await browse.tap();
    await expect(page.getByRole('navigation', { name: 'Help sections' }).getByRole('link', { name: 'Help home' })).toBeVisible();

    await page.goto('/help');
    const box = page.getByRole('combobox', { name: 'Search help' });
    await box.tap();
    await box.fill('glossary');
    const option = page.getByRole('option', { name: /Glossary/ }).first();
    await expect(option).toBeVisible();
    await option.tap();
    await page.waitForURL(/\/help\/getting-started\/glossary$/);
    await expect(page.locator('.help-table').first()).toBeVisible();

    for (const width of [320, 360, 390, 430]) {
      await page.setViewportSize({ width, height: 800 });
      for (const path of ['/help', '/help/getting-started', '/help/getting-started/glossary', PUBLIC_ARTICLE, '/help?q=publish']) {
        await page.goto(path);
        expect(await overflow(page), `${path} @${width}`).toBeLessThanOrEqual(0);
      }
    }
    await ctx.close();
  });
});
