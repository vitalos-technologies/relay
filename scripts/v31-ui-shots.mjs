#!/usr/bin/env node
// V3.1 UI evidence screenshots (DEV ONLY). Checkpoints → evidence/v3-1/ui/checkpoints/<n>-<area>-<theme>.png (1440, DPR 2);
// full set → evidence/v3-1/ui/<screen>-<width>-<theme>.png.
//
//   set -a; . ./.env; set +a; node scripts/v31-ui-shots.mjs [screen ...]
//   env: CHECKPOINT=1 (1440 only, checkpoint file names)  WIDTHS=1440,390  SCHEMES=light,dark
//
// Signs in as the Demo Workspace owner by inserting a short-lived session row with MIGRATOR_DATABASE_URL (never use
// against production). Fixtures go through the normal API; demo data stays in the Demo Workspace.
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';

const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const pg = require('pg');

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const checkpoint = process.env.CHECKPOINT === '1';
const OUT = checkpoint ? 'evidence/v3-1/ui/checkpoints' : 'evidence/v3-1/ui';
const only = process.argv.slice(2);
const widths = checkpoint ? [1440] : (process.env.WIDTHS || '1440,390').split(',').map(Number);
const schemes = (process.env.SCHEMES || 'light,dark').split(',');
if (!process.env.MIGRATOR_DATABASE_URL) throw new Error('MIGRATOR_DATABASE_URL is required (dev only)');
mkdirSync(OUT, { recursive: true });

const db = new pg.Pool({ connectionString: process.env.MIGRATOR_DATABASE_URL });
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const ws = (await one(`SELECT id FROM workspaces WHERE is_demo ORDER BY created_at LIMIT 1`)).id;
const owner = (await one(`SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.workspace_id=$1 AND m.role='owner' LIMIT 1`, [ws])).id;
const token = randomBytes(32).toString('base64url');
const csrf = randomUUID();
await db.query(`INSERT INTO sessions(user_id, token_hash, csrf_token, active_workspace_id, expires_at, mfa_verified, auth_time, acr, amr)
  VALUES ($1,$2,$3,$4,now() + interval '1 hour',true,now(),'mfa','{pwd,otp}')`, [owner, createHash('sha256').update(token).digest(), csrf, ws]);

const call = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method, headers: { origin: BASE, cookie: `sl_session=${token}`, 'content-type': 'application/json', 'x-csrf-token': csrf, 'x-workspace-id': ws, 'idempotency-key': randomUUID() }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// ---- fixtures (idempotent by title)
const coffee = await one(`SELECT id FROM brands WHERE workspace_id=$1 AND name ILIKE 'Relay Coffee%' LIMIT 1`, [ws]);
async function draftPost(title, text) {
  const existing = await one(`SELECT id FROM posts WHERE brand_id=$1 AND title=$2 AND archived_at IS NULL AND deleted_at IS NULL LIMIT 1`, [coffee.id, title]);
  if (existing) return existing.id;
  const conns = (await call('GET', `/api/brands/${coffee.id}/connections`)).body?.items ?? [];
  const variants = conns.filter((c) => c.status !== 'disconnected').slice(0, 4).map((c) => ({ connectionId: c.id, inheritText: true, inheritMedia: true }));
  const r = await call('POST', `/api/brands/${coffee.id}/posts`, { title, draft: { baseText: text, baseLink: null, baseAssetIds: [], variants } });
  if (!r.body?.id) console.log('fixture failed', title, r.status, JSON.stringify(r.body).slice(0, 200));
  return r.body?.id;
}
const session = (await call('GET', '/api/session')).body;
const ns = session.draft_recovery?.namespace;

const recoveryPost = await draftPost('Weekend brunch menu', 'Brunch is back this weekend: shakshuka, sourdough French toast and our cold brew tonic.');
const conflictPost = await draftPost('Barista workshop sign-ups', 'Learn latte art with our head barista. Saturday 10:00, six places.');

// Two trashed drafts for the Trash page (trashed through the API; restorable).
for (const [t, x] of [['Pumpkin spice teaser (old)', 'Pumpkin spice is coming back soon.'], ['Summer menu recap', 'Thanks for a great summer of iced lattes.']]) {
  const gone = await one(`SELECT id FROM posts WHERE brand_id=$1 AND title=$2 AND deleted_at IS NOT NULL LIMIT 1`, [coffee.id, t]);
  if (!gone) { const id = await draftPost(t, x); if (id) await call('POST', '/api/trash/items', { kind: 'post', id }); }
}

