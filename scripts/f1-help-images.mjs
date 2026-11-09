#!/usr/bin/env node
// F1 (2026-11-09) — retake the two help images that showed fixed defects (DEV/LOCAL ONLY; synthetic data):
//   apps/web/public/help/img/analytics/analytics-channels.png   (Relay Showcase, demo dataset, 28 days) — H6
//   apps/web/public/help/img/social-connections/connections.png (Demo Workspace, simulated destinations) — H7
// Signs in by inserting short-lived session rows with MIGRATOR_DATABASE_URL (same approach as scripts/help-shots.mjs).
//   set -a; . ./.env; set +a; node scripts/f1-help-images.mjs
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const pg = require('pg');
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
if (!process.env.MIGRATOR_DATABASE_URL) throw new Error('MIGRATOR_DATABASE_URL is required (dev only)');
const db = new pg.Pool({ connectionString: process.env.MIGRATOR_DATABASE_URL });
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0] ?? null;
const tokens = [];
async function session(email, workspace) {
  const u = await one(`SELECT id FROM users WHERE email=$1`, [email]);
  const ws = await one(`SELECT id FROM workspaces WHERE name=$1 LIMIT 1`, [workspace]);
  const token = randomBytes(32).toString('base64url');
  await db.query(`INSERT INTO sessions(user_id, token_hash, csrf_token, active_workspace_id, expires_at, mfa_verified, auth_time, acr, amr)
    VALUES ($1,$2,$3,$4,now() + interval '1 hour',true,now(),'mfa','{pwd,otp}')`, [u.id, createHash('sha256').update(token).digest(), randomUUID(), ws.id]);
  tokens.push(token);
  return token;
}
const SHOTS = [
  ['apps/web/public/help/img/analytics/analytics-channels.png', '/analytics/channels?dataset=demo', await session('ava.moreno@showcase.social-lite.test', 'Relay Showcase')],
  ['apps/web/public/help/img/social-connections/connections.png', '/accounts', await session('owner@demo.social-lite.test', 'Demo Workspace')],
];
const browser = await chromium.launch();
try {
  for (const [file, url, token] of SHOTS) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', deviceScaleFactor: 1 });
    await ctx.addCookies([{ name: 'sl_session', value: token, domain: new URL(BASE).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
    const page = await ctx.newPage();
    await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: file });
    console.log('shot', file);
    await ctx.close();
  }
} finally {
  await browser.close();
  for (const t of tokens) await db.query(`UPDATE sessions SET revoked_at=now(), revoked_reason='signed_out' WHERE token_hash=$1`, [createHash('sha256').update(t).digest()]);
  await db.end();
}
