// V3.1 UI browser workflows (real Keycloak sign-in, real API + worker, simulated destinations only, E2E Workspace):
// autosave + conflict + recovery, trash restore, bulk partial failure + retry, Cmd+K search, a mandatory brand rule
// blocking Schedule, and the onboarding checklist (seeded empty "E2E Onboarding" workspace).
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { api, demoBrand, signIn, type Api } from './helpers';

const OWNER = 'owner@demo.social-lite.test';
const SEEDED_TG = /^Vitalos Telegram \(simulated\)$/;

async function setup(page: Page) {
  await signIn(page, OWNER);
  const a = await api(page);
  const brand = await demoBrand(a, /Vitalos/);
  const conns = (await a.get(`/api/brands/${brand.id}/connections`)).body.items;
  const tg = conns.find((c: any) => SEEDED_TG.test(c.display_name) && c.status === 'ready');
  expect(tg, 'seeded Telegram destination').toBeTruthy();
  return { a, brand, tg };
}

async function draft(a: Api, brandId: string, connId: string, title: string, text: string): Promise<{ id: string; version: number }> {
  const r = await a.send('POST', `/api/brands/${brandId}/posts`, { title, draft: { baseText: text, baseLink: null, baseAssetIds: [], variants: [{ connectionId: connId, inheritText: true, inheritMedia: true }] } });
  expect([200, 201], JSON.stringify(r.body).slice(0, 300)).toContain(r.status);
  return { id: r.body.id, version: r.body.version };
}

const textBox = (page: Page) => page.getByRole('textbox', { name: 'Text', exact: true });

