// F2 fixes, browser level (real Keycloak sign-in, real API, E2E Workspace):
//  - H4: an ownership transfer to a member WITHOUT members.read (Editor) shows an Accept / Decline banner on every page;
//    declining tells the owner; the owner cancels a pending transfer from Team. (Accepting would change the shared E2E
//    workspace's owner and needs the recipient's second factor; it is covered by the integration tests.)
//  - H5: an Approver can pause a brand but sees no Resume, and the server refuses a resume from them.
// Every test leaves the workspace as it found it (no pending transfer, nothing paused).
import { expect, test, type Browser, type Page } from '@playwright/test';
import { api, demoBrand, signIn, type Api } from './helpers';

const OWNER = 'owner@demo.social-lite.test';
const EDITOR = 'editor@demo.social-lite.test';
const APPROVER = 'approver@demo.social-lite.test';

async function as(browser: Browser, email: string): Promise<{ page: Page; a: Api; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await signIn(page, email);
  return { page, a: await api(page), close: () => ctx.close() };
}

async function cancelPending(a: Api) {
  const r = await a.get('/api/workspace/ownership-transfers');
  for (const t of (r.body?.items ?? []) as Array<{ id: string }>) await a.send('DELETE', `/api/workspace/ownership-transfers/${t.id}`);
}

async function memberId(a: Api, email: string): Promise<string> {
  const r = await a.get(`/api/members?q=${encodeURIComponent(email)}`);
  const m = (r.body.members as Array<{ user_id: string; email: string }>).find((x) => x.email === email);
  expect(m, `${email} is a member of the E2E workspace`).toBeTruthy();
  return m!.user_id;
}

test.describe('Ownership transfer and resume permissions', () => {
  test.describe.configure({ timeout: 180_000 });

  test('H4: an Editor can decline from the shell banner; the owner can cancel from Team', async ({ browser }) => {
    const owner = await as(browser, OWNER);
    const editor = await as(browser, EDITOR);
    try {
      await cancelPending(owner.a);
      const editorId = await memberId(owner.a, EDITOR);
      const proposed = await owner.a.send('POST', '/api/workspace/ownership-transfers', { to_user_id: editorId, keep_previous_owner_as: 'admin' });
      expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);

      // The Editor has no members.read: Team says "No access", but the banner is in the shell on every page.
      await editor.page.goto('/team');
      await expect(editor.page.getByText('No access')).toBeVisible();
      const banner = editor.page.getByTestId('ownership-transfer-banner');
      await expect(banner).toContainText(`${OWNER} wants you to become the owner`);
      await expect(banner.getByRole('button', { name: 'Accept ownership' })).toBeVisible();
      await editor.page.goto('/overview');
      await expect(banner).toBeVisible();
      await editor.page.screenshot({ path: 'evidence/fix/f2/h4-editor-banner.png' });
      await banner.getByRole('button', { name: 'Decline' }).click();
      const dlg = editor.page.getByRole('dialog', { name: 'Decline ownership?' });
      await expect(dlg).toContainText(`${OWNER} stays the owner and is told you declined.`);
      await dlg.getByRole('button', { name: 'Decline' }).click();
      await expect(editor.page.getByText('Transfer declined')).toBeVisible();
      await expect(banner).toHaveCount(0);
      expect((await owner.a.get('/api/workspace/ownership-transfers')).body.items).toEqual([]);

      // A second proposal: the owner sees it pending on Team and on the member's page, and cancels it there.
      expect((await owner.a.send('POST', '/api/workspace/ownership-transfers', { to_user_id: editorId, keep_previous_owner_as: 'none' })).status).toBe(200);
      await owner.page.goto('/team');
      const pending = owner.page.getByText(`Ownership transfer to ${EDITOR} pending`);
      await expect(pending).toBeVisible();
      await expect(owner.page.getByText(/previous owner keeps no Admin role/)).toBeVisible();
      await owner.page.screenshot({ path: 'evidence/fix/f2/h4-owner-pending.png' });
      await owner.page.goto(`/team/members/${editorId}`);
      await expect(owner.page.getByRole('button', { name: 'Make owner' })).toHaveCount(0);
      await owner.page.getByRole('button', { name: 'Cancel transfer' }).click();
      await owner.page.getByRole('dialog', { name: 'Cancel ownership transfer?' }).getByRole('button', { name: 'Cancel transfer' }).click();
      await expect(owner.page.getByText('Transfer cancelled')).toBeVisible();
      await expect(owner.page.getByRole('button', { name: 'Make owner' })).toBeVisible();
      await editor.page.reload();
      await expect(editor.page.getByTestId('ownership-transfer-banner')).toHaveCount(0);

      // The Make owner dialog offers the previous owner's choice (no transfer is sent here).
      await owner.page.getByRole('button', { name: 'Make owner' }).click();
      const make = owner.page.getByRole('dialog', { name: `Make ${EDITOR} the owner?` });
      await expect(make.getByRole('radio', { name: 'Stay as Admin' })).toBeChecked();
      await expect(make.getByRole('radio', { name: /Give up your access/ })).toBeVisible();
      await owner.page.screenshot({ path: 'evidence/fix/f2/h4-make-owner-dialog.png' });
      await owner.page.keyboard.press('Escape');
    } finally {
      await cancelPending(owner.a).catch(() => undefined);
      await owner.close();
      await editor.close();
    }
  });

  test('H5: an Approver can pause a brand but not resume it', async ({ browser }) => {
    const owner = await as(browser, OWNER);
    const approver = await as(browser, APPROVER);
    const brand = await demoBrand(owner.a, /Vitalos/);
    try {
      const paused = await approver.a.send('POST', `/api/brands/${brand.id}/pause`, { paused: true, reason: 'E2E H5' });
      expect(paused.status, JSON.stringify(paused.body)).toBe(200);
      const resume = await approver.a.send('POST', `/api/brands/${brand.id}/pause`, { paused: false });
      expect(resume.status).toBe(403);
      await approver.page.goto('/settings/publishing/defaults');
      await approver.page.locator('main').getByRole('combobox', { name: 'Brand', exact: true }).selectOption({ label: brand.name });
      await expect(approver.page.getByText('Brand paused').first()).toBeVisible();
      await expect(approver.page.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
      await approver.page.screenshot({ path: 'evidence/fix/f2/h5-approver-no-resume.png' });
      // The owner (publishing.resume) still can.
      expect((await owner.a.send('POST', `/api/brands/${brand.id}/pause`, { paused: false })).status).toBe(200);
    } finally {
      await owner.a.send('POST', `/api/brands/${brand.id}/pause`, { paused: false }).catch(() => undefined);
      await owner.close();
      await approver.close();
    }
  });
});
