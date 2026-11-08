#!/usr/bin/env node
// V3.5 listening evidence screenshots (DEV/LOCAL ONLY; synthetic Demo data from scripts/seed-listening-demo.ts).
//   set -a; . ./.env; set +a; node scripts/listening-shots.mjs [screen ...]
//   env: CHECKPOINT=1 → evidence/v3-5/listening/checkpoints/<n>-<screen>-<theme>.png (1440, DPR 2)
//        otherwise   → evidence/v3-5/listening/<screen>-<width>-<theme>.png   WIDTHS=1440,390  SCHEMES=light,dark  OUT=<dir>
//        MOBILE_QA=1  → no screenshots; checks page-level horizontal scroll at 320,360,390,430,768,1024,1440 for every screen.
// Signs in as the Demo Workspace owner by inserting a short-lived session row with MIGRATOR_DATABASE_URL. Never point this at production.
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';

const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const pg = require('pg');

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const checkpoint = process.env.CHECKPOINT === '1';
const qa = process.env.MOBILE_QA === '1';
const OUT = process.env.OUT ?? (checkpoint ? 'evidence/v3-5/listening/checkpoints' : 'evidence/v3-5/listening');
const only = process.argv.slice(2);
const widths = qa ? [320, 360, 390, 430, 768, 1024, 1440] : checkpoint ? [1440] : (process.env.WIDTHS || '1440,390').split(',').map(Number);
const schemes = qa ? ['light'] : (process.env.SCHEMES || 'light,dark').split(',');
if (!process.env.MIGRATOR_DATABASE_URL) throw new Error('MIGRATOR_DATABASE_URL is required (dev only)');
mkdirSync(OUT, { recursive: true });

const db = new pg.Pool({ connectionString: process.env.MIGRATOR_DATABASE_URL });
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const ws = (await one(`SELECT id FROM workspaces WHERE name='Demo Workspace' LIMIT 1`)).id;
const own = await one(`SELECT id FROM listening_searches WHERE workspace_id=$1 AND name='Vitalos' AND archived_at IS NULL`, [ws]);
const alert = await one(`SELECT a.id FROM listening_alerts a WHERE a.workspace_id=$1 ORDER BY a.created_at DESC LIMIT 1`, [ws]);
const dash = await one(`SELECT id FROM listening_dashboards WHERE workspace_id=$1 AND archived_at IS NULL LIMIT 1`, [ws]);
const mention = await one(`SELECT o.id FROM listening_observations o JOIN listening_matches m ON m.observation_id=o.id WHERE m.search_id=$1 AND o.sentiment_label='negative' ORDER BY o.occurred_at DESC LIMIT 1`, [own?.id]);
const rival = await one(`SELECT id FROM listening_searches WHERE workspace_id=$1 AND name='Brewly' AND archived_at IS NULL`, [ws]);
if (!own || !alert) throw new Error('Run scripts/seed-listening-demo.ts first');
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

const coverage = async (page) => { await page.getByRole('button', { name: 'Coverage' }).first().click(); };
const newSearch = async (page) => {
  await page.getByRole('button', { name: 'New search' }).click();
  const d = page.getByRole('dialog', { name: 'New saved search' });
  await d.getByLabel('Name', { exact: true }).fill('Pastries');
  await d.getByLabel('Names and aliases').fill('Vitalos');
  await d.getByLabel('Advanced query').fill('(tart OR croissant* OR scones) NOT job');
  await d.getByRole('button', { name: 'Test' }).click();
  await d.getByRole('status').waitFor();
};
const mentionMenu = async (page) => { await page.getByRole('button', { name: 'Mention actions' }).first().click(); };

// [name, url, action?, checkpoint number]
const SCREENS = [
  ['overview', '/listening', null, 1],
  ['search', `/listening/searches/${own.id}?days=30`, null, 2],
  ['search-coverage', `/listening/searches/${own.id}?days=30`, coverage, 2],
  ['search-menu', `/listening/searches/${own.id}?days=30`, mentionMenu, 3],
  ['new-search', '/listening', newSearch, 3],
  ['alert', `/listening/alerts/${alert.id}`, null, 4],
  ['mention', `/listening/mentions/${mention?.id}`, null, 4],
  ['compare', `/listening/compare?search_ids=${own.id},${rival?.id}&days=30`, null, 5],
  ['dashboard', `/listening/dashboards/${dash?.id}`, null, 5],
  ['sources', '/settings/listening/sources', null, 6],
].filter(([n]) => !only.length || only.includes(n));

const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
let scrollIssues = 0;
for (const scheme of schemes) {
  for (const w of widths) {
    for (const [name, url, act, n] of SCREENS) {
      const ctx = await browser.newContext({ viewport: { width: w, height: w < 600 ? 844 : 900 }, colorScheme: scheme, deviceScaleFactor: qa ? 1 : 2 });
      await ctx.addCookies([{ name: 'sl_session', value: owner, domain: new URL(BASE).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
      const page = await ctx.newPage();
      page.setDefaultTimeout(30_000);
      page.on('pageerror', (e) => console.log('pageerror', name, e.message.slice(0, 300)));
      page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 400) console.log('api', r.status(), name, w, r.url().replace(BASE, '').slice(0, 100)); });
      await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await page.waitForFunction(() => !document.querySelector('.skeleton') && !document.body.innerText.includes('Loading…'), null, { timeout: 60_000 }).catch(() => console.log('still loading', name));
      if (act) await act(page, ctx).catch((e) => console.log('action failed', name, e.message.slice(0, 160)));
      await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' }).catch(() => {});
      await page.waitForTimeout(qa ? 300 : 900);
      if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) { scrollIssues++; console.log('HORIZONTAL SCROLL', name, w, scheme); }
      if (!qa) {
        const file = checkpoint ? `${OUT}/${n}-${name}-${scheme}.png` : `${OUT}/${name}-${w}-${scheme}.png`;
        await page.screenshot({ path: file });
        console.log('shot', file);
      }
      await ctx.close();
    }
  }
}
await browser.close();
await db.query(`DELETE FROM sessions WHERE token_hash = ANY($1)`, [tokens.map((t) => createHash('sha256').update(t).digest())]);
await db.end();
console.log(JSON.stringify({ done: true, widths, screens: SCREENS.length, horizontal_scroll_issues: scrollIssues }));
