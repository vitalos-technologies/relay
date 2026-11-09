// V3.5 stream C browser workflows (real Keycloak sign-in, real API, E2E Workspace, SIMULATED integrations only):
// hub honesty (needs app setup / not connected), add a simulated Asana install, choose a project explicitly, sync
// contract, diagnose; create an external task from a case with the outbound preview (no customer messages leave Relay);
// translation off until enabled with the billing acknowledgement, then a labelled machine translation with the original
// kept; the Slack link page refuses an invalid token; the phone hub (@mobile).
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { api, demoBrand, signIn, type Api } from './helpers';

const OWNER = 'owner@demo.social-lite.test';
const PAGE_NAME = 'E2E Integrations Page (simulated)';

async function caseConversation(a: Api): Promise<{ name: string; id: string }> {
  const brand = await demoBrand(a, /Vitalos/);
  const existing = (await a.get('/api/inbox/channels')).body.items as Array<{ id: string; display_name: string }>;
  let ch = existing.find((c) => c.display_name === PAGE_NAME)?.id;
  if (!ch) {
    const conn = await a.send('POST', `/api/brands/${brand.id}/connections/mock`, { provider: 'facebook', display_name: PAGE_NAME });
    ch = (await a.send('POST', '/api/inbox/channels', { connection_id: conn.body.id })).body.id;
  }
  const name = `Dana ${randomUUID().slice(0, 6)}`;
  expect((await a.send('POST', `/api/inbox/channels/${ch}/simulate`, { kind: 'dm', name, text: 'My parcel arrived damaged, order 7781.' })).status).toBe(200);
  const conv = (await a.get(`/api/inbox/conversations?queue=all&q=${encodeURIComponent(name)}`)).body.items[0];
  expect((await a.send('POST', '/api/inbox/cases', { conversation_id: conv.id, title: 'Damaged parcel' })).status).toBe(200);
  return { name, id: conv.id };
}

async function ensureSimulated(page: Page, a: Api, connector: string, brandId: string | null) {
  const r = await a.send('POST', '/api/connectors/hub/simulated', { connector, brand_id: brandId });
  expect(r.status).toBe(200);
  return r.body.id as string;
}

