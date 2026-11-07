#!/usr/bin/env node
// Collaboration performance + sync latency (lab) on a PRODUCTION build. DEV/LOCAL ONLY (synthetic Demo Workspace data).
//   set -a; . ./.env; set +a; node scripts/collab-perf.mjs [--runs 8] [--label collab]
// Needs scripts/seed-collab-demo.ts (+ --volume 200 for the "Collaboration volume (synthetic)" post).
//  1) API latency, warm, sequential, n = 30 per endpoint (includes Next routing, session + policy load, serialisation),
//     against the volume post (200 threads / 800 comments / 200 tasks) and the caller's notification feed.
//  2) Sync latency: person B holds the SSE stream open (/api/collab/stream); person A posts a comment; time from A's request
//     start to the event arriving in B's stream (n = 20). Also the polling fallback (/api/collab/events) cost.
//  3) Browser cold loads (n = --runs) of the collaboration routes: LCP, CLS, useful content, INP proxy, route JS, requests.
// Writes evidence/collaboration/perf-<label>.json.
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';

const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const pg = require('pg');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const RUNS = Number(arg('runs', '8'));
const LABEL = arg('label', 'collab');
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
if (!process.env.MIGRATOR_DATABASE_URL) throw new Error('MIGRATOR_DATABASE_URL is required (dev only)');

const db = new pg.Pool({ connectionString: process.env.MIGRATOR_DATABASE_URL });
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const ws = (await one(`SELECT id FROM workspaces WHERE is_demo AND name='Demo Workspace' LIMIT 1`)).id;
const vol = await one(`SELECT id FROM posts WHERE workspace_id=$1 AND title='Collaboration volume (synthetic)' AND deleted_at IS NULL`, [ws]);
const demo = await one(`SELECT id FROM posts WHERE workspace_id=$1 AND title='Spring menu launch (collaboration demo)' AND deleted_at IS NULL`, [ws]);
if (!vol || !demo) throw new Error('Run scripts/seed-collab-demo.ts --volume 200 first');
const counts = await one(`SELECT (SELECT count(*) FROM comment_threads WHERE post_id=$1)::int threads, (SELECT count(*) FROM comments WHERE post_id=$1)::int comments,
  (SELECT count(*) FROM collab_tasks WHERE workspace_id=$2)::int tasks, (SELECT count(*) FROM notifications WHERE workspace_id=$2)::int notifications,
  (SELECT count(*) FROM collab_events)::int events, (SELECT count(*) FROM post_versions WHERE post_id=$3)::int versions`, [vol.id, ws, demo.id]);
const tokens = [];
async function as(email) {
  const u = await one(`SELECT id FROM users WHERE email=$1`, [email]);
  const token = randomBytes(32).toString('base64url'); const csrf = randomUUID();
  await db.query(`INSERT INTO sessions(user_id, token_hash, csrf_token, active_workspace_id, expires_at, mfa_verified, auth_time, acr, amr)
    VALUES ($1,$2,$3,$4,now() + interval '2 hours',true,now(),'mfa','{pwd,otp}')`, [u.id, createHash('sha256').update(token).digest(), csrf, ws]);
  tokens.push(token);
  const headers = { origin: BASE, cookie: `sl_session=${token}`, 'content-type': 'application/json', 'x-csrf-token': csrf, 'x-workspace-id': ws };
  return { token, headers, id: u.id };
}
const owner = await as('owner@demo.social-lite.test');
const editor = await as('editor@demo.social-lite.test');
const approver = await as('approver@demo.social-lite.test');

const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const r = (v) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const sum = (xs) => ({ n: xs.length, p50: r(pct(xs, 50)), p95: r(pct(xs, 95)), max: r(Math.max(...xs)) });