// Brand rules (V3.1 §12): flag on for the Demo Workspace, one draft that breaks a mandatory and an advisory rule.
await call('PUT', '/api/feature-flags/v31.brand_rules', { enabled: true });
const rulePost = await draftPost('Flash sale teaser', 'Cheap lattes all day on Monday. A sure win for your week.');
const rules = (await call('GET', `/api/brands/${coffee.id}/rules`)).body?.items ?? [];
if (!rules.some((r) => r.value === 'sure win')) await call('POST', `/api/brands/${coffee.id}/rules`, { kind: 'prohibited_phrase', value: 'sure win', severity: 'mandatory', providers: [], note: 'Never promise outcomes.' });
for (const r of rules) if (r.kind === 'approved_link_domain' && r.value === 'relay.coffee') await call('DELETE', `/api/brand-rules/${r.id}`); // earlier fixture; it flagged the UX showcase
if (!rules.some((r) => r.value === 'cheap')) await call('POST', `/api/brands/${coffee.id}/rules`, { kind: 'discouraged_phrase', value: 'cheap', severity: 'advisory', providers: [] });

// Onboarding (V3.1 §7): the seeded empty workspace "E2E Onboarding" (pnpm db:seed:e2e) with its own session.
const nw = await one(`SELECT id FROM workspaces WHERE name='E2E Onboarding' LIMIT 1`);
if (!nw) throw new Error('Run pnpm db:seed:e2e first (E2E Onboarding workspace)');
const token2 = randomBytes(32).toString('base64url');
await db.query(`INSERT INTO sessions(user_id, token_hash, csrf_token, active_workspace_id, expires_at, mfa_verified, auth_time, acr, amr)
  VALUES ($1,$2,$3,$4,now() + interval '1 hour',true,now(),'mfa','{pwd,otp}')`, [owner, createHash('sha256').update(token2).digest(), csrf, nw.id]);
await fetch(`${BASE}/api/feature-flags/v31.onboarding_checklist`, { method: 'PUT', headers: { origin: BASE, cookie: `sl_session=${token2}`, 'content-type': 'application/json', 'x-csrf-token': csrf, 'x-workspace-id': nw.id }, body: JSON.stringify({ enabled: true }) });
await call('PUT', '/api/feature-flags/v31.onboarding_checklist', { enabled: true });
// Content queue (V3.1 §13): flag on, two evergreen drafts queued, one time-sensitive draft marked evergreen (ineligible).
await call('PUT', '/api/feature-flags/v31.content_queue', { enabled: true });
const ever1 = await draftPost('Pour-over basics', 'Pour-over in four steps: rinse the filter, bloom the grounds, pour slowly in circles, enjoy.');
const ever2 = await draftPost('Why we roast light', 'Lighter roasts keep the fruit and floral notes of each origin. Ask us for a tasting flight.');
const timely = await draftPost('Saturday cupping', 'Join our cupping on Saturday 14 November at 10:00. Six seats left.');
for (const id of [ever1, ever2, timely]) await call('PUT', `/api/posts/${id}/evergreen`, { evergreen: true });
const q = (await call('GET', `/api/brands/${coffee.id}/content-queue`)).body;
for (const id of [ever1, ever2]) if (!q?.items?.some((i) => i.post_id === id && i.status === 'queued')) await call('POST', `/api/brands/${coffee.id}/content-queue`, { post_id: id });

// Bulk (V3.1 §11): runs in the E2E Workspace (Playwright's synthetic workspace) on three posts scheduled to simulated
// destinations three days out, so the preview shows eligible items and a real job.
const e2eWs = (await one(`SELECT id FROM workspaces WHERE name='E2E Workspace' LIMIT 1`)).id;
const token3 = randomBytes(32).toString('base64url');
await db.query(`INSERT INTO sessions(user_id, token_hash, csrf_token, active_workspace_id, expires_at, mfa_verified, auth_time, acr, amr)
  VALUES ($1,$2,$3,$4,now() + interval '1 hour',true,now(),'mfa','{pwd,otp}')`, [owner, createHash('sha256').update(token3).digest(), csrf, e2eWs]);
