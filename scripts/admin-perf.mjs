#!/usr/bin/env node
// V3.1 Admin §17 browser + API performance (lab) on a PRODUCTION build. DEV/LOCAL ONLY. Adapted from v31-browser-perf.mjs.
//
//   set -a; . ./.env; set +a; node scripts/admin-perf.mjs [--runs 10] [--label admin] [--cpu 1] [--check]
// Also measures admin API latency (n = 30 sequential warm calls each) and writes evidence/v3-1/perf/admin-<label>.json.
//
// Per core route, N cold loads (fresh browser context = empty cache) measuring: LCP, CLS, "useful content" (main
// rendered with no skeleton left), an INP proxy (max Event Timing duration over a scripted interaction: typing in the
// composer, Cmd+K open/type/close elsewhere), route JS (encoded bytes of script resources), request count. Plus warm
// navigation through the persistent shell (click → useful content). Percentiles are nearest-rank; with n = 10 the p95
// is the max of 10 and only indicative. Writes evidence/v3-1/perf/browser-<label>.json.
// --check exits 1 when a route exceeds its JS budget (docs/PERFORMANCE_BUDGETS.md, "Browser").
// Signs in as the Demo Workspace owner by inserting a short-lived session row (MIGRATOR_DATABASE_URL; never production).
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';

const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const pg = require('pg');

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const RUNS = Number(arg('runs', '10'));
const LABEL = arg('label', 'admin');
const CPU = Number(arg('cpu', '1'));
const CHECK = process.argv.includes('--check');
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
if (!process.env.MIGRATOR_DATABASE_URL) throw new Error('MIGRATOR_DATABASE_URL is required (dev only)');

// Route JS budgets (encoded/compressed bytes of every script the route loads on a cold visit). Set from the final
// production measurement (p50, n = 10) + ~5% headroom, rounded up to 5 KB; see docs/PERFORMANCE_BUDGETS.md ("Browser").
// Admin route JS budgets (KB, compressed): set from the first production measurement (p50 + ~5%), see PERFORMANCE_REPORT.md.
export const JS_BUDGET_KB = { a_overview: 300, a_publishing: 310, a_people: 310, a_connections: 310, a_operations: 310, a_analytics: 300, a_audit: 305, p_health: 300, p_workspaces: 300 };

const db = new pg.Pool({ connectionString: process.env.MIGRATOR_DATABASE_URL });
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const ws = (await one(`SELECT id FROM workspaces WHERE is_demo AND name='Demo Workspace' LIMIT 1`)).id;
const owner = (await one(`SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.workspace_id=$1 AND m.role='owner' LIMIT 1`, [ws])).id;
const token = randomBytes(32).toString('base64url');
await db.query(`INSERT INTO sessions(user_id, token_hash, csrf_token, active_workspace_id, expires_at, mfa_verified, auth_time, acr, amr)
  VALUES ($1,$2,$3,$4,now() + interval '2 hours',true,now(),'mfa','{pwd,otp}')`, [owner, createHash('sha256').update(token).digest(), randomUUID(), ws]);
// A V3.1 fixture draft (scripts/v31-ui-shots.mjs), so typing never touches the UX showcase draft.
const showcase = (await one(`SELECT id FROM posts WHERE workspace_id=$1 AND title='Pour-over basics' AND deleted_at IS NULL LIMIT 1`, [ws]))?.id
  ?? (await one(`SELECT id FROM posts WHERE workspace_id=$1 AND deleted_at IS NULL AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 1`, [ws])).id;
const counts = await one(`SELECT (SELECT count(*) FROM posts WHERE workspace_id=$1)::int posts, (SELECT count(*) FROM brands WHERE workspace_id=$1)::int brands,
  (SELECT count(*) FROM social_connections WHERE workspace_id=$1)::int connections`, [ws]).catch(() => ({}));

const ROUTES = [
  ['a_overview', '/admin'], ['a_publishing', '/admin/publishing?state=attention'], ['a_people', '/admin/people'], ['a_connections', '/admin/connections'],
  ['a_operations', '/admin/operations'], ['a_analytics', '/admin/analytics'], ['a_audit', '/admin/security/audit'], ['p_health', '/admin/platform'], ['p_workspaces', '/admin/platform/workspaces'],
];
void showcase;

