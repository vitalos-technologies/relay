// Collaboration browser workflows (real Keycloak sign-in, real API + worker, E2E Workspace, simulated destinations only):
// two people discussing a post with live updates (no reload) + mention + notification deep link, tasks with deadlines,
// concurrent edits → conflict → apply selected changes, version comparison + restore as a new version, internal threads
// invisible to a guest + CSRF refusal, and the essential workflows on a phone (@mobile).
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { api, demoBrand, signIn, type Api } from './helpers';

const EDITOR = 'editor@demo.social-lite.test';     // Eden Editor
// Second person: Vic (workspace viewer — can read, discuss internally and be assigned tasks; stable grant across the suite).
// The approver identity is left to security.spec (its back-channel logout test expects the approver to have no other live
// identity-provider sessions).
const TEAMMATE = 'viewer@demo.social-lite.test'; // Vic Viewer
const GUEST = 'guest@demo.social-lite.test';

async function newPost(a: Api, title: string, text = `${title} — first draft text for the team.`) {
  const brand = await demoBrand(a, /Vitalos/);
  const conns = (await a.get(`/api/brands/${brand.id}/connections`)).body.items as Array<{ id: string; display_name: string; status: string }>;
  const tg = conns.find((c) => /Telegram/.test(c.display_name) && c.status === 'ready')!;
  const p = await a.send('POST', `/api/brands/${brand.id}/posts`, { title, draft: { baseText: text, baseLink: null, baseAssetIds: [], variants: [{ connectionId: tg.id, inheritText: true, inheritMedia: true }] } });
  expect([200, 201]).toContain(p.status);
  return { id: p.body.id as string, brandId: brand.id as string };
}

async function person(browser: Browser, email: string, viewport = { width: 1440, height: 900 }): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  await signIn(page, email);
  return page;
}

const panel = (p: Page) => p.getByTestId('collab-panel');

