#!/usr/bin/env node
// V5 final (lead) — evidence over the V5 screens (DEV/LOCAL ONLY; synthetic data: Demo Workspace = legacy plan,
// "E2E Billing" = trial). Signs in by inserting short-lived session rows with MIGRATOR_DATABASE_URL. Never point this at production.
//   set -a; . ./.env; set +a; node scripts/v5-final-shots.mjs [screen ...]
//   default        → evidence/v5/final/<screen>-<width>-<theme>.png   (WIDTHS=1440,390 SCHEMES=light,dark)
//   MOBILE_QA=1    → no screenshots; page-level horizontal scroll at 320,360,390,430,768,1024,1440 for every screen
//                     (+ evidence/v5/final/mobile-qa.json)
//   PERF=1         → cold + warm load timings (DOMContentLoaded, first data API, all APIs settled) at 1440 →
//                     evidence/v5/final/perf.json
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const pg = require('pg');

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const qa = process.env.MOBILE_QA === '1';
const perf = process.env.PERF === '1';
const OUT = process.env.OUT ?? 'evidence/v5/final';
const only = process.argv.slice(2);
const widths = qa ? [320, 360, 390, 430, 768, 1024, 1440] : perf ? [1440] : (process.env.WIDTHS || '1440,390').split(',').map(Number);
const schemes = qa || perf ? ['light'] : (process.env.SCHEMES || 'light,dark').split(',');
if (!process.env.MIGRATOR_DATABASE_URL) throw new Error('MIGRATOR_DATABASE_URL is required (dev only)');
mkdirSync(OUT, { recursive: true });

const db = new pg.Pool({ connectionString: process.env.MIGRATOR_DATABASE_URL });
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0] ?? null;
const ws = (await one(`SELECT id FROM workspaces WHERE name='Demo Workspace' LIMIT 1`)).id;
const billingWs = (await one(`SELECT id FROM workspaces WHERE name='E2E Billing' LIMIT 1`))?.id ?? ws;
const ticket = await one(`SELECT reference FROM support_tickets ORDER BY created_at DESC LIMIT 1`);
const myTicket = await one(`SELECT t.reference FROM support_tickets t JOIN users u ON u.id=t.requester_user_id WHERE u.email='owner@demo.social-lite.test' AND t.workspace_id=$1 ORDER BY t.created_at DESC LIMIT 1`, [ws]);
const tokens = [];
async function session(email, workspaceId = ws) {
  const u = await one(`SELECT id FROM users WHERE email=$1`, [email]);
  const token = randomBytes(32).toString('base64url');
  await db.query(`INSERT INTO sessions(user_id, token_hash, csrf_token, active_workspace_id, expires_at, mfa_verified, auth_time, acr, amr)
    VALUES ($1,$2,$3,$4,now() + interval '1 hour',true,now(),'mfa','{pwd,otp}')`, [u.id, createHash('sha256').update(token).digest(), randomUUID(), workspaceId]);
  tokens.push(token);
  return token;
}
const owner = await session('owner@demo.social-lite.test');
const billingOwner = await session('owner@demo.social-lite.test', billingWs);
const opOk = await one(`SELECT 1 AS ok FROM platform_operators o JOIN users u ON u.id=o.user_id WHERE u.email='owner@demo.social-lite.test' AND o.revoked_at IS NULL`);

// [name, url, action?, session?] — V5 screens (marketing, signup handoff, AI workspace, admin/platform V5 pages).
const SCREENS = [
  ['marketing', '/', null, 'anon'],
  ['marketing-signed-in', '/'],
  ['signup-handoff', '/signup?plan=standard&seats=3'],
  ['assistant', '/assistant'],
  ['admin-ai', '/admin/ai'],
  ...(opOk ? [
    ['platform-marketing', '/admin/platform/marketing'],
    ['platform-ai', '/admin/platform/ai'],
    ['platform-support-widget', '/admin/platform/support?queue=open&source=widget'],
  ] : []),
].filter(([n]) => !only.length || only.includes(n));

const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
let scrollIssues = 0;
const qaRows = [];
const perfRows = [];
for (const scheme of schemes) {
  for (const w of widths) {
    for (const [name, url, act, who] of SCREENS) {
      const runs = perf ? ['cold', 'warm'] : ['once'];
      const ctx = await browser.newContext({ viewport: { width: w, height: w < 600 ? 844 : 900 }, colorScheme: scheme, deviceScaleFactor: qa || perf ? 1 : 2 });
      if (who !== 'anon') await ctx.addCookies([{ name: 'sl_session', value: who === 'billing' ? billingOwner : owner, domain: new URL(BASE).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
      for (const run of runs) {
        const page = await ctx.newPage();
        page.setDefaultTimeout(30_000);
        page.on('pageerror', (e) => console.log('pageerror', name, e.message.slice(0, 300)));
        const apis = [];
        const t0 = Date.now();
        page.on('response', (r) => {
          const u = r.url().replace(BASE, '');
          if (u.startsWith('/api/') && !u.startsWith('/api/session') && !u.includes('/stream')) apis.push({ u: u.slice(0, 80), at: Date.now() - t0, s: r.status() });
          if (u.startsWith('/api/') && r.status() >= 400) console.log('api', r.status(), name, w, u.slice(0, 100));
        });
        await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
        const dcl = Date.now() - t0;
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
        await page.waitForFunction(() => !document.querySelector('.skeleton') && !document.body.innerText.includes('Loading…'), null, { timeout: 60_000 }).catch(() => console.log('still loading', name));
        const ready = Date.now() - t0;
        if (perf) perfRows.push({ screen: name, run, dom_content_loaded_ms: dcl, first_api_ms: apis[0]?.at ?? null, settled_ms: ready, api_calls: apis.length, slowest_api: apis.sort((a, b) => b.at - a.at)[0] ?? null });
        if (act && !perf) await act(page, ctx).catch((e) => console.log('action failed', name, e.message.slice(0, 160)));
        await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' }).catch(() => {});
        if (!perf) {
          await page.waitForTimeout(qa ? 300 : 900);
          const over = await page.evaluate(() => {
            const sw = document.documentElement.scrollWidth;
            if (sw <= window.innerWidth + 1) return null;
            const wide = [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).slice(-3)
              .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`);
            return { sw, wide };
          });
          if (over) { scrollIssues++; console.log('HORIZONTAL SCROLL', name, w, scheme, JSON.stringify(over)); }
          if (qa) qaRows.push({ screen: name, width: w, horizontal_scroll: !!over });
          else { const file = `${OUT}/${name}-${w}-${scheme}.png`; await page.screenshot({ path: file }); console.log('shot', file); }
        }
        await page.close();
      }
      await ctx.close();
    }
  }
}
await browser.close();
await db.query(`DELETE FROM sessions WHERE token_hash = ANY($1)`, [tokens.map((t) => createHash('sha256').update(t).digest())]);
await db.end();
if (qa) writeFileSync(`${OUT}/mobile-qa.json`, JSON.stringify({ at: new Date().toISOString(), widths, screens: SCREENS.map((s) => s[0]), horizontal_scroll_issues: scrollIssues, rows: qaRows }, null, 1));
if (perf) writeFileSync(`${OUT}/perf.json`, JSON.stringify({ at: new Date().toISOString(), base: BASE, note: 'Production build on the shared dev host; Demo Workspace data; Chromium headless 1440 px.', rows: perfRows }, null, 1));
console.log(JSON.stringify({ done: true, widths, screens: SCREENS.length, horizontal_scroll_issues: scrollIssues }));