test.describe('Integrations', () => {
  test.describe.configure({ timeout: 240_000 });

  test('hub honesty, simulated Asana install, explicit project choice, sync contract, diagnose', async ({ page }) => {
    await signIn(page, OWNER);
    await page.goto('/integrations');
    const hub = page.getByTestId('integrations-hub');
    await expect(hub.getByTestId('hub-asana')).toBeVisible();
    for (const n of ['monday.com', 'HubSpot', 'Google Business Profile', 'Google Cloud Translation', 'Slack', 'Mailchimp']) await expect(hub.getByText(n, { exact: true })).toBeVisible();
    await hub.getByRole('link', { name: 'Asana' }).click();
    await expect(page).toHaveURL(/\/integrations\/asana/);
    // No operator credentials in this environment: Connect is honest about it.
    await expect(page.getByText('Needs app setup').first()).toBeVisible();
    await page.getByRole('button', { name: 'Add simulated' }).click();
    const inst = page.getByTestId('installation');
    await expect(inst.getByText('Simulated').first()).toBeVisible();
    await page.getByRole('button', { name: 'Choose' }).click();
    await page.getByLabel('Customer care follow-ups').check();
    await page.getByRole('button', { name: 'Save selection' }).click();
    await expect(page.getByTestId('selected-resources').getByText('Customer care follow-ups')).toBeVisible();
    await page.getByRole('tab', { name: 'Sync rules' }).click();
    await expect(page.getByRole('cell', { name: 'Approval / publishing' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Never synced' }).first()).toBeVisible();
    await inst.getByRole('button', { name: 'Diagnose' }).click();
    await expect(page.getByText(/Connected as/).first()).toBeVisible();
  });

  test('external task from a case: preview shows what leaves Relay; customer messages excluded', async ({ page }) => {
    await signIn(page, OWNER);
    const a = await api(page);
    const brand = await demoBrand(a, /Vitalos/);
    const asana = await ensureSimulated(page, a, 'asana', brand.id);
    const found = await a.get(`/api/connectors/hub/${asana}/discover?type=project`);
    await a.send('PUT', `/api/connectors/${asana}/resources`, { resources: found.body.items.map((r: { resource_type: string; external_id: string; name: string; url: string | null }) => ({ ...r, selected: true })) });
    const conv = await caseConversation(a);
    await page.goto(`/inbox?queue=all&c=${conv.id}`);
    if ((page.viewportSize()?.width ?? 1440) < 1536) { await page.getByRole('button', { name: 'More actions' }).click(); await page.getByRole('menuitem', { name: 'Customer and case' }).click(); }
    await page.getByRole('button', { name: 'Create task' }).click();
    const dlg = page.getByRole('dialog', { name: 'Create task' });
    await dlg.getByLabel('Title').fill('Replace damaged parcel 7781');
    await dlg.getByRole('button', { name: 'Review' }).click();
    const preview = dlg.getByTestId('outbound-preview');
    await expect(preview).toContainText('Not sent: Customer messages');
    await expect(preview.getByLabel('Description')).not.toHaveValue(/arrived damaged/);
    await dlg.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByTestId('external-task').filter({ hasText: 'Replace damaged parcel 7781' })).toBeVisible();
  });

  test('translation: off until enabled with billing acknowledged; labelled; original kept; nothing sent', async ({ page }) => {
    await signIn(page, OWNER);
    const a = await api(page);
    await ensureSimulated(page, a, 'google_translate', null);
    await a.send('PUT', '/api/connectors/translate/settings', { enabled: false, allow_customer_content: false, monthly_char_cap: 100000, glossary_id: null });
    await page.goto('/integrations/google-translate');
    await page.getByRole('tab', { name: 'Settings' }).click();
    const s = page.getByTestId('translation-settings');
    await expect(s.getByText('Off', { exact: true })).toBeVisible();
    await s.getByRole('switch', { name: 'Allow translation in this workspace' }).click();
    await s.getByRole('switch', { name: 'Include customer messages and reply drafts' }).click();
    const ack = s.getByLabel(/billed per character/);
    if (await ack.count()) {
      await expect(s.getByRole('button', { name: 'Save' })).toBeDisabled();
      await ack.check();
    }
    await s.getByRole('button', { name: 'Save' }).click();
    await expect(s.getByText('On', { exact: true })).toBeVisible();
    const conv = await caseConversation(a);
    await page.goto(`/inbox?queue=all&c=${conv.id}`);
    if ((page.viewportSize()?.width ?? 1440) < 1536) { await page.getByRole('button', { name: 'More actions' }).click(); await page.getByRole('menuitem', { name: 'Customer and case' }).click(); }
    await page.getByRole('button', { name: 'Latest message' }).click();
    const t = page.getByTestId('translation-incoming');
    await expect(t).toContainText('Machine translated');
    await expect(t).toContainText('[Simulated →');
    await t.getByText('Original').click();
    await expect(t).toContainText('My parcel arrived damaged, order 7781.');
    const detail = (await a.get(`/api/inbox/conversations/${conv.id}`)).body;
    expect(detail.timeline.filter((e: { type: string }) => e.type === 'attempt')).toHaveLength(0);
  });

  test('Slack link page refuses an invalid token (nothing linked)', async ({ page }) => {
    await signIn(page, OWNER);
    await page.goto('/integrations/link/slack?t=not-a-real-token-123');
    await page.getByRole('button', { name: 'Link' }).click();
    await expect(page.getByText('Not linked')).toBeVisible();
  });

  test('phone: hub and an integration are usable without horizontal scroll @mobile', async ({ page }) => {
    await signIn(page, OWNER);
    await page.goto('/integrations');
    await expect(page.getByTestId('hub-slack')).toBeVisible();
    expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')).toBe(true);
    await page.getByTestId('integrations-hub').getByRole('link', { name: 'Slack' }).click();
    await expect(page.getByRole('link', { name: 'Business apps' }).first()).toBeVisible();
    expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')).toBe(true);
  });
});
