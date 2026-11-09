// V3.5 stream B browser workflows (real sign-in, real API, E2E Workspace, SIMULATED accounts only). These run in the web
// process (no worker needed): add channels per network (needs-approval networks shown honestly), Google review →
// inbox item with rating + public-reply-only composer, moderation (hide a comment), identity link/unlink with history,
// @mentions in internal notes, saved views, WhatsApp template charge notice, Telegram "never overwrite" dialog, phone.
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { api, demoBrand, signIn, type Api } from './helpers';

const OWNER = 'owner@demo.social-lite.test';
const tag = () => randomUUID().slice(0, 6);

async function simulatedChannel(a: Api, provider: 'instagram' | 'youtube' | 'telegram', name: string): Promise<string> {
  const existing = (await a.get('/api/inbox/channels')).body.items as Array<{ id: string; display_name: string }>;
  const found = existing.find((c) => c.display_name === name);
  if (found) return found.id;
  const brand = await demoBrand(a, /Vitalos/);
  const conn = await a.send('POST', `/api/brands/${brand.id}/connections/mock`, { provider, display_name: name });
  expect(conn.status).toBe(200);
  const ch = await a.send('POST', '/api/inbox/channels', { connection_id: conn.body.id });
  expect(ch.status).toBe(200);
  return ch.body.id;
}

async function integrationChannel(a: Api, connector: 'whatsapp' | 'google_business_profile'): Promise<string> {
  const brand = await demoBrand(a, /Vitalos/);
  const existing = (await a.get('/api/inbox/channels')).body.items as Array<{ id: string; kind: string; is_simulated: boolean; brand_id: string }>;
  const found = existing.find((c) => c.kind === connector && c.is_simulated && c.brand_id === brand.id);
  if (found) return found.id;
  const i = await a.send('POST', '/api/connectors', { connector, brand_id: brand.id });
  expect(i.status).toBe(200);
  const acc = await a.get(`/api/inbox/integrations/${i.body.id}/accounts`);
  expect(acc.status).toBe(200);
  const ch = await a.send('POST', '/api/inbox/channels/integration', { integration_id: i.body.id, account_id: acc.body.items[0].account_id });
  expect(ch.status).toBe(200);
  if (connector === 'whatsapp') expect((await a.send('POST', `/api/inbox/channels/${ch.body.id}/templates`, {})).status).toBe(200);
  return ch.body.id;
}

