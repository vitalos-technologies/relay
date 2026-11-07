#!/usr/bin/env node
// Collaboration mobile QA (DEV/LOCAL ONLY; E2E Workspace, simulated destinations, synthetic data).
//   set -a; . ./.env; set +a; node scripts/collab-mobile-qa.mjs
// 1) Collaboration routes at 320/360/390/430/768 (+ 1440): page-level horizontal scroll, small touch targets (< 44 px,
//    reported), console errors — including the composer with its collaboration sheet open.
// 2) The brief's §12 phone workflows at 390×844 through the real UI, with a screenshot of each end state:
//    read/reply to a thread · mention a teammate · assign a task + deadline · review + request changes · approve when
//    authorised · open a notification at the correct thread · inspect a revision comparison · recover from an editing conflict.
// Writes evidence/collaboration/mobile-qa.json and evidence/collaboration/mobile/<n>-<workflow>.png.
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const pg = require('pg');
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
if (!process.env.MIGRATOR_DATABASE_URL) throw new Error('MIGRATOR_DATABASE_URL is required (dev only)');
mkdirSync('evidence/collaboration/mobile', { recursive: true });

const db = new pg.Pool({ connectionString: process.env.MIGRATOR_DATABASE_URL });
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const ws = (await one(`SELECT id FROM workspaces WHERE name='E2E Workspace' LIMIT 1`)).id;
const tokens = [];
async function as(email) {
  const u = await one(`SELECT id FROM users WHERE email=$1`, [email]);
  const token = randomBytes(32).toString('base64url');
  const csrf = randomUUID();
  await db.query(`INSERT INTO sessions(user_id, token_hash, csrf_token, active_workspace_id, expires_at, mfa_verified, auth_time, acr, amr)
    VALUES ($1,$2,$3,$4,now() + interval '1 hour',true,now(),'mfa','{pwd,otp}')`, [u.id, createHash('sha256').update(token).digest(), csrf, ws]);
  tokens.push(token);
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { origin: BASE, cookie: `sl_session=${token}`, 'content-type': 'application/json', 'x-csrf-token': csrf, 'x-workspace-id': ws, 'idempotency-key': randomUUID() }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { token, call, id: u.id };
}
console.log('start');
const editor = await as('editor@demo.social-lite.test');
console.log('editor ok');
const approver = await as('approver@demo.social-lite.test');

// Fixtures: a post with a thread + task; a post submitted for review on the approval brand.
const session = (await editor.call('GET', '/api/session')).body;
console.log('session ok', session?.brands?.length);
const vit = session.brands.find((b) => /Vitalos/.test(b.name));
const tip = session.brands.find((b) => b.approval_required) ?? null;
const connOf = async (brandId) => (await editor.call('GET', `/api/brands/${brandId}/connections`)).body.items.find((c) => /Telegram/.test(c.display_name) && c.status === 'ready');
const mk = async (brandId, title) => {
  const c = await connOf(brandId);
  return (await editor.call('POST', `/api/brands/${brandId}/posts`, { title, draft: { baseText: `${title}: copy for the team to check.`, baseLink: null, baseAssetIds: [], variants: [{ connectionId: c.id, inheritText: true, inheritMedia: true }] } })).body;
};
const tag = randomUUID().slice(0, 6);
console.log('fixtures…', { vit: !!vit, tip: !!tip });
const post = await mk(vit.id, `Mobile QA ${tag}`);
const thread = (await editor.call('POST', `/api/posts/${post.id}/threads`, { visibility: 'internal', body: `@[${approver.id}] can you check the first line on your phone?` })).body.thread;
await editor.call('PUT', `/api/posts/${post.id}/autosave`, { base_version: 1, client_id: `qa_${tag}_seed`, client_revision: 1, draft: { baseText: `Mobile QA ${tag}: edited copy for the team.`, baseLink: null, baseAssetIds: [], variants: (await editor.call('GET', `/api/posts/${post.id}`)).body.draft.variants } });
let review = null;
if (tip) {
  const p2 = await mk(tip.id, `Mobile review ${tag}`);
  const c = await connOf(tip.id);
  const local = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 16);
  const s = await editor.call('POST', `/api/posts/${p2.id}/submit`, { expected_version: 1, connection_ids: [c.id], input_local_time: local, timezone: 'Europe/London' });
  review = s.body?.approval ?? null;
  const p3 = await mk(tip.id, `Mobile approve ${tag}`);
  const s3 = await editor.call('POST', `/api/posts/${p3.id}/submit`, { expected_version: 1, connection_ids: [c.id], input_local_time: local, timezone: 'Europe/London' });
  review = { reject: review, approve: s3.body?.approval ?? null };
}
console.log('fixtures done', { post: post?.id, review: !!review?.reject });
// Wait for the worker to turn the mention into a notification.
for (let i = 0; i < 30; i++) { if (JSON.stringify((await approver.call('GET', '/api/notifications?category=mentions')).body).includes(post.id) || i === 29) break; await new Promise((r) => setTimeout(r, 1000)); }

