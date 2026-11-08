#!/usr/bin/env node
// V3.5 integrations evidence screenshots (DEV/LOCAL ONLY; synthetic + SIMULATED data from scripts/seed-integrations-demo.ts).
//   set -a; . ./.env; set +a; node scripts/integrations-shots.mjs [screen ...]
//   env: CHECKPOINT=1 → evidence/v3-5/integrations/checkpoints/<n>-<screen>-<theme>.png (1440, DPR 2)
//        otherwise   → evidence/v3-5/integrations/<screen>-<width>-<theme>.png   WIDTHS=1440,390  SCHEMES=light,dark  OUT=<dir>
//        MOBILE_QA=1  → no screenshots; checks page-level horizontal scroll at 320,360,390,430,768,1024,1440 for every screen.
// Signs in as Demo Workspace people by inserting short-lived session rows with MIGRATOR_DATABASE_URL. Never point this at production.
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';

const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const pg = require('pg');

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const checkpoint = process.env.CHECKPOINT === '1';
const qa = process.env.MOBILE_QA === '1';
const OUT = process.env.OUT ?? (checkpoint ? 'evidence/v3-5/integrations/checkpoints' : 'evidence/v3-5/integrations');
const only = process.argv.slice(2);
const widths = qa ? [320, 360, 390, 430, 768, 1024, 1440] : checkpoint ? [1440] : (process.env.WIDTHS || '1440,390').split(',').map(Number);
const schemes = qa ? ['light'] : (process.env.SCHEMES || 'light,dark').split(',');
if (!process.env.MIGRATOR_DATABASE_URL) throw new Error('MIGRATOR_DATABASE_URL is required (dev only)');
mkdirSync(OUT, { recursive: true });

const db = new pg.Pool({ connectionString: process.env.MIGRATOR_DATABASE_URL });
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const ws = (await one(`SELECT id FROM workspaces WHERE name='Demo Workspace' LIMIT 1`)).id;
const kase = await one(`SELECT c.id, v.id AS conv FROM care_cases c JOIN inbox_conversations v ON v.case_id=c.id WHERE c.workspace_id=$1 ORDER BY c.created_at LIMIT 1`, [ws]);
const mcPost = await one(`SELECT j.relay_id AS id FROM integration_sync_jobs j WHERE j.workspace_id=$1 AND j.kind='mailchimp.campaign' LIMIT 1`, [ws]);
const gbpPost = await one(`SELECT post_id AS id FROM gbp_local_posts WHERE workspace_id=$1 LIMIT 1`, [ws]);
if (!kase) throw new Error('Run scripts/seed-inbox-demo.ts and scripts/seed-integrations-demo.ts first');
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

const details = async (page) => { if (page.viewportSize().width < 1536) { await page.getByRole('button', { name: 'More actions' }).click(); await page.getByRole('menuitem', { name: 'Customer and case' }).click(); await page.getByRole('dialog').waitFor(); await page.waitForTimeout(800); } };
const tab = (name) => async (page) => { await page.getByRole('tab', { name }).click(); await page.waitForTimeout(600); await page.getByRole('tablist').evaluate((e) => e.scrollIntoView({ block: 'start' })); await page.evaluate(() => window.scrollBy(0, -90)); await page.waitForTimeout(300); };
const createTask = async (page) => { await details(page); await page.getByRole('button', { name: 'Create task' }).first().click(); await page.getByLabel('Title').last().fill('Call back about pickup time'); await page.getByRole('button', { name: 'Review' }).click(); await page.getByTestId('outbound-preview').waitFor(); };
const translateIn = async (page) => { await details(page); await page.getByRole('button', { name: 'Latest message' }).first().click(); await page.getByTestId('translation-incoming').first().waitFor(); };
const postSide = async (page) => { await page.getByTestId('post-integrations').scrollIntoViewIfNeeded(); };

// [name, url, session, action?, checkpoint number]
const SCREENS = [
  ['hub', '/integrations', owner, null, 1],
  ['asana', '/integrations/asana', owner, null, 2],
  ['asana-sync', '/integrations/asana', owner, tab('Sync rules'), 2],
  ['asana-history', '/integrations/asana', owner, tab('History'), 2],
  ['hubspot', '/integrations/hubspot', owner, null, 3],
  ['slack-alerts', '/integrations/slack', owner, tab('Settings'), 4],
  ['translate', '/integrations/google-translate', owner, tab('Settings'), 5],
  ['gbp', '/integrations/google-business-profile', owner, tab('Resources'), 6],
  ['mailchimp', '/integrations/mailchimp', owner, null, 6],
  ['inbox-external-work', `/inbox?queue=all&c=${kase.conv}`, owner, details, 7],
  ['inbox-create-task', `/inbox?queue=all&c=${kase.conv}`, owner, createTask, 7],
  ['inbox-translate', `/inbox?queue=all&c=${kase.conv}`, owner, translateIn, 8],
  ...(gbpPost ? [['post-integrations', `/posts/${gbpPost.id}`, owner, postSide, 9]] : []),
  ...(mcPost ? [['post-mailchimp', `/posts/${mcPost.id}`, owner, postSide, 9]] : []),
].filter(([n]) => !only.length || only.includes(n));

const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
let scrollIssues = 0;
for (const scheme of schemes) {
  for (const w of widths) {
    for (const [name, url, token, act, n] of SCREENS) {
      const ctx = await browser.newContext({ viewport: { width: w, height: w < 600 ? 844 : 900 }, colorScheme: scheme, deviceScaleFactor: qa ? 1 : 2 });
      await ctx.addCookies([{ name: 'sl_session', value: token, domain: new URL(BASE).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
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
      if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) {
        scrollIssues++; console.log('HORIZONTAL SCROLL', name, w, scheme);
        if (process.env.DEBUG_OVERFLOW) console.log(await page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && ![...e.children].some((c) => c.getBoundingClientRect().right > window.innerWidth + 1)).slice(0, 5).map((e) => `${e.tagName}.${String(e.className).slice(0, 80)} «${(e.textContent || '').slice(0, 50)}»`)));
      }
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