test.describe('Collaboration', () => {
  test.describe.configure({ timeout: 240_000 });

  test('two people discuss a post: mention, live update without reload, notification deep link, reply', async ({ browser }) => {
    const eden = await person(browser, EDITOR);
    const april = await person(browser, TEAMMATE);
    const a = await api(eden);
    const title = `Collab live ${randomUUID().slice(0, 6)}`;
    const { id } = await newPost(a, title);
    await eden.goto(`/posts/${id}?panel=discussion`);
    await april.goto(`/posts/${id}?panel=discussion`);
    await expect(panel(eden).getByRole('heading', { name: /No open discussions/ }).or(panel(eden).getByText('No open discussions'))).toBeVisible();
    await expect(panel(april).getByText('No open discussions')).toBeVisible();
    // Mention by keyboard: "@vic" → Enter picks Vic (identity, not text).
    const box = panel(eden).getByRole('combobox', { name: /New internal comment/ });
    await box.click();
    await box.pressSequentially('Can you check the opening line? @vic');
    await expect(eden.getByRole('option', { name: /Vic Viewer/ })).toBeVisible();
    await box.press('Enter');
    await expect(box).toHaveValue(/@Vic Viewer $/);
    const t0 = Date.now();
    await panel(eden).getByRole('button', { name: 'Comment' }).click();
    await expect(panel(eden).getByText('Can you check the opening line?')).toBeVisible();
    // The teammate's open page receives it without a reload (change stream).
    await expect(panel(april).getByText('Can you check the opening line?')).toBeVisible({ timeout: 20_000 });
    test.info().annotations.push({ type: 'sync_ms', description: String(Date.now() - t0) });
    // Her notification links to the exact thread.
    const b = await api(april);
    await expect.poll(async () => JSON.stringify((await b.get('/api/notifications?category=mentions')).body), { timeout: 30_000 }).toContain(title);
    await april.goto('/notifications?category=mentions');
    const row = april.getByRole('listitem').filter({ hasText: title }).getByRole('link', { name: /Eden Editor mentioned you/ }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    await expect(april).toHaveURL(new RegExp(`/posts/${id}\\?thread=`));
    const thread = april.locator('article[id^="thread-"]').first();
    await expect(thread).toBeFocused();
    await thread.getByRole('button', { name: 'Reply' }).click();
    await thread.getByRole('combobox', { name: 'Reply' }).fill('Looks good — shorten it a little.');
    await thread.getByRole('button', { name: 'Reply' }).last().click();
    await expect(panel(eden).getByText('Looks good — shorten it a little.')).toBeVisible({ timeout: 20_000 });
    // Commenting never approves or schedules anything.
    expect((await a.get(`/api/posts/${id}`)).body.status).toBe('draft');
    await eden.context().close(); await april.context().close();
  });

  test('tasks: assign with a deadline, see it in Tasks, complete it; the post schedule is untouched', async ({ browser }) => {
    const eden = await person(browser, EDITOR);
    const a = await api(eden);
    const { id } = await newPost(a, `Collab task ${randomUUID().slice(0, 6)}`);
    await eden.goto(`/posts/${id}?panel=tasks`);
    await panel(eden).getByRole('button', { name: 'New task' }).click();
    await panel(eden).getByRole('textbox', { name: 'Task', exact: true }).fill('Shorten caption');
    await panel(eden).getByLabel('Search people to assign').fill('Vic');
    const assignee = panel(eden).locator('form').getByRole('combobox', { name: /^Assignee/ });
    const opt = assignee.locator('option', { hasText: 'Vic' }).first();
    await expect(opt).toBeAttached();
    await assignee.selectOption((await opt.getAttribute('value'))!);
    await panel(eden).getByLabel('Deadline').fill('2031-05-01T10:00');
    await panel(eden).getByRole('button', { name: 'Create task' }).click();
    await expect(panel(eden).getByTestId('task-row').filter({ hasText: 'Shorten caption' })).toBeVisible();
    const april = await person(browser, TEAMMATE);
    await april.goto('/tasks');
    const row = april.getByTestId('task-row').filter({ hasText: 'Shorten caption' }).first();
    await expect(row).toBeVisible();
    await row.click();
    await april.getByRole('button', { name: 'Mark done' }).click();
    await expect(april.getByRole('dialog').getByText('Done', { exact: true }).first()).toBeVisible();
    const detail = (await a.get(`/api/posts/${id}`)).body;
    expect(detail.current_schedule).toBeNull();
    await eden.context().close(); await april.context().close();
  });

  test('concurrent edits: conflict dialog, apply selected changes to the latest version; history compare + restore as new version', async ({ browser }) => {
    const eden = await person(browser, EDITOR);
    const a = await api(eden);
    const { id } = await newPost(a, `Collab conflict ${randomUUID().slice(0, 6)}`, 'Original line.');
    await eden.goto(`/posts/${id}`);
    const editor = eden.locator('textarea[data-anchor-field="base"]');
    await expect(editor).toHaveValue('Original line.');
    // Someone else (another tab) saves first.
    const p = (await a.get(`/api/posts/${id}`)).body;
    const other = await a.send('PUT', `/api/posts/${id}/autosave`, { base_version: p.version, client_id: `othertab_${randomUUID().slice(0, 8)}`, client_revision: 1, draft: { ...p.draft, baseText: 'Original line.', baseLink: 'https://example.com/theirs' } });
    expect(other.status).toBe(200);
    await editor.click(); await editor.press('End'); await editor.pressSequentially(' My addition.');
    const dlg = eden.getByRole('dialog', { name: 'Someone else saved a newer version' });
    await expect(dlg).toBeVisible({ timeout: 20_000 });
    await expect(dlg.getByTestId('conflict-compare')).toContainText('My addition');
    await dlg.getByRole('button', { name: 'Apply selected to latest' }).click();
    await expect(eden.getByTestId('save-status')).toHaveAttribute('data-save-state', 'saved', { timeout: 20_000 });
    const after = (await a.get(`/api/posts/${id}`)).body;
    expect(after.draft.baseText).toBe('Original line. My addition.');
    expect(after.draft.baseLink).toBe('https://example.com/theirs'); // their change kept
    // History: compare an older version and restore it as a NEW version.
    await eden.goto(`/posts/${id}?panel=history`);
    await panel(eden).locator('[aria-label="Versions"] button').filter({ hasText: /^v1(?!\d)/ }).first().click();
    await expect(panel(eden).getByTestId('version-compare')).toBeVisible();
    await panel(eden).getByRole('button', { name: 'Restore this' }).click();
    await eden.getByRole('button', { name: 'Restore as new version' }).click();
    await expect.poll(async () => (await a.get(`/api/posts/${id}`)).body.draft.baseText, { timeout: 20_000 }).toBe('Original line.');
    expect((await a.get(`/api/posts/${id}`)).body.version).toBeGreaterThan(after.version);
    await eden.context().close();
  });

  test('server-side refusals: a guest never sees internal threads; mutations need the CSRF token', async ({ browser }) => {
    const eden = await person(browser, EDITOR);
    const a = await api(eden);
    const { id } = await newPost(a, `Collab guard ${randomUUID().slice(0, 6)}`);
    const t = await a.send('POST', `/api/posts/${id}/threads`, { visibility: 'internal', body: 'INTERNAL only' });
    expect(t.status).toBe(200);
    expect((await a.send('POST', `/api/posts/${id}/threads`, { visibility: 'internal', body: 'no csrf' }, { csrf: false })).status).toBe(403);
    const guest = await person(browser, GUEST);
    const g = await api(guest);
    expect((await g.get(`/api/threads/${t.body.thread.id}`)).status).toBe(404);
    expect((await g.get(`/api/posts/${id}/threads`)).status).toBe(404);
    const ev = await g.get(`/api/collab/events?post=${id}&after=0`);
    expect(JSON.stringify(ev.body)).not.toContain(t.body.thread.id);
    await eden.context().close(); await guest.context().close();
  });

  test('phone: open a notification at the thread, reply, add a task, compare versions @mobile', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'phone layout only');
    await signIn(page, EDITOR);
    const a = await api(page);
    const { id } = await newPost(a, `Collab mobile ${randomUUID().slice(0, 6)}`);
    const th = await a.send('POST', `/api/posts/${id}/threads`, { visibility: 'internal', body: 'Phone review please' });
    expect(th.status).toBe(200);
    await page.goto(`/posts/${id}?thread=${th.body.thread.id}`);
    const sheet = page.getByRole('dialog', { name: 'Collaborate' });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator(`#thread-${th.body.thread.id}`)).toBeVisible();
    expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')).toBe(true);
    await sheet.getByRole('button', { name: 'Reply' }).first().click();
    await sheet.getByRole('combobox', { name: 'Reply' }).fill('Replied from my phone');
    await sheet.getByRole('button', { name: 'Reply' }).last().click();
    await expect(sheet.getByText('Replied from my phone')).toBeVisible();
    await sheet.getByRole('tab', { name: 'Tasks' }).click();
    await sheet.getByRole('button', { name: 'New task' }).click();
    await sheet.getByRole('textbox', { name: 'Task', exact: true }).fill('Mobile task');
    await sheet.getByLabel('Deadline').fill('2031-06-01T09:30');
    await sheet.getByRole('button', { name: 'Create task' }).click();
    await expect(sheet.getByTestId('task-row').filter({ hasText: 'Mobile task' })).toBeVisible();
    await sheet.getByRole('tab', { name: 'History' }).click();
    await sheet.locator('[aria-label="Versions"] button').first().click();
    await expect(sheet.getByTestId('version-compare')).toBeVisible();
    expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')).toBe(true);
  });
});
