// V3.5 listening browser workflows (real Keycloak sign-in, real API + worker, E2E Workspace, SIMULATED Facebook Page only):
// create a saved search in the UI → simulated public comments flow inbox → listening (worker) → mentions with coverage,
// sentiment correction and an insight task; a spike alert built by the worker links to the exact simulated comments and
// states its coverage (brief §22 AT10); the phone workflow "inspect a listening alert" (@mobile, AT15).
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { api, demoBrand, signIn, type Api } from './helpers';

const OWNER = 'owner@demo.social-lite.test';
const PAGE_NAME = 'E2E Inbox Page (simulated)';

async function channel(a: Api): Promise<string> {
  const existing = (await a.get('/api/inbox/channels')).body.items as Array<{ id: string; display_name: string }>;
  const found = existing.find((c) => c.display_name === PAGE_NAME);
  if (found) return found.id;
  const brand = await demoBrand(a, /Vitalos/);
  const conn = await a.send('POST', `/api/brands/${brand.id}/connections/mock`, { provider: 'facebook', display_name: PAGE_NAME });
  expect(conn.status).toBe(200);
  const ch = await a.send('POST', '/api/inbox/channels', { connection_id: conn.body.id });
  expect(ch.status).toBe(200);
  return ch.body.id;
}

async function comment(a: Api, ch: string, text: string, minutesAgo = 0, kind: 'comment' | 'dm' = 'comment') {
  const r = await a.send('POST', `/api/inbox/channels/${ch}/simulate`, { kind, text, name: `Pat ${randomUUID().slice(0, 4)}`, minutes_ago: minutesAgo });
  expect(r.status).toBe(200);
}

