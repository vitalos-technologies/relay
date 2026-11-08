#!/usr/bin/env node
// V5 MKT — capture the real Overview dashboard of the SYNTHETIC "Relay Showcase" workspace (scripts/seed-marketing-showcase.ts)
// for the marketing hero (DEV/LOCAL ONLY). Signs in by inserting a short-lived session row with MIGRATOR_DATABASE_URL and
// deletes it afterwards. Never point this at production.
//   set -a; . ./.env; set +a; npx tsx scripts/seed-marketing-showcase.ts && node scripts/marketing-capture.mjs
// Output: raw captures → evidence/v5/mkt/source/overview-{light,dark}.png (1280×800 CSS px, DPR 2) and the optimisation
// sources the page uses → apps/web/public/marketing/overview-{light,dark}.webp (next/image re-encodes to AVIF/WebP per
// request width). The demo strip ("Demo · simulated destinations") is hidden at capture time only; the marketing page keeps
// its visible "Illustrative preview with example content" caption. Product behaviour is unchanged.
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';

const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const pg = require('pg');
const sharp = require(require.resolve('sharp', { paths: [new URL('../packages/services', import.meta.url).pathname] }));

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const RAW = 'evidence/v5/mkt/source';
const PUB = 'apps/web/public/marketing';
if (!process.env.MIGRATOR_DATABASE_URL) throw new Error('MIGRATOR_DATABASE_URL is required (dev only)');
if (process.env.APP_ENV === 'production') throw new Error('Refusing to run against production');
mkdirSync(RAW, { recursive: true });
mkdirSync(PUB, { recursive: true });

const db = new pg.Pool({ connectionString: process.env.MIGRATOR_DATABASE_URL });
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0] ?? null;
const ws = await one(`SELECT id FROM workspaces WHERE name='Relay Showcase' AND is_demo AND state='active'`);
if (!ws) throw new Error('Relay Showcase not found: run npx tsx scripts/seed-marketing-showcase.ts first');
const u = await one(`SELECT id FROM users WHERE email='ava.moreno@showcase.social-lite.test'`);
const token = randomBytes(32).toString('base64url');
const sess = await one(`INSERT INTO sessions(user_id, token_hash, csrf_token, active_workspace_id, expires_at, mfa_verified, auth_time, acr, amr)
  VALUES ($1,$2,$3,$4,now() + interval '10 minutes',true,now(),'mfa','{pwd,otp}') RETURNING id`, [u.id, createHash('sha256').update(token).digest(), randomUUID(), ws.id]);

const browser = await chromium.launch();
try {
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: scheme, reducedMotion: 'reduce' });
    await ctx.addCookies([{ name: 'sl_session', value: token, url: BASE }]);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/overview`, { waitUntil: 'networkidle' });
    if (!page.url().includes('/overview')) throw new Error(`not on /overview (got ${page.url()})`);
    await page.getByRole('heading', { name: 'Overview', level: 1 }).waitFor();
    // Skeletons settled, stylesheet loaded (refuse an unstyled capture).
    await page.waitForFunction(() => document.querySelectorAll('.skeleton, [aria-busy="true"]').length === 0, null, { timeout: 30_000 });
    const styled = await page.evaluate(() => ({
      css: performance.getEntriesByType('resource').filter((e) => /\/_next\/static\/.*\.css/.test(e.name)).length,
      font: getComputedStyle(document.body).fontFamily,
      bg: getComputedStyle(document.body).backgroundColor,
    }));
    if (!styled.css || !/Inter/i.test(styled.font)) throw new Error(`page is not styled — refusing to capture: ${JSON.stringify(styled)}`);
    // Capture-time only: hide the demo strip (the marketing page labels the image as an illustrative preview).
    await page.evaluate(() => { for (const n of document.querySelectorAll('[role="note"]')) if (/simulated destinations/i.test(n.textContent ?? '')) n.style.display = 'none'; });
    await page.waitForTimeout(800);
    const raw = `${RAW}/overview-${scheme}.png`;
    await page.screenshot({ path: raw });
    const out = `${PUB}/overview-${scheme}.webp`;
    await sharp(raw).webp({ quality: 88, effort: 6 }).toFile(out);
    console.log(`${raw} → ${out} (${Math.round(statSync(out).size / 1024)} KB source; served resized as AVIF/WebP by next/image)`);
    await ctx.close();
  }
} finally {
  await browser.close();
  await db.query(`DELETE FROM sessions WHERE id=$1`, [sess.id]);
  await db.end();
}
