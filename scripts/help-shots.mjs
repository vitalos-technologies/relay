#!/usr/bin/env node
// HC — Help Centre evidence (DEV/LOCAL ONLY; synthetic data). Signs in by inserting short-lived session rows with
// MIGRATOR_DATABASE_URL (same approach as scripts/v5-final-shots.mjs). Never point this at production.
//   set -a; . ./.env; set +a; node scripts/help-shots.mjs [screen ...]
//   default     → evidence/docs/hc/<screen>-<width>-<theme>.png  (WIDTHS=1440,390 SCHEMES=light,dark)
//   MOBILE_QA=1 → no screenshots; page-level horizontal scroll at 320,360,390,430,768,1024,1440 → evidence/docs/hc/mobile-qa.json
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const pg = require('pg');

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const qa = process.env.MOBILE_QA === '1';
const OUT = process.env.OUT ?? 'evidence/docs/hc';
const only = process.argv.slice(2);
const widths = qa ? [320, 360, 390, 430, 768, 1024, 1440] : (process.env.WIDTHS || '1440,390').split(',').map(Number);
const schemes = qa ? ['light'] : (process.env.SCHEMES || 'light,dark').split(',');
if (!process.env.MIGRATOR_DATABASE_URL) throw new Error('MIGRATOR_DATABASE_URL is required (dev only)');
mkdirSync(OUT, { recursive: true });

const db = new pg.Pool({ connectionString: process.env.MIGRATOR_DATABASE_URL });
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0] ?? null;
const ws = (await one(`SELECT id FROM workspaces WHERE name='Demo Workspace' LIMIT 1`)).id;
const tokens = [];
async function session(email) {
  const u = await one(`SELECT id FROM users WHERE email=$1`, [email]);
  const token = randomBytes(32).toString('base64url');
  await db.query(`INSERT INTO sessions(user_id, token_hash, csrf_token, active_workspace_id, expires_at, mfa_verified, auth_time, acr, amr)
    VALUES ($1,$2,$3,$4,now() + interval '1 hour',true,now(),'mfa','{pwd,otp}')`, [u.id, createHash('sha256').update(token).digest(), randomUUID(), ws]);
  tokens.push(token);
  return token;
}
const who = { owner: await session('owner@demo.social-lite.test'), member: await session('editor@demo.social-lite.test') };

// [name, url, session ('anon' | 'member' | 'owner'), action?]
const SCREENS = [
  ['home-public', '/help', 'anon'],
  ['home-member', '/help', 'member'],
  ['section-member', '/help/teams-and-approvals', 'member'],
  ['article-member', '/help/getting-started/find-your-way-around', 'member'],
  ['article-table', '/help/teams-and-approvals/roles-and-permissions', 'member'],
  ['article-signin-prompt', '/help/getting-started/find-your-way-around', 'anon'],
  ['article-admin', '/help/getting-started/first-steps-for-workspace-admins', 'owner'],
  ['search-results', '/help?q=schedule', 'member'],
  ['search-suggestions', '/help', 'member', async (p) => { const b = p.getByRole('combobox', { name: 'Search help' }); await b.click(); await b.pressSequentially('approval', { delay: 20 }); await p.getByRole('listbox', { name: 'Suggested articles' }).getByRole('option').first().waitFor(); await p.keyboard.press('ArrowDown'); }],
  ['mobile-browse', '/help/getting-started/glossary', 'anon', async (p, w) => { if (w < 1024) { await p.locator('details summary').first().click(); } }],
  ['contextual-planner', '/planner', 'member', async (p) => { await p.locator('a[data-help-slug="time-zones-and-dst"]').first().waitFor(); }],
  ['contextual-settings', '/settings/people/security-policy', 'owner'],
  ['admin-help', '/admin/help', 'owner'],
  ['support-nav', '/help/contact', 'member'],
];

const browser = await chromium.launch();
const results = [];
try {
  for (const [name, url, as, action] of SCREENS) {
    if (only.length && !only.includes(name)) continue;
    for (const w of widths) for (const scheme of schemes) {
      const ctx = await browser.newContext({ viewport: { width: w, height: w < 600 ? 844 : 900 }, colorScheme: scheme, deviceScaleFactor: qa ? 1 : 2 });
      if (as !== 'anon') await ctx.addCookies([{ name: 'sl_session', value: who[as], domain: new URL(BASE).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
      const page = await ctx.newPage();
      try {
        await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle', timeout: 60_000 });
        await page.waitForTimeout(400);
        if (action) await action(page, w);
        await page.waitForTimeout(250);
        if (qa) {
          const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          results.push({ name, url, width: w, overflow: over });
          console.log(over > 0 ? '✖' : '✔', name, w, over);
        } else {
          const file = `${OUT}/${name}-${w}-${scheme}.png`;
          await page.screenshot({ path: file });
          console.log('shot', file);
        }
      } catch (e) { console.error('fail', name, w, scheme, e.message); results.push({ name, url, width: w, error: e.message }); }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  for (const t of tokens) await db.query(`UPDATE sessions SET revoked_at=now(), revoked_reason='signed_out' WHERE token_hash=$1`, [createHash('sha256').update(t).digest()]);
  await db.end();
}
if (qa) {
  writeFileSync(`${OUT}/mobile-qa.json`, JSON.stringify({ checked: results.length, overflow: results.filter((r) => r.overflow > 0 || r.error), results }, null, 2));
  const bad = results.filter((r) => r.overflow > 0 || r.error).length;
  console.log(`${results.length} checks, ${bad} with horizontal scroll or errors`);
  process.exit(bad ? 1 : 0);
}
