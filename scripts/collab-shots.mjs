#!/usr/bin/env node
// Collaboration evidence screenshots (DEV/LOCAL ONLY; synthetic Demo data from scripts/seed-collab-demo.ts).
//   set -a; . ./.env; set +a; node scripts/collab-shots.mjs [screen ...]
//   env: CHECKPOINT=1 → evidence/collaboration/checkpoints/<n>-<screen>-<theme>.png (1440, DPR 2)
//        otherwise   → evidence/collaboration/<screen>-<width>-<theme>.png   WIDTHS=1440,390  SCHEMES=light,dark  OUT=<dir>
// Signs in as Demo Workspace people by inserting short-lived session rows with MIGRATOR_DATABASE_URL. Never point this at production.
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';

const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const pg = require('pg');

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const checkpoint = process.env.CHECKPOINT === '1';
const OUT = process.env.OUT ?? (checkpoint ? 'evidence/collaboration/checkpoints' : 'evidence/collaboration');
const only = process.argv.slice(2);
const widths = checkpoint ? [1440] : (process.env.WIDTHS || '1440,390').split(',').map(Number);
const schemes = (process.env.SCHEMES || 'light,dark').split(',');
if (!process.env.MIGRATOR_DATABASE_URL) throw new Error('MIGRATOR_DATABASE_URL is required (dev only)');
mkdirSync(OUT, { recursive: true });

const db = new pg.Pool({ connectionString: process.env.MIGRATOR_DATABASE_URL });
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const ws = (await one(`SELECT id FROM workspaces WHERE name='Demo Workspace' LIMIT 1`)).id;
const post = await one(`SELECT id FROM posts WHERE workspace_id=$1 AND title='Spring menu launch (collaboration demo)' AND deleted_at IS NULL`, [ws]);
if (!post) throw new Error('Run scripts/seed-collab-demo.ts first');
const review = await one(`SELECT a.id, a.post_id FROM approvals a JOIN posts p ON p.id=a.post_id WHERE a.workspace_id=$1 AND p.title='Weekend picks (review demo)' ORDER BY a.requested_at DESC LIMIT 1`, [ws]);
const tokens = [];
async function session(email) {
  const u = await one(`SELECT id FROM users WHERE email=$1`, [email]);
  const token = randomBytes(32).toString('base64url');
  await db.query(`INSERT INTO sessions(user_id, token_hash, csrf_token, active_workspace_id, expires_at, mfa_verified, auth_time, acr, amr)
    VALUES ($1,$2,$3,$4,now() + interval '1 hour',true,now(),'mfa','{pwd,otp}')`, [u.id, createHash('sha256').update(token).digest(), randomUUID(), ws]);
  tokens.push(token);
  return token;
}
const owner = await session('owner@demo.social-lite.test');
const approver = await session('approver@demo.social-lite.test');
const editor = await session('editor@demo.social-lite.test');

const openVersion = async (page) => { await page.locator('[aria-label="Versions"] button').nth(1).click(); await page.getByTestId('version-compare').waitFor(); };
const conflict = async (page) => {
  // Someone else saves first (another tab of the editor), then this tab edits → the conflict dialog.
  const s = await page.request.get(`${BASE}/api/session`); const csrf = (await s.json()).csrf_token;
  const p = await (await page.request.get(`${BASE}/api/posts/${post.id}`)).json();
  await page.request.put(`${BASE}/api/posts/${post.id}/autosave`, { headers: { 'content-type': 'application/json', origin: BASE, 'x-csrf-token': csrf },
    data: JSON.stringify({ base_version: p.version, client_id: `shot_${randomUUID().slice(0, 12)}`, client_revision: 1, draft: { ...p.draft, baseText: `${p.draft.baseText} Walk-ins welcome.` } }) });
  const ta = page.locator('textarea[data-anchor-field="base"]');
  await ta.click(); await ta.press('End'); await ta.type(' Limited tables.');
  await page.getByRole('dialog').waitFor({ timeout: 20_000 });
};
const sheet = async (page) => {
  if (page.viewportSize().width >= 1280) return;
  const dlg = page.getByRole('dialog', { name: 'Collaborate' });
  // Deep links (?panel= / ?thread=) open the sheet by themselves.
  if (!(await dlg.isVisible().catch(() => false))) await page.getByRole('button', { name: /Collaborate/ }).click();
  await dlg.waitFor(); await page.waitForTimeout(600);
};
const mention = async (page) => {
  await sheet(page);
  const box = page.getByRole('combobox', { name: /New internal comment/ });
  await box.click(); await box.type('Thanks @apr'); await page.getByRole('listbox').waitFor(); await page.waitForTimeout(400);
};
const firstTask = async (page) => { await page.getByTestId('task-row').first().click(); await page.getByRole('dialog').waitFor(); await page.waitForTimeout(600); };

