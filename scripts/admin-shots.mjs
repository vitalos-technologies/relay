#!/usr/bin/env node
// V3.1 Admin evidence screenshots (DEV/LOCAL ONLY; synthetic Demo data).
//   set -a; . ./.env; set +a; node scripts/admin-shots.mjs [screen ...]
//   env: CHECKPOINT=1 → evidence/v3-1/admin/checkpoints/<n>-<screen>-<theme>.png (1440, DPR 2)
//        otherwise   → evidence/v3-1/admin/<screen>-<width>-<theme>.png   WIDTHS=1440,390  SCHEMES=light,dark  OUT=<dir>
// Signs in as the Demo Workspace owner (also the seeded platform operator) by inserting a short-lived session row with
// MIGRATOR_DATABASE_URL. Never point this at production.
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';

const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const pg = require('pg');

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const checkpoint = process.env.CHECKPOINT === '1';
const OUT = process.env.OUT ?? (checkpoint ? 'evidence/v3-1/admin/checkpoints' : 'evidence/v3-1/admin');
const only = process.argv.slice(2);
const widths = checkpoint ? [1440] : (process.env.WIDTHS || '1440,390').split(',').map(Number);
const schemes = (process.env.SCHEMES || 'light,dark').split(',');
if (!process.env.MIGRATOR_DATABASE_URL) throw new Error('MIGRATOR_DATABASE_URL is required (dev only)');
mkdirSync(OUT, { recursive: true });

const db = new pg.Pool({ connectionString: process.env.MIGRATOR_DATABASE_URL });
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const ws = (await one(`SELECT id FROM workspaces WHERE name='Demo Workspace' LIMIT 1`)).id;
const owner = (await one(`SELECT id FROM users WHERE email='owner@demo.social-lite.test'`)).id;
const tokens = [];
async function session(workspaceId) {
  const token = randomBytes(32).toString('base64url');
  await db.query(`INSERT INTO sessions(user_id, token_hash, csrf_token, active_workspace_id, expires_at, mfa_verified, auth_time, acr, amr)
    VALUES ($1,$2,$3,$4,now() + interval '1 hour',true,now(),'mfa','{pwd,otp}')`, [owner, createHash('sha256').update(token).digest(), randomUUID(), workspaceId]);
  tokens.push(token);
  return token;
}
const token = await session(ws);
const other = await one(`SELECT id FROM workspaces WHERE name='Other Workspace' LIMIT 1`);

const firstRowDrawer = async (page) => {
  await page.locator('main tbody tr').first().click().catch(async () => { await page.locator('main ul[aria-label] li button').first().click(); });
  await page.getByRole('dialog').waitFor();
  await page.waitForFunction(() => !document.querySelector('[role=dialog] .skeleton'), null, { timeout: 60_000 });
  await page.waitForTimeout(500);
};

// [name, url, action?, checkpoint number]
const SCREENS = [
  ['overview', '/admin', null, 1],
  ['nav-drawer', '/admin', async (page) => { if (page.viewportSize().width < 1024) { await page.getByRole('button', { name: 'Open navigation' }).click(); await page.waitForTimeout(500); } }, 1],
  ['jump', '/admin', async (page) => { await page.keyboard.press('Control+k'); await page.getByRole('combobox', { name: 'Jump to' }).fill('dead'); await page.waitForTimeout(400); }, 1],
  ['people', '/admin/people', null, 2],
  ['member', '/admin/people', async (page) => { await page.locator('main a[href^="/admin/people/members/"]:visible').nth(2).click(); await page.waitForURL(/members\//); await page.waitForLoadState('networkidle'); await page.waitForTimeout(800); }, 2],
  ['publishing', '/admin/publishing', null, 3],
  ['publishing-attention', '/admin/publishing?state=attention', firstRowDrawer, 3],
  ['approvals', '/admin/approvals', null, 3],
  ['connections', '/admin/connections', null, 4],
  ['connection-drawer', '/admin/connections', firstRowDrawer, 4],
  ['content', '/admin/content', null, 5],
  ['analytics', '/admin/analytics', null, 5],
  ['developer-webhooks', '/admin/developer/webhooks', null, 6],
  ['mcp', '/admin/settings/developer/mcp', null, 6],
  ['audit', '/admin/security/audit', null, 7],
  ['support', '/admin/security/support', null, 7],
  ['operations', '/admin/operations', null, 8],
  ['usage', '/admin/usage', null, 8],
  ['settings', '/admin/settings/workspace/general', null, 8],
  ['platform', '/admin/platform', null, 9],
  ['platform-workspaces', '/admin/platform/workspaces', null, 9],
  ['platform-workspace', `/admin/platform/workspaces/${other?.id ?? ''}`, null, 9],
  ['platform-rollouts', '/admin/platform/rollouts', null, 10],
  ['platform-support', '/admin/platform/support', null, 10],
  ['platform-audit', '/admin/platform/audit', null, 10],
  ['platform-integrations', '/admin/platform/integrations', null, 10],
  ['help', '/admin/help', null, 11],
].filter(([n]) => !only.length || only.includes(n));

const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
let scrollIssues = 0;
for (const scheme of schemes) {
  for (const w of widths) {
    for (const [name, url, act, n] of SCREENS) {
      const ctx = await browser.newContext({ viewport: { width: w, height: w < 600 ? 844 : 900 }, colorScheme: scheme, deviceScaleFactor: 2 });
      await ctx.addCookies([{ name: 'sl_session', value: token, domain: new URL(BASE).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
      const page = await ctx.newPage();
      page.setDefaultTimeout(30_000);
      page.on('pageerror', (e) => console.log('pageerror', name, e.message.slice(0, 300)));
      page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 400) console.log('api', r.status(), name, w, r.url().replace(BASE, '').slice(0, 100)); });
      try { await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle', timeout: 180_000 }); }
      catch (e) { console.log('retry', name, e.message.slice(0, 80)); await page.waitForTimeout(5000); await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle', timeout: 180_000 }); }
      await page.waitForFunction(() => !document.querySelector('.skeleton'), null, { timeout: 60_000 }).catch(() => console.log('still loading', name));
      if (act) await act(page, ctx).catch((e) => console.log('action failed', name, e.message.slice(0, 160)));
      await page.waitForFunction(() => !document.querySelector('.skeleton'), null, { timeout: 60_000 }).catch(() => console.log('still loading after action', name));
      await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' }).catch(() => {});
      await page.waitForTimeout(700);
      if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) { scrollIssues++; console.log('HORIZONTAL SCROLL', name, w, scheme); }
      const file = checkpoint ? `${OUT}/${n}-${name}-${scheme}.png` : `${OUT}/${name}-${w}-${scheme}.png`;
      await page.screenshot({ path: file });
      console.log('shot', file);
      await ctx.close();
    }
  }
}
await browser.close();
await db.query(`DELETE FROM sessions WHERE token_hash = ANY($1)`, [tokens.map((t) => createHash('sha256').update(t).digest())]);
await db.end();
console.log(JSON.stringify({ done: true, horizontal_scroll_issues: scrollIssues }));
