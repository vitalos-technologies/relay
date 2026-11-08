#!/usr/bin/env node
// V3.5 AI assistant + automation evidence screenshots (DEV/LOCAL ONLY; synthetic Demo data from scripts/seed-inbox-demo.ts
// + scripts/seed-ai-automation-demo.ts). No AI provider is configured here: assistant screens show the honest 'not set up' state.
//   set -a; . ./.env; set +a; node scripts/ai-automation-shots.mjs [screen ...]
//   env: CHECKPOINT=1 → evidence/v3-5/ai-automation/checkpoints/<n>-<screen>-<theme>.png (1440, DPR 2)
//        otherwise   → evidence/v3-5/ai-automation/<screen>-<width>-<theme>.png   WIDTHS=1440,390  SCHEMES=light,dark  OUT=<dir>
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
const OUT = process.env.OUT ?? (checkpoint ? 'evidence/v3-5/ai-automation/checkpoints' : 'evidence/v3-5/ai-automation');
const only = process.argv.slice(2);
const widths = qa ? [320, 360, 390, 430, 768, 1024, 1440] : checkpoint ? [1440] : (process.env.WIDTHS || '1440,390').split(',').map(Number);
const schemes = qa ? ['light'] : (process.env.SCHEMES || 'light,dark').split(',');
if (!process.env.MIGRATOR_DATABASE_URL) throw new Error('MIGRATOR_DATABASE_URL is required (dev only)');
mkdirSync(OUT, { recursive: true });

const db = new pg.Pool({ connectionString: process.env.MIGRATOR_DATABASE_URL });
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const ws = (await one(`SELECT id FROM workspaces WHERE name='Demo Workspace' LIMIT 1`)).id;
const ana = await one(`SELECT c.id FROM inbox_conversations c JOIN inbox_contacts ct ON ct.id=c.contact_id WHERE c.workspace_id=$1 AND ct.display_name='Ana Lopes' ORDER BY c.created_at DESC LIMIT 1`, [ws]);
const sam = await one(`SELECT ar.subject_id AS id FROM automation_runs ar JOIN automation_rules r ON r.id=ar.rule_id WHERE ar.workspace_id=$1 AND r.name='Escalate refunds and complaints' AND ar.outcome='escalated' ORDER BY ar.created_at DESC LIMIT 1`, [ws]);
if (!ana || !sam) throw new Error('Run scripts/seed-inbox-demo.ts and scripts/seed-ai-automation-demo.ts first');
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

const tab = (name) => async (page) => { await page.getByRole('tab', { name }).click(); await page.waitForTimeout(800); };
const openRule = async (page) => { await page.getByRole('button', { name: /Opening hours reply/ }).click(); const d = page.getByRole('dialog'); await d.waitFor(); await d.getByRole('button', { name: 'Test' }).click(); await d.getByText(/Test ·/).waitFor({ timeout: 20_000 }); await d.getByText(/Test ·/).scrollIntoViewIfNeeded(); };
const openPolicy = async (page) => { await page.getByRole('tab', { name: 'Policies' }).click(); await page.getByRole('button', { name: 'Edit' }).first().click(); await page.getByRole('dialog').waitFor(); };
const drawer = async (page) => { if (page.viewportSize().width < 1536) { /* context below: chip visible in details */ } await page.getByRole('button', { name: 'Assistant' }).first().click(); await page.getByRole('dialog').waitFor(); await page.waitForTimeout(600); };
const details = async (page) => { if (page.viewportSize().width < 1536) { await page.getByRole('button', { name: 'More actions' }).click(); await page.getByRole('menuitem', { name: 'Customer and case' }).click(); await page.getByRole('dialog').waitFor(); await page.waitForTimeout(500); } };

// [name, url, session, action?, checkpoint number]
const SCREENS = [
  ['automation-rules', '/automation', owner, null, 1],
  ['automation-rule-test', '/automation', owner, openRule, 2],
  ['automation-policies', '/automation', owner, tab('Policies'), 3],
  ['automation-policy-edit', '/automation', owner, openPolicy, 3],
  ['automation-history', '/automation', owner, tab('History'), 4],
  ['assistant', '/assistant', owner, null, 5],
  ['assistant-knowledge', '/assistant', owner, tab('Knowledge'), 5],
  ['inbox-escalated', `/inbox?queue=all&c=${sam.id}`, owner, details, 6],
  ['inbox-auto-reply', `/inbox?queue=all&c=${ana.id}`, owner, null, 6],
  ['inbox-assistant', `/inbox?queue=all&c=${ana.id}`, owner, drawer, 7],
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
