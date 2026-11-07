// Critical journeys against the running app + worker (simulated destinations only).
import { expect, test } from '@playwright/test';
import { api, demoBrand, signIn } from './helpers';

/** Destinations created by the seed (scripts/seed-agency.ts), as opposed to ones other specs create at run time. */
const SEEDED = /^Vitalos (Instagram|Facebook|Telegram|X)\b.*\(simulated\)$/;

test.describe('owner publishing journey', () => {
  test('sign in, compose, publish to four simulated destinations, see honest results', async ({ page }) => {
    await signIn(page, 'owner@demo.social-lite.test');
    const a = await api(page);
    const brand = await demoBrand(a, /Vitalos/);
    const conns = (await a.get(`/api/brands/${brand.id}/connections`)).body.items
      // Seeded destinations only ("Vitalos <Network> (simulated)"): the E2E workspace persists between runs and other
      // specs add their own simulated accounts (e.g. "Health FB …" with a missing-permission scenario).
      .filter((c: any) => c.is_mock && c.status === 'ready' && SEEDED.test(c.display_name) && !/rejects/.test(c.display_name));
    const byProvider = Object.fromEntries(conns.map((c: any) => [c.provider, c.id]));
    expect(Object.keys(byProvider).sort()).toEqual(['facebook', 'instagram', 'telegram', 'x']);
    const assets = (await a.get(`/api/brands/${brand.id}/assets?status=ready`)).body.items;
    expect(assets.length).toBeGreaterThan(0);

    const created = await a.send('POST', `/api/brands/${brand.id}/posts`, { title: 'E2E publish', draft: {
      baseText: `E2E ${Date.now()} — four channels`, baseLink: null, baseAssetIds: [assets[0].id],
      variants: Object.values(byProvider).map((connectionId) => ({ connectionId, inheritText: true, inheritMedia: true })) } });
    expect(created.status).toBe(201);
    const post = created.body;

    // Same idempotency key twice => one schedule
    const key = `e2e-${Date.now()}`;
    const body = { expected_version: post.version, connection_ids: Object.values(byProvider) };
    const first = await a.send('POST', `/api/posts/${post.id}/publish`, body, { idem: key });
    const again = await a.send('POST', `/api/posts/${post.id}/publish`, body, { idem: key });
    expect(first.status).toBe(202);
    expect(again.body.schedule.id).toBe(first.body.schedule.id);

    // The worker publishes while we only watch the UI.
    await page.goto(`/posts/${post.id}`);
    await expect.poll(async () => (await a.get(`/api/posts/${post.id}/deliveries`)).body.items.map((d: any) => d.state).sort(), { timeout: 45_000 })
      .toEqual(['published', 'published', 'published', 'published']);
    await page.reload();
    await expect(page.getByText(/Simulated/).first()).toBeVisible();
    await expect(page.getByText(/^Published$/)).toHaveCount(0); // simulated results are never labelled Published
    await page.screenshot({ path: 'evidence/e2e/post-published-simulated.png', fullPage: true });
  });

  test('partial failure: retry only the failed destination', async ({ page }) => {
    await signIn(page, 'owner@demo.social-lite.test');
    const a = await api(page);
    const brand = await demoBrand(a, /Vitalos/);
    const conns = (await a.get(`/api/brands/${brand.id}/connections`)).body.items;
    const fb = conns.find((c: any) => c.provider === 'facebook' && c.is_mock && SEEDED.test(c.display_name));
    const tg = conns.find((c: any) => c.provider === 'telegram' && c.is_mock && SEEDED.test(c.display_name));
    await a.send('PATCH', `/api/connections/${tg.id}/mock-scenario`, { scenario: 'fail_permanent' });
    try {
      const p = (await a.send('POST', `/api/brands/${brand.id}/posts`, { title: 'E2E partial', draft: { baseText: `Partial ${Date.now()}`, baseLink: null, baseAssetIds: [],
        variants: [fb.id, tg.id].map((connectionId: string) => ({ connectionId, inheritText: true, inheritMedia: true })) } })).body;
      expect((await a.send('POST', `/api/posts/${p.id}/publish`, { expected_version: p.version, connection_ids: [fb.id, tg.id] })).status).toBe(202);
      await expect.poll(async () => Object.fromEntries((await a.get(`/api/posts/${p.id}/deliveries`)).body.items.map((d: any) => [d.provider, d.state])), { timeout: 45_000 })
        .toEqual({ facebook: 'published', telegram: 'failed' });
      expect((await a.get(`/api/posts/${p.id}`)).body.status).toBe('partial');
      await a.send('PATCH', `/api/connections/${tg.id}/mock-scenario`, { scenario: 'success' });
      const ds = (await a.get(`/api/posts/${p.id}/deliveries`)).body.items;
      const fbBefore = ds.find((d: any) => d.provider === 'facebook');
      const failed = ds.find((d: any) => d.provider === 'telegram');
      expect((await a.send('POST', `/api/deliveries/${failed.id}/retry`, {})).status).toBe(200);
      expect((await a.send('POST', `/api/deliveries/${fbBefore.id}/retry`, {})).status).toBe(409); // published is never resent
      await expect.poll(async () => (await a.get(`/api/posts/${p.id}/deliveries`)).body.items.map((d: any) => d.state).sort(), { timeout: 45_000 }).toEqual(['published', 'published']);
      const fbAfter = (await a.get(`/api/posts/${p.id}/deliveries`)).body.items.find((d: any) => d.provider === 'facebook');
      expect(fbAfter.provider_ids).toEqual(fbBefore.provider_ids);
      await page.goto(`/posts/${p.id}`);
      await page.screenshot({ path: 'evidence/e2e/partial-then-retried.png', fullPage: true });
    } finally {
      await a.send('PATCH', `/api/connections/${tg.id}/mock-scenario`, { scenario: 'success' });
    }
  });

  test('Instagram text-only is rejected before scheduling', async ({ page }) => {
    await signIn(page, 'owner@demo.social-lite.test');
    const a = await api(page);
    const brand = await demoBrand(a, /Vitalos/);
    const ig = (await a.get(`/api/brands/${brand.id}/connections`)).body.items.find((c: any) => c.provider === 'instagram' && c.is_mock && SEEDED.test(c.display_name));
    const p = (await a.send('POST', `/api/brands/${brand.id}/posts`, { draft: { baseText: 'text only', baseLink: null, baseAssetIds: [], variants: [{ connectionId: ig.id, inheritText: true, inheritMedia: true }] } })).body;
    const r = await a.send('POST', `/api/posts/${p.id}/publish`, { expected_version: p.version, connection_ids: [ig.id] });
    expect(r.status).toBe(422);
    expect(r.body.error.details.issues[0].message).toMatch(/^Instagram: an image or video is required/);
  });
});