// ---------------------------------------------------------------- 1) API latency
const firstVersion = (await one(`SELECT id FROM post_versions WHERE post_id=$1 ORDER BY created_at LIMIT 1`, [demo.id])).id;
const firstThread = (await one(`SELECT id FROM comment_threads WHERE post_id=$1 ORDER BY last_activity_at DESC LIMIT 1`, [vol.id])).id;
const today = new Date().toISOString().slice(0, 10);
const API = [
  ['threads_page (volume post)', `/api/posts/${vol.id}/threads`, editor],
  ['threads_resolved', `/api/posts/${vol.id}/threads?status=resolved`, editor],
  ['thread_detail', `/api/threads/${firstThread}`, editor],
  ['mention_search', `/api/posts/${vol.id}/mentions?visibility=internal&q=a`, editor],
  ['tasks_mine', '/api/tasks?view=mine', approver],
  ['tasks_team', '/api/tasks?view=team', owner],
  ['tasks_post', `/api/tasks?view=all&status=all&post_id=${vol.id}&limit=50`, owner],
  ['task_workload', '/api/tasks/workload', owner],
  ['notifications_feed', '/api/notifications?limit=30', editor],
  ['notifications_bell', '/api/notifications?limit=20', approver],
  ['history_page', `/api/posts/${demo.id}/history`, editor],
  ['compare', `/api/posts/${demo.id}/compare?from=${firstVersion}&to=current`, editor],
  ['activity', `/api/posts/${vol.id}/activity`, editor],
  ['events_poll', `/api/collab/events?post=${vol.id}&after=now`, editor],
  ['presence_get', `/api/posts/${demo.id}/presence`, editor],
  ['planner_week (decorated)', `/api/planner?from=${today}T00:00:00Z&to=${new Date(Date.now() + 7 * 86_400_000).toISOString()}`, owner],
  ['admin_collaboration', '/api/admin/collaboration', owner],
  ['post_detail', `/api/posts/${demo.id}`, editor],
];
const api = {};
for (const [k, path, who] of API) {
  const xs = []; let bytes = 0;
  for (let i = 0; i < 31; i++) {
    const t0 = performance.now();
    const res = await fetch(`${BASE}${path}`, { headers: who.headers });
    const buf = await res.arrayBuffer();
    if (res.status !== 200) { console.log('api status', k, res.status, Buffer.from(buf).toString().slice(0, 200)); break; }
    if (i > 0) xs.push(performance.now() - t0);
    bytes = buf.byteLength;
  }
  api[k] = { ...sum(xs), payload_kb: Math.round(bytes / 102.4) / 10 };
  console.log('api', k, JSON.stringify(api[k]));
}
// A write: create a reply (persisted + outbox + event in one transaction).
{
  const xs = [];
  for (let i = 0; i < 21; i++) {
    await db.query(`DELETE FROM rate_limit_buckets WHERE key LIKE 'collab.%'`);
    const t0 = performance.now();
    const res = await fetch(`${BASE}/api/threads/${firstThread}/replies`, { method: 'POST', headers: editor.headers, body: JSON.stringify({ body: `perf reply ${i}`, client_key: `perf_${randomUUID().slice(0, 12)}` }) });
    await res.arrayBuffer();
    if (i > 0) xs.push(performance.now() - t0);
  }
  api['reply_write (returns full thread)'] = sum(xs);
  console.log('api reply_write', JSON.stringify(api['reply_write (returns full thread)']));
}

// ---------------------------------------------------------------- 2) sync latency (SSE)
async function openStream(who, postId) {
  const cur = await (await fetch(`${BASE}/api/collab/events?post=${postId}&after=now`, { headers: who.headers })).json();
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/api/collab/stream?post=${postId}&after=${cur.cursor}`, { headers: { ...who.headers, accept: 'text/event-stream' }, signal: ctrl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const waiters = [];
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (data) { const at = performance.now(); for (const w of waiters.splice(0)) w(at); }
        }
      }
    } catch { /* aborted */ }
  })();
  return { next: () => new Promise((res2) => waiters.push(res2)), close: () => ctrl.abort() };
}
const sync = [];
{
  const syncThread = (await one(`SELECT id FROM comment_threads WHERE post_id=$1 AND resolved_at IS NOT NULL ORDER BY created_at LIMIT 1`, [demo.id])).id;
  const s = await openStream(approver, demo.id);
  await new Promise((r2) => setTimeout(r2, 500));
  for (let i = 0; i < 20; i++) {
    await db.query(`DELETE FROM rate_limit_buckets WHERE key LIKE 'collab.%'`);
    const got = s.next();
    const t0 = performance.now();
    await fetch(`${BASE}/api/posts/${demo.id}/threads/read`, { method: 'POST', headers: editor.headers, body: '{}' }); // warm-up noop write path
    const res = await fetch(`${BASE}/api/threads/${syncThread}/replies`, { method: 'POST', headers: editor.headers, body: JSON.stringify({ body: `sync check ${i}` }) });
    await res.arrayBuffer();
    const at = await Promise.race([got, new Promise((r2) => setTimeout(() => r2(null), 15_000))]);
    if (at) sync.push(at - t0);
    await new Promise((r2) => setTimeout(r2, 300));
  }
  s.close();
  // Put the demo thread back to resolved (the sync replies reopened it).
  const th = { id: syncThread };
  if (th) {
    await db.query(`UPDATE comments SET deleted_at=now(), body='—' WHERE thread_id=$1 AND body LIKE 'sync check %'`, [th.id]);
    await db.query(`UPDATE comment_threads SET resolved_at=now() WHERE id=$1`, [th.id]);
  }
}
console.log('sync_ms', JSON.stringify(sum(sync)));

// ---------------------------------------------------------------- 3) browser
const INIT = `
  window.__perf = { lcp: 0, cls: 0, events: [] };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.lcp = Math.max(window.__perf.lcp, e.startTime); }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__perf.cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.interactionId) window.__perf.events.push(e.duration); }).observe({ type: 'event', buffered: true, durationThreshold: 16 }); } catch {}
