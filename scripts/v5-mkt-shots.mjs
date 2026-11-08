#!/usr/bin/env node
// V5 MKT — marketing page evidence (DEV/LOCAL ONLY). No sign-in needed for `/`; the signed-in variant inserts a short-lived
// session row with MIGRATOR_DATABASE_URL (never point this at production).
//   node scripts/v5-mkt-shots.mjs                → evidence/v5/mkt/<name>-<width>-<theme>.png (WIDTHS=1440,390 SCHEMES=light,dark)
//   MOBILE_QA=1 node scripts/v5-mkt-shots.mjs    → page-level horizontal overflow at 320…1440 (+1440 at 200 % zoom) → evidence/v5/mkt/mobile-qa.json
//   BASE=http://localhost:3200 to use another server.
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const BASE = process.env.BASE ?? process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const OUT = process.env.OUT ?? 'evidence/v5/mkt';
const qa = process.env.MOBILE_QA === '1';
const widths = qa ? [320, 360, 390, 430, 768, 1024, 1440] : (process.env.WIDTHS || '1440,390').split(',').map(Number);
const schemes = qa ? ['light'] : (process.env.SCHEMES || 'light,dark').split(',');
const only = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });

/** Refuse to capture an unstyled page (e.g. taken while .next was being rebuilt): the marketing stylesheet must have loaded. */
async function assertStyled(page) {
  const r = await page.evaluate(() => {
    const css = performance.getEntriesByType('resource').filter((e) => /\/_next\/static\/.*\.css(\?|$)/.test(e.name));
    const h1 = document.querySelector('h1');
    const mkt = document.querySelector('.mkt');
    return {
      css: css.length, cssFailed: css.filter((e) => e.responseStatus && e.responseStatus !== 200).length,
      h1Weight: h1 ? getComputedStyle(h1).fontWeight : null,
      font: getComputedStyle(document.body).fontFamily,
      mktBg: mkt ? getComputedStyle(mkt).backgroundColor : null,
      tokens: mkt ? getComputedStyle(mkt).getPropertyValue('--v5-primary').trim() : '',
    };
  });
  const ok = r.css > 0 && r.cssFailed === 0 && r.h1Weight === '800' && /Inter/i.test(r.font) && !!r.tokens;
  if (!ok) throw new Error(`page is not styled (stylesheet missing?) — refusing to capture: ${JSON.stringify(r)}`);
}

