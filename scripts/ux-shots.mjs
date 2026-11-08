#!/usr/bin/env node
// V3 UX evidence screenshots (DEV ONLY). Regenerates evidence/v3/ux/<screen>-<width>-<theme>.png at deviceScaleFactor 2.
//
//   set -a; . ./.env; set +a; node scripts/ux-shots.mjs [outDir] [screen ...]
//   env: WIDTHS=1440,390  SCHEMES=light,dark  CHECKPOINT=<n>  (checkpoint mode: 1440 only, <outDir>/<n>-<screen>-<theme>.png)
//
// Signs in as the demo workspace owner by inserting a short-lived session row with MIGRATOR_DATABASE_URL (never use
// against production). For the composer shots it ensures one draft titled "Autumn menu launch (UX showcase)" on the
// synthetic Relay Coffee brand with all ten destinations, created through the normal API.
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';

const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const pg = require('pg');

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const OUT = process.argv[2] && !process.argv[2].includes('=') ? process.argv[2] : 'evidence/v3/ux';
const only = process.argv.slice(OUT === process.argv[2] ? 3 : 2);
const widths = (process.env.WIDTHS || '1440,390').split(',').map(Number);
const schemes = (process.env.SCHEMES || 'light,dark').split(',');
const checkpoint = process.env.CHECKPOINT;
if (!process.env.MIGRATOR_DATABASE_URL) throw new Error('MIGRATOR_DATABASE_URL is required (dev only)');
mkdirSync(OUT, { recursive: true });

const db = new pg.Pool({ connectionString: process.env.MIGRATOR_DATABASE_URL });
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const ws = (await one(`SELECT id FROM workspaces WHERE is_demo ORDER BY created_at LIMIT 1`)).id;
const owner = (await one(`SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.workspace_id=$1 AND m.role='owner' LIMIT 1`, [ws])).id;
const token = randomBytes(32).toString('base64url');
const csrf = randomUUID();
await db.query(`INSERT INTO sessions(user_id, token_hash, csrf_token, active_workspace_id, expires_at, mfa_verified, auth_time, acr, amr)
  VALUES ($1,$2,$3,$4,now() + interval '1 hour',true,now(),'mfa','{pwd,otp}')`, [owner, createHash('sha256').update(token).digest(), csrf, ws]);

const call = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method, headers: { origin: BASE, cookie: `sl_session=${token}`, 'content-type': 'application/json', 'x-csrf-token': csrf, 'x-workspace-id': ws, 'idempotency-key': randomUUID() }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// ---- showcase draft (idempotent by title)
const TITLE = 'Autumn menu launch (UX showcase)';
const coffee = await one(`SELECT id FROM brands WHERE workspace_id=$1 AND name ILIKE 'Relay Coffee%' LIMIT 1`, [ws]);
let showcase = null;
if (coffee) {
  const existing = await one(`SELECT id FROM posts WHERE brand_id=$1 AND title=$2 AND archived_at IS NULL LIMIT 1`, [coffee.id, TITLE]);
  if (existing) showcase = existing.id;
  else {
    const conns = (await call('GET', `/api/brands/${coffee.id}/connections`)).body?.items ?? [];
    const variants = conns.filter((c) => c.status !== 'disconnected').map((c) => ({ connectionId: c.id, inheritText: true, inheritMedia: true }));
    const r = await call('POST', `/api/brands/${coffee.id}/posts`, { title: TITLE, draft: { baseText: 'Our autumn menu lands Monday: maple oat latte, spiced pear cold brew and a new single-origin from Huila. Come early, the first 50 cups are on us.', baseLink: 'https://example.com/autumn', baseAssetIds: [], variants } });
    showcase = r.body?.id ?? null;
    if (!showcase) console.log('showcase draft not created', r.status, JSON.stringify(r.body).slice(0, 300));
  }
}
const firstPost = await one(`SELECT p.id FROM posts p JOIN schedules s ON s.post_id=p.id WHERE p.workspace_id=$1 AND p.archived_at IS NULL AND s.status='completed' ORDER BY s.due_at DESC LIMIT 1`, [ws]);

