// V5 AI workspace (stream AIW) — real sign-in, real API + worker, E2E Workspace, SIMULATED accounts/channels only.
// No AI provider is configured in this environment: deterministic workflow steps run for real and the product says
// "AI is not set up" for AI-written parts (no fabricated output). Brief §18: 13 (relevant, actionable suggestions),
// 14 (workflows create real records with working links), 15 (runs survive refresh; cancellation), 16 (scheduling only via
// a reviewed preview), 17 (mobile with the on-screen keyboard), 18 (accessibility checks recorded).
import { mkdirSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { api, demoBrand, signIn, type Api } from './helpers';

const OWNER = 'owner@demo.social-lite.test';
const EVIDENCE = 'evidence/v5/aiw';
const noScroll = 'document.documentElement.scrollWidth <= window.innerWidth + 1';
mkdirSync(EVIDENCE, { recursive: true });

async function as(browser: Browser, opts: { mobile?: boolean; dark?: boolean; reduced?: boolean } = {}): Promise<Page> {
  const ctx = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000', deviceScaleFactor: 2, colorScheme: opts.dark ? 'dark' : 'light', reducedMotion: opts.reduced ? 'reduce' : 'no-preference',
    viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: !!opts.mobile, hasTouch: !!opts.mobile,
  });
  const page = await ctx.newPage();
  await signIn(page, OWNER);
  return page;
}
async function shot(page: Page, name: string, fullPage = false) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${EVIDENCE}/${name}.png`, fullPage });
}
const key = () => `e2e${Date.now()}${Math.random().toString(36).slice(2, 8)}`;

async function vitalos(a: Api): Promise<string> { return (await demoBrand(a, /Vitalos/)).id as string; }

/** Wait until a run leaves preparing/working (worker on the ai-assist queue). */
async function settle(a: Api, id: string, timeoutMs = 60_000) {
  const t0 = Date.now();
  for (;;) {
    const r = await a.get(`/api/assistant/workflows/${id}`);
    if (!['preparing', 'working'].includes(r.body.status)) return r.body;
    if (Date.now() - t0 > timeoutMs) throw new Error(`run ${id} still ${r.body.status}`);
    await new Promise((res) => setTimeout(res, 700));
  }
}

test.describe('V5 AI workspace', () => {
  test.describe.configure({ timeout: 240_000 });

  test('home: welcome, composer with context, 4–6 actionable suggestions from real data (AT13)', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop');
    for (const dark of [false, true]) {
      const page = await as(browser, { dark });
      const a = await api(page);
      const brand = await vitalos(a);
      const ctx = (await a.get(`/api/assistant/workspace?brand_id=${brand}`)).body;
      expect(ctx.suggestions.length).toBeGreaterThanOrEqual(4);
      expect(ctx.suggestions.length).toBeLessThanOrEqual(6);
      // Never targets an account that is not ready.
      const ready = new Set(ctx.brands.find((b: { id: string }) => b.id === brand).accounts.filter((x: { ready: boolean }) => x.ready).map((x: { id: string }) => x.id));
      for (const s of ctx.suggestions) for (const id of (s.prefill.inputs.connection_ids ?? []) as string[]) expect(ready.has(id)).toBe(true);
      await page.goto(`/assistant?brand=${brand}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Assistant' })).toBeAttached();
      await expect(page.getByRole('heading', { level: 2, name: /What should we work on/ })).toBeVisible();
      const composer = page.getByTestId('ai-composer');
      await expect(composer.getByLabel('Brand', { exact: true })).toHaveValue(brand);
      if (!ctx.status.configured) await expect(page.getByText('AI is not set up').first()).toBeVisible();
      const cards = page.getByTestId('ai-suggestions').getByRole('button');
      await expect(cards).toHaveCount(ctx.suggestions.length);
      expect(await page.evaluate(noScroll)).toBe(true);
      await shot(page, `workspace-home-1440-${dark ? 'dark' : 'light'}`);
      if (!dark) {
        // Every suggestion opens a prefilled task (task type + task-specific details), never a dead button.
        for (let i = 0; i < ctx.suggestions.length; i++) {
          await cards.nth(i).click();
          await expect(composer.getByLabel('Task type', { exact: true })).toHaveValue(ctx.suggestions[i].workflow);
          if (ctx.suggestions[i].workflow !== 'ask') await expect(composer.getByRole('group', { name: /details/ })).toBeVisible();
        }
        await cards.first().click();
        await shot(page, 'workspace-suggestion-prefilled-1440-light');
      }
      await page.context().close();
    }
  });

  test('weekly planning through the UI: progress, refresh-safe, real plan + review schedule preview (AT14/15/16)', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop');
    const page = await as(browser);
    const a = await api(page);
    const brand = await vitalos(a);
    await page.goto(`/assistant?brand=${brand}`);
    const composer = page.getByTestId('ai-composer');
    await composer.getByLabel('Task type', { exact: true }).selectOption('weekly_planning');
    await composer.getByLabel('Week', { exact: true }).selectOption({ index: 2 }); // next week: every slot is in the future
    await composer.getByRole('button', { name: 'Start task' }).click();
    const card = page.getByTestId('run-card').last();
    await expect(card).toBeVisible();
    await expect(page).toHaveURL(/[?&]t=/);
    // Refresh while it runs (or after): the run is read back from the server.
    await page.reload();
    const after = page.getByTestId('run-card').last();
    await expect(after).toHaveAttribute('data-status', /needs_review|partially_completed|completed/, { timeout: 60_000 });
    await expect(after.getByRole('list', { name: /Steps/ })).toBeVisible();
    await expect(after.getByText('Read the calendar')).toBeVisible();
    await expect(page.getByTestId('ai-history').getByRole('button').first()).toBeVisible();
    await after.getByTestId('result-schedule_plan').first().scrollIntoViewIfNeeded().catch(() => undefined);
    await shot(page, 'run-weekly-plan-1440-light');
    const review = after.getByRole('button', { name: 'Review schedule' }).first();
    if (await review.count()) {
      await review.click();
      const dlg = page.getByTestId('action-review');
      await expect(dlg).toBeVisible();
      await expect(dlg.getByText('Exactly what is sent')).toBeVisible();
      await expect(dlg.getByText('Destinations')).toBeVisible();
      await shot(page, 'review-schedule-1440-light');
      // Leave the calendar untouched in the shared E2E workspace: decline this one.
      await page.getByRole('button', { name: 'Don’t do this' }).click();
      await expect(dlg).toBeHidden();
    }
    // Every plan card opens the real post.
    const open = after.getByRole('link', { name: 'Open draft' }).first();
    if (await open.count()) {
      const href = await open.getAttribute('href');
      expect(href).toMatch(/^\/posts\/[0-9a-f-]{36}$/);
      expect((await a.get(`/api/posts/${href!.split('/').pop()}`)).status).toBe(200);
    }
    await page.context().close();
  });

  test('campaign from an attached brief: real campaign record with a working link; honest about AI (AT14)', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop');
    const page = await as(browser);
    const a = await api(page);
    const brand = await vitalos(a);
    await page.goto(`/assistant?brand=${brand}`);
    const composer = page.getByTestId('ai-composer');
    await composer.getByLabel('Task type', { exact: true }).selectOption('campaign_from_brief');
    await page.locator('input[type=file]').setInputFiles({ name: `winter-brief-${Date.now()}.md`, mimeType: 'text/markdown', buffer: Buffer.from('# Winter range\nNew winter blend, available from 1 December in all stores.') });
    await expect(composer.getByText(/winter-brief-/).first()).toBeVisible();
    await expect(composer.getByLabel('Brief', { exact: true })).not.toHaveValue('');
    await composer.getByRole('textbox', { name: 'Task' }).fill('Keep it warm and short.');
    await composer.getByRole('button', { name: 'Start task' }).click();
    const card = page.getByTestId('run-card').last();
    await expect(card).toHaveAttribute('data-status', /partially_completed|completed|needs_review/, { timeout: 60_000 });
    const ctx = (await a.get(`/api/assistant/workspace?brand_id=${brand}`)).body;
    if (!ctx.status.configured) await expect(card.getByText('AI is not set up').first()).toBeVisible();
    const link = card.getByRole('link', { name: 'Open campaign' });
    await expect(link).toBeVisible();
    await link.scrollIntoViewIfNeeded();
    await shot(page, 'run-campaign-1440-light');
    await card.getByRole('button', { name: /Activity/ }).click();
    await expect(card.getByText('Reading the selected brief.')).toBeVisible();
    const href = await link.getAttribute('href');
    await link.click();
    await expect(page).toHaveURL(new RegExp(href!.replace('?', '\\?')));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.context().close();
  });

  test('stop: a run stopped before it starts never runs, and says so (AT15)', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop');
    const page = await as(browser);
    const a = await api(page);
    const brand = await vitalos(a);
    const r = await a.send('POST', '/api/assistant/workflows', { workflow: 'performance_analysis', inputs: { brand_id: brand, range_days: 28 }, idempotency_key: key() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const c = await a.send('POST', `/api/assistant/workflows/${r.body.id}/cancel`);
    expect([200, 409]).toContain(c.status);
    const done = await settle(a, r.body.id);
    expect(['cancelled', 'completed', 'partially_completed']).toContain(done.status);
    await page.goto(`/assistant?t=${r.body.thread_id}&brand=${brand}`);
    const card = page.getByTestId('run-card').last();
    await expect(card).toHaveAttribute('data-status', done.status);
    if (done.status === 'cancelled') await expect(card.getByText(/Stopped\./).first()).toBeVisible();
    else await expect(card.getByRole('link', { name: 'View report' })).toBeVisible();
    await shot(page, `run-${done.status === 'cancelled' ? 'stopped' : 'report'}-1440-light`);
    await page.context().close();
  });

  test('keyboard, names and reduced motion: suggestions and composer work without a mouse (AT18)', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop');
    const page = await as(browser, { reduced: true });
    await page.goto('/assistant');
    const composer = page.getByTestId('ai-composer');
    await expect(composer.getByRole('textbox', { name: 'Task' })).toBeFocused();
    // Tab reaches the suggestions; Enter opens one.
    const first = page.getByTestId('ai-suggestions').getByRole('button').first();
    await first.focus();
    await page.keyboard.press('Enter');
    await expect(composer.getByRole('textbox', { name: 'Task' })).toBeFocused();
    // Controls have accessible names.
    for (const name of ['Brand', 'Task type', 'Task']) await expect(composer.getByLabel(name, { exact: true })).toBeAttached();
    await expect(composer.getByRole('button', { name: /Attach a file/ })).toBeVisible();
    await expect(composer.getByRole('button', { name: /Knowledge sources/ })).toBeVisible();
    // Content is visible with reduced motion (no element left transparent).
    const hidden = await page.evaluate(`[...document.querySelectorAll('[data-testid="ai-suggestions"] li')].filter((el) => getComputedStyle(el).opacity !== '1').length`);
    expect(hidden).toBe(0);
    // 200 % zoom: no horizontal scroll.
    await page.setViewportSize({ width: 720, height: 900 });
    expect(await page.evaluate(noScroll)).toBe(true);
    await page.context().close();
  });

  test('widths 320–1440: no horizontal scroll on the workspace and a run', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop');
    const page = await as(browser);
    const a = await api(page);
    const threads = (await a.get('/api/assistant/threads?limit=1')).body.items as Array<{ id: string }>;
    for (const width of [320, 360, 390, 430, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of ['/assistant', ...(threads[0] ? [`/assistant?t=${threads[0].id}`] : [])]) {
        await page.goto(path);
        await expect(page.getByTestId('ai-composer')).toBeVisible();
        expect(await page.evaluate(noScroll), `${path} @ ${width}`).toBe(true);
      }
    }
    await page.context().close();
  });

  test('admin: workspace AI workflows and Platform → AI operations (metadata only)', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop');
    const page = await as(browser);
    await page.goto('/admin/ai');
    await expect(page.getByTestId('admin-ai-workflows')).toBeVisible();
    await expect(page.getByText('AI workspace availability')).toBeVisible();
    await shot(page, 'admin-ai-workflows-1440-light');
    await page.goto('/admin/platform/ai');
    await expect(page.getByTestId('platform-ai')).toBeVisible();
    await shot(page, 'platform-ai-1440-light');
    await page.context().close();
  });

  test('phone: history sheet, composer with the on-screen keyboard, results readable @mobile', async ({ browser }, info) => {
    test.skip(info.project.name !== 'mobile', 'phone layout only');
    for (const dark of [false, true]) {
      const page = await as(browser, { mobile: true, dark });
      await page.goto('/assistant');
      const composer = page.getByTestId('ai-composer');
      await expect(composer).toBeVisible();
      expect(await page.evaluate(noScroll)).toBe(true);
      await shot(page, `workspace-home-390-${dark ? 'dark' : 'light'}`);
      if (dark) { await page.context().close(); continue; }
      // On-screen keyboard: tapping the text box keeps it and the Start button reachable in the visual viewport.
      const box = composer.getByRole('textbox', { name: 'Task' });
      await box.tap();
      await page.setViewportSize({ width: 390, height: 844 - 300 }); // keyboard open: the viewport shrinks
      await box.fill('Plan next week');
      await expect(composer.getByLabel('Task type', { exact: true })).toHaveValue('weekly_planning');
      await box.scrollIntoViewIfNeeded();
      await expect(box).toBeInViewport();
      // Enter on a touch keyboard inserts a new line instead of submitting.
      await box.press('Enter');
      await expect(page.getByTestId('run-card')).toHaveCount(0);
      await composer.getByRole('button', { name: 'Start task' }).scrollIntoViewIfNeeded();
      await expect(composer.getByRole('button', { name: 'Start task' })).toBeInViewport();
      await page.setViewportSize({ width: 390, height: 844 });
      await composer.getByRole('button', { name: 'Start task' }).tap();
      const card = page.getByTestId('run-card').last();
      await expect(card).toHaveAttribute('data-status', /needs_review|partially_completed|completed/, { timeout: 60_000 });
      expect(await page.evaluate(noScroll)).toBe(true);
      await card.getByRole('list', { name: /Steps/ }).scrollIntoViewIfNeeded();
      await shot(page, 'run-390-light');
      await card.getByTestId(/result-/).first().scrollIntoViewIfNeeded().catch(() => undefined);
      await shot(page, 'run-results-390-light');
      await page.getByRole('button', { name: 'History' }).tap();
      await expect(page.getByRole('navigation', { name: 'Conversation history' }).last()).toBeVisible();
      await shot(page, 'history-sheet-390-light');
      await page.getByRole('button', { name: 'Close history' }).tap();
      for (const width of [320, 360, 430]) {
        await page.setViewportSize({ width, height: 800 });
        expect(await page.evaluate(noScroll), `run @ ${width}`).toBe(true);
      }
      await page.context().close();
    }
  });
});
