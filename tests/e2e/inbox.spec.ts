// V3.5 inbox browser workflows (real Keycloak sign-in, real API + worker, E2E Workspace, SIMULATED Facebook Page only):
// receive → assign → internal note (mode switch keeps the draft) → reply sent once with the provider result shown;
// two agents replying at once (the second is stopped and shown what changed); the phone workflow (@mobile).
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { api, demoBrand, signIn, type Api } from './helpers';

const OWNER = 'owner@demo.social-lite.test';
const ADMIN = 'admin@demo.social-lite.test';
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
  expect(ch.body).toMatchObject({ status: 'active', is_simulated: true });
  return ch.body.id;
}

async function incoming(a: Api, text: string): Promise<{ name: string; id: string }> {
  const ch = await channel(a);
  const name = `Cara ${randomUUID().slice(0, 6)}`;
  const r = await a.send('POST', `/api/inbox/channels/${ch}/simulate`, { kind: 'dm', name, text });
  expect(r.status).toBe(200);
  const list = await a.get(`/api/inbox/conversations?queue=all&q=${encodeURIComponent(name)}`);
  expect(list.body.items).toHaveLength(1);
  return { name, id: list.body.items[0].id };
}

async function person(browser: Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await signIn(page, email);
  return page;
}

const timeline = (p: Page) => p.getByRole('list', { name: 'Conversation' });
const composer = (p: Page, mode: string) => p.getByRole('textbox', { name: mode });

test.describe('Inbox', () => {
  test.describe.configure({ timeout: 240_000 });

  test('receive, assign, internal note, reply sent once with the provider result', async ({ browser }) => {
    const owner = await person(browser, OWNER);
    const a = await api(owner);
    const conv = await incoming(a, 'Is my order 5521 ready for pickup?');

    await owner.goto(`/inbox?queue=unassigned`);
    await owner.getByRole('button', { name: new RegExp(conv.name) }).click();
    await expect(owner.getByRole('heading', { name: conv.name })).toBeVisible();
    await expect(timeline(owner).getByText('Is my order 5521 ready for pickup?')).toBeVisible();

    await owner.getByRole('button', { name: /^Assignee/ }).click();
    await owner.getByRole('menuitem', { name: 'Me' }).click();
    await expect(owner.getByText('Assigned to you')).toBeVisible();

    // Mode switch keeps the text and never sends it.
    await composer(owner, 'Private message').fill('Checking with the kitchen now');
    await owner.getByRole('radio', { name: 'Internal note' }).click();
    await expect(composer(owner, 'Internal note')).toHaveValue('Checking with the kitchen now');
    await expect(owner.getByText('Internal — only your team sees this')).toBeVisible();
    await composer(owner, 'Internal note').fill('Order 5521 is still in the oven — 10 minutes.');
    await owner.getByRole('button', { name: 'Add note' }).click();
    await expect(owner.getByText('Order 5521 is still in the oven — 10 minutes.')).toBeVisible();
    await expect(owner.getByText(/Internal note · /).first()).toBeVisible();

    await owner.getByRole('radio', { name: 'Private message' }).click();
    await composer(owner, 'Private message').fill('Hi! Your order will be ready in 10 minutes.');
    await owner.getByRole('button', { name: 'Send' }).click();
    await expect(owner.getByText('Sent (simulated)').last()).toBeVisible({ timeout: 30_000 });

    const replies = (await a.get(`/api/inbox/conversations/${conv.id}/replies`)).body.items as Array<{ state: string; provider_result: { external_id?: string } }>;
    expect(replies).toHaveLength(1);
    expect(replies[0]!.state).toBe('sent');
    expect(replies[0]!.provider_result.external_id).toMatch(/^mock_mid_/);
    const detail = (await a.get(`/api/inbox/conversations/${conv.id}`)).body as { timeline: Array<{ type: string; message?: { body: string } }> };
    const messages = detail.timeline.filter((t) => t.type === 'message').map((t) => t.message!.body);
    expect(messages.some((b) => b.includes('still in the oven'))).toBe(false); // the note never became a message
    expect(detail.timeline.some((t) => t.type === 'note')).toBe(true);
    await owner.context().close();
  });

  test('two agents reply at the same time: one is sent, the other is stopped and shown what changed', async ({ browser }) => {
    const owner = await person(browser, OWNER);
    const admin = await person(browser, ADMIN);
    const a = await api(owner);
    const conv = await incoming(a, 'Can I get a refund for the cancelled class?');
    for (const p of [owner, admin]) {
      await p.goto(`/inbox?queue=all&c=${conv.id}`);
      await expect(timeline(p).getByText('Can I get a refund for the cancelled class?')).toBeVisible();
    }
    await composer(admin, 'Private message').fill('Yes — refund issued today.');
    await composer(owner, 'Private message').fill('Let me check that for you.');
    await admin.getByRole('button', { name: 'Send' }).click();
    await expect(admin.getByText('Sent (simulated)').last()).toBeVisible({ timeout: 30_000 });

    await owner.getByRole('button', { name: 'Send' }).click();
    await expect(owner.getByText('Someone else replied')).toBeVisible();
    await expect(composer(owner, 'Private message')).toHaveValue('Let me check that for you.'); // nothing lost, nothing sent
    const replies = (await a.get(`/api/inbox/conversations/${conv.id}/replies`)).body.items as Array<{ state: string; body: string }>;
    expect(replies).toHaveLength(1);
    expect(replies[0]!.body).toBe('Yes — refund issued today.');
    await owner.context().close();
    await admin.context().close();
  });

  test('phone: reply, add a note and create + resolve a case @mobile', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'phone layout only');
    await signIn(page, OWNER);
    const a = await api(page);
    const conv = await incoming(a, 'The café door code is not working');
    await page.goto('/inbox?queue=all');
    await page.getByRole('button', { name: new RegExp(conv.name) }).click();
    await expect(page.getByRole('heading', { name: conv.name })).toBeVisible();
    await composer(page, 'Private message').fill('Sorry! The code is 4821 today.');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Sent (simulated)').last()).toBeVisible({ timeout: 30_000 });
    await page.getByRole('radio', { name: 'Internal note' }).click();
    await composer(page, 'Internal note').fill('Door code changed this morning.');
    await page.getByRole('button', { name: 'Add note' }).click();
    await expect(page.getByText('Door code changed this morning.')).toBeVisible();

    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Customer and case' }).click();
    await page.getByRole('button', { name: 'Create case' }).click();
    await page.getByRole('dialog', { name: 'Create case' }).getByRole('button', { name: 'Create' }).click();
    await expect(page.getByText('Case created')).toBeVisible();
    await page.getByRole('button', { name: 'Resolve case' }).click();
    await page.getByRole('dialog', { name: 'Resolve case' }).getByRole('textbox').fill('Code shared');
    await page.getByRole('dialog', { name: 'Resolve case' }).getByRole('button', { name: 'Resolve' }).click();
    await expect(page.getByText('Case resolved')).toBeVisible();
    expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')).toBe(true);
  });
});
