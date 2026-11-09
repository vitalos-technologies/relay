// Fix stream F1 (2026-11-09) in the browser, against the running app (simulated destinations only):
//  H1 — TikTok composer: interactions start off, a creator-disabled interaction is greyed out, photo posts show
//       comments only, privacy options come from the creator's current settings
//  H3 — library alt-text field names the networks that receive it
//  H6 — Analytics → Channels: the Engagements column shows the same totals as the API (no longer always "—")
//  H7 — Connections cards: simulated Facebook / Instagram / X say "Analytics Available"
// Screenshots → evidence/fix/f1/ (1440 + 390, light + dark, deviceScaleFactor 2).
import { mkdirSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { api, demoBrand, signIn, type Api } from './helpers';

const OUT = 'evidence/fix/f1';
mkdirSync(OUT, { recursive: true });
const noScroll = 'document.documentElement.scrollWidth <= window.innerWidth + 1';

async function as(browser: Browser, opts: { mobile?: boolean; dark?: boolean } = {}): Promise<Page> {
  const ctx = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000', deviceScaleFactor: 2, colorScheme: opts.dark ? 'dark' : 'light',
    viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: !!opts.mobile, hasTouch: !!opts.mobile,
  });
  const page = await ctx.newPage();
  await signIn(page, 'owner@demo.social-lite.test');
  return page;
}
async function shot(page: Page, name: string, target?: ReturnType<Page['locator']>) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(250);
  if (target) await target.screenshot({ path: `${OUT}/${name}.png` });
  else await page.screenshot({ path: `${OUT}/${name}.png` });
}

/** A fresh simulated TikTok destination + a draft for it (photo post when `assetId` is given). */
async function tiktokDraft(a: Api, brandId: string, assetId: string | null): Promise<{ connId: string; postId: string; name: string }> {
  const name = `F1 TikTok ${Date.now().toString(36)}`;
  const c = await a.send('POST', `/api/brands/${brandId}/connections/mock`, { provider: 'tiktok', display_name: name, scenario: 'success' });
  expect([200, 201], JSON.stringify(c.body).slice(0, 300)).toContain(c.status);
  const p = await a.send('POST', `/api/brands/${brandId}/posts`, { title: 'F1 TikTok interactions', draft: {
    baseText: 'F1 TikTok interactions', baseLink: null, baseAssetIds: assetId ? [assetId] : [],
    variants: [{ connectionId: c.body.id, inheritText: true, inheritMedia: true }] } });
  expect(p.status).toBe(201);
  return { connId: c.body.id, postId: p.body.id, name };
}

async function openTikTok(page: Page, postId: string, name: string) {
  await page.goto(`/posts/${postId}`);
  const nav = page.getByRole('navigation', { name: 'Content to edit' });
  await nav.getByRole('button', { name: new RegExp(`^TikTok ${name}`) }).click();
  const panel = page.getByRole('region', { name: /^TikTok settings/ });
  await expect(panel).toBeVisible();
  return panel;
}

