// V3.5 stream E browser workflows (real sign-in, real API + worker, E2E Workspace, SIMULATED Facebook Page only):
//  - the assistant is honest about its provider state (no output without a configured provider);
//  - a bounded policy + rule built in the UI: test preview (dry run), enable, a simulated customer message is classified
//    and routed by the worker, the run shows in History; emergency stop and resume;
//  - phone layouts (@mobile) for /assistant, /automation and the inbox assistant drawer.
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { api, demoBrand, signIn, type Api } from './helpers';

const OWNER = 'owner@demo.social-lite.test';
const PAGE_NAME = 'E2E Inbox Page (simulated)';

async function channel(a: Api): Promise<{ id: string; brandId: string }> {
  const existing = (await a.get('/api/inbox/channels')).body.items as Array<{ id: string; display_name: string; brand_id: string }>;
  const found = existing.find((c) => c.display_name === PAGE_NAME);
  if (found) return { id: found.id, brandId: found.brand_id };
  const brand = await demoBrand(a, /Vitalos/);
  const conn = await a.send('POST', `/api/brands/${brand.id}/connections/mock`, { provider: 'facebook', display_name: PAGE_NAME });
  expect(conn.status).toBe(200);
  const ch = await a.send('POST', '/api/inbox/channels', { connection_id: conn.body.id });
  expect(ch.status).toBe(200);
  return { id: ch.body.id, brandId: brand.id };
}

const noHorizontalScroll = async (page: Page) => expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')).toBe(true);

test.describe('AI assistant + automation', () => {
  test.describe.configure({ timeout: 240_000 });

  test('assistant reports its provider state honestly and never shows invented output', async ({ page }) => {
    await signIn(page, OWNER);
    const a = await api(page);
    const status = (await a.get('/api/assistant/status')).body as { configured: boolean };
    await page.goto('/assistant');
    await expect(page.getByRole('heading', { name: 'Assistant', level: 1 })).toBeVisible();
    if (!status.configured) {
      await expect(page.getByText('AI is not set up').first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Ask' })).toHaveAttribute('aria-disabled', 'true');
      const ch = await channel(a);
      const name = `Cara ${randomUUID().slice(0, 6)}`;
      await a.send('POST', `/api/inbox/channels/${ch.id}/simulate`, { kind: 'dm', name, text: 'Where is my order?' });
      const conv = (await a.get(`/api/inbox/conversations?queue=all&q=${encodeURIComponent(name)}`)).body.items[0];
      const r = await a.send('POST', '/api/assistant/runs', { surface: 'inbox', task: 'suggest_reply', context: { type: 'conversation', id: conv.id }, idempotency_key: randomUUID().replace(/-/g, '') });
      expect(r.status).toBe(412);
      expect(r.body.error.code).toBe('provider_not_configured');
      await page.goto(`/inbox?queue=all&c=${conv.id}`);
      await page.getByRole('button', { name: 'Assistant' }).first().click();
      await expect(page.getByRole('dialog').getByText('AI is not set up')).toBeVisible();
      await expect(page.getByRole('dialog').getByRole('button', { name: 'Run' })).toHaveCount(0);
    }
    await page.keyboard.press('Escape');
    await page.goto('/assistant');
    await page.getByRole('tab', { name: 'Knowledge' }).click();
    await expect(page.getByText(/approved knowledge|Only approved sources/).first()).toBeVisible();
  });

  test('policy + rule: test preview, live routing by the worker, history, emergency stop', async ({ page }) => {
    await signIn(page, OWNER);
    const a = await api(page);
    const ch = await channel(a);
    const tag = randomUUID().slice(0, 6);
    const pol = await a.send('POST', '/api/automation/policies', {
      name: `E2E routing ${tag}`, brand_ids: [ch.brandId], channel_ids: [ch.id], allowed_actions: ['add_labels', 'set_priority', 'escalate', 'add_note'],
      limits: { max_actions_per_hour: 100, max_auto_replies_per_day: 0, monthly_token_budget: 0 }, escalation: { negative_sentiment: true, keywords: [] },
      expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    expect(pol.status).toBe(200);
    const label = `e2e-${tag}`;
    try {
      await page.goto('/automation');
      await expect(page.getByRole('heading', { name: 'Automation', level: 1 })).toBeVisible();
      await page.getByRole('tab', { name: 'Policies' }).click();
      const card = page.getByRole('listitem').filter({ hasText: `E2E routing ${tag}` });
      await card.getByRole('button', { name: 'Activate' }).click();
      await expect(card.getByText('Active')).toBeVisible();

      await page.getByRole('tab', { name: 'Rules' }).click();
      await page.getByRole('button', { name: 'New rule' }).click();
      const d = page.getByRole('dialog');
      await d.getByLabel('Name').fill(`Label order questions ${tag}`);
      await d.getByLabel('Policy').selectOption({ label: `E2E routing ${tag}` });
      await d.getByRole('button', { name: 'Add condition' }).click();
      await d.getByRole('button', { name: 'Order status' }).click();
      await d.getByLabel('Labels').fill(label);
      await d.getByRole('button', { name: 'Test' }).click();
      await expect(d.getByText(/Test · \d+ of \d+ recent matched/)).toBeVisible();
      await expect(d.getByText('Dry run: nothing was changed or sent.')).toBeVisible();
      await d.getByRole('switch', { name: 'Enabled' }).click();
      await d.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText(`Label order questions ${tag}`)).toBeVisible();

      // A customer message: classified (order status) and labelled by the worker through the inbox hook.
      const name = `Olu ${tag}`;
      await a.send('POST', `/api/inbox/channels/${ch.id}/simulate`, { kind: 'dm', name, text: 'Hi, where is my order? The tracking has not moved.' });
      const conv = (await a.get(`/api/inbox/conversations?queue=all&q=${encodeURIComponent(name)}`)).body.items[0];
      await expect.poll(async () => (await a.get(`/api/inbox/conversations/${conv.id}`)).body.labels, { timeout: 60_000 }).toContain(label);
      const cl = (await a.get(`/api/assistant/classification?conversation_id=${conv.id}`)).body.classification;
      expect(cl).toMatchObject({ category: 'order_status', method: 'rules' });

      await page.getByRole('tab', { name: 'History' }).click();
      await expect(page.getByRole('listitem').filter({ hasText: `Label order questions ${tag}` }).first()).toContainText('Done');

      await page.getByRole('button', { name: 'Emergency stop' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Stop everything' }).click();
      await expect(page.getByText('Emergency stop is on')).toBeVisible();
      await page.getByRole('button', { name: 'Resume automation' }).click();
      await expect(page.getByText('Emergency stop is on')).toHaveCount(0);
    } finally {
      await a.send('POST', '/api/automation/emergency-stop', { active: false });
      await a.send('POST', `/api/automation/policies/${pol.body.id}/status`, { status: 'paused' });
    }
  });

  test('phone: assistant and automation screens fit every width @mobile', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'phone layout only');
    await signIn(page, OWNER);
    for (const width of [320, 360, 390, 430, 768]) {
      await page.setViewportSize({ width, height: 860 });
      for (const path of ['/assistant', '/automation']) {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await noHorizontalScroll(page);
      }
    }
    await page.setViewportSize({ width: 390, height: 860 });
    await page.goto('/automation');
    await page.getByRole('button', { name: 'New rule' }).click().catch(() => undefined);
    await noHorizontalScroll(page);
  });
});