const ROUTES = [`/posts/${post.id}`, `/posts/${post.id}?panel=discussion`, '/tasks', '/tasks?view=team', '/notifications', ...(review?.reject ? [`/approvals/${review.reject.id}`] : []),
  '/admin/collaboration', '/admin/collaboration/reassign', '/admin/collaboration/notifications', '/admin/collaboration/settings'];
const SIZES = [[320, 640], [360, 740], [390, 844], [430, 932], [768, 1024], [1440, 900]];

const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
async function page(w, h, who = editor) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, hasTouch: w < 1024, isMobile: w < 768, reducedMotion: 'reduce' });
  await ctx.addCookies([{ name: 'sl_session', value: who.token, domain: new URL(BASE).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
  const p = await ctx.newPage();
  p.setDefaultTimeout(30_000);
  p.__errors = [];
  p.on('pageerror', (e) => p.__errors.push(e.message.slice(0, 200)));
  return { ctx, p };
}
const ready = (p) => p.waitForFunction(() => document.querySelector('h1') && !document.querySelector('.skeleton'), null, { timeout: 20_000 }).catch(() => { p.__slow = (p.__slow ?? 0) + 1; });
const measure = (p) => p.evaluate(() => {
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  const root = document.querySelector('[role=dialog]') ?? document.querySelector('main') ?? document.body;
  const small = [...root.querySelectorAll('button, a[href], select, input:not([type=hidden]), textarea')]
    .filter((el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && (b.width < 44 || b.height < 44) && getComputedStyle(el).visibility !== 'hidden'; })
    .filter((el) => !(el.tagName === 'A' && el.closest('p, li, td, dd') && el.textContent.trim().length > 2))
    .filter((el) => !(el.tagName === 'INPUT' && ['checkbox', 'radio'].includes(el.type) && el.closest('label')));
  return { overflow, small_targets: small.length };
});

const layout = [];
for (const [w, h] of SIZES) {
  const { ctx, p } = await page(w, h);
  for (const url of ROUTES) {
    await p.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded', timeout: 120_000 }).catch(() => undefined);
    await p.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => undefined);
    await ready(p);
    if (url.includes('?panel=') && w < 1280) await p.getByRole('dialog', { name: 'Collaborate' }).waitFor({ timeout: 10_000 }).catch(() => undefined);
    await p.waitForTimeout(300);
    const r = await measure(p);
    layout.push({ width: w, height: h, url, page_overflow_px: Math.max(0, r.overflow), small_targets: r.small_targets, errors: p.__errors.splice(0) });
  }
  await ctx.close();
  console.error('layout', w, 'overflow:', layout.filter((l) => l.width === w && l.page_overflow_px > 1).map((l) => l.url));
}

const results = [];
async function workflow(n, name, who, fn) {
  const { ctx, p } = await page(390, 844, who);
  const t0 = Date.now();
  try {
    await fn(p);
    await p.waitForTimeout(400);
    const r = await measure(p);
    if (r.overflow > 1) throw new Error(`page scrolls sideways by ${r.overflow}px`);
    await p.screenshot({ path: `evidence/collaboration/mobile/${n}-${name}.png` });
    results.push({ n, name, ok: true, ms: Date.now() - t0, errors: p.__errors });
  } catch (e) {
    await p.screenshot({ path: `evidence/collaboration/mobile/${n}-${name}-FAILED.png` }).catch(() => undefined);
    results.push({ n, name, ok: false, ms: Date.now() - t0, error: e.message.slice(0, 300), errors: p.__errors });
  }
  console.error('workflow', n, name, results[results.length - 1].ok ? 'ok' : `FAILED ${results[results.length - 1].error}`);
  await ctx.close();
}
const sheet = (p) => p.getByRole('dialog', { name: 'Collaborate' });

await workflow(1, 'open-notification-at-thread', approver, async (p) => {
  await p.goto(`${BASE}/notifications?category=mentions`); await ready(p);
  await p.getByRole('listitem').filter({ hasText: `Mobile QA ${tag}` }).getByRole('link').first().click();
  await p.waitForURL(/thread=/);
  await sheet(p).locator(`#thread-${thread.id}`).waitFor();
  await p.waitForFunction((id) => document.activeElement?.id === `thread-${id}`, thread.id, { timeout: 5000 }).catch(() => { throw new Error('thread not focused'); });
});
await workflow(2, 'read-and-reply', approver, async (p) => {
  await p.goto(`${BASE}/posts/${post.id}?thread=${thread.id}`);
  const t = sheet(p).locator(`#thread-${thread.id}`);
  await t.getByRole('button', { name: 'Reply' }).click();
  await t.getByRole('combobox', { name: 'Reply' }).fill('Checked — the first line works.');
  await t.getByRole('button', { name: 'Reply' }).last().click();
  await t.getByText('Checked — the first line works.').waitFor();
});
await workflow(3, 'mention-a-teammate', editor, async (p) => {
  await p.goto(`${BASE}/posts/${post.id}?panel=discussion`);
  const box = sheet(p).getByRole('combobox', { name: /New internal comment/ });
  await box.click(); await box.pressSequentially('Thanks @apr');
  await p.getByRole('option', { name: /April Approver/ }).waitFor();
  await box.press('Enter');
  await sheet(p).getByRole('button', { name: 'Comment', exact: true }).click();
  await sheet(p).locator('article').filter({ hasText: 'Thanks' }).getByText('@April Approver').first().waitFor();
});
await workflow(4, 'assign-task-with-deadline', editor, async (p) => {
  await p.goto(`${BASE}/posts/${post.id}?panel=tasks`);
  await sheet(p).getByRole('button', { name: 'New task' }).click();
  const form = sheet(p).locator('form');
  await form.getByRole('textbox', { name: 'Task', exact: true }).fill('Check alt text on phone');
  await form.getByLabel('Search people to assign').fill('Apr');
  const sel = form.getByRole('combobox', { name: /^Assignee/ });
  const v = await sel.locator('option', { hasText: 'April' }).first().getAttribute('value');
  await sel.selectOption(v);
  await form.getByLabel('Deadline').fill('2031-03-03T09:00');
  await form.getByRole('button', { name: 'Create task' }).click();
  await sheet(p).getByTestId('task-row').filter({ hasText: 'Check alt text on phone' }).waitFor();
});
if (review?.reject) {
  await workflow(5, 'review-and-request-changes', approver, async (p) => {
    await p.goto(`${BASE}/approvals/${review.reject.id}`); await ready(p);
    await p.getByRole('button', { name: 'Request changes' }).click();
    await p.getByRole('dialog').getByRole('textbox').fill('Please add the price.');
    await p.getByRole('dialog').getByRole('button', { name: 'Request changes' }).click();
    await p.getByText('Changes requested').first().waitFor();
  });
  await workflow(6, 'approve-when-authorised', approver, async (p) => {
    await p.goto(`${BASE}/approvals/${review.approve.id}`); await ready(p);
    await p.getByRole('button', { name: 'Approve', exact: true }).click();
    await p.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
    await p.getByText('Approved').first().waitFor();
  });
}
await workflow(7, 'inspect-revision-comparison', editor, async (p) => {
  await p.goto(`${BASE}/posts/${post.id}?panel=history`);
  await sheet(p).locator('[aria-label="Versions"] button').filter({ hasText: /^v1(?!\d)/ }).first().click();
  await sheet(p).getByTestId('version-compare').waitFor();
  await sheet(p).getByTestId('version-compare').scrollIntoViewIfNeeded();
});
await workflow(8, 'recover-from-conflict', editor, async (p) => {
  await p.goto(`${BASE}/posts/${post.id}`); await ready(p);
  await p.getByRole('button', { name: 'Write' }).click().catch(() => undefined);
  const cur = (await editor.call('GET', `/api/posts/${post.id}`)).body;
  await editor.call('PUT', `/api/posts/${post.id}/autosave`, { base_version: cur.version, client_id: `qa_${tag}_other`, client_revision: 1, draft: { ...cur.draft, baseLink: 'https://example.com/theirs' } });
  const ta = p.locator('textarea[data-anchor-field="base"]');
  await ta.click(); await ta.press('End'); await ta.pressSequentially(' From my phone.');
  const dlg = p.getByRole('dialog', { name: 'Someone else saved a newer version' });
  await dlg.waitFor({ timeout: 20_000 });
  await p.screenshot({ path: 'evidence/collaboration/mobile/8a-conflict-dialog.png' });
  await dlg.getByRole('button', { name: 'Apply selected to latest' }).click();
  await p.getByTestId('save-status').and(p.locator('[data-save-state="saved"]')).waitFor({ timeout: 20_000 });
  const after = (await editor.call('GET', `/api/posts/${post.id}`)).body;
  if (!after.draft.baseText.endsWith('From my phone.') || after.draft.baseLink !== 'https://example.com/theirs') throw new Error('merge lost work');
});

await browser.close();
await db.query(`DELETE FROM sessions WHERE token_hash = ANY($1)`, [tokens.map((t) => createHash('sha256').update(t).digest())]);
await db.end();
const out = {
  generated_at: new Date().toISOString(), base: BASE, sizes: SIZES.map(([w, h]) => `${w}x${h}`), routes: ROUTES.length,
  overflow_issues: layout.filter((l) => l.page_overflow_px > 1), small_target_pages: layout.filter((l) => l.small_targets > 0).length,
  console_errors: layout.filter((l) => l.errors.length).map((l) => ({ url: l.url, width: l.width, errors: l.errors })), workflows: results, layout,
};
writeFileSync('evidence/collaboration/mobile-qa.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ overflow_issues: out.overflow_issues.length, workflows_ok: results.filter((r) => r.ok).length, workflows: results.length, console_errors: out.console_errors.length }));