// Collected in the page from the first byte: LCP, CLS (session-less sum, excluding shifts right after input), event timing.
const INIT = `
  window.__perf = { lcp: 0, cls: 0, events: [] };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.lcp = Math.max(window.__perf.lcp, e.startTime); }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__perf.cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.interactionId) window.__perf.events.push(e.duration); }).observe({ type: 'event', buffered: true, durationThreshold: 16 }); } catch {}
`;
const READY = () => {
  const main = document.querySelector('#admin-main');
  if (!main || !main.querySelector('h1')) return false;
  return !document.querySelector('.skeleton, [role=status][aria-label=Loading], [aria-label="Loading post"]');
};

const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const sum = (xs) => ({ n: xs.length, p50: r(pct(xs, 50)), p75: r(pct(xs, 75)), p95: r(pct(xs, 95)), max: r(Math.max(...xs)), min: r(Math.min(...xs)) });
const r = (v) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000);

const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  await ctx.addCookies([{ name: 'sl_session', value: token, domain: new URL(BASE).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  if (CPU > 1) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU }); }
  return { ctx, page };
}

async function interact(page) {
  // Jump palette open → type → close, then the nav filter: the admin shell's two keyboard-heavy interactions.
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox', { name: 'Jump to' }).waitFor();
  await page.keyboard.type('dead', { delay: 80 });
  await page.keyboard.press('Escape');
  await page.getByRole('textbox', { name: 'Filter navigation' }).first().fill('aud');
  await page.waitForTimeout(300);
}

// Warm-up: one visit per route so the server's first-hit work isn't counted as a browser number.
{ const { ctx, page } = await newPage(); for (const [, url] of ROUTES) { await page.goto(`${BASE}${url}`, { waitUntil: 'load' }); await page.waitForFunction(READY, null, { timeout: 60_000 }).catch(() => {}); } await ctx.close(); }

let out_api = {};
const routes = {};
for (const [name, url] of ROUTES) {
  const s = { lcp: [], cls: [], useful: [], inp: [], js_kb: [], requests: [], ttfb: [] };
  for (let i = 0; i < RUNS; i++) {
    const { ctx, page } = await newPage();
    await page.goto(`${BASE}${url}`, { waitUntil: 'commit' });
    await page.waitForFunction(READY, null, { timeout: 60_000, polling: 'raf' });
    const useful = await page.evaluate(() => performance.now());
    await page.waitForLoadState('networkidle').catch(() => {});
    await interact(page).catch((e) => console.log('interaction failed', name, e.message.slice(0, 100)));
    const m = await page.evaluate(() => {
      const res = performance.getEntriesByType('resource');
      const js = res.filter((e) => e.initiatorType === 'script' || /\.js(\?|$)/.test(e.name));
      const nav = performance.getEntriesByType('navigation')[0];
      return { lcp: window.__perf.lcp, cls: window.__perf.cls, inp: window.__perf.events.length ? Math.max(...window.__perf.events) : 0,
        js: js.reduce((a, e) => a + (e.encodedBodySize || e.transferSize || 0), 0), requests: res.length + 1, ttfb: nav ? nav.responseStart : null };
    });
    s.lcp.push(m.lcp); s.cls.push(m.cls); s.useful.push(useful); s.inp.push(m.inp); s.js_kb.push(m.js / 1024); s.requests.push(m.requests); if (m.ttfb !== null) s.ttfb.push(m.ttfb);
    await ctx.close();
  }
  routes[name] = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, sum(v)]));
  console.log(name, JSON.stringify({ lcp: routes[name].lcp.p75, useful_p95: routes[name].useful.p95, cls: routes[name].cls.p75, inp: routes[name].inp.p75, js_kb: routes[name].js_kb.p50 }));
}

// Warm navigation through the shell (client-side transitions).
const NAV = [['Deliveries', 'deliveries', 'Deliveries', '/admin/publishing'], ['Members', 'members', 'Team', '/admin/people'], ['Social accounts', 'accounts', 'Social accounts', '/admin/connections'],
  ['Queues and workers', 'operations', 'Queues and workers', '/admin/operations'], ['Overview', 'overview', 'Overview', '/admin']];
