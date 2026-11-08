// V3.5 stream F browser workflows (real Keycloak sign-in, real API, production build, SIMULATED channels only):
//  - Admin → Inbox, listening and AI: every page renders from the owning stream's service, numbers match the app's own
//    APIs (AT14 consistency), and no customer text ever reaches the admin app;
//  - the integrations hub honesty after the lead review (one neutral "Simulated" badge, status under the name);
//  - phone (@mobile): translate a customer message, see an integration that needs reconnecting, and admin overview at 390 px.
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { api, demoBrand, signIn, type Api } from './helpers';

const OWNER = 'owner@demo.social-lite.test';
const PAGE_NAME = 'E2E Final Page (simulated)';

async function channel(a: Api): Promise<string> {
  const brand = await demoBrand(a, /Vitalos/);
  const existing = (await a.get('/api/inbox/channels')).body.items as Array<{ id: string; display_name: string }>;
  const found = existing.find((c) => c.display_name === PAGE_NAME)?.id;
  if (found) return found;
  const conn = await a.send('POST', `/api/brands/${brand.id}/connections/mock`, { provider: 'facebook', display_name: PAGE_NAME });
  return (await a.send('POST', '/api/inbox/channels', { connection_id: conn.body.id })).body.id;
}

const noScroll = 'document.documentElement.scrollWidth <= window.innerWidth + 1';

test.describe('V3.5 admin + final', () => {
  test.describe.configure({ timeout: 240_000 });

  test('admin: inbox, integrations, listening and AI pages show counts that match the app — never customer text', async ({ page }) => {
    await signIn(page, OWNER);
    const a = await api(page);
    const ch = await channel(a);
    const secret = `PRIVATE-${randomUUID().slice(0, 8)} my card number is in this message`;
    expect((await a.send('POST', `/api/inbox/channels/${ch}/simulate`, { kind: 'dm', name: `Erin ${randomUUID().slice(0, 4)}`, text: secret })).status).toBe(200);

    const care = (await a.get('/api/admin/care')).body;
    const inbox = (await a.get('/api/admin/inbox')).body;
    expect(care.inbox.backlog).toEqual(inbox.backlog);          // same service, same numbers
    expect(care.inbox.backlog.unanswered).toBeGreaterThan(0);
    expect(JSON.stringify(care)).not.toContain('PRIVATE-');

    await page.goto('/admin/care');
    const root = page.getByTestId('care-admin');
    await expect(page.getByRole('heading', { name: 'Inbox, listening and AI' })).toBeVisible();
    await expect(root.getByRole('link', { name: /Waiting for a reply/ })).toContainText(String(care.inbox.backlog.unanswered));
    for (const label of ['Failed replies (24 h)', 'Service-level breaches', 'Sync problems (24 h)', 'AI budget used', 'Automation problems (24 h)']) await expect(root.getByText(label)).toBeVisible();
    await expect(page.getByText('PRIVATE-')).toHaveCount(0);

    for (const [href, heading] of [['/admin/inbox', 'Inbox health'], ['/admin/integrations', 'Integrations and sync'], ['/admin/listening', 'Listening coverage'], ['/admin/ai', 'AI and automation']] as const) {
      await page.goto(href);
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await expect(page.getByText('PRIVATE-')).toHaveCount(0);
    }
    // The audit log has an "Inbox and AI" category.
    await page.goto('/admin/security/audit?category=care');
    await expect(page.getByRole('radio', { name: 'Inbox and AI' })).toBeChecked();
  });

  test('integrations hub: simulated installs carry one neutral “Simulated” badge on its own line', async ({ page }) => {
    await signIn(page, OWNER);
    const a = await api(page);
    expect((await a.send('POST', '/api/connectors/hub/simulated', { connector: 'monday', brand_id: null })).status).toBe(200);
    await page.goto('/integrations');
    const card = page.getByTestId('hub-monday');
    const status = card.getByTestId('hub-status');
    await expect(status).toBeVisible();
    const hub = (await a.get('/api/connectors/hub')).body.connectors.find((c: { connector: string }) => c.connector === 'monday');
    const live = hub.installations.filter((i: { disconnected_at: string | null; is_simulated: boolean }) => !i.disconnected_at && !i.is_simulated);
    if (!live.length) {
      await expect(status).toHaveText('Simulated');
      await expect(card.getByText('Connected')).toHaveCount(0);
    }
  });

  test('phone: translate a customer message, spot an integration that needs reconnecting, admin overview @mobile', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'phone layout');
    await signIn(page, OWNER);
    const a = await api(page);
    // Translation (simulated provider) for customer content, enabled with the billing acknowledgement.
    await a.send('POST', '/api/connectors/hub/simulated', { connector: 'google_translate', brand_id: null });
    expect((await a.send('PUT', '/api/connectors/translate/settings', { enabled: true, allow_customer_content: true, monthly_char_cap: 100000, glossary_id: null, acknowledge_billing: true })).status).toBe(200);
    const ch = await channel(a);
    const name = `Rui ${randomUUID().slice(0, 6)}`;
    await a.send('POST', `/api/inbox/channels/${ch}/simulate`, { kind: 'dm', name, text: 'Olá, a minha encomenda chegou danificada.' });
    const conv = (await a.get(`/api/inbox/conversations?queue=all&q=${encodeURIComponent(name)}`)).body.items[0];
    await page.goto(`/inbox?queue=all&c=${conv.id}`);
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Customer and case' }).click();
    await page.getByRole('button', { name: 'Latest message' }).click();
    await expect(page.getByTestId('translation-incoming')).toContainText('Machine translated');
    await expect(page.getByTestId('translation-incoming')).toContainText('[Simulated →');
    expect(await page.evaluate(noScroll)).toBe(true);

    // An installation whose access was revoked shows "Reconnect" (the OAuth step itself needs live credentials).
    const id = (await a.send('POST', '/api/connectors/hub/simulated', { connector: 'asana', brand_id: null })).body.id as string;
    await a.send('PUT', `/api/connectors/hub/${id}/scenario`, { scenario: 'revoked' });
    await a.send('POST', `/api/connectors/hub/${id}/diagnose`);
    await page.goto('/integrations');
    await expect(page.getByTestId('hub-asana').getByTestId('hub-status')).toContainText(/Reconnect|Needs attention/);
    expect(await page.evaluate(noScroll)).toBe(true);
    await a.send('PUT', `/api/connectors/hub/${id}/scenario`, { scenario: 'success' });
    await a.send('POST', `/api/connectors/hub/${id}/diagnose`);

    await page.goto('/admin/care');
    await expect(page.getByRole('heading', { name: 'Inbox, listening and AI' })).toBeVisible();
    expect(await page.evaluate(noScroll)).toBe(true);
  });
});
