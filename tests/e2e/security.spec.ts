// V2 identity & security journeys against the running app + the local Keycloak realm:
// TOTP sign-in, My Security, step-up, real TOTP enrolment / recovery codes (incl. reuse refusal) / factor removal,
// session revocation, back-channel logout, service-account keys, CSP. Screenshots → evidence/v2/security-*.png
import { expect, test, type Locator, type Page } from '@playwright/test';
import { KEYCLOAK, api, completeKeycloak, freshTotp, signIn } from './helpers';

const REALM_ADMIN = `${KEYCLOAK}/admin/realms/social-lite`;
// The shared dev server compiles routes on first use; UI assertions get a generous timeout.
const ui = expect.configure({ timeout: 60_000 });

async function kcAdminToken(): Promise<string> {
  const r = await fetch(`${KEYCLOAK}/realms/master/protocol/openid-connect/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'admin', password: 'socialite-kc-admin-local-only' }),
  });
  return ((await r.json()) as { access_token: string }).access_token;
}
async function kcUserId(email: string): Promise<string> {
  const r = await fetch(`${REALM_ADMIN}/users?exact=true&email=${encodeURIComponent(email)}`, { headers: { authorization: `Bearer ${await kcAdminToken()}` } });
  return ((await r.json()) as Array<{ id: string }>)[0]!.id;
}
/** Test setup only: return a demo identity to "password only" (Keycloak admin API, local realm). */
async function resetSecondFactors(email: string): Promise<void> {
  const t = await kcAdminToken();
  const id = await kcUserId(email);
  const creds = (await (await fetch(`${REALM_ADMIN}/users/${id}/credentials`, { headers: { authorization: `Bearer ${t}` } })).json()) as Array<{ id: string; type: string }>;
  for (const c of creds.filter((x) => x.type !== 'password')) await fetch(`${REALM_ADMIN}/users/${id}/credentials/${c.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${t}` } });
  await fetch(`${REALM_ADMIN}/attack-detection/brute-force/users/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${t}` } });
}

/** On Keycloak: answer password / TOTP re-authentication prompts until `target` shows up. */
async function kcUntil(page: Page, email: string, key: Buffer | undefined, target: Locator): Promise<void> {
  const otp = page.locator('input[name=otp]');
  const pwd = page.locator('input[name=password]');
  for (let i = 0; i < 6; i++) {
    await ui(target.or(otp).or(pwd).first()).toBeVisible();
    if (await target.first().isVisible()) return;
    if (await otp.isVisible()) {
      await otp.fill(await freshTotp(key!, email));
    } else {
      const user = page.locator('input[name=username]');
      if (await user.isVisible().catch(() => false) && await user.isEditable().catch(() => false)) await user.fill(email);
      await pwd.fill('socialite-demo');
    }
    await page.locator('#kc-login, [type=submit]').first().click();
    await page.waitForLoadState();
  }
  await ui(target.first()).toBeVisible();
}

/** Collects CSP violations raised by OUR pages (Keycloak's own pages are a different origin with their own policy). */
function trackCspViolations(page: Page): string[] {
  const v: string[] = [];
  const ours = () => new URL(page.url()).port === '3000';
  void page.addInitScript({ content: "document.addEventListener('securitypolicyviolation', (e) => console.error('CSP violation: ' + e.violatedDirective + ' ' + e.blockedURI));" });
  page.on('console', (m) => { if (ours() && /CSP violation|Content Security Policy|Refused to (load|execute|connect|apply|frame)/i.test(m.text())) v.push(m.text()); });
  page.on('pageerror', (e) => { if (/Content Security Policy/i.test(e.message)) v.push(e.message); });
  return v;
}

test.describe('identity & security (Keycloak)', () => {
  test('owner signs in with password + TOTP; My Security shows two-step; CSP enforced without violations', async ({ page }) => {
    test.setTimeout(240_000);
    const violations = trackCspViolations(page);
    await signIn(page, 'owner@demo.social-lite.test');
    const res = await page.goto('/security');
    const csp = res!.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(csp).toContain('http://localhost:8333'); // presigned uploads/previews
    await ui(page.getByText('Two-step verified')).toBeVisible();
    await ui(page.getByTestId('factor-totp')).toContainText('1 active');
    await ui(page.getByTestId('session-list').locator('li').first()).toContainText('This device');
    await ui(page.getByTestId('security-events')).toContainText('Signed in');
    await page.screenshot({ path: 'evidence/v2/security-overview.png', fullPage: true });
    const s = await (await api(page)).get('/api/security');
    expect(s.body.assurance).toMatchObject({ mfa_verified: true, acr: 'mfa' });
    expect(s.body.assurance.amr).toEqual(expect.arrayContaining(['pwd', 'otp']));
    expect(violations).toEqual([]);
  });

  test('CSP + security headers: theme boot script, composer and a presigned media upload work with no violations; sign-out', async ({ page }) => {
    test.setTimeout(300_000);
    const violations = trackCspViolations(page);
    await signIn(page, 'owner@demo.social-lite.test');

    // Headers on an HTML page and on an API response.
    const res = await page.goto('/compose');
    const h = res!.headers();
    const csp = h['content-security-policy'] ?? '';
    for (const d of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"]) expect(csp).toContain(d);
    expect(csp).toMatch(/connect-src 'self' [^;]*http:\/\/localhost:8333/); // presigned POST uploads go straight to object storage
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(h['permissions-policy']).toContain('camera=()');
    expect(h['strict-transport-security']).toBeUndefined(); // local http: HSTS only in production (unit-tested)
    const apiRes = await page.request.get('/api/session');
    expect(apiRes.headers()['content-security-policy']).toContain("default-src 'none'");

    // The nonce'd inline theme boot script still runs before paint.
    await page.evaluate(() => localStorage.setItem('sl-theme', 'dark'));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.evaluate(() => localStorage.removeItem('sl-theme'));

    // Composer: new draft, write text, upload an image through upload-intent → presigned POST → validation, attach it.
    await page.getByRole('button', { name: 'Create draft' }).click();
    await page.waitForURL(/\/posts\/[0-9a-f-]{36}/, { timeout: 60_000 });
    await ui(page.getByPlaceholder('Write your post…')).toBeVisible();
    await page.getByPlaceholder('Write your post…').fill(`CSP check ${Date.now()}`);
    await page.getByRole('group', { name: 'Base media' }).getByRole('button', { name: 'Add' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add media' });
    await dialog.getByRole('tab', { name: 'Upload' }).click();
    const png = await page.screenshot({ clip: { x: 0, y: 0, width: 1080, height: 1080 } });
    await dialog.locator('input[type=file][accept*="image/png"]').setInputFiles({ name: `csp-upload-${Date.now()}.png`, mimeType: 'image/png', buffer: png });
    await ui(dialog.getByLabel('Uploads').getByText('Ready')).toBeVisible({ timeout: 90_000 });
    await dialog.getByRole('button', { name: 'Add', exact: true }).last().click();
    const thumb = page.getByRole('group', { name: 'Base media' }).locator('img').first();
    await ui(thumb).toBeVisible();
    // The preview loads from the storage origin (img-src).
    await expect.poll(() => thumb.evaluate((el) => { const i = el as unknown as { complete: boolean; naturalWidth: number }; return i.complete && i.naturalWidth > 0; })).toBe(true);
    await page.screenshot({ path: 'evidence/v2/security-csp-composer-upload.png', fullPage: true });
    const postId = /\/posts\/([0-9a-f-]{36})/.exec(page.url())![1]!;
    expect((await (await api(page)).send('POST', `/api/posts/${postId}/archive`, {})).status).toBeLessThan(300); // tidy up the demo data

    // Sign out (RP-initiated logout at Keycloak, back to /login) under the same policy.
    await page.getByRole('button', { name: /Account menu/ }).first().click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.waitForURL(/\/login/, { timeout: 60_000 });
    expect((await page.request.get('/api/session')).status()).toBe(401);
    expect(violations).toEqual([]);
  });

  test('step-up re-authenticates at Keycloak (password + TOTP) and returns verified', async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page, 'admin@demo.social-lite.test');
    await page.goto('/security');
    const before = (await (await api(page)).get('/api/security')).body.assurance.auth_time;
    await page.getByTestId('verify-now').click();
    await page.waitForURL(/localhost:5556/);
    await completeKeycloak(page, 'admin@demo.social-lite.test');
    await page.waitForURL(/\/security\?verified=1/);
    const after = (await (await api(page)).get('/api/security')).body;
    expect(new Date(after.assurance.auth_time).getTime()).toBeGreaterThan(new Date(before).getTime());
    expect(after.events.map((e: { action: string }) => e.action)).toContain('auth.step_up');
  });

  test('a user enrols TOTP, generates recovery codes (step-up), signs in with one, cannot reuse it, then removes factors', async ({ page, browser }) => {
    test.setTimeout(300_000);
    const email = 'analyst@demo.social-lite.test';
    await resetSecondFactors(email);
    await signIn(page, email);
    await page.goto('/security');
    await ui(page.getByText('Password only')).toBeVisible();

    // 1) Enrol an authenticator app through Keycloak's CONFIGURE_TOTP application-initiated action.
    await page.getByTestId('add-totp').click();
    await page.waitForURL(/localhost:5556/);
    await kcUntil(page, email, undefined, page.locator('input[name=totp]')); // the IdP may re-authenticate first
    const secret = await page.locator('input[name=totpSecret]').inputValue();
    const key = Buffer.from(secret, 'utf8');
    await page.screenshot({ path: 'evidence/v2/security-totp-enrol-keycloak.png' });
    await page.fill('input[name=totp]', await freshTotp(key, email));
    await page.fill('input[name=userLabel]', 'E2E phone').catch(() => undefined);
    await page.locator('#saveTOTPBtn, [type=submit]').first().click();
    await page.waitForURL(/\/security/);
    await ui(page.getByTestId('factor-totp')).toContainText('1 active');

    // 2) Recovery codes need a fresh verification now that a factor exists: the app sends us to step-up first.
    await page.getByTestId('add-codes').click();
    await page.waitForURL(/localhost:5556/);
    await completeKeycloak(page, email, { totpKey: key });
    await page.waitForURL(/\/security\?verified=1/);
    await page.getByTestId('add-codes').click();
    await page.waitForURL(/localhost:5556/);
    const list = page.locator('#kc-recovery-codes-list li, .kc-recovery-codes-list li');
    await kcUntil(page, email, key, list); // Keycloak's own re-authentication for the action
    await ui(list.first()).toBeVisible();
    const codes = (await list.allInnerTexts()).map((t) => t.replace(/^\s*\d+:\s*/, '').trim());
    expect(codes.length).toBeGreaterThanOrEqual(10);
    await page.screenshot({ path: 'evidence/v2/security-recovery-codes-keycloak.png' });
    await page.locator('#kcRecoveryCodesConfirmationCheck').check();
    await page.locator('#saveRecoveryAuthnCodesBtn, [type=submit]').first().click();
    await page.waitForURL(/\/security/);
    await ui(page.getByTestId('factor-recovery')).toContainText('Set');
    await page.screenshot({ path: 'evidence/v2/security-factors.png', fullPage: true });

    // 3) Sign in elsewhere with recovery code #1 (Keycloak "Try another way").
    const useRecovery = async (code: string) => {
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      await p.goto('/api/auth/login');
      await p.waitForURL(/localhost:5556/);
      await p.fill('input[name=username]', email);
      await p.fill('input[name=password]', 'socialite-demo');
      await p.locator('#kc-login').click();
      await p.locator('#try-another-way').click();
      await p.getByText(/recovery/i).first().click();
      await p.fill('input[name=recoveryCodeInput]', code);
      await p.locator('#kc-login, [type=submit]').first().click();
      return { ctx, p };
    };
    const alerts = async () => {
      const r = await fetch(`http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:"${email}" subject:"recovery code"`)}`);
      return ((await r.json()) as { messages_count?: number }).messages_count ?? 0;
    };
    const alertsBefore = await alerts();
    const first = await useRecovery(codes[0]!);
    await first.p.waitForURL((u) => u.port === '3000', { timeout: 30_000 });
    const s1 = (await (await api(first.p)).get('/api/security')).body.assurance;
    expect(s1.mfa_verified).toBe(true);
    expect(s1.amr).toContain('rc');
    await first.ctx.close();
    // Recovery-code sign-in revokes the user's other sessions (this page) and emails them.
    expect((await page.request.get('/api/session')).status()).toBe(401);
    await expect.poll(alerts, { timeout: 15_000 }).toBeGreaterThan(alertsBefore);
    await signIn(page, email, { totpKey: key });
    // Reusing the same code fails (Keycloak consumes codes in order and atomically).
    const again = await useRecovery(codes[0]!);
    await ui(again.p.getByText(/Invalid recovery authentication code/i).first()).toBeVisible();
    expect(new URL(again.p.url()).port).toBe('5556');
    await again.p.screenshot({ path: 'evidence/v2/security-recovery-code-reuse-refused.png' });
    await again.ctx.close();

    // 4) Remove the authenticator app (fresh verification + Keycloak delete_credential confirmation).
    await page.goto('/security');
    await page.getByTestId('verify-now').click();
    await page.waitForURL(/localhost:5556/);
    await completeKeycloak(page, email, { totpKey: key });
    await page.waitForURL(/\/security\?verified=1/);
    await page.getByTestId('factor-totp').getByRole('button', { name: /Remove/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
    await page.waitForURL(/localhost:5556/);
    const accept = page.locator('#kc-accept, [name=accept]');
    await kcUntil(page, email, key, accept);
    await page.screenshot({ path: 'evidence/v2/security-remove-factor-keycloak.png' });
    await accept.first().click();
    await page.waitForURL(/\/security/);
    await ui(page.getByTestId('factor-totp')).toContainText('Not set');
    await resetSecondFactors(email);
  });

  test('revoking another session signs it out on its next request', async ({ browser }) => {
    test.setTimeout(240_000);
    const a = await browser.newContext();
    const b = await browser.newContext();
    const pa = await a.newPage();
    const pb = await b.newPage();
    await signIn(pa, 'viewer@demo.social-lite.test');
    await signIn(pb, 'viewer@demo.social-lite.test');
    expect((await pb.request.get('/api/session')).status()).toBe(200);
    await pa.goto('/security');
    await ui(pa.getByTestId('session-list').locator('li')).toHaveCount(2, { timeout: 10_000 }).catch(() => undefined);
    await pa.screenshot({ path: 'evidence/v2/security-sessions.png', fullPage: true }).catch(() => undefined);
    await pa.getByTestId('revoke-others').click();
    await pa.getByRole('dialog').getByRole('button', { name: 'Sign out others' }).click();
    await expect.poll(async () => (await pb.request.get('/api/session')).status()).toBe(401);
    expect((await pa.request.get('/api/session')).status()).toBe(200);
    await a.close(); await b.close();
  });

  test('back-channel logout from Keycloak revokes the app session', async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page, 'approver@demo.social-lite.test');
    expect((await page.request.get('/api/session')).status()).toBe(200);
    // Dev server compiles routes on first use; make sure the receiver is warm so Keycloak's call does not time out.
    expect((await page.request.post('/api/auth/backchannel-logout', { form: { logout_token: 'not-a-jwt' }, timeout: 120_000 })).status()).toBe(400);
    // An administrator ends the user's IdP sessions; Keycloak POSTs a signed logout_token to the app.
    const t = await kcAdminToken();
    const r = await fetch(`${REALM_ADMIN}/users/${await kcUserId('approver@demo.social-lite.test')}/logout`, { method: 'POST', headers: { authorization: `Bearer ${t}` } });
    expect(r.status).toBe(204);
    await expect.poll(async () => (await page.request.get('/api/session')).status(), { timeout: 15_000 }).toBe(401);
  });

  test('Settings → Security: owner tightens and restores the workspace security policy (audited)', async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page, 'owner@demo.social-lite.test');
    await page.goto('/settings?tab=security');
    const card = page.getByTestId('security-policy');
    await ui(card).toBeVisible();
    const before = (await (await api(page)).get('/api/workspace/security-policy')).body.policy;
    const everyone = card.getByRole('switch', { name: 'Require two-step for everyone' });
    await everyone.click();
    await card.getByTestId('policy-save').click();
    await ui(page.getByRole('status').getByText('Saved', { exact: true })).toBeVisible();
    expect((await (await api(page)).get('/api/workspace/security-policy')).body.policy.mfa_required_all).toBe(!before.mfa_required_all);
    await page.screenshot({ path: 'evidence/v2/security-policy-settings.png', fullPage: true });
    // Restore (weakening if it was turned on: allowed because this sign-in is fresh).
    await card.getByRole('switch', { name: 'Require two-step for everyone' }).click();
    await card.getByTestId('policy-save').click();
    await expect.poll(async () => (await (await api(page)).get('/api/workspace/security-policy')).body.policy.mfa_required_all).toBe(before.mfa_required_all);
  });

  test('service account: key shown once, creates drafts on its brand only, never publishes, revoked key fails at once', async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page, 'owner@demo.social-lite.test');
    // Fresh verification for key creation.
    await page.goto('/api/auth/step-up?returnTo=/settings?tab=service-accounts');
    await completeKeycloak(page, 'owner@demo.social-lite.test');
    await page.waitForURL(/tab=service-accounts/);
    const name = `E2E bot ${Date.now()}`;
    await page.getByTestId('sa-new').click({ timeout: 120_000 });
    await page.getByTestId('sa-name').fill(name);
    const brandOptions = await page.getByTestId('sa-brand').locator('option').allInnerTexts();
    await page.getByTestId('sa-brand').selectOption({ label: brandOptions.find((o) => /Vitalos/.test(o))! });
    await page.getByTestId('sa-create').click();
    const secret = (await page.getByTestId('sa-secret').innerText()).trim();
    expect(secret).toMatch(/^sl_live_[a-z0-9]{12}_[a-f0-9]{64}$/);
    await page.screenshot({ path: 'evidence/v2/security-service-account-key-once.png' });
    await page.getByRole('button', { name: 'Done' }).click();
    await ui(page.locator(`[data-sa-name="${name}"]`)).toContainText('Create drafts');
    await ui(page.locator('body')).not.toContainText(secret.slice(21));
    await page.screenshot({ path: 'evidence/v2/security-service-accounts.png', fullPage: true });

    const a = await api(page);
    const brands = (await a.get('/api/session')).body.brands as Array<{ id: string; name: string }>;
    const vitalos = brands.find((b) => /Vitalos/.test(b.name))!;
    const other = brands.find((b) => !/Vitalos/.test(b.name))!;
    const call = (method: string, path: string, body?: unknown, auth = `Bearer ${secret}`) =>
      page.request.fetch(path, { method, headers: { authorization: auth, 'content-type': 'application/json' }, data: body ? JSON.stringify(body) : undefined });
    const me = await call('GET', '/api/v1/me');
    expect(me.status()).toBe(200);
    expect((await me.json()).grants).toEqual([{ role: 'integration', scope: 'brand', brand_id: vitalos.id }]);
    const draft = await call('POST', '/api/v1/drafts', { brand_id: vitalos.id, text: 'Drafted by an API key' });
    expect(draft.status()).toBe(200);
    expect((await call('POST', '/api/v1/drafts', { brand_id: other.id, text: 'x' })).status()).toBe(403);
    // Session-cookie routes ignore API keys entirely (no cookie ⇒ 401), so a key can never reach publish.
    const anon = await page.context().browser()!.newContext();
    const pub = await anon.request.fetch(`/api/posts/${(await draft.json()).id}/publish`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', origin: 'http://localhost:3000' }, data: '{}' });
    expect(pub.status()).toBe(401);
    await anon.close();

    // Revoke from the UI → the key fails on the very next request.
    const card = page.locator(`[data-sa-name="${name}"]`);
    await card.getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click();
    await ui(card).toContainText('revoked', { timeout: 90_000 }); // dev server may full-reload after compiling the route
    const after = await call('GET', '/api/v1/me');
    expect(after.status()).toBe(401);
    expect(after.headers()['www-authenticate']).toContain('Bearer');
    // Clean up: disable the account (also revokes any remaining keys).
    const list = (await (await api(page)).get('/api/service-accounts')).body.items as Array<{ id: string; name: string }>;
    const sa = list.find((x) => x.name === name)!;
    expect((await (await api(page)).send('POST', `/api/service-accounts/${sa.id}/disable`, {})).status).toBe(200);
  });
});