// ---- screens: [name, url, optional action]
const SCREENS = [
  ['overview', '/'],
  ['planner-week', '/planner?view=week'],
  ['planner-drawer', '/planner?view=week', async (page) => { await page.locator('main [role=listitem] button, main section li button').first().click(); await page.getByRole('dialog').waitFor(); await page.waitForTimeout(1500); }],
  ['planner-month', '/planner?view=month'],
  ['planner-list', '/planner?view=agenda'],
  ['create', '/compose'],
  ...(showcase ? [
    ['composer', `/posts/${showcase}`],
    ['composer-youtube', `/posts/${showcase}`, async (page) => { const step = page.getByRole('radio', { name: /^Destinations/ }); if (await step.isVisible().catch(() => false)) await step.click(); await page.getByRole('button', { name: /YouTube Relay Coffee/ }).first().click(); }],
  ] : []),
  ...(firstPost ? [['composer-published', `/posts/${firstPost.id}`]] : []),
  ['connections', '/accounts'],
  ['connections-bluesky', '/accounts', async (page) => { await page.getByRole('button', { name: /^Connect/ }).first().click(); await page.getByRole('dialog').getByRole('button', { name: /Bluesky/ }).click(); await page.getByLabel('App password').waitFor(); }],
  ['library', '/library'],
  ['campaigns', '/campaigns'],
  ['approvals', '/approvals'],
  ['analytics', '/analytics?dataset=demo'],
  ['analytics-content', '/analytics/content?dataset=demo&sort=engagements'],
  ['analytics-channels', '/analytics/channels?dataset=demo'],
  ['analytics-video', '/analytics/video?dataset=demo'],
  ['analytics-audience', '/analytics/audience?dataset=demo'],
  ['analytics-workflow', '/analytics/workflow?dataset=demo'],
  ['team', '/team'],
  ['history', '/history'],
  ['settings', '/settings/workspace/general'],
  ['settings-mcp', '/settings/developer/mcp'],
  ['settings-sources', '/settings/connections/google'],
  ['settings-security', '/security'],
].filter(([n]) => !only.length || only.includes(n));

const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
for (const scheme of schemes) {
  for (const w of checkpoint ? [1440] : widths) {
    const ctx = await browser.newContext({ viewport: { width: w, height: w < 600 ? 844 : 900 }, colorScheme: scheme, deviceScaleFactor: 2 });
    await ctx.addCookies([{ name: 'sl_session', value: token, domain: new URL(BASE).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
    const page = await ctx.newPage();
    page.setDefaultTimeout(30_000);
    page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 300)));
    for (const [name, url, act] of SCREENS) {
      // Retry once: the dev server can restart or recompile mid-navigation.
      try { await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle', timeout: 180_000 }); }
      catch (e) { console.log('retry', name, e.message.slice(0, 80)); await page.waitForTimeout(5000); await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle', timeout: 180_000 }); }
      await page.waitForSelector('main', { timeout: 180_000 }).catch(() => {});
      // Wait for content, not just network idle (the dev server compiles on first hit).
      await page.waitForFunction(() => !document.querySelector('[role=status][aria-label=Loading], [aria-label="Loading post"], .skeleton'), null, { timeout: 60_000 }).catch(() => console.log('still loading', name));
      if (act) await act(page).catch((e) => console.log('action failed', name, e.message.slice(0, 120)));
      await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' }).catch(() => {});
      await page.waitForTimeout(900);
      if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) console.log('HORIZONTAL SCROLL', name, w, scheme);
      const file = checkpoint ? `${OUT}/${checkpoint}-${name}-${scheme}.png` : `${OUT}/${name}-${w}-${scheme}.png`;
      await page.screenshot({ path: file });
      console.log('shot', file);
    }
    await ctx.close();
  }
}
await browser.close();
await db.query(`DELETE FROM sessions WHERE token_hash=$1`, [createHash('sha256').update(token).digest()]);
await db.end();
