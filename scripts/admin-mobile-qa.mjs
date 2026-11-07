#!/usr/bin/env node
// V3.1 Admin §16 mobile QA (DEV/LOCAL ONLY; E2E Workspace, simulated destinations).
//   set -a; . ./.env; set +a; node scripts/admin-mobile-qa.mjs
// 1) Every admin route at 320/360/390/430/768/1024/1440 (+ landscape 844×390): page-level horizontal scroll, small touch
//    targets inside the page content (< 44×44 CSS px, reported), console errors.
// 2) The brief's ten phone workflows at 390×844, each driven through the real UI, with a screenshot of the end state.
// Writes evidence/v3-1/admin/mobile-qa.json and evidence/v3-1/admin/mobile/<n>-<workflow>.png.
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const pg = require('pg');
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
if (!process.env.MIGRATOR_DATABASE_URL) throw new Error('MIGRATOR_DATABASE_URL is required (dev only)');
mkdirSync('evidence/v3-1/admin/mobile', { recursive: true });

const db = new pg.Pool({ connectionString: process.env.MIGRATOR_DATABASE_URL });
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const ws = (await one(`SELECT id FROM workspaces WHERE name='E2E Workspace' LIMIT 1`)).id;
const owner = (await one(`SELECT id FROM users WHERE email='owner@demo.social-lite.test'`)).id;
const token = randomBytes(32).toString('base64url');
const csrf = randomUUID();
await db.query(`INSERT INTO sessions(user_id, token_hash, csrf_token, active_workspace_id, expires_at, mfa_verified, auth_time, acr, amr)
  VALUES ($1,$2,$3,$4,now() + interval '1 hour',true,now(),'mfa','{pwd,otp}')`, [owner, createHash('sha256').update(token).digest(), csrf, ws]);
const call = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: { origin: BASE, cookie: `sl_session=${token}`, 'content-type': 'application/json', 'x-csrf-token': csrf, 'x-workspace-id': ws, 'idempotency-key': randomUUID() }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const other = (await one(`SELECT id FROM workspaces WHERE name='Other Workspace'`)).id;

const ROUTES = ['/admin', '/admin/people', '/admin/people/invitations', '/admin/people/teams', '/admin/publishing', '/admin/publishing?state=attention', '/admin/approvals',
  '/admin/content', '/admin/connections', '/admin/connections/diagnostics', '/admin/analytics', '/admin/developer/webhooks', '/admin/settings/developer/mcp',
  '/admin/settings/developer/service-accounts', '/admin/security/audit', '/admin/security/support', '/admin/security/reports', '/admin/operations', '/admin/usage',
  '/admin/settings/workspace/general', '/admin/help', '/admin/platform', '/admin/platform/workspaces', `/admin/platform/workspaces/${other}`, '/admin/platform/accounts',
  '/admin/platform/rollouts', '/admin/platform/integrations', '/admin/platform/support', '/admin/platform/audit', '/admin/platform/operators'];
const SIZES = [[320, 640], [360, 740], [390, 844], [430, 932], [768, 1024], [1024, 768], [1440, 900], [844, 390]];