async function waitFor<T>(fn: () => Promise<T | null>, timeout = 90_000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for the worker');
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

/** Saved search + spike rule + baseline (3 earlier windows) + a burst now; returns ids once the worker fired the alert. */
async function spikeWorld(a: Api, tag: string) {
  const brand = await demoBrand(a, /Vitalos/);
  const ch = await channel(a);
  const s = await a.send('POST', '/api/listening/searches', { brand_id: brand.id, name: `E2E ${tag}`, role: 'own', terms: [tag], keywords: [], exclusions: [], boolean: null, languages: [], sources: [], kinds: [] });
  expect(s.status).toBe(200);
  for (const m of [90, 150, 210]) await comment(a, ch, `${tag} quiet visit, lovely`, m);
  const rule = await a.send('POST', '/api/listening/rules', { search_id: s.body.id, name: 'E2E spike', metric: 'volume', window_minutes: 60, baseline_days: 1, min_sample: 3, multiplier: 2, min_baseline_windows: 3, cooldown_minutes: 60 });
  expect(rule.status).toBe(200);
  const burst = [`${tag} app checkout failed`, `${tag} payment error again`, `${tag} charged twice, terrible`, `${tag} app is down`];
  for (const t of burst) await comment(a, ch, t);
  await comment(a, ch, `${tag} private: my card number…`, 0, 'dm'); // never observed
  const alert = await waitFor(async () => {
    const r = await a.get(`/api/listening/alerts?search_id=${s.body.id}`);
    return r.body?.items?.[0] ?? null;
  }, 420_000); // ≤ 20 s with the current worker; up to 5 min with a worker built before the match-triggered sweep
  return { searchId: s.body.id as string, alertId: alert.id as string, burst };
}

const noHScroll = (p: Page) => p.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1');

test.describe('Listening', () => {
  test.describe.configure({ timeout: 600_000 });

  test('saved search in the UI, mentions with coverage, correction and a task from an insight', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, OWNER);
    const a = await api(page);
    const tag = `zq${randomUUID().slice(0, 6)}`;
    const ch = await channel(a);

    await page.goto('/listening');
    await expect(page.getByRole('heading', { name: 'Listening', level: 1 })).toBeVisible();
    await expect(page.getByText(/Private messages are never included/)).toBeVisible();
    await page.getByRole('button', { name: 'New search' }).first().click();
    const dlg = page.getByRole('dialog', { name: 'New saved search' });
    await dlg.getByLabel('Name', { exact: true }).fill(`E2E ${tag}`);
    await dlg.getByLabel('Brand').selectOption({ label: (await demoBrand(a, /Vitalos/)).name });
    await dlg.getByLabel('Names and aliases').fill(tag);
    await dlg.getByLabel('Advanced query').fill('(flat');
    await expect(dlg.getByText(/Close the bracket/)).toBeVisible();          // same parser as the server, live
    await dlg.getByLabel('Advanced query').fill('');
    await dlg.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/listening\/searches\//);
    const searchId = page.url().split('/').pop()!.split('?')[0]!;

    await comment(a, ch, `${tag} flat white is delicious, love it`);
    await comment(a, ch, `${tag} cake was stale and the staff rude`);
    await comment(a, ch, `${tag} please refund my order`, 0, 'dm');           // private: never in listening
    await waitFor(async () => ((await a.get(`/api/listening/searches/${searchId}/mentions?days=1`)).body?.items?.length >= 2 ? true : null));
    await page.reload();
    const list = page.getByRole('article');
    await expect(list).toHaveCount(2);
    await expect(page.getByText(`${tag} please refund my order`)).toHaveCount(0);
    await expect(page.getByText(/Facebook Page.* · since .* · n = 2/).first()).toBeVisible();
    await expect(page.getByText('Simulated', { exact: true }).first()).toBeVisible();

    const stale = page.getByRole('article').filter({ hasText: 'stale' });
    await expect(stale.getByText(/^Negative/)).toBeVisible();
    await stale.getByRole('button', { name: 'Mention actions' }).click();
    await page.getByRole('menuitem', { name: 'Mark neutral' }).click();
    await expect(stale.getByText(/Neutral · corrected/)).toBeVisible();

    await stale.getByRole('button', { name: 'Mention actions' }).click();
    await page.getByRole('menuitem', { name: 'Task' }).click();
    await expect(page.getByText('Task created')).toBeVisible();
  });

  test('AT10: the alert lists the exact simulated comments and states its coverage', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, OWNER);
    const a = await api(page);
    const tag = `zs${randomUUID().slice(0, 6)}`;
    const w = await spikeWorld(a, tag);
    const detail = (await a.get(`/api/listening/alerts/${w.alertId}`)).body;
    expect(detail.observed).toBe(4);
    expect(detail.mentions.map((m: { text: string }) => m.text).sort()).toEqual([...w.burst].sort());
    expect(detail.coverage.sources[0]).toMatchObject({ key: 'connected:facebook_page' });
    expect(detail.coverage.dataset).toBe('simulated');

    await page.goto(`/listening/alerts/${w.alertId}`);
    await expect(page.getByRole('heading', { name: 'Mention spike' })).toBeVisible();
    await expect(page.getByText('Mentions counted (4)')).toBeVisible();
    for (const t of w.burst) await expect(page.getByText(t)).toBeVisible();
    await expect(page.getByText('Simulated data')).toBeVisible();
    await expect(page.getByText(/query v1/).first()).toBeVisible();
    await page.getByRole('button', { name: 'Coverage' }).click();
    await expect(page.getByText(/Private messages are never included/)).toBeVisible();
    await page.getByRole('button', { name: 'Acknowledge' }).click();
    await expect(page.getByText('Acknowledged').first()).toBeVisible();
  });

  test('phone: inspect a listening alert and create a task @mobile', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'phone layout only');
    await signIn(page, OWNER);
    const a = await api(page);
    const tag = `zm${randomUUID().slice(0, 6)}`;
    const w = await spikeWorld(a, tag);
    await page.goto('/listening');
    await page.getByRole('link', { name: /Mention spike/ }).first().click();
    await page.waitForURL(/\/listening\/alerts\//);
    await expect(page.getByText(/Mentions counted/)).toBeVisible();
    expect(await noHScroll(page)).toBe(true);
    await page.goto(`/listening/alerts/${w.alertId}`);
    await page.getByRole('button', { name: 'Create task' }).click();
    await expect(page.getByText('Task created')).toBeVisible();
    await page.goto(`/listening/searches/${w.searchId}`);
    await expect(page.getByRole('heading', { name: `E2E ${tag}` })).toBeVisible();
    expect(await noHScroll(page)).toBe(true);
  });
});