`;
const READY = () => !!document.querySelector('h1') && !document.querySelector('.skeleton, [aria-label="Loading post"]');
const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
async function newPage(who) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: 'sl_session', value: who.token, domain: new URL(BASE).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
  await ctx.addInitScript(INIT);
  return { ctx, page: await ctx.newPage() };
}
const ROUTES = [
  ['composer_with_panel', `/posts/${demo.id}?panel=discussion`, editor, async (p) => { const b = p.getByRole('combobox', { name: /New internal comment/ }); await b.click(); await p.keyboard.type('Quick check', { delay: 60 }); await b.fill(''); }],
  ['composer_volume_post', `/posts/${vol.id}?panel=discussion`, editor, null],
  ['tasks', '/tasks', approver, null],
  ['notifications', '/notifications', approver, null],
  ['admin_collaboration', '/admin/collaboration', owner, null],
];
const routes = {};
for (const [name, url, who, act] of ROUTES) {
  { const { ctx, page } = await newPage(who); await page.goto(`${BASE}${url}`); await page.waitForFunction(READY, null, { timeout: 60_000 }).catch(() => {}); await ctx.close(); }
  const s = { lcp: [], cls: [], useful: [], inp: [], js_kb: [], requests: [] };
  for (let i = 0; i < RUNS; i++) {
    const { ctx, page } = await newPage(who);
    await page.goto(`${BASE}${url}`, { waitUntil: 'commit' });
    await page.waitForFunction(READY, null, { timeout: 60_000, polling: 'raf' });
    const useful = await page.evaluate(() => performance.now());
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    if (act) await act(page).catch((e) => console.log('interaction failed', name, e.message.slice(0, 100)));
    const m = await page.evaluate(() => {
      const res = performance.getEntriesByType('resource');
      const js = res.filter((e) => e.initiatorType === 'script' || /\.js(\?|$)/.test(e.name));
      return { lcp: window.__perf.lcp, cls: window.__perf.cls, inp: window.__perf.events.length ? Math.max(...window.__perf.events) : 0, js: js.reduce((a, e) => a + (e.encodedBodySize || e.transferSize || 0), 0), requests: res.length + 1 };
    });
    s.lcp.push(m.lcp); s.cls.push(m.cls); s.useful.push(useful); s.inp.push(m.inp); s.js_kb.push(m.js / 1024); s.requests.push(m.requests);
    await ctx.close();
  }
  routes[name] = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { ...sum(v), p75: r(pct(v, 75)) }]));
  console.log('route', name, JSON.stringify({ lcp_p75: routes[name].lcp.p75, useful_p95: routes[name].useful.p95, cls_p75: routes[name].cls.p75, inp_p75: routes[name].inp.p75, js_kb_p50: routes[name].js_kb.p50 }));
}
await browser.close();
await db.query(`DELETE FROM sessions WHERE token_hash = ANY($1)`, [tokens.map((t) => createHash('sha256').update(t).digest())]);
await db.end();

const out = {
  label: LABEL, generated_at: new Date().toISOString(), base_url: BASE,
  conditions: { host: `${os.cpus().length} vCPU ${os.cpus()[0]?.model ?? ''}`.trim(), memory_gb: Math.round(os.totalmem() / 2 ** 30), network: 'localhost, no throttling',
    build: 'production (next build --webpack + next start)', dataset: { workspace: 'Demo Workspace (synthetic)', volume_post: counts } },
  api_ms: api, sync_latency_ms: { sse_comment_to_other_person: sum(sync), polling_fallback_interval_s: 10, stream_recheck_s: 15, stream_lifetime_s: 55 },
  browser: routes,
};
mkdirSync('evidence/collaboration', { recursive: true });
writeFileSync(`evidence/collaboration/perf-${LABEL}.json`, JSON.stringify(out, null, 2));
console.log(`wrote evidence/collaboration/perf-${LABEL}.json`);