test.describe('V3.1 UI', () => {
  test.describe.configure({ timeout: 180_000 });
  test('autosave: Saved only after the server ack, conflict shows yours vs server, recovery restores a browser copy', async ({ page }) => {
    const { a, brand, tg } = await setup(page);
    const tag = randomUUID().slice(0, 6);
    const p = await draft(a, brand.id, tg.id, `Autosave ${tag}`, `Autosave base ${tag}`);
    await page.goto(`/posts/${p.id}`);
    const status = page.getByTestId('save-status');

    // Typing → debounced PUT /autosave → "Saved" (with the server's version).
    const saved = page.waitForResponse((r) => r.url().includes(`/api/posts/${p.id}/autosave`) && r.request().method() === 'PUT' && r.status() === 200);
    await textBox(page).fill(`Autosave edited ${tag}`);
    await saved;
    await expect(status).toHaveAttribute('data-save-state', 'saved');
    expect((await a.get(`/api/posts/${p.id}`)).body.draft.baseText).toBe(`Autosave edited ${tag}`);

    // Another client saves first; this tab's next save gets 409 → conflict dialog with both copies.
    const cur = (await a.get(`/api/posts/${p.id}`)).body;
    const theirs = `Server copy ${tag}`;
    const other = await a.send('PUT', `/api/posts/${p.id}/autosave`, { base_version: cur.version, client_id: `e2eother_${tag}`, client_revision: 1, draft: { ...cur.draft, baseText: theirs } });
    expect(other.status).toBe(200);
    await textBox(page).fill(`Mine ${tag}`);
    // (Collaboration stream: the dialog now compares field by field; discarding yours is an explicit two-step choice.)
    const dialog = page.getByRole('dialog', { name: 'Someone else saved a newer version' });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(status).toHaveAttribute('data-save-state', 'conflict');
    await expect(dialog.getByTestId('conflict-compare')).toContainText('Mine');
    await expect(dialog.getByTestId('conflict-compare')).toContainText('Server copy');
    await dialog.getByRole('button', { name: 'Discard mine…' }).click();
    await dialog.getByRole('button', { name: 'Discard my changes' }).click();
    await expect(textBox(page)).toHaveValue(theirs);

    // A copy left in this browser (refresh/restart) is offered, re-checked by the server, and restored on request.
    const s = (await a.get('/api/session')).body;
    expect(s.draft_recovery?.local_recovery).toBe('persistent');
    const v = (await a.get(`/api/posts/${p.id}`)).body.version;
    const recovered = `Recovered from this browser ${tag}`;
    await page.evaluate(([k, val]: string[]) => localStorage.setItem(k!, val!), [`${s.draft_recovery.namespace}:${p.id}`,
      JSON.stringify({ base_version: v, title: `Autosave ${tag}`, saved_at: new Date().toISOString(), draft: { baseText: recovered, baseLink: null, baseAssetIds: [], variants: [{ connectionId: tg.id, inheritText: true, inheritMedia: true }] } })]);
    await page.goto(`/posts/${p.id}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Unsaved changes found')).toBeVisible();
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(textBox(page)).toHaveValue(recovered);
    await expect.poll(async () => (await a.get(`/api/posts/${p.id}`)).body.draft.baseText).toBe(recovered);
    // Recovery never schedules anything.
    expect((await a.get(`/api/posts/${p.id}`)).body.status).toBe('draft');
  });

  test('trash: consequences before deleting, restore from /trash brings back a draft', async ({ page }) => {
    const { a, brand, tg } = await setup(page);
    const tag = randomUUID().slice(0, 6);
    const p = await draft(a, brand.id, tg.id, `Trash me ${tag}`, `Trash test ${tag}`);
    await page.goto(`/posts/${p.id}`);
    await page.getByRole('button', { name: 'More post actions' }).click();
    await page.getByRole('menuitem', { name: 'Move to Trash' }).click();
    const dlg = page.getByRole('dialog', { name: 'Move post to Trash?' });
    await expect(dlg.getByTestId('trash-consequences')).toContainText('Nothing on social networks is deleted');
    await dlg.getByRole('button', { name: 'Move to Trash' }).click();
    await page.waitForURL(/\/planner/);
    await expect(page.getByText('Moved to Trash')).toBeVisible();
    expect((await a.get(`/api/posts/${p.id}`)).status).toBe(404);

    await page.goto('/trash?kind=post');
    const row = page.getByTestId(`trash-${p.id}`);
    await expect(row).toContainText('30 days left');
    await row.getByRole('button', { name: 'Restore' }).click();
    await page.getByRole('dialog', { name: 'Restore as a draft?' }).getByRole('button', { name: 'Restore' }).click();
    await expect(row).toHaveCount(0);
    const back = await a.get(`/api/posts/${p.id}`);
    expect(back.status).toBe(200);
    expect(back.body.status).toBe('draft');
  });

  test('bulk: partial failure is shown per item and only the failed item is retried', async ({ page }) => {
    const { a, brand, tg } = await setup(page);
    const tag = randomUUID().slice(0, 6);
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      const p = await draft(a, brand.id, tg.id, `Bulk ${tag} ${n}`, `Bulk ${tag} ${n}`);
      expect((await a.send('POST', '/api/trash/items', { kind: 'post', id: p.id })).status).toBe(200);
      ids.push(p.id);
    }
    await page.goto('/trash?kind=post');
    for (const n of [1, 2, 3]) await page.getByRole('checkbox', { name: `Select Bulk ${tag} ${n}` }).check();
    await page.getByRole('region', { name: 'Bulk actions' }).getByRole('button', { name: 'Restore' }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByTestId('bulk-preview')).toContainText('3 will change');

    // The job is durable and runs in the worker. Right after it is accepted (before the worker picks it up), item 2 is
    // restored elsewhere, so the job's own restore of item 2 fails on its own — the other two succeed.
    await page.route('**/api/bulk/jobs', async (route) => {
      const res = await route.fetch();
      if (route.request().method() === 'POST') await a.send('POST', '/api/trash/restore', { kind: 'post', id: ids[1] });
      await route.fulfill({ response: res });
    });
    await sheet.getByRole('button', { name: /^Restore 3$/ }).click();
    const job = sheet.getByTestId('bulk-job');
    await expect(job).toHaveAttribute('data-status', 'completed_with_errors', { timeout: 30_000 });
    await expect(job).toContainText('2 done');
    await expect(job).toContainText('1 failed');
    await expect(job.locator('[data-item-status=failed]')).toHaveCount(1);
    await page.unroute('**/api/bulk/jobs');

    // Put item 2 back in Trash so the retry can succeed; successes are never re-run.
    expect((await a.send('POST', '/api/trash/items', { kind: 'post', id: ids[1] })).status).toBe(200);
    await job.getByRole('button', { name: /^Retry 1 failed/ }).click();
    await expect(job).toHaveAttribute('data-status', 'completed', { timeout: 30_000 });
    await expect(job).toContainText('3 done');
    for (const id of ids) expect((await a.get(`/api/posts/${id}`)).status).toBe(200);
  });

  test('Cmd/Ctrl+K: keyboard search opens an authorized result and records it as recent', async ({ page }) => {
    const { a, brand, tg } = await setup(page);
    const word = `zephyr${randomUUID().slice(0, 6)}`;
    const p = await draft(a, brand.id, tg.id, `Search ${word}`, `Findable ${word} text`);
    await page.goto('/overview');
    await expect(page.getByRole('button', { name: 'Search' })).toBeVisible();
    await page.keyboard.press('Control+k');
    const box = page.getByRole('combobox', { name: /Search posts/ });
    await expect(box).toBeFocused();
    await box.fill(word);
    await expect(page.getByRole('option', { name: new RegExp(`Search ${word}`) })).toBeVisible();
    await expect(box).toHaveAttribute('aria-activedescendant', 'cmdk-0');
    await page.keyboard.press('Enter');
    await page.waitForURL(new RegExp(`/posts/${p.id}`));
    // Recent items (re-authorized server-side) show next time the menu opens.
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('option', { name: new RegExp(`Search ${word}`) })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(box).toBeHidden();
  });

  test('a mandatory brand rule blocks Schedule with the reason; the server refuses too', async ({ page }) => {
    const { a, brand, tg } = await setup(page);
    const phrase = `sure win ${randomUUID().slice(0, 4)}`;
    const rule = await a.send('POST', `/api/brands/${brand.id}/rules`, { kind: 'prohibited_phrase', value: phrase, severity: 'mandatory', providers: [] });
    expect([200, 201], JSON.stringify(rule.body).slice(0, 300)).toContain(rule.status);
    try {
      const p = await draft(a, brand.id, tg.id, 'Rule check', `A ${phrase} for everyone`);
      await page.goto(`/posts/${p.id}`);
      await expect(page.getByTestId('brand-findings')).toContainText(phrase, { timeout: 20_000 });
      await expect(page.getByTestId('brand-findings').locator('[data-severity=mandatory]')).toHaveCount(1);
      const schedule = page.getByRole('button', { name: /^Schedule/ });
      await expect(schedule).toHaveAttribute('aria-disabled', 'true');
      await expect(schedule).toContainText(/unavailable: Brand rule: /);
      const when = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
      const refused = await a.send('POST', `/api/posts/${p.id}/schedule`, { expected_version: p.version, connection_ids: [tg.id], input_local_time: `${when}T10:00`, timezone: 'Europe/London' });
      expect(refused.status).toBe(422);
      expect(refused.body.error.details.reason).toBe('brand_rules');
    } finally {
      await a.send('DELETE', `/api/brand-rules/${rule.body.rule.id}`);
    }
  });

  test('onboarding checklist in a new workspace: progress, role-adapted next step, readiness, hide and resume', async ({ page }) => {
    await signIn(page, OWNER);
    let a = await api(page);
    const s = (await a.get('/api/session')).body;
    const target = s.workspaces.find((w: any) => w.name === 'E2E Onboarding');
    expect(target, 'seeded by pnpm db:seed:e2e').toBeTruthy();
    await page.goto('/api/session');
    expect((await a.send('POST', '/api/session/workspace', { workspace_id: target.id })).status).toBeLessThan(300);
    await page.goto('/overview');
    a = await api(page);
    expect((await a.send('PUT', '/api/feature-flags/v31.onboarding_checklist', { enabled: true })).status).toBe(200);
    await a.send('PATCH', '/api/onboarding', { dismissed: false });
    await a.send('PATCH', '/api/onboarding', { unacknowledge: 'brand_defaults' });
    await page.reload();

    const card = page.getByTestId('onboarding');
    await expect(card).toBeVisible();
    await expect(card).toContainText(/\d of 7 done/);
    await expect(card.locator('[data-step=brand][data-status=done]')).toHaveCount(1);
    await expect(card.locator('[data-step=connect_destination][data-status=todo]')).toContainText('Connect an account');
    await card.locator('[data-step=brand_defaults]').getByRole('button', { name: 'Mark reviewed' }).click();
    await expect(card.locator('[data-step=brand_defaults]')).toHaveAttribute('data-status', 'done');

    await card.getByRole('button', { name: 'Hide checklist' }).click();
    await expect(card).toBeHidden();
    await page.getByRole('button', { name: /^Setup \d\/7/ }).click();
    await expect(page.getByTestId('onboarding')).toBeVisible();
    await a.send('PATCH', '/api/onboarding', { unacknowledge: 'brand_defaults' });
  });
});