// [name, url, session, action?, checkpoint number]
const SCREENS = [
  ['discussion', `/posts/${post.id}?panel=discussion`, editor, sheet, 1],
  ['mention', `/posts/${post.id}?panel=discussion`, editor, mention, 1],
  ['tasks-panel', `/posts/${post.id}?panel=tasks`, editor, sheet, 2],
  ['tasks', '/tasks', approver, null, 2],
  ['task-drawer', '/tasks?view=team', owner, firstTask, 2],
  ['review-panel', review ? `/posts/${review.post_id}?panel=review` : `/posts/${post.id}?panel=review`, editor, sheet, 3],
  ['approval', review ? `/approvals/${review.id}` : '/approvals', approver, null, 3],
  ['notifications', '/notifications', approver, null, 4],
  ['bell', '/planner', approver, async (page) => { await page.getByRole('button', { name: /^Notifications/ }).click(); await page.waitForTimeout(600); }, 4],
  ['history', `/posts/${post.id}?panel=history`, editor, async (page) => { await sheet(page); await openVersion(page); }, 5],
  ['activity', `/posts/${post.id}?panel=activity`, editor, sheet, 5],
  ['conflict', `/posts/${post.id}`, editor, conflict, 6],
  ['planner', '/planner?view=list', editor, null, 7],
  ['admin-collab', '/admin/collaboration', owner, null, 8],
  ['admin-reassign', '/admin/collaboration/reassign', owner, null, 8],
  ['admin-delivery', '/admin/collaboration/notifications', owner, null, 8],
  ['admin-settings', '/admin/collaboration/settings', owner, null, 8],
  ['platform-collab', '/admin/platform/collaboration', owner, null, 8],
].filter(([n]) => !only.length || only.includes(n));

// Seed text (scripts/seed-collab-demo.ts); restored after the run.
const original = { baseText: 'Spring menu is here 🌱 Fresh peas, wild garlic and our new lemon tart. Book a table this weekend and try all three.' };
const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
async function restoreText() {
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: 'sl_session', value: editor, domain: new URL(BASE).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
  const s = await (await ctx.request.get(`${BASE}/api/session`)).json();
  const p = await (await ctx.request.get(`${BASE}/api/posts/${post.id}`)).json();
  if (p.draft.baseText !== original.baseText) {
    await ctx.request.put(`${BASE}/api/posts/${post.id}/autosave`, { headers: { 'content-type': 'application/json', origin: BASE, 'x-csrf-token': s.csrf_token },
      data: JSON.stringify({ base_version: p.version, client_id: `shot_${randomUUID().slice(0, 12)}`, client_revision: 1, draft: { ...p.draft, baseText: original.baseText } }) });
  }
  await ctx.close();
}
await restoreText();
let scrollIssues = 0;
for (const scheme of schemes) {
  for (const w of widths) {
    for (const [name, url, token, act, n] of SCREENS) {
      const ctx = await browser.newContext({ viewport: { width: w, height: w < 600 ? 844 : 900 }, colorScheme: scheme, deviceScaleFactor: 2 });
      await ctx.addCookies([{ name: 'sl_session', value: token, domain: new URL(BASE).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
      const page = await ctx.newPage();
      page.setDefaultTimeout(30_000);
      page.on('pageerror', (e) => console.log('pageerror', name, e.message.slice(0, 300)));
      page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 400 && !r.url().includes('/autosave')) console.log('api', r.status(), name, w, r.url().replace(BASE, '').slice(0, 100)); });
      await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {}); // the change stream keeps a connection open
      await page.waitForFunction(() => !document.querySelector('.skeleton'), null, { timeout: 60_000 }).catch(() => console.log('still loading', name));
      if (act) await act(page, ctx).catch((e) => console.log('action failed', name, e.message.slice(0, 160)));
      await page.waitForFunction(() => !document.querySelector('.skeleton'), null, { timeout: 30_000 }).catch(() => console.log('still loading after action', name));
      await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' }).catch(() => {});
      await page.waitForTimeout(900);
      if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) { scrollIssues++; console.log('HORIZONTAL SCROLL', name, w, scheme); }
      const file = checkpoint ? `${OUT}/${n}-${name}-${scheme}.png` : `${OUT}/${name}-${w}-${scheme}.png`;
      await page.screenshot({ path: file });
      console.log('shot', file);
      await ctx.close();
      if (name === 'conflict') await restoreText(); // the conflict screen saves a change as "another tab"
    }
  }
}
await browser.close();
await db.query(`DELETE FROM sessions WHERE token_hash = ANY($1)`, [tokens.map((t) => createHash('sha256').update(t).digest())]);
await db.end();
console.log(JSON.stringify({ done: true, horizontal_scroll_issues: scrollIssues }));