const call3 = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: { origin: BASE, cookie: `sl_session=${token3}`, 'content-type': 'application/json', 'x-csrf-token': csrf, 'x-workspace-id': e2eWs, 'idempotency-key': randomUUID() }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const vitalos = await one(`SELECT id FROM brands WHERE workspace_id=$1 AND name='Vitalos (demo)'`, [e2eWs]);
const vConns = (await call3('GET', `/api/brands/${vitalos.id}/connections`)).body?.items ?? [];
const vTg = vConns.find((c) => c.provider === 'telegram' && /simulated/.test(c.display_name) && c.status !== 'disconnected');
const bulkDay = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
for (const [n, t] of [['A', '07:30'], ['B', '12:00'], ['C', '17:45']]) {
  const title = `Weekly tip ${n}`;
  const has = await one(`SELECT p.id FROM posts p JOIN schedules s ON s.post_id=p.id WHERE p.brand_id=$1 AND p.title=$2 AND s.status='active' AND s.due_at > now() + interval '1 day' AND p.deleted_at IS NULL LIMIT 1`, [vitalos.id, title]);
  if (has || !vTg) continue;
  const r = await call3('POST', `/api/brands/${vitalos.id}/posts`, { title, draft: { baseText: `Weekly wellness tip ${n}: take a short walk after lunch.`, baseLink: null, baseAssetIds: [], variants: [{ connectionId: vTg.id, inheritText: true, inheritMedia: true }] } });
  const s1 = await call3('POST', `/api/posts/${r.body.id}/schedule`, { expected_version: r.body.version, connection_ids: [vTg.id], input_local_time: `${bulkDay}T${t}`, timezone: 'Europe/London' });
  if (s1.status >= 300) console.log('schedule failed', s1.status, JSON.stringify(s1.body).slice(0, 200));
}

// Campaign links (V3.1 §14): flag on, brand UTM defaults for Relay Coffee.
await call('PUT', '/api/feature-flags/v31.tracked_links', { enabled: true });
await call('PUT', `/api/brands/${coffee.id}/utm-defaults`, { campaign_id: null, params: { utm_medium: 'social', utm_source: 'relay' } });

await call('PUT', '/api/feature-flags/v31.integration_diagnostics', { enabled: true });
await call('PUT', '/api/feature-flags/v31.release_notes', { enabled: true });
const unseeNotes = () => db.query(`DELETE FROM release_note_reads WHERE user_id=$1`, [owner]);
// Phones show the composer as steps; checks and reuse live under Preview.
async function phonePreview(page) { if ((page.viewportSize()?.width ?? 1440) < 1024) await page.getByRole('radio', { name: /^Preview/ }).click(); }
async function postVersion(id) { return (await call('GET', `/api/posts/${id}`)).body?.version ?? 1; }