async function signedInCookie() {
  if (!process.env.MIGRATOR_DATABASE_URL) return null;
  const pg = require('pg');
  const db = new pg.Pool({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  const u = (await db.query(`SELECT id FROM users WHERE email='owner@demo.social-lite.test'`)).rows[0];
  const token = randomBytes(32).toString('base64url');
  await db.query(`INSERT INTO sessions(user_id, token_hash, csrf_token, expires_at, mfa_verified, auth_time, acr, amr)
    VALUES ($1,$2,$3,now() + interval '20 minutes',true,now(),'mfa','{pwd,otp}')`, [u.id, createHash('sha256').update(token).digest(), randomUUID()]);
  await db.end();
  return { name: 'sl_session', value: token, url: BASE };
}

const SHOTS = [
  { name: 'home', full: true },
  { name: 'hero', full: false },
  { name: 'pricing', full: false, prep: async (p) => { await p.locator('#pricing').scrollIntoViewIfNeeded(); await p.evaluate(() => document.getElementById('pricing').scrollIntoView({ behavior: 'instant' })); } },
  { name: 'comparison', full: false, prep: async (p) => { await p.getByTestId('mkt-compare').click(); await p.waitForTimeout(400); await p.evaluate(() => document.querySelector('[data-testid=mkt-comparison]').scrollIntoView({ behavior: 'instant' })); } },
  { name: 'integrations', full: false, prep: async (p) => { await p.evaluate(() => document.getElementById('integrations').scrollIntoView({ behavior: 'instant' })); } },
  { name: 'faq', full: false, prep: async (p) => { await p.getByTestId('mkt-faq-trial').getByRole('button').click(); await p.waitForTimeout(300); await p.evaluate(() => document.getElementById('faq').scrollIntoView({ behavior: 'instant' })); } },
  { name: 'explore-ai', full: false, prep: async (p) => { await p.evaluate(() => document.getElementById('ai').scrollIntoView({ behavior: 'instant', block: 'center' })); await p.getByTestId('mkt-explore-ai-assistant').click(); await p.waitForTimeout(300); } },
  { name: 'menu', full: false, mobileOnly: true, prep: async (p) => { await p.getByTestId('mkt-menu-open').click(); await p.waitForTimeout(350); } },
  { name: 'signed-in', full: false, signedIn: true },
];

const browser = await chromium.launch();
const report = [];
if (process.env.PERF === '1') {
  // JS shipped + LCP/CLS on `/` (cold cache, 5 runs each): desktop 1440 unthrottled, and mobile 390 with 4x CPU slowdown on
  // a "slow 4G" profile (150 ms RTT, 1.6 Mbps down, 750 kbps up). /login measured the same way as a baseline.
  const runs = Number(process.env.RUNS || 5);
  const out = { base: BASE, at: new Date().toISOString(), conditions: 'headless Chromium, cold cache per run; mobile = 390x844, DPR 2, CPU 4x, 150ms RTT, 1.6/0.75 Mbps', results: [] };
  for (const path of ['/', '/login']) for (const profile of ['desktop', 'mobile']) {
    const samples = [];
    for (let i = 0; i < runs; i++) {
      const ctx = await browser.newContext(profile === 'mobile' ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      if (profile === 'mobile') {
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 });
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      }
      await page.addInitScript(() => {
        window.__lcp = 0; window.__cls = 0;
        new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
        new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
      });
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
      if (path === '/') await assertStyled(page);
      await page.waitForTimeout(500);
      const m = await page.evaluate(() => {
        const res = performance.getEntriesByType('resource');
        const js = res.filter((r) => r.initiatorType === 'script' || /\.js(\?|$)/.test(r.name));
        const css = res.filter((r) => /\.css(\?|$)/.test(r.name));
        const font = res.filter((r) => /\.woff2(\?|$)/.test(r.name));
        const nav = performance.getEntriesByType('navigation')[0];
        const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null;
        return { lcp: Math.round(window.__lcp), fcp: fcp && Math.round(fcp), cls: Number(window.__cls.toFixed(4)), ttfb: Math.round(nav.responseStart), html_kb: Math.round(nav.encodedBodySize / 102.4) / 10,
          js_files: js.length, js_kb: Math.round(js.reduce((a, r) => a + r.encodedBodySize, 0) / 102.4) / 10, js_decoded_kb: Math.round(js.reduce((a, r) => a + r.decodedBodySize, 0) / 102.4) / 10,
          css_kb: Math.round(css.reduce((a, r) => a + r.encodedBodySize, 0) / 102.4) / 10, fonts: font.map((f) => f.name.split('/').pop()), images: res.filter((r) => r.initiatorType === 'img').length };
      });
      samples.push(m);
      await ctx.close();
    }
    const med = (k) => { const v = samples.map((x) => x[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
    const row = { path, profile, runs, lcp_ms_median: med('lcp'), fcp_ms_median: med('fcp'), cls_max: Math.max(...samples.map((x) => x.cls)), ttfb_ms_median: med('ttfb'), html_kb: samples[0].html_kb,
      js_files: samples[0].js_files, js_transfer_kb: samples[0].js_kb, js_decoded_kb: samples[0].js_decoded_kb, css_kb: samples[0].css_kb, fonts: samples[0].fonts, images: samples[0].images };
    out.results.push(row);
    console.log(JSON.stringify(row));
  }
  writeFileSync(`${OUT}/perf.json`, JSON.stringify(out, null, 2));
  await browser.close();
  process.exit(0);
}
try {
  const cookie = await signedInCookie().catch(() => null);
  for (const scheme of schemes) for (const width of widths) {
    if (qa) {
      // 200 % browser zoom = half the CSS viewport: 1440 → 720 (and 640 → 320, covered by the 320 run).
      for (const zoom of width === 1440 ? [1, 2] : [1]) {
        const ctx = await browser.newContext({ viewport: { width: width / zoom, height: 900 / zoom }, deviceScaleFactor: zoom, colorScheme: scheme });
        const page = await ctx.newPage();
        await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
        await assertStyled(page);
        await page.getByTestId('mkt-compare').click();
        await page.waitForTimeout(300);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        report.push({ width, zoom, overflow });
        console.log(`width ${width} zoom ${zoom}: overflow ${overflow}px`);
        await ctx.close();
      }
      continue;
    }
    for (const s of SHOTS) {
      if (only.length && !only.includes(s.name)) continue;
      if (s.mobileOnly && width > 500) continue;
      if (s.signedIn && !cookie) continue;
      const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, deviceScaleFactor: 2, colorScheme: scheme });
      if (s.signedIn) await ctx.addCookies([cookie]);
      const page = await ctx.newPage();
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      if (s.full) { // let scroll-in reveals run before a full-page capture
        await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo({ top: y, behavior: 'instant' }); await new Promise((r) => setTimeout(r, 120)); } window.scrollTo({ top: 0, behavior: 'instant' }); });
        await page.waitForTimeout(600);
      }
      await assertStyled(page);
      if (s.prep) await s.prep(page);
      await page.waitForTimeout(700);
      if (s.full) {
        // Full page split into parts of at most 3,900 CSS px (≤ 7,800 px tall at DPR 2), cut at section boundaries.
        const total = await page.evaluate(() => document.documentElement.scrollHeight);
        const cuts = await page.evaluate(() => [...document.querySelectorAll('main > section, footer')].map((e) => Math.round(e.getBoundingClientRect().top + window.scrollY)));
        const bounds = [...new Set([...cuts, total])].filter((c) => c > 0).sort((a, b) => a - b);
        const parts = []; let start = 0;
        while (start < total) {
          const fits = bounds.filter((c) => c > start && c - start <= 3900);
          const end = fits.length ? fits[fits.length - 1] : Math.min(start + 3900, total);
          parts.push([start, end]); start = end;
        }
        for (let i = 0; i < parts.length; i++) {
          const [y, e] = parts[i];
          const file = `${OUT}/${s.name}-${width}-${scheme}-${i + 1}.png`;
          await page.screenshot({ path: file, fullPage: true, clip: { x: 0, y, width, height: e - y } });
          console.log(file);
        }
      } else {
        await page.screenshot({ path: `${OUT}/${s.name}-${width}-${scheme}.png` });
        console.log(`${OUT}/${s.name}-${width}-${scheme}.png`);
      }
      await ctx.close();
    }
  }
  if (qa) writeFileSync(`${OUT}/mobile-qa.json`, JSON.stringify({ base: BASE, at: new Date().toISOString(), results: report }, null, 2));
} finally {
  await browser.close();
}