test.describe('security', () => {
  test('mutations without the CSRF token are refused', async ({ page }) => {
    await signIn(page, 'owner@demo.social-lite.test');
    const a = await api(page);
    const r = await a.send('POST', '/api/workspace/pause', { paused: true }, { csrf: false });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('csrf_failed');
  });

  test('a user from another workspace cannot read demo posts', async ({ page, browser }) => {
    await signIn(page, 'owner@demo.social-lite.test');
    const a = await api(page);
    const brand = await demoBrand(a, /Vitalos/);
    const postId = (await a.get(`/api/brands/${brand.id}/posts`)).body.items[0].id;
    const ctx2 = await browser.newContext();
    const p2 = await ctx2.newPage();
    await signIn(p2, 'outsider@other.social-lite.test');
    const b = await api(p2);
    expect((await b.get(`/api/posts/${postId}`)).status).toBe(404);
    expect((await b.get(`/api/brands/${brand.id}/assets`)).status).toBe(404);
    expect((await b.get(`/api/brands/${brand.id}/connections`)).status).toBe(404);
    await ctx2.close();
  });

  test('viewer can read but cannot create or publish', async ({ page }) => {
    await signIn(page, 'viewer@demo.social-lite.test');
    const a = await api(page);
    const brand = await demoBrand(a, /Vitalos/);
    expect((await a.get('/api/history')).status).toBe(200);
    expect((await a.send('POST', `/api/brands/${brand.id}/posts`, { title: 'nope' })).status).toBe(403);
    const s = (await a.get('/api/session')).body;
    expect(s.permissions['drafts.edit']).toBe(false);
  });

  test('signed-out users are sent to sign in', async ({ page }) => {
    await page.goto('/history');
    await expect(page).toHaveURL(/\/login/);
    const r = await page.request.get('/api/posts/00000000-0000-0000-0000-000000000000');
    expect(r.status()).toBe(401);
  });
});

test.describe('screens', () => {
  for (const path of ['/', '/planner', '/compose', '/approvals', '/library', '/history', '/accounts', '/settings', '/operations']) {
    test(`${path} renders without errors @mobile`, async ({ page }, info) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await signIn(page, 'owner@demo.social-lite.test');
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      expect(errors).toEqual([]);
      const overflow = await page.evaluate<number>('document.documentElement.scrollWidth - document.documentElement.clientWidth');
      expect(overflow).toBeLessThanOrEqual(1);
      await page.screenshot({ path: `evidence/e2e/screens/${info.project.name}${path === '/' ? '-home' : path.replace(/\//g, '-')}.png`, fullPage: false });
    });
  }

  test('keyboard: skip to content and visible focus', async ({ page }) => {
    await signIn(page, 'owner@demo.social-lite.test');
    await page.goto('/history');
    await page.waitForLoadState('networkidle');
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toHaveText(/Skip to content/);
    const focused = await page.evaluate<{ tag: string; outline: boolean } | null>(`(() => {
      const el = document.activeElement; if (!el) return null;
      const s = getComputedStyle(el);
      return { tag: el.tagName, outline: s.outlineStyle !== 'none' || s.boxShadow !== 'none' };
    })()`);
    expect(focused?.tag).toBeTruthy();
    expect(focused?.outline).toBe(true);
  });
});