// ---- screens: [name, url, action?]
const SCREENS = [
  ['autosave-recovery', `/posts/${recoveryPost}`, async (page) => {
    const v = await postVersion(recoveryPost);
    await page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify({ base_version: v, title: 'Weekend brunch menu', saved_at: new Date(Date.now() - 6 * 60_000).toISOString(),
      draft: { baseText: 'Brunch is back this weekend: shakshuka, sourdough French toast, our cold brew tonic and a new maple granola bowl.', baseLink: null, baseAssetIds: [], variants: [] } })), [`${ns}:${recoveryPost}`, v]);
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText('Unsaved changes found').waitFor();
  }],
  ['autosave-conflict', `/posts/${conflictPost}`, async (page) => {
    const v = await postVersion(conflictPost);
    const d = (await call('GET', `/api/posts/${conflictPost}`)).body.draft;
    // Someone else saves first (another client), then this tab types.
    await call('PUT', `/api/posts/${conflictPost}/autosave`, { base_version: v, client_id: `shots_${randomUUID().slice(0, 8)}`, client_revision: 1, draft: { ...d, baseText: `${d.baseText.split(' (')[0]} (${new Date().toISOString().slice(11, 16)}) Bring your own cup for 10% off.` } });
    const box = page.getByRole('textbox', { name: 'Text', exact: true });
    await box.click();
    await box.press('End');
    await box.type(' Beginners welcome.');
    await page.getByRole('dialog', { name: 'Edited elsewhere' }).waitFor({ timeout: 15_000 });
  }],
  ['autosave-offline', `/posts/${recoveryPost}`, async (page, ctx) => {
    const box = page.getByRole('textbox', { name: 'Text', exact: true });
    await box.waitFor();
    await ctx.setOffline(true);
    await box.click();
    await box.press('End');
    await box.type(' Open from 9.');
    await page.getByText(/Offline ·/).first().waitFor({ timeout: 10_000 });
  }],
  ['settings-drafts', '/settings/workspace/drafts'],
  ['trash-page', '/trash'],
  ['trash-confirm', `/posts/${recoveryPost}`, async (page) => {
    await page.getByRole('button', { name: 'More post actions' }).click();
    await page.getByRole('menuitem', { name: 'Move to Trash' }).click();
    await page.getByTestId('trash-consequences').locator('li').first().waitFor();
    await page.waitForTimeout(500);
  }],
  ['bulk-preview', `/planner?view=agenda&date=${bulkDay}`, async (page) => {
    for (const n of ['A', 'B', 'C']) await page.getByRole('checkbox', { name: `Select Weekly tip ${n}` }).first().check();
    await page.getByRole('region', { name: 'Bulk actions' }).getByRole('button', { name: 'Reschedule' }).click();
    await page.getByTestId('bulk-preview').waitFor();
    await page.waitForTimeout(500);
  }],
  ['bulk-job', `/planner?view=agenda&date=${bulkDay}`, async (page) => {
    for (const n of ['A', 'B', 'C']) await page.getByRole('checkbox', { name: `Select Weekly tip ${n}` }).first().check();
    await page.getByRole('region', { name: 'Bulk actions' }).getByRole('button', { name: 'Reschedule' }).click();
    await page.getByTestId('bulk-preview').waitFor();
    // Move them back and forth across runs: +1 day on light, -1 day on dark.
    if (page.__scheme === 'dark') await page.getByRole('spinbutton', { name: 'Move by' }).fill('-1');
    await page.waitForTimeout(600);
    await page.getByRole('dialog').getByRole('button', { name: /^Reschedule \d/ }).click();
    await page.getByTestId('bulk-job').waitFor();
    await page.waitForTimeout(150);
  }],
  ['brand-rules', `/settings/publishing/brand-rules?brand=${coffee.id}`],
  ['brand-reviews', `/settings/publishing/brand-rules?brand=${coffee.id}`, async (page) => { await page.getByRole('tab', { name: /Reviews/ }).click(); await page.waitForTimeout(800); }],
  ['brand-composer', `/posts/${rulePost}`, async (page) => { await phonePreview(page); await page.getByTestId('brand-findings').waitFor({ timeout: 20_000 }); await page.getByRole('button', { name: /^Schedule/ }).hover(); await page.waitForTimeout(600); }],
  ['onboarding', '/'],
  ['onboarding-connections', '/', async (page) => { await page.getByRole('button', { name: /Connection readiness/ }).click().catch(() => {}); await page.waitForTimeout(400); }],
  ['queue-page', `/queue?brand=${coffee.id}`],
  ['reuse-composer', `/posts/${timely}`, async (page) => { await phonePreview(page); await page.getByText('Evergreen').first().waitFor(); await page.locator('#h-reuse').scrollIntoViewIfNeeded(); await page.waitForTimeout(600); }],
  ['links-settings', `/settings/publishing/links?brand=${coffee.id}`],
  ['links-builder', `/posts/${ever1}`, async (page) => {
    await page.getByRole('button', { name: 'Campaign link' }).click();
    await page.getByTestId('link-builder').getByRole('textbox', { name: 'Destination' }).fill('https://relay.coffee/brew-guides?ref=menu');
    await page.getByTestId('link-builder').getByRole('textbox', { name: 'Content' }).fill('pour-over');
    await page.getByTestId('link-preview-url').waitFor();
    await page.waitForTimeout(600);
  }],
  ['measurement', '/campaigns', async (page) => {
    await page.getByRole('button', { name: /^Actions for / }).first().click();
    await page.getByRole('menuitem', { name: 'Measurement' }).click();
    await page.getByTestId('campaign-measurement').waitFor();
    await page.waitForTimeout(500);
  }],
  ['diagnostics', '/accounts/diagnostics', async (page) => { await page.locator('main li button[aria-expanded]').first().click(); await page.waitForTimeout(500); }],
  ['diagnostics-drawer', '/accounts', async (page) => {
    await page.getByRole('button', { name: /^Actions for / }).first().click();
    await page.getByRole('menuitem', { name: 'Diagnostics' }).click();
    await page.locator('[data-testid^=diagnostics-]').waitFor();
    await page.waitForTimeout(500);
  }],
  ['flags-settings', '/settings/operations/features'],
  ['release-notes', '/', async (page) => {
    await unseeNotes(); await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /^Account menu/ }).click();
    await page.getByRole('menuitem', { name: /What.s new/ }).waitFor();
    await page.waitForTimeout(400);
  }],
  ['release-drawer', '/', async (page) => {
    await page.getByRole('button', { name: /^Account menu/ }).click();
    await page.getByRole('menuitem', { name: /What.s new/ }).click();
    await page.getByTestId('release-notes').waitFor();
    await page.waitForTimeout(500);
  }],
  ['support-report', '/posts/' + rulePost, async (page) => {
    await page.getByRole('button', { name: /^Account menu/ }).click();
    await page.getByRole('menuitem', { name: 'Report a problem' }).click();
    await page.getByRole('textbox', { name: 'What happened?' }).fill('Scheduling failed twice after I pasted token=abc123secret from the agency. Contact me at sam@example.com.');
    await page.getByRole('checkbox', { name: /page.s address/ }).check();
    await page.waitForTimeout(400);
  }],
  ['cmdk-recent', '/', async (page) => {
    await call('POST', '/api/search/recent', { kind: 'post', id: recoveryPost });
    await call('POST', '/api/search/recent', { kind: 'post', id: conflictPost });
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox').waitFor();
    await page.waitForTimeout(800);
  }],
  ['cmdk-results', '/', async (page) => {
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox').fill('latte');
    await page.getByRole('option').nth(1).waitFor();
    await page.waitForTimeout(800);
    await page.keyboard.press('ArrowDown');
  }],
].filter(([n]) => !only.length || only.includes(n));