const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
async function page(w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, hasTouch: w < 1024, isMobile: w < 768 });
  await ctx.addCookies([{ name: 'sl_session', value: token, domain: new URL(BASE).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
  const p = await ctx.newPage();
  p.setDefaultTimeout(30_000);
  p.__errors = [];
  p.on('pageerror', (e) => p.__errors.push(e.message.slice(0, 200)));
  return { ctx, p };
}
const ready = (p) => p.waitForFunction(() => document.querySelector('#admin-main h1') && !document.querySelector('.skeleton'), null, { timeout: 60_000 }).catch(() => undefined);

const layout = [];
for (const [w, h] of SIZES) {
  const { ctx, p } = await page(w, h);
  for (const url of ROUTES) {
    await p.goto(`${BASE}${url}`, { waitUntil: 'networkidle', timeout: 120_000 }).catch(() => undefined);
    await ready(p);
    const r = await p.evaluate(() => {
      const overflow = document.documentElement.scrollWidth - window.innerWidth;
      const small = [...document.querySelectorAll('#admin-main button, #admin-main a[href], #admin-main select, #admin-main input:not([type=hidden])')]
        .filter((el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && (b.width < 44 || b.height < 44) && getComputedStyle(el).visibility !== 'hidden'; })
        .filter((el) => !(el.tagName === 'A' && el.closest('p, li, td, dd') && el.textContent.trim().length > 2)); // inline text links are exempt (WCAG 2.5.8 inline exception)
      return { overflow, small_targets: small.length };
    });
    layout.push({ width: w, height: h, url, page_overflow_px: Math.max(0, r.overflow), small_targets: r.small_targets, errors: p.__errors.splice(0) });
  }
  await ctx.close();
  console.log('layout', w, 'overflow:', layout.filter((l) => l.width === w && l.page_overflow_px > 1).map((l) => l.url));
}

// ---------------------------------------------------------------- ten phone workflows (390 × 844)
const results = [];
async function workflow(n, name, fn) {
  const { ctx, p } = await page(390, 844);
  const t0 = Date.now();
  try {
    await fn(p);
    await p.waitForTimeout(400);
    await p.screenshot({ path: `evidence/v3-1/admin/mobile/${n}-${name}.png` });
    results.push({ n, name, ok: true, ms: Date.now() - t0, errors: p.__errors });
  } catch (e) {
    await p.screenshot({ path: `evidence/v3-1/admin/mobile/${n}-${name}-FAILED.png` }).catch(() => undefined);
    results.push({ n, name, ok: false, ms: Date.now() - t0, error: e.message.slice(0, 300), errors: p.__errors });
  }
  console.log('workflow', n, name, results[results.length - 1].ok ? 'ok' : `FAILED ${results[results.length - 1].error}`);
  await ctx.close();
}
const openNav = async (p, group, item) => {
  await p.getByRole('button', { name: 'Open navigation' }).click();
  const d = p.getByRole('dialog', { name: 'Admin navigation' });
  if (group) await d.getByRole('button', { name: group }).click();
  await d.getByRole('link', { name: item, exact: true }).click();
  await ready(p);
};

await workflow(1, 'find-workspace-health', async (p) => {
  await p.goto(`${BASE}/admin/platform/workspaces`); await ready(p);
  await p.getByRole('textbox', { name: 'Search workspaces' }).fill('Other');
  await p.keyboard.press('Enter');
  await p.locator('#admin-main ul[aria-label="Workspaces"] button').first().click();
  await p.waitForURL(/platform\/workspaces\/[0-9a-f-]{36}/); await ready(p);
  await p.getByRole('heading', { name: 'Publishing · 7 days (live)' }).waitFor();
});
let inviteEmail = `mobile-qa-${randomUUID().slice(0, 6)}@example.test`;
await workflow(2, 'invite-and-scoped-role', async (p) => {
  await p.goto(`${BASE}/admin`); await ready(p);
  await openNav(p, 'People and teams', 'Invitations');
  await p.getByRole('button', { name: 'Invite' }).click();
  await p.getByRole('textbox', { name: 'Email' }).fill(inviteEmail);
  await p.getByRole('button', { name: 'Send' }).click();
  await p.locator('#admin-main').getByText(inviteEmail).first().waitFor();
  // Scoped role change on an existing member: give analyst@ Approver on one brand through the member page, then revoke it.
  const m = (await call('GET', '/api/members')).body.members.find((x) => x.email === 'analyst@demo.social-lite.test');
  await p.goto(`${BASE}/admin/people/members/${m.user_id}`); await ready(p);
  await p.getByRole('button', { name: 'Add', exact: true }).first().click();
  const dlg = p.getByRole('dialog');
  await dlg.getByRole('combobox', { name: 'Role' }).selectOption('approver');
  await dlg.getByRole('combobox', { name: 'Brand' }).selectOption({ index: 1 });
  await dlg.getByRole('button', { name: 'Grant', exact: true }).click();
  await dlg.waitFor({ state: 'hidden' });
  await p.locator('#admin-main').getByText(/Approver/).first().waitFor();
  await p.screenshot({ path: 'evidence/v3-1/admin/mobile/2-scoped-role-granted.png' });
  await p.getByRole('button', { name: 'Revoke Approver' }).first().click();
  await p.waitForTimeout(800);
  // cleanup: revoke the invitation (the grant stays visible in the screenshot; removed below)
  const inv = (await call('GET', '/api/invitations')).body?.items?.find?.((i) => i.email === inviteEmail);
  if (inv) await call('DELETE', `/api/invitations/${inv.id}`);
});
await workflow(3, 'failed-publication-recovery', async (p) => {
  await p.goto(`${BASE}/admin`); await ready(p);
  await p.getByRole('link', { name: /Needs attention/ }).click();
  await p.waitForURL(/state=attention/); await ready(p);
  const first = p.locator('#admin-main ul[aria-label="Deliveries"] button').first();
  if (await first.count()) { await first.click(); await p.getByRole('dialog').getByText(/Recovery/i).first().waitFor(); }
});
await workflow(4, 'broken-connection-reconnect', async (p) => {
  await p.goto(`${BASE}/admin/connections`); await ready(p);
  await p.locator('#admin-main ul[aria-label="Social accounts"] button').first().click();
  const d = p.getByRole('dialog');
  await d.getByText('Authorization', { exact: true }).waitFor();
  await d.getByRole('button', { name: 'Reconnect' }).waitFor();
});
await workflow(5, 'approval-decision', async (p) => {
  const s = (await call('GET', '/api/session')).body;
  const brand = s.brands.find((b) => b.approval_required);
  const conns = (await call('GET', `/api/brands/${brand.id}/connections`)).body.items.filter((c) => c.status === 'ready');
  const post = (await call('POST', `/api/brands/${brand.id}/posts`, { title: `Mobile QA approval ${randomUUID().slice(0, 4)}`, draft: { baseText: 'Approval from a phone', baseLink: null, baseAssetIds: [], variants: [{ connectionId: conns.find((c) => c.provider === 'telegram' || c.provider === 'facebook').id, inheritText: true, inheritMedia: true }] } })).body;
  const local = new Date(Date.now() + 30 * 3600_000).toISOString().slice(0, 16);
  await call('POST', `/api/posts/${post.id}/submit`, { expected_version: post.version, connection_ids: [conns.find((c) => c.provider === 'telegram' || c.provider === 'facebook').id], input_local_time: local, timezone: 'UTC' });
  await p.goto(`${BASE}/admin/approvals`); await ready(p);
  await p.locator('#admin-main a[href^="/admin/approvals/"]').first().click();
  await p.waitForURL(/admin\/approvals\/[0-9a-f-]{36}/); await ready(p);
  await p.getByRole('button', { name: /^Approve/ }).first().click();
  await p.waitForTimeout(1500);
});
await workflow(6, 'analytics-report', async (p) => {
  await p.goto(`${BASE}/admin`); await ready(p);
  await openNav(p, null, 'Analytics');
  await p.getByRole('heading', { name: 'Analytics ingestion' }).waitFor();
  await p.getByRole('button', { name: 'Show' }).click();
  await p.getByRole('textbox', { name: 'Filter metrics' }).fill('reach');
});
await workflow(7, 'revoke-api-key', async (p) => {
  const sa = (await call('POST', '/api/service-accounts', { name: `Mobile QA ${randomUUID().slice(0, 4)}`, role: 'integration', brand_id: (await call('GET', '/api/session')).body.brands[0].id })).body;
  await p.goto(`${BASE}/admin/settings/developer/service-accounts`); await ready(p);
  const revoke = p.getByRole('button', { name: 'Revoke', exact: true }).first();
  await revoke.waitFor();
  await revoke.click();
  const confirm = p.getByRole('dialog').getByRole('button', { name: /Revoke|Disable/ }).last();
  if (await confirm.count()) await confirm.click();
  await p.waitForTimeout(800);
  void sa;
});
await workflow(8, 'setting-persists', async (p) => {
  await p.goto(`${BASE}/admin/settings/workspace/drafts`); await ready(p);
  const radios = p.getByRole('radio');
  const before = await radios.evaluateAll((els) => els.findIndex((e) => e.checked));
  const target = before === 0 ? 1 : 0;
  await radios.nth(target).check();
  const save = p.getByRole('button', { name: /^Save/ });
  if (await save.count()) await save.first().click();
  await p.waitForTimeout(1000);
  await p.reload(); await ready(p);
  const after = await p.getByRole('radio').evaluateAll((els) => els.findIndex((e) => e.checked));
  if (after !== target) throw new Error(`setting did not persist (${after} ≠ ${target})`);
  await p.getByRole('radio').nth(before).check();
  if (await save.count()) await save.first().click();
  await p.waitForTimeout(800);
});
await workflow(9, 'search-audit', async (p) => {
  await p.goto(`${BASE}/admin/security/audit`); await ready(p);
  await p.locator('#admin-main select').first().selectOption({ index: 1 });   // first filter (brand or category)
  await p.waitForURL(/[?&](category|brand_id|brand)=/);
  await ready(p);
});
await workflow(10, 'pause-scope', async (p) => {
  await p.goto(`${BASE}/admin`); await ready(p);
  await openNav(p, 'Operations', 'Queues and workers');
  const row = p.locator('#admin-main li').filter({ hasText: /TipSignal/ }).first();
  await row.getByRole('button', { name: /^Pause/ }).click();
  await p.getByRole('textbox', { name: 'Reason' }).fill('Mobile QA pause');
  await p.getByRole('button', { name: 'Pause brand' }).click();
  await p.getByRole('dialog').waitFor({ state: 'hidden' });
  await p.reload(); await ready(p);
  await p.locator('#admin-main li').filter({ hasText: /TipSignal/ }).first().getByText('Paused').waitFor();
  await p.screenshot({ path: 'evidence/v3-1/admin/mobile/10-pause-scope-paused.png' });
  await p.locator('#admin-main li').filter({ hasText: /TipSignal/ }).first().getByRole('button', { name: /^Resume/ }).click();
  await p.getByRole('button', { name: 'Resume brand' }).click();
  await p.getByRole('dialog').waitFor({ state: 'hidden' });
});

await browser.close();
await db.query(`DELETE FROM sessions WHERE token_hash=$1`, [createHash('sha256').update(token).digest()]);
await db.end();
const out = { generated_at: new Date().toISOString(), base_url: BASE, routes: ROUTES.length, sizes: SIZES, layout, workflows: results,
  summary: { overflow: layout.filter((l) => l.page_overflow_px > 1).map((l) => `${l.width}:${l.url}`), workflows_ok: results.filter((r) => r.ok).length, workflows: results.length,
    page_errors: layout.flatMap((l) => l.errors).length } };
writeFileSync('evidence/v3-1/admin/mobile-qa.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.summary));