async function open(page: Page, name: string) {
  await page.goto(`/inbox?queue=all&q=${encodeURIComponent(name)}`);
  await page.getByRole('button', { name: new RegExp(name) }).first().click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

test.describe('Inbox — remaining networks', () => {
  test.describe.configure({ timeout: 240_000 });

  test('Add channel: networks with honest states; X needs approval; a simulated Instagram account is added', async ({ page }) => {
    await signIn(page, OWNER);
    await page.goto('/settings/inbox/channels');
    await page.getByRole('button', { name: 'Add channel' }).first().click();
    const d = page.getByRole('dialog', { name: 'Add channel' });
    await expect(d.getByRole('button', { name: /WhatsApp/ })).toBeVisible();
    await d.getByRole('button', { name: /^X/ }).click();
    await expect(page.getByRole('dialog', { name: 'Add X' }).getByText('Not available in Relay yet')).toBeVisible();
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByRole('dialog', { name: 'Add channel' }).getByRole('button', { name: /Instagram/ }).click();
    const ig = page.getByRole('dialog', { name: 'Add Instagram' });
    await ig.getByRole('button', { name: 'Use a simulated account' }).click();
    await expect(page.getByText('Channel added')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByText('Instagram (simulated)').first()).toBeVisible();
    await expect(page.getByText('Built and testable with simulated accounts', { exact: false })).toBeVisible();
  });

  test('Google review → inbox item with its rating; only a public owner reply is offered; identity link/unlink', async ({ page }) => {
    await signIn(page, OWNER);
    const a = await api(page);
    const ch = await integrationChannel(a, 'google_business_profile');
    const name = `Rita ${tag()}`;
    expect((await a.send('POST', `/api/inbox/channels/${ch}/simulate`, { kind: 'review', name, text: 'Lovely staff, cold flat white.', rating: 3 })).status).toBe(200);
    await open(page, name);
    await expect(page.getByLabel('3 out of 5 stars')).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Public reply' })).toBeChecked();
    await expect(page.getByRole('radio', { name: 'Private message' })).toHaveCount(0);
    // An authorized owner reply goes through the worker to the review's own location (AT4); the provider result is shown.
    await page.getByPlaceholder('Write a reply…').fill('Thanks Rita — we have fixed the milk steamer.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Sent (simulated)').last()).toBeVisible({ timeout: 60_000 });

    // Identity linking: explicit, with a reason; unlink keeps history.
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Customer and case' }).click();
    const panel = page.getByRole('dialog', { name: 'Customer and case' });
    await panel.getByRole('button', { name: 'Link to customer' }).click();
    const link = page.getByRole('dialog', { name: 'Link to a customer' });
    await link.getByRole('radio', { name: 'New customer' }).click();
    await link.getByLabel('Customer name').fill(`${name} (customer)`);
    await link.getByLabel('How did you confirm it is the same person?').fill('Receipt number in the review');
    await link.getByRole('button', { name: 'Link' }).click();
    await expect(panel.getByText(`${name} (customer)`).first()).toBeVisible();
    await panel.getByRole('button', { name: 'Unlink' }).click();
    await page.getByRole('dialog', { name: 'Unlink identity' }).getByLabel('Reason').fill('Wrong person');
    await page.getByRole('dialog', { name: 'Unlink identity' }).getByRole('button', { name: 'Unlink' }).click();
    await expect(panel.getByText('Not linked')).toBeVisible();
    await panel.getByText(/Link history/).click();
    await expect(panel.getByText(/Unlinked from .* Wrong person/)).toBeVisible();
  });

  test('moderation hides a comment; @mention in a note; saved view', async ({ page }) => {
    await signIn(page, OWNER);
    const a = await api(page);
    const ch = await simulatedChannel(a, 'instagram', 'E2E Instagram (simulated)');
    const name = `Dan ${tag()}`;
    expect((await a.send('POST', `/api/inbox/channels/${ch}/simulate`, { kind: 'comment', name, text: 'Spammy link here' })).status).toBe(200);
    const conv = (await a.get(`/api/inbox/conversations?queue=all&q=${encodeURIComponent('Spammy link here')}`)).body.items[0];
    await page.goto(`/inbox?queue=all&c=${conv.id}`);
    const tl = page.getByRole('list', { name: 'Conversation' });
    await tl.getByRole('button', { name: 'Moderate this message' }).first().click();
    await page.getByRole('menuitem', { name: /Hide on Instagram/ }).click();
    await expect(tl.getByText('Hidden')).toBeVisible();

    await page.getByRole('radio', { name: 'Internal note' }).click();
    const box = page.getByPlaceholder(/Note for your team/);
    await box.fill('Looping in @');
    const opt = page.getByRole('listbox', { name: 'Mention a teammate' }).getByRole('option').first();
    await expect(opt).toBeVisible();
    const label = (await opt.textContent())!.slice(1);
    await opt.click();
    await expect(box).toHaveValue(`Looping in @${label} `);
    await page.getByRole('button', { name: 'Add note' }).click();
    await expect(page.getByText('Note added')).toBeVisible();

    // Saved view: filter comments, save, clear, re-apply.
    await page.goto('/inbox?queue=all&kind=comment');
    await page.getByRole('button', { name: 'Save current filters as a view' }).click();
    const viewName = `Comments ${tag()}`;
    await page.getByRole('dialog', { name: 'Save view' }).getByLabel('Name').fill(viewName);
    await page.getByRole('dialog', { name: 'Save view' }).getByRole('button', { name: 'Save' }).click();
    await page.goto('/inbox');
    await page.getByRole('button', { name: viewName, exact: true }).click();
    await expect(page).toHaveURL(/kind=comment/);
  });

  test('WhatsApp: outside the 24 h window only a template, with the charge shown before sending', async ({ page }) => {
    await signIn(page, OWNER);
    const a = await api(page);
    const ch = await integrationChannel(a, 'whatsapp');
    const name = `Wes ${tag()}`;
    expect((await a.send('POST', `/api/inbox/channels/${ch}/simulate`, { kind: 'dm', name, text: 'Any update?', minutes_ago: 26 * 60 })).status).toBe(200);
    await open(page, name);
    await expect(page.getByText(/Send an approved template instead/).first()).toBeVisible();
    await page.getByRole('button', { name: 'Template', exact: true }).click();
    const d = page.getByRole('dialog', { name: 'Send a WhatsApp template' });
    await d.getByLabel('Template').selectOption({ label: 'we_miss_you · en · marketing' });
    await d.getByLabel(/^Value 1/).fill('Wes');
    await expect(d.getByText('Hi Wes, it has been a while.', { exact: false })).toBeVisible();
    await expect(d.getByText('This message is charged', { exact: true })).toBeVisible();
    await expect(d.getByRole('button', { name: 'Send (charged)' })).toHaveAttribute('aria-disabled', 'true');
    await d.getByLabel('I understand this message is charged').check();
    await expect(d.getByRole('button', { name: 'Send (charged)' })).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('WhatsApp: a utility template inside the 24 h window is charged (Meta, since 2026-10-01) and needs the acknowledgement (H2)', async ({ page }) => {
    await signIn(page, OWNER);
    const a = await api(page);
    const ch = await integrationChannel(a, 'whatsapp');
    const name = `Uma ${tag()}`;
    expect((await a.send('POST', `/api/inbox/channels/${ch}/simulate`, { kind: 'dm', name, text: 'Order status?' })).status).toBe(200);
    await open(page, name);
    await page.getByRole('button', { name: 'Template', exact: true }).click();
    const d = page.getByRole('dialog', { name: 'Send a WhatsApp template' });
    await d.getByLabel('Template').selectOption({ label: 'order_update · en · utility' });
    await d.getByLabel(/^Value 1/).fill('Uma');
    await d.getByLabel(/^Value 2/).fill('#7');
    await expect(d.getByText('This message is charged', { exact: true })).toBeVisible();
    await expect(d.getByText(/utility rate/)).toBeVisible();
    await expect(d.getByRole('button', { name: 'Send (charged)' })).toHaveAttribute('aria-disabled', 'true');
    await d.getByLabel('I understand this message is charged').check();
    await expect(d.getByRole('button', { name: 'Send (charged)' })).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('phone: Google review, internal note with mention and Add channel dialog fit 390 px @mobile', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'phone layout only');
    await signIn(page, OWNER);
    const a = await api(page);
    const ch = await integrationChannel(a, 'google_business_profile');
    const name = `Sol ${tag()}`;
    await a.send('POST', `/api/inbox/channels/${ch}/simulate`, { kind: 'review', name, text: 'Perfect espresso.', rating: 5 });
    await open(page, name);
    await expect(page.getByLabel('5 out of 5 stars')).toBeVisible();
    await page.getByRole('radio', { name: 'Internal note' }).click();
    await page.getByPlaceholder(/Note for your team/).fill('Share with the barista team');
    await page.getByRole('button', { name: 'Add note' }).click();
    await expect(page.getByText('Note added')).toBeVisible();
    expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')).toBe(true);
    await page.goto('/settings/inbox/channels');
    await page.getByRole('button', { name: 'Add channel' }).first().click();
    await expect(page.getByRole('dialog', { name: 'Add channel' })).toBeVisible();
    expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')).toBe(true);
  });
});