const warm = Object.fromEntries(NAV.map(([, k]) => [k, []]));
{
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/admin`, { waitUntil: 'load' });
  await page.waitForFunction(READY, null, { timeout: 60_000 });
  for (let i = 0; i < RUNS + 1; i++) {
    for (const [label, key, heading, href] of NAV) {
      const t0 = await page.evaluate(() => performance.now());
      const link = page.getByRole('navigation', { name: 'Workspace admin' }).locator(`a[href="${href}"]`);
      if (!(await link.isVisible())) { await page.getByRole('navigation', { name: 'Workspace admin' }).getByRole('button', { name: { deliveries: 'Publishing', members: 'People and teams', accounts: 'Connections', operations: 'Operations' }[key] ?? label }).click(); }
      await link.click();
      await page.waitForFunction((h) => document.querySelector('#admin-main h1')?.textContent?.trim().startsWith(h), heading, { polling: 'raf', timeout: 30_000 });
      await page.waitForFunction(READY, null, { timeout: 30_000, polling: 'raf' });
      const t1 = await page.evaluate(() => performance.now());
      if (i > 0) warm[key].push(t1 - t0); // first lap loads each route's chunks once
      await page.waitForTimeout(150);
    }
  }
  await ctx.close();
}
const warmSummary = Object.fromEntries(Object.entries(warm).map(([k, v]) => [k, sum(v)]));
console.log('warm', JSON.stringify(Object.fromEntries(Object.entries(warmSummary).map(([k, v]) => [k, v.p95]))));

// Admin API latency (warm, sequential, n = 30; includes Next routing, session + policy load, serialisation).
const API = [['admin_overview', '/api/admin/overview'], ['admin_changes', '/api/admin/changes'], ['admin_deliveries', '/api/admin/deliveries'],
  ['admin_deliveries_attention', '/api/admin/deliveries?state=attention'], ['admin_connections', '/api/admin/connections'], ['admin_analytics', '/api/admin/analytics'],
  ['admin_jobs', '/api/admin/jobs'], ['platform_overview', '/api/platform/overview'], ['platform_workspaces', '/api/platform/workspaces']];
const apiMs = {};
for (const [k, path] of API) {
  const xs = [];
  for (let i = 0; i < 31; i++) {
    const t0 = performance.now();
    const res = await fetch(`${BASE}${path}`, { headers: { cookie: `sl_session=${token}`, 'x-workspace-id': ws } });
    await res.arrayBuffer();
    if (res.status !== 200) { console.log('api status', k, res.status); break; }
    if (i > 0) xs.push(performance.now() - t0);
  }
  apiMs[k] = sum(xs);
}
console.log('api p95', JSON.stringify(Object.fromEntries(Object.entries(apiMs).map(([k, v]) => [k, v.p95]))));
out_api = apiMs;

await browser.close();
await db.query(`DELETE FROM sessions WHERE token_hash=$1`, [createHash('sha256').update(token).digest()]);
await db.end();

const out = {
  label: LABEL, generated_at: new Date().toISOString(), base_url: BASE, runs_per_route: RUNS, cpu_throttle: CPU,
  conditions: { host: `${os.cpus().length} vCPU ${os.cpus()[0]?.model ?? ''}`.trim(), memory_gb: Math.round(os.totalmem() / 2 ** 30), browser: `Chromium (Playwright) headless ${browser.version?.() ?? ''}`.trim(),
    network: 'localhost, no throttling', cache: 'cold per run (fresh context); server warmed once per route', viewport: '1440×900', dataset: { workspace: 'Demo Workspace', ...counts } },
  routes, warm_navigation_ms: warmSummary, api_ms: out_api,
};
mkdirSync('evidence/v3-1/perf', { recursive: true });
writeFileSync(`evidence/v3-1/perf/${LABEL}.json`, JSON.stringify(out, null, 2));
console.log(`wrote evidence/v3-1/perf/${LABEL}.json`);
if (CHECK) {
  const over = Object.entries(routes).filter(([k, v]) => JS_BUDGET_KB[k] && v.js_kb.p50 > JS_BUDGET_KB[k]);
  for (const [k, v] of over) console.log(`BUDGET ${k}: ${v.js_kb.p50} KB > ${JS_BUDGET_KB[k]} KB`);
  if (over.length) process.exit(1);
  console.log('JS budgets: all routes within budget');
}