test.describe('F1 fixes', () => {
  test('H1 TikTok: interactions off by default, creator-disabled Stitch greyed out, photo posts comments only', async ({ page }) => {
    await signIn(page, 'owner@demo.social-lite.test');
    const a = await api(page);
    const brand = await demoBrand(a, /Vitalos/);
    // Tidy up simulated TikTok accounts an interrupted earlier run left behind.
    for (const c of (await a.get(`/api/brands/${brand.id}/connections`)).body.items) {
      if (/^F1 TikTok /.test(c.display_name) && !c.disconnected_at) await a.send('POST', `/api/connections/${c.id}/disconnect`, {});
    }
    const created: string[] = [];
    try {
      // Video/text post (no media): all three interactions, Stitch locked by the creator (simulator: stitch_disabled).
      const t = await tiktokDraft(a, brand.id, null);
      created.push(t.connId);
      const info = await a.get(`/api/connections/${t.connId}/tiktok-creator-info`);
      expect(info.status).toBe(200);
      expect(info.body.interactions).toEqual({ comment_disabled: false, duet_disabled: false, stitch_disabled: true });
      const panel = await openTikTok(page, t.postId, t.name);
      const comments = panel.getByRole('switch', { name: 'Allow comments' });
      await expect(comments).not.toBeChecked();
      await expect(comments).toBeEnabled();
      await expect(panel.getByRole('switch', { name: 'Allow Duet' })).not.toBeChecked();
      const stitch = panel.getByRole('switch', { name: 'Allow Stitch' });
      await expect(stitch).toBeDisabled();
      await expect(stitch).not.toBeChecked();
      await expect(panel.getByText('Turned off in the creator’s TikTok settings')).toBeVisible();
      // Privacy options = the creator's current options (the simulator offers no "Followers").
      const options = await panel.getByRole('combobox').first().locator('option').allTextContents();
      expect(options).toEqual(['Choose…', 'Everyone', 'Friends', 'Only me']);
      // Turning comments on is what gets saved (and sent): allowComment === true.
      await comments.click();
      await expect(comments).toBeChecked();
      await expect.poll(async () => (await a.get(`/api/posts/${t.postId}`)).body.draft.variants[0].options?.tiktok?.allowComment, { timeout: 15_000 }).toBe(true);
      await shot(page, 'h1-tiktok-interactions-1440-light', panel);

      // Photo post: comments only.
      const assets = (await a.get(`/api/brands/${brand.id}/assets?status=ready`)).body.items.filter((x: { mime: string | null }) => x.mime?.startsWith('image/'));
      expect(assets.length).toBeGreaterThan(0);
      const ph = await tiktokDraft(a, brand.id, assets[0].id);
      created.push(ph.connId);
      const photo = await openTikTok(page, ph.postId, ph.name);
      await expect(photo.getByRole('switch', { name: 'Allow comments' })).toBeVisible();
      await expect(photo.getByRole('switch', { name: 'Allow Duet' })).toHaveCount(0);
      await expect(photo.getByRole('switch', { name: 'Allow Stitch' })).toHaveCount(0);
      await shot(page, 'h1-tiktok-photo-comments-only-1440-light', photo);
    } finally {
      for (const id of created) await a.send('POST', `/api/connections/${id}/disconnect`, {});
    }
  });

  test('H7 connection cards, H3 library alt text, H6 channels engagements', async ({ page }) => {
    await signIn(page, 'owner@demo.social-lite.test');
    const a = await api(page);
    const brand = await demoBrand(a, /Vitalos/);
    // H7: the API (= cards) says Facebook / Instagram / X read metrics, Telegram does not.
    const conns = (await a.get(`/api/brands/${brand.id}/connections`)).body.items.filter((c: { is_mock: boolean; disconnected_at: string | null }) => c.is_mock && !c.disconnected_at);
    for (const p of ['facebook', 'instagram', 'x']) {
      const c = conns.find((x: { provider: string; display_name: string }) => x.provider === p && /^Vitalos /.test(x.display_name));
      expect(c?.capabilities.canReadMetrics, p).toBe(true);
    }
    expect(conns.find((x: { provider: string }) => x.provider === 'telegram')?.capabilities.canReadMetrics).toBe(false);
    await page.goto('/accounts');
    const fbName = conns.find((x: { provider: string; display_name: string }) => x.provider === 'facebook' && /^Vitalos /.test(x.display_name)).display_name as string;
    const fb = page.getByRole('listitem').filter({ hasText: fbName }).filter({ hasText: 'Analytics' }).first();
    await expect(fb.getByText('Available', { exact: true })).toBeVisible();
    await expect(page.getByText('Not available').first()).toBeVisible(); // Telegram stays honest

    // H3: the alt-text field says where it goes.
    await page.goto('/library');
    await page.locator('main ul li button').first().click();
    await expect(page.getByText('Sent to Instagram, Facebook, X, LinkedIn, Threads, Pinterest and Bluesky.')).toBeVisible();

    // H6: Engagements column = the API's measure (simulated dataset of published E2E posts).
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 89 * 86400_000).toISOString().slice(0, 10);
    const qs = `dataset=simulated&from=${from}&to=${to}`;
    const ch = (await a.get(`/api/analytics/channels?${qs}`)).body;
    const row = ch.rows.find((r: { measures: Array<{ measure: string; value: number | null }> }) => r.measures.find((m) => m.measure === 'engagements')?.value);
    expect(row, 'a channel with simulated engagements').toBeTruthy();
    await page.goto(`/analytics/channels?${qs}`);
    const tr = page.getByRole('row').filter({ hasText: row.display_name }).first();
    const cell = tr.locator('td[data-measure="engagements"]');
    await expect(cell).not.toHaveText('—');
    await expect(cell).toHaveText(/\d/);
  });

  test('screenshots: light + dark, 1440 + 390; no horizontal scroll', async ({ browser }) => {
    test.setTimeout(420_000);
    const page = await as(browser); // one sign-in; viewport and colour scheme switched per shot
    const a = await api(page);
    const brand = await demoBrand(a, /Vitalos/);
    const t = await tiktokDraft(a, brand.id, null);
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 89 * 86400_000).toISOString().slice(0, 10);
    // Channels evidence: accounts with simulated engagements (the column that used to be always "—").
    const ch = (await a.get(`/api/analytics/channels?dataset=simulated&from=${from}&to=${to}`)).body;
    const withEng = ch.rows.filter((r: { measures: Array<{ measure: string; value: number | null }> }) => r.measures.find((m) => m.measure === 'engagements')?.value).slice(0, 4);
    const accountQs = withEng.length ? `&account=${withEng.map((r: { connection_id: string }) => r.connection_id).join(',')}` : '';
    try {
      for (const dark of [false, true]) {
        for (const mobile of [false, true]) {
          await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
          await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
          const tag = `${mobile ? 390 : 1440}-${dark ? 'dark' : 'light'}`;
          if (mobile) {
            // Phone: the composer shows one step at a time; open the TikTok content from the destination rail.
            await page.goto(`/posts/${t.postId}`);
            await page.getByLabel('Composer step').getByText('Destinations').click();
            await page.getByRole('navigation', { name: 'Content to edit' }).getByRole('button', { name: new RegExp(`^TikTok ${t.name}`) }).click();
            const region = page.getByRole('region', { name: /^TikTok settings/ });
            await expect(region).toBeVisible();
            await region.scrollIntoViewIfNeeded();
          } else {
            const panel = await openTikTok(page, t.postId, t.name);
            await panel.scrollIntoViewIfNeeded();
          }
          await shot(page, `h1-tiktok-settings-${tag}`);
          expect(await page.evaluate(noScroll)).toBe(true);
          await page.goto(`/analytics/channels?dataset=simulated&from=${from}&to=${to}${accountQs}`);
          await expect(page.getByRole('table')).toBeVisible();
          await shot(page, `h6-channels-${tag}`);
          expect(await page.evaluate(noScroll)).toBe(true);
          await page.goto('/accounts');
          await expect(page.getByText('Available', { exact: true }).first()).toBeVisible();
          await shot(page, `h7-accounts-${tag}`);
          expect(await page.evaluate(noScroll)).toBe(true);
          await page.goto('/library');
          await page.locator('main ul li button').first().click();
          await expect(page.getByText(/^Sent to Instagram/)).toBeVisible();
          await shot(page, `h3-library-alt-text-${tag}`);
        }
      }
    } finally {
      await a.send('POST', `/api/connections/${t.connId}/disconnect`, {});
      await page.context().close();
    }
  });
});