const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
for (const scheme of schemes) {
  for (const w of widths) {
    for (const [name, url, act] of SCREENS) {
      // Fresh context per screen: offline/local storage from one screen never leaks into the next.
      const ctx = await browser.newContext({ viewport: { width: w, height: w < 600 ? 844 : 900 }, colorScheme: scheme, deviceScaleFactor: 2 });
      await ctx.addCookies([{ name: 'sl_session', value: name.startsWith('onboarding') ? token2 : name.startsWith('bulk') ? token3 : token, domain: new URL(BASE).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
      const page = await ctx.newPage();
      page.__scheme = scheme;
      page.setDefaultTimeout(30_000);
      page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 300)));
      page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 400) console.log('api', r.status(), name, w, r.url().replace(BASE, '').slice(0, 100)); });
      page.on('requestfailed', (r) => { if (r.url().includes('/api/')) console.log('requestfailed', name, w, r.url().replace(BASE, '').slice(0, 100), r.failure()?.errorText); });
      try { await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle', timeout: 180_000 }); }
      catch (e) { console.log('retry', name, e.message.slice(0, 80)); await page.waitForTimeout(5000); await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle', timeout: 180_000 }); }
      await page.waitForFunction(() => !document.querySelector('[role=status][aria-label=Loading], [aria-label="Loading post"], .skeleton'), null, { timeout: 60_000 }).catch(() => console.log('still loading', name));
      if (act) await act(page, ctx).catch((e) => console.log('action failed', name, e.message.slice(0, 160)));
      await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' }).catch(() => {});
      await page.waitForTimeout(900);
      if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) console.log('HORIZONTAL SCROLL', name, w, scheme);
      const n = { autosave: 1, settings: 1, cmdk: 2, trash: 3, bulk: 4, brand: 5, rules: 5, onboarding: 6, queue: 7, reuse: 7, links: 8, measurement: 8, diagnostics: 9, flags: 10, release: 10, support: 10 }[name.split('-')[0]] ?? 0;
      const file = checkpoint ? `${OUT}/${n}-${name}-${scheme}.png` : `${OUT}/${name}-${w}-${scheme}.png`;
      await page.screenshot({ path: file });
      console.log('shot', file);
      await ctx.close();
    }
  }
}
await browser.close();
await db.query(`DELETE FROM sessions WHERE token_hash = ANY($1)`, [[token, token2, token3].map((t) => createHash('sha256').update(t).digest())]);
await db.end();
