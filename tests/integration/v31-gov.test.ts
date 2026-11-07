// V3.1 GOV against REAL PostgreSQL through the real policy path (v2Ctx): brand rules (mandatory vs advisory, review
// of affected content without rewriting it), asset governance, TipSignal fact preservation, reuse + evergreen queue
// (never recycling time-sensitive content), campaign links/UTM (no open redirect), read-only diagnostics, feature
// flag scoping, support-report redaction, onboarding state, MCP tools, and tenant isolation for all of it.
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toLocalInput } from '@social-lite/core';
import { createPost, dispatchEnabled, publishNow, schedulePost, updateDraft, validatePost, type Ctx } from '@social-lite/services';
import { readiness } from '@social-lite/services/product/index';
import { createSlot } from '@social-lite/services/slots/index';
import {
  addToContentQueue, archiveBrandRule, campaignMeasurement, checkPostBrandRules, createBrandRule, createSupportReport, createTrackedLink, decideRuleReview,
  disableTrackedLink, dispatchVersionAllowed, getAssetGovernance, getBrandProfile, getContentQueue, getProvenance, getReleaseNotes, getReuseEligibility,
  getUtmDefaults, integrationDiagnostics, isFeatureEnabled, listFeatureFlags, listRuleReviews, listSupportReports, listTrackedLinks, markReleaseNotesSeen,
  onboardingState, previewCampaignLink, removeFromContentQueue, resolveTrackedLink, reusePost, scheduleNextFromQueue, setAssetGovernance, setContentQueuePaused,
  setDispatchVersion, setEvergreen, setUtmDefaults, setWorkspaceFlag, updateBrandProfile, updateOnboarding,
} from '@social-lite/services/gov/index';
import { setMcpAuthTestOverrides } from '@social-lite/services/mcp/auth';
import { closeAllMcpSessions, handleMcpHttp } from '@social-lite/services/mcp/server';
import { consentClient } from '@social-lite/services/mcp/registry';
import { Client, StreamableHTTPClientTransport } from '@social-lite/services/mcp/sdk-client';
import { closeTestPool, createBrand, createWorkspace, testPool, v2Ctx } from './helpers.js';
import { seedConnections, seedReadyImage } from './engine-helpers.js';

const db = () => testPool();
const ISS = 'https://idp.test/realms/relay';
const RESOURCE = 'http://localhost:3000/mcp';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });

beforeAll(() => {
  testPool();
  setMcpAuthTestOverrides({ issuer: ISS, keys: async (kid) => (kid === 'k1' ? keys.publicKey : null) });
});
const createdWorkspaces: string[] = [];
afterAll(async () => {
  // Hygiene: other test files claim/reconcile deliveries globally; never leave this file's scheduled work behind.
  await testPool().query(`UPDATE deliveries SET state='cancelled' WHERE workspace_id = ANY($1::uuid[]) AND state IN ('scheduled','retry_wait','blocked','paused')`, [createdWorkspaces]);
  await closeAllMcpSessions(); setMcpAuthTestOverrides(null); await closeTestPool();
});

// ------------------------------------------------------------------ fixtures
async function member(ws: string, grants: Array<{ role: string; brandId?: string }>, opts: { issuer?: string } = {}): Promise<{ id: string; sub: string; ctx: () => Promise<Ctx> }> {
  const sub = randomUUID();
  const u = await db().query<{ id: string }>(`INSERT INTO users(oidc_issuer, oidc_subject, email, email_verified, name) VALUES ($1,$2,$3,true,'Gov user') RETURNING id`,
    [opts.issuer ?? 'test', sub, `gov-${sub.slice(0, 8)}@test.relay.test`]);
  const id = u.rows[0]!.id;
  await db().query(`INSERT INTO memberships(workspace_id, user_id, role, brand_restricted) VALUES ($1,$2,'viewer',$3)`, [ws, id, grants.some((g) => g.brandId)]);
  for (const g of grants) {
    await db().query(`INSERT INTO scoped_role_grants(workspace_id, principal_type, user_id, role, scope_type, brand_id, source) VALUES ($1,'user',$2,$3,$4,$5,'test')`,
      [ws, id, g.role, g.brandId ? 'brand' : 'workspace', g.brandId ?? null]);
  }
  return { id, sub, ctx: () => v2Ctx(id, ws) };
}

async function world() {
  const ws = await createWorkspace('Gov WS');
  createdWorkspaces.push(ws);
  const brandA = await createBrand(ws, 'Northfield');
  const brandB = await createBrand(ws, 'Other brand');
  const owner = await member(ws, [{ role: 'owner' }]);
  const conns = await seedConnections(ws, brandA);
  return { ws, brandA, brandB, owner, conns, ctx: await owner.ctx() };
}

const draftFor = (text: string, connectionIds: string[], assetIds: string[] = []) => ({
  baseText: text, baseLink: null, baseAssetIds: assetIds, variants: connectionIds.map((connectionId) => ({ connectionId, inheritText: true, inheritMedia: true })),
});
const later = (minutes = 600) => toLocalInput(new Date(Date.now() + minutes * 60_000), 'Europe/London');
const sched = (ctx: Ctx, postId: string, ids: string[], version = 1) =>
  schedulePost(ctx, postId, { expected_version: version, connection_ids: ids, input_local_time: later(), timezone: 'Europe/London' }, randomUUID());

const counts = async (ws: string) => (await db().query<Record<string, number>>(
  `SELECT (SELECT count(*)::int FROM outbox WHERE workspace_id=$1) outbox, (SELECT count(*)::int FROM deliveries WHERE workspace_id=$1) deliveries,
          (SELECT count(*)::int FROM delivery_attempts WHERE workspace_id=$1) attempts, (SELECT count(*)::int FROM schedules WHERE workspace_id=$1) schedules,
          (SELECT count(*)::int FROM mock_provider_objects) mock_objects, (SELECT coalesce(sum(value),0)::int FROM mock_provider_counters) mock_counters,
          (SELECT count(*)::int FROM posts WHERE workspace_id=$1) posts, (SELECT count(*)::int FROM sync_runs WHERE workspace_id=$1) sync_runs`, [ws])).rows[0]!;

// ====================================================================== §12 brand rules
describe('§12 brand rules: mandatory vs advisory, enforced in composer, preflight and scheduling', () => {
  it('mandatory rules block schedule/submit/publish; advisory rules only warn; editors cannot change rules', async () => {
    const t = await world();
    const editor = await member(t.ws, [{ role: 'editor', brandId: t.brandA }]);
    await expect(createBrandRule(await editor.ctx(), t.brandA, { kind: 'prohibited_phrase', value: 'sure win', severity: 'mandatory' })).rejects.toMatchObject({ code: 'forbidden' });
    await createBrandRule(t.ctx, t.brandA, { kind: 'prohibited_phrase', value: 'sure win', severity: 'mandatory' });
    await createBrandRule(t.ctx, t.brandA, { kind: 'discouraged_phrase', value: 'cheap', severity: 'advisory' });
    await createBrandRule(t.ctx, t.brandA, { kind: 'required_disclaimer', value: '18+', severity: 'mandatory', providers: ['telegram'] });

    // advisory only → schedules fine, warnings visible in composer validation + preflight
    const ok = await createPost(t.ctx, t.brandA, { draft: draftFor('A cheap day out', [t.conns.x, t.conns.facebook]) }, randomUUID());
    const v = await validatePost(t.ctx, ok.id) as Awaited<ReturnType<typeof validatePost>> & { brand_rules: { ok: boolean; advisory: Array<{ code: string }> } };
    expect(v.brand_rules).toMatchObject({ ok: true, mandatory: [] });
    expect(v.brand_rules.advisory.map((f) => f.code)).toEqual(['discouraged_phrase']);
    const pre = await readiness(t.ctx, ok.id, { mode: 'schedule', connection_ids: [t.conns.x], input_local_time: later(), timezone: 'Europe/London' });
    expect(pre.checks.filter((c) => c.key === 'brand_rules').map((c) => c.status)).toEqual(['warn']);
    await expect(sched(t.ctx, ok.id, [t.conns.x, t.conns.facebook])).resolves.toMatchObject({ status: 202 });

    // mandatory → refused by the server (not only the UI)
    const bad = await createPost(t.ctx, t.brandA, { draft: draftFor('Today is a SURE   WIN', [t.conns.x]) }, randomUUID());
    const pre2 = await readiness(t.ctx, bad.id, { mode: 'schedule', connection_ids: [t.conns.x], input_local_time: later(), timezone: 'Europe/London' });
    expect(pre2.ready).toBe(false);
    expect(pre2.checks.find((c) => c.key === 'brand_rules')).toMatchObject({ status: 'fail' });
    const e = await sched(t.ctx, bad.id, [t.conns.x]).catch((x) => x);
    expect(e).toMatchObject({ code: 'validation_failed', details: { reason: 'brand_rules' } });
    expect(e.details.brand_rules[0]).toMatchObject({ code: 'prohibited_phrase', severity: 'mandatory' });
    await expect(publishNow(t.ctx, bad.id, { expected_version: 1, connection_ids: [t.conns.x] }, randomUUID())).rejects.toMatchObject({ details: { reason: 'brand_rules' } });
    expect((await db().query(`SELECT count(*)::int n FROM schedules WHERE post_id=$1`, [bad.id])).rows[0].n).toBe(0);

    // provider-scoped mandatory rule: only Telegram needs the disclaimer
    const tg = await createPost(t.ctx, t.brandA, { draft: draftFor('Match day', [t.conns.telegram, t.conns.x]) }, randomUUID());
    const chk = await checkPostBrandRules(t.ctx, tg.id);
    expect(chk.mandatory).toEqual([expect.objectContaining({ code: 'missing_disclaimer', connection_id: t.conns.telegram })]);
    await expect(sched(t.ctx, tg.id, [t.conns.x])).resolves.toMatchObject({ status: 202 });

    // legacy brand voice "avoid terms" stay advisory
    await db().query(`UPDATE brands SET voice='{"prohibited":["synergy"]}' WHERE id=$1`, [t.brandA]);
    const legacy = await createPost(t.ctx, t.brandA, { draft: draftFor('Synergy!', [t.conns.facebook]) }, randomUUID());
    expect((await checkPostBrandRules(t.ctx, legacy.id)).advisory).toEqual([expect.objectContaining({ code: 'discouraged_phrase', source: 'brand_voice' })]);
    await expect(sched(t.ctx, legacy.id, [t.conns.facebook])).resolves.toMatchObject({ status: 202 });
  });

  it('rule changes never rewrite content: affected drafts and schedules are listed for an explicit, audited review', async () => {
    const t = await world();
    const draft = await createPost(t.ctx, t.brandA, { draft: draftFor('Visit our shop for deals', [t.conns.x]) }, randomUUID());
    const live = await createPost(t.ctx, t.brandA, { draft: draftFor('Big deals this weekend', [t.conns.facebook]) }, randomUUID());
    const s = await sched(t.ctx, live.id, [t.conns.facebook]);
    const scheduleId = (s.body as { schedule: { id: string } }).schedule.id;
    const before = await db().query(`SELECT p.draft, p.version, s.revision_id, s.status FROM posts p JOIN schedules s ON s.post_id=p.id WHERE p.id=$1`, [live.id]);

    const r = await createBrandRule(t.ctx, t.brandA, { kind: 'prohibited_phrase', value: 'deals', severity: 'mandatory' });
    expect(r.impact).toMatchObject({ rules_version: 1, affected: { drafts: 1, schedules: 1, reviews_opened: 2, truncated: false } });
    const after = await db().query(`SELECT p.draft, p.version, s.revision_id, s.status FROM posts p JOIN schedules s ON s.post_id=p.id WHERE p.id=$1`, [live.id]);
    expect(after.rows[0]).toEqual(before.rows[0]); // untouched: same text, version, revision, still active
    expect((await db().query(`SELECT count(*)::int n FROM deliveries WHERE schedule_id=$1 AND state='scheduled'`, [scheduleId])).rows[0].n).toBe(1);

    const reviews = (await listRuleReviews(t.ctx, t.brandA)).items;
    expect(reviews.map((x) => [x.kind, x.post_id]).sort()).toEqual([['draft', draft.id], ['schedule', live.id]].sort());
    const sr = reviews.find((x) => x.kind === 'schedule')!;
    expect(sr).toMatchObject({ schedule_id: scheduleId, mandatory_count: 1, status: 'open' });

    // keeping scheduled content needs scheduling authority; an editor cannot
    const editor = await member(t.ws, [{ role: 'editor', brandId: t.brandA }]);
    await expect(decideRuleReview(await editor.ctx(), sr.id, { decision: 'keep' })).rejects.toMatchObject({ code: 'forbidden' });
    const kept = await decideRuleReview(t.ctx, sr.id, { decision: 'keep', note: 'Approved by legal' });
    expect(kept).toMatchObject({ status: 'decided', decision: 'keep' });
    await expect(decideRuleReview(t.ctx, sr.id, { decision: 'keep' })).rejects.toMatchObject({ code: 'invalid_state' });
    expect((await db().query(`SELECT count(*)::int n FROM audit_events WHERE workspace_id=$1 AND action='brand_rule.review_decided'`, [t.ws])).rows[0].n).toBe(1);

    // archiving the rule: drafts that now pass have their open review superseded
    await archiveBrandRule(t.ctx, r.rule.id);
    expect((await listRuleReviews(t.ctx, t.brandA)).items).toEqual([]);
  });

  it('asset governance: expired assets are mandatory, superseded advisory; usage is reported', async () => {
    const t = await world();
    const img = await seedReadyImage(t.ws, t.brandA);
    const img2 = await seedReadyImage(t.ws, t.brandA);
    const post = await createPost(t.ctx, t.brandA, { draft: draftFor('Photo post', [t.conns.facebook], [img]) }, randomUUID());
    const sup = await setAssetGovernance(t.ctx, img, { superseded_by: img2, ownership: 'licensed', licence: 'Getty RM' });
    expect(sup).toMatchObject({ lifecycle: 'superseded', superseded_by: img2, usage: { drafts: 1 } });
    expect((await checkPostBrandRules(t.ctx, post.id)).advisory.map((f) => f.code)).toEqual(['asset_superseded']);
    await setAssetGovernance(t.ctx, img, { expires_at: new Date(Date.now() - 3600_000).toISOString() });
    expect((await getAssetGovernance(t.ctx, img)).expiry_state).toBe('expired');
    await expect(sched(t.ctx, post.id, [t.conns.facebook])).rejects.toMatchObject({ details: { reason: 'brand_rules', brand_rules: [expect.objectContaining({ code: 'asset_expired' })] } });
    // expiring before the publish time also blocks
    await setAssetGovernance(t.ctx, img, { expires_at: new Date(Date.now() + 120 * 60_000).toISOString() });
    await expect(sched(t.ctx, post.id, [t.conns.facebook])).rejects.toMatchObject({ details: { brand_rules: [expect.objectContaining({ code: 'asset_expires_before_publish' })] } });
    // viewer reads, cannot write
    const viewer = await member(t.ws, [{ role: 'viewer' }]);
    expect((await getAssetGovernance(await viewer.ctx(), img)).licence).toBe('Getty RM');
    await expect(setAssetGovernance(await viewer.ctx(), img, { lifecycle: 'archived' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('profile: approved logos must be the brand’s own assets; mandatory link domains apply', async () => {
    const t = await world();
    const mine = await seedReadyImage(t.ws, t.brandA);
    const theirs = await seedReadyImage(t.ws, t.brandB);
    await expect(updateBrandProfile(t.ctx, t.brandA, { logo_asset_ids: [theirs] })).rejects.toMatchObject({ code: 'validation_failed' });
    const p = await updateBrandProfile(t.ctx, t.brandA, { logo_asset_ids: [mine], colours: [{ name: 'Orange', hex: '#FD6701' }], tone: 'Warm' });
    expect(p).toMatchObject({ logo_asset_ids: [mine], tone: 'Warm', can_edit: true });
    await createBrandRule(t.ctx, t.brandA, { kind: 'approved_link_domain', value: 'https://northfield.example/', severity: 'mandatory' });
    const post = await createPost(t.ctx, t.brandA, { draft: { ...draftFor('See https://evil.example/x', [t.conns.facebook]) } }, randomUUID());
    expect((await checkPostBrandRules(t.ctx, post.id)).mandatory.map((f) => f.code)).toEqual(['unapproved_link']);
  });
});

// ====================================================================== §12 TipSignal fact preservation
describe('§12 TipSignal: source facts preserved, never promises', () => {
  async function tipPost(t: Awaited<ReturnType<typeof world>>, kickoff = new Date(Date.now() + 3 * 86400_000)) {
    const { draftText } = await import('@social-lite/services/tipsignal');
    const ev = { schema_version: 1 as const, event_id: `evt-gov-${randomUUID()}`, type: 'picks.ready' as const, occurred_at: new Date().toISOString(),
      data: { record_id: 'rec-1', source_url: 'https://tipsignal.example/r/1', fixture: { home: 'Northfield', away: 'Southport', competition: 'League One', kickoff_at: kickoff.toISOString() }, market: 'Match result', selection: 'Northfield', probability: 0.623 } };
    await db().query(`INSERT INTO source_events(source, source_event_id, event_type, schema_version, workspace_id, brand_id, payload, status) VALUES ('tipsignal',$1,'picks.ready',1,$2,$3,$4,'draft_created')`,
      [ev.event_id, t.ws, t.brandA, JSON.stringify(ev)]);
    const tz = (await db().query(`SELECT timezone FROM brands WHERE id=$1`, [t.brandA])).rows[0].timezone as string;
    const text = draftText(ev, tz);
    const r = await db().query<{ id: string }>(`INSERT INTO posts(workspace_id, brand_id, title, draft, source, tags) VALUES ($1,$2,'Pick',$3,$4,'{tipsignal,picks.ready}') RETURNING id`,
      [t.ws, t.brandA, JSON.stringify(draftFor(text, [t.conns.x, t.conns.facebook])), JSON.stringify({ kind: 'tipsignal', event_id: ev.event_id, record_id: 'rec-1', source_url: ev.data.source_url, type: ev.type })]);
    return { id: r.rows[0]!.id, text };
  }

  it('the deterministic draft schedules; altered probability / invented stats / promise language are refused', async () => {
    const t = await world();
    const p = await tipPost(t);
    expect((await checkPostBrandRules(t.ctx, p.id)).ok).toBe(true);
    // edit: probability changed + invented statistic + promise
    await updateDraft(t.ctx, p.id, { expected_version: 1, draft: draftFor(p.text.replace('62.3%', '75%').replace('Probabilities are estimates, not promises.', 'Guaranteed! They won 9 in a row.'), [t.conns.x, t.conns.facebook]) });
    const c = await checkPostBrandRules(t.ctx, p.id);
    expect(c.ok).toBe(false);
    expect(new Set(c.mandatory.map((f) => f.code))).toEqual(new Set(['tipsignal_fact_altered', 'tipsignal_fact_invented', 'tipsignal_promise_language']));
    expect(c.mandatory.every((f) => f.connection_id === null)).toBe(true); // same text on both destinations
    await expect(sched(t.ctx, p.id, [t.conns.x, t.conns.facebook], 2)).rejects.toMatchObject({ details: { reason: 'brand_rules' } });
    // restoring the source facts makes it schedulable again
    await updateDraft(t.ctx, p.id, { expected_version: 2, draft: draftFor(p.text, [t.conns.x, t.conns.facebook]) });
    await expect(sched(t.ctx, p.id, [t.conns.x, t.conns.facebook], 3)).resolves.toMatchObject({ status: 202 });
  });

  it('a destination-specific variant that drops the kick-off time is refused for that destination only', async () => {
    const t = await world();
    const p = await tipPost(t);
    const d = draftFor(p.text, [t.conns.x, t.conns.facebook]);
    d.variants[1] = { connectionId: t.conns.facebook, inheritText: false, inheritMedia: true, text: p.text.replace(/Kick-off .*\n/, '') } as never;
    await updateDraft(t.ctx, p.id, { expected_version: 1, draft: d });
    const c = await checkPostBrandRules(t.ctx, p.id);
    expect(c.mandatory.length).toBeGreaterThan(0);
    expect(c.mandatory.every((f) => f.connection_id === t.conns.facebook && f.code === 'tipsignal_fact_dropped')).toBe(true);
    await expect(sched(t.ctx, p.id, [t.conns.x], 2)).resolves.toMatchObject({ status: 202 });
  });

  it('picks are never recycled: reuse, evergreen and the queue all refuse them', async () => {
    const t = await world();
    const p = await tipPost(t);
    await expect(reusePost(t.ctx, p.id, { mode: 'duplicate' })).rejects.toMatchObject({ code: 'invalid_state', details: { reason: 'time_sensitive' } });
    await expect(setEvergreen(t.ctx, p.id, { evergreen: true })).rejects.toMatchObject({ details: { reason: 'time_sensitive' } });
    await expect(addToContentQueue(t.ctx, p.id)).rejects.toMatchObject({ details: { reason: 'not_eligible' } });
    expect((await getReuseEligibility(t.ctx, p.id)).reasons.map((r) => r.code)).toEqual(expect.arrayContaining(['tipsignal_source', 'contains_probability', 'contains_date_or_time']));
  });
});

// ====================================================================== §13 reuse + queue
describe('§13 reuse with provenance; evergreen queue never recycles', () => {
  it('reuses a published post as a new draft with provenance and similar-post warnings', async () => {
    const t = await world();
    const orig = await createPost(t.ctx, t.brandA, { title: 'Roastery story', draft: draftFor('How we roast our coffee, step by step.', [t.conns.facebook]) }, randomUUID());
    await expect(reusePost(t.ctx, orig.id, { mode: 'reuse' })).rejects.toMatchObject({ details: { reason: 'not_published' } });
    await publishNow(t.ctx, orig.id, { expected_version: 1, connection_ids: [t.conns.facebook] }, randomUUID());
    await db().query(`UPDATE deliveries SET state='published', published_at=now() - interval '2 days' WHERE post_id=$1`, [orig.id]);
    const r = await reusePost(t.ctx, orig.id, { mode: 'reuse' });
    expect(r.post_id).not.toBe(orig.id);
    expect(r.provenance).toMatchObject({ derived_post_id: r.post_id, original_post_id: orig.id, kind: 'reuse' });
    expect(r.provenance.original_revision_id).toBeTruthy();
    expect(r.similar).toEqual([expect.objectContaining({ connection_id: t.conns.facebook, other_post_id: orig.id, similarity: 1 })]);
    expect((await getProvenance(t.ctx, orig.id)).derivatives.map((d) => d.derived_post_id)).toEqual([r.post_id]);
    // the original itself is "already used" and cannot be queued again
    await setEvergreen(t.ctx, orig.id, { evergreen: true });
    expect((await getReuseEligibility(t.ctx, orig.id)).reasons.map((x) => x.code)).toContain('already_used');
    // brand-scoped user of brand B cannot see either post
    const other = await member(t.ws, [{ role: 'brand_manager', brandId: t.brandB }]);
    await expect(getProvenance(await other.ctx(), orig.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('queue: explicit evergreen only, pause blocks, one occurrence per item, never recurring; dated content refused', async () => {
    const t = await world();
    // A slot ~12 h away so the queued delivery never becomes due while other test files run (they claim globally).
    const slotHour = (Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' }).format(new Date())) + 12) % 24;
    await createSlot(t.ctx, t.brandA, { weekdays: [1, 2, 3, 4, 5, 6, 7], local_time: `${String(slotHour).padStart(2, '0')}:00`, timezone: 'Europe/London', connection_ids: [t.conns.facebook] });
    const ever = await createPost(t.ctx, t.brandA, { draft: draftFor('Our five favourite brewing tips.', [t.conns.facebook]) }, randomUUID());
    await expect(addToContentQueue(t.ctx, ever.id)).rejects.toMatchObject({ details: { reason: 'not_eligible' } }); // not marked
    expect((await setEvergreen(t.ctx, ever.id, { evergreen: true })).eligible).toBe(true);
    const item = await addToContentQueue(t.ctx, ever.id);
    await expect(addToContentQueue(t.ctx, ever.id)).rejects.toMatchObject({ code: 'conflict' });

    const dated = await createPost(t.ctx, t.brandA, { draft: draftFor('Sale ends 30 November!', [t.conns.facebook]) }, randomUUID());
    await setEvergreen(t.ctx, dated.id, { evergreen: true });
    await expect(addToContentQueue(t.ctx, dated.id)).rejects.toMatchObject({ details: { reason: 'not_eligible' } });

    // pause: inspect still works, scheduling refused
    const viewer = await member(t.ws, [{ role: 'viewer' }]);
    await expect(setContentQueuePaused(await viewer.ctx(), t.brandA, { paused: true })).rejects.toMatchObject({ code: 'forbidden' });
    const paused = await setContentQueuePaused(t.ctx, t.brandA, { paused: true, reason: 'Crisis comms' });
    expect(paused).toMatchObject({ paused: true, paused_reason: 'Crisis comms', items: [expect.objectContaining({ id: item.id, status: 'queued' })] });
    expect((await getContentQueue(await viewer.ctx(), t.brandA)).items).toHaveLength(1);
    await expect(scheduleNextFromQueue(t.ctx, t.brandA, `k-${randomUUID()}`)).rejects.toMatchObject({ details: { reason: 'queue_paused' } });
    await setContentQueuePaused(t.ctx, t.brandA, { paused: false });

    const key = `k-${randomUUID()}`;
    const s1 = await scheduleNextFromQueue(t.ctx, t.brandA, key);
    expect(s1).toMatchObject({ item_id: item.id, post_id: ever.id });
    const again = await scheduleNextFromQueue(t.ctx, t.brandA, key); // idempotent retry
    expect(again).toMatchObject({ item_id: item.id, schedule_id: s1.schedule_id, duplicate: true });
    expect((await db().query(`SELECT count(*)::int n FROM schedules WHERE post_id=$1`, [ever.id])).rows[0].n).toBe(1);
    expect((await db().query(`SELECT count(*)::int n FROM slot_reservations WHERE post_id=$1 AND released_at IS NULL`, [ever.id])).rows[0].n).toBe(1);
    // consumed: the queue is empty and the same post can never be queued again (no recurring publication)
    await expect(scheduleNextFromQueue(t.ctx, t.brandA, `k-${randomUUID()}`)).rejects.toMatchObject({ details: { reason: 'empty' } });
    await expect(addToContentQueue(t.ctx, ever.id)).rejects.toMatchObject({ code: 'invalid_state' }); // already scheduled

    // remove + unmark
    const p3 = await createPost(t.ctx, t.brandA, { draft: draftFor('Meet the team behind the beans.', [t.conns.facebook]) }, randomUUID());
    await setEvergreen(t.ctx, p3.id, { evergreen: true });
    const it3 = await addToContentQueue(t.ctx, p3.id);
    await removeFromContentQueue(t.ctx, it3.id);
    expect((await getContentQueue(t.ctx, t.brandA)).items.find((i) => i.id === it3.id)).toBeUndefined();
  });
});

// ====================================================================== §14 links
describe('§14 campaign links: UTM correctness and no open redirect', () => {
  it('layers brand → campaign defaults, preserves params, never duplicates keys', async () => {
    const t = await world();
    const camp = (await db().query<{ id: string }>(`INSERT INTO campaigns(workspace_id, brand_id, name) VALUES ($1,$2,'Autumn Launch 2026') RETURNING id`, [t.ws, t.brandA])).rows[0]!.id;
    await setUtmDefaults(t.ctx, t.brandA, { params: { utm_medium: 'organic_social' } });
    await setUtmDefaults(t.ctx, t.brandA, { campaign_id: camp, params: { utm_content: 'hero' } });
    expect((await getUtmDefaults(t.ctx, t.brandA, camp)).effective).toEqual({ utm_source: '{provider}', utm_medium: 'organic_social', utm_campaign: '{campaign}', utm_content: 'hero' });
    const p = await previewCampaignLink(t.ctx, { brand_id: t.brandA, campaign_id: camp, provider: 'instagram', url: 'https://northfield.example/shop?ref=abc&utm_source=newsletter&utm_source=x' });
    const u = new URL(p.url!);
    expect(Object.fromEntries(u.searchParams)).toEqual({ ref: 'abc', utm_source: 'newsletter', utm_medium: 'organic_social', utm_campaign: 'autumn_launch_2026', utm_content: 'hero' });
    expect([...u.searchParams.keys()].length).toBe(5);
    const ov = await previewCampaignLink(t.ctx, { brand_id: t.brandA, campaign_id: camp, provider: 'x', url: 'https://northfield.example/', overrides: { utm_source: 'x_promo', utm_content: null } });
    expect(new URL(ov.url!).searchParams.get('utm_source')).toBe('x_promo');
    expect(new URL(ov.url!).searchParams.has('utm_content')).toBe(false);
    expect((await previewCampaignLink(t.ctx, { brand_id: t.brandA, url: 'javascript:alert(1)' })).ok).toBe(false);
    // editors cannot change defaults; other brands' campaigns are invisible
    const editor = await member(t.ws, [{ role: 'editor', brandId: t.brandA }]);
    await expect(setUtmDefaults(await editor.ctx(), t.brandA, { params: {} })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(getUtmDefaults(t.ctx, t.brandB, camp)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('short links redirect only to the stored destination; unknown/disabled codes never redirect; clicks kept apart from other metrics', async () => {
    const t = await world();
    const camp = (await db().query<{ id: string }>(`INSERT INTO campaigns(workspace_id, brand_id, name) VALUES ($1,$2,'Clicks') RETURNING id`, [t.ws, t.brandA])).rows[0]!.id;
    await expect(createTrackedLink(t.ctx, { brand_id: t.brandA, url: 'javascript:alert(1)' })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(createTrackedLink(t.ctx, { brand_id: t.brandA, url: 'https://user:pw@northfield.example/' })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(createTrackedLink(t.ctx, { brand_id: t.brandA, url: 'http://localhost:3000/api/l/abcdefghijkl' })).rejects.toMatchObject({ code: 'validation_failed' });
    await createBrandRule(t.ctx, t.brandA, { kind: 'approved_link_domain', value: 'northfield.example', severity: 'mandatory' });
    await expect(createTrackedLink(t.ctx, { brand_id: t.brandA, url: 'https://evil.example/' })).rejects.toMatchObject({ details: { reason: 'brand_rules' } });
    const l = await createTrackedLink(t.ctx, { brand_id: t.brandA, campaign_id: camp, url: 'https://shop.northfield.example/a?x=1' });
    expect(l.code).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(l.short_url).toBe(`http://localhost:3000/api/l/${l.code}`);
    expect(await resolveTrackedLink(l.code)).toBe('https://shop.northfield.example/a?x=1');
    expect(await resolveTrackedLink(l.code)).toBe('https://shop.northfield.example/a?x=1');
    // open-redirect probes: a URL, path tricks and unknown codes never resolve
    for (const probe of ['https://evil.example', '//evil.example', '..%2f..%2fevil', `${l.code}?next=https://evil.example`, 'AAAAAAAAAAAA']) {
      expect(await resolveTrackedLink(probe)).toBeNull();
    }
    // stored destination is re-validated at redirect time (defence in depth)
    await db().query(`UPDATE tracked_links SET destination_url='http://localhost/admin' WHERE id=$1`, [l.id]);
    expect(await resolveTrackedLink(l.code)).toBeNull();
    await db().query(`UPDATE tracked_links SET destination_url='https://shop.northfield.example/a?x=1' WHERE id=$1`, [l.id]);
    await disableTrackedLink(t.ctx, l.id);
    expect(await resolveTrackedLink(l.code)).toBeNull();

    const m = await campaignMeasurement(t.ctx, camp);
    expect(m.app_clicks).toMatchObject({ status: 'available', total: 2 });
    expect(m.website_events.status).toBe('not_configured');
    expect(m.conversions).toMatchObject({ status: 'unavailable', model: null });
    expect(m.native_social.by_provider).toEqual([]);
    expect((await listTrackedLinks(t.ctx, t.brandA)).items[0]).toMatchObject({ clicks: 2, disabled: true });
    // measurement needs analytics.read; editor lacks it
    const editor = await member(t.ws, [{ role: 'editor', brandId: t.brandA }]);
    await expect(campaignMeasurement(await editor.ctx(), camp)).rejects.toMatchObject({ code: 'forbidden' });
  });
});

// ====================================================================== §15 diagnostics
describe('§15 integration diagnostics are read-only', () => {
  it('reports every check without publishing, calling providers or exposing secrets', async () => {
    const t = await world();
    const cred = await db().query<{ id: string }>(`INSERT INTO credentials(workspace_id, encrypted_blob, key_version, expires_at, refresh_expires_at, granted_scopes)
      VALUES ($1, '{"ct":"SENTINEL-CIPHERTEXT-should-never-leak"}'::jsonb, 'k1', now() + interval '3 days', NULL, '{tweet.write}') RETURNING id`, [t.ws]);
    await db().query(`UPDATE connections SET credential_id=$2, throttled_until=now() + interval '10 minutes' WHERE id=$1`, [t.conns.x, cred.rows[0]!.id]);
    const p = await createPost(t.ctx, t.brandA, { draft: draftFor('Queued for X', [t.conns.x]) }, randomUUID());
    await sched(t.ctx, p.id, [t.conns.x]);
    await db().query(`INSERT INTO delivery_attempts(workspace_id, delivery_id, attempt_number, fence, phase, correlation_id)
      SELECT workspace_id, id, 1, 1, 'preparing', 'corr-123.safe' FROM deliveries WHERE post_id=$1`, [p.id]);
    const before = await counts(t.ws);
    const d = await integrationDiagnostics(t.ctx);
    const d2 = await integrationDiagnostics(t.ctx, { connection_id: t.conns.x });
    expect(await counts(t.ws)).toEqual(before); // nothing published, queued, synced or created
    expect(d.read_only).toBe(true);
    expect(d.items).toHaveLength(4);
    const x = d2.items[0]!;
    expect(x.checks.map((c) => c.key)).toEqual(['authorization', 'selected_account', 'capabilities', 'token', 'publishing', 'media', 'analytics', 'quota', 'scheduled_work']);
    expect(x.token.expires_at).toBeTruthy();
    expect(x.quota.throttled_until).toBeTruthy();
    expect(x.checks.find((c) => c.key === 'quota')!.status).toBe('warning');
    expect(x.scheduled_work.count).toBe(1);
    expect(x.correlation.last_attempt_id).toBe('corr-123.safe');
    expect(x.capabilities.granted_scopes).toEqual(['tweet.write']);
    expect(JSON.stringify(d)).not.toMatch(/SENTINEL|encrypted_blob|ciphertext/i);
    // scope: brand-scoped analyst on brand B sees nothing of brand A; no connections.read → forbidden
    const other = await member(t.ws, [{ role: 'analyst', brandId: t.brandB }]);
    expect((await integrationDiagnostics(await other.ctx())).items).toEqual([]);
    await expect(integrationDiagnostics(await other.ctx(), { connection_id: t.conns.x })).rejects.toMatchObject({ code: 'not_found' });
    const exporter = await member(t.ws, [{ role: 'exporter' }]);
    await expect(integrationDiagnostics(await exporter.ctx())).rejects.toMatchObject({ code: 'forbidden' });
  });
});

// ====================================================================== §16 release controls
describe('§16 feature flags, support reports, release notes, dispatch guard', () => {
  it('flags are workspace-scoped with safe defaults; overrides need workspace.manage; kill switch wins', async () => {
    const a = await world();
    const b = await world();
    expect(await isFeatureEnabled(a.ws, 'v31.content_queue')).toBe(false);
    expect(await isFeatureEnabled(a.ws, 'does.not.exist')).toBe(false);
    const editor = await member(a.ws, [{ role: 'editor' }]);
    await expect(setWorkspaceFlag(await editor.ctx(), 'v31.content_queue', { enabled: true })).rejects.toMatchObject({ code: 'forbidden' });
    expect((await listFeatureFlags(await editor.ctx())).can_override).toBe(false);
    const r = await setWorkspaceFlag(a.ctx, 'v31.content_queue', { enabled: true });
    expect(r.flags.find((f) => f.key === 'v31.content_queue')).toMatchObject({ enabled: true, source: 'workspace_override', workspace_override: true });
    expect(await isFeatureEnabled(a.ws, 'v31.content_queue')).toBe(true);
    expect(await isFeatureEnabled(b.ws, 'v31.content_queue')).toBe(false); // other workspace unaffected
    await expect(setWorkspaceFlag(a.ctx, 'nope.flag', { enabled: true })).rejects.toMatchObject({ code: 'not_found' });
    await db().query(`UPDATE feature_flags SET killed=true WHERE key='v31.content_queue'`);
    try {
      expect(await isFeatureEnabled(a.ws, 'v31.content_queue')).toBe(false);
    } finally {
      await db().query(`UPDATE feature_flags SET killed=false WHERE key='v31.content_queue'`);
    }
    await setWorkspaceFlag(a.ctx, 'v31.content_queue', { enabled: null });
    expect(await isFeatureEnabled(a.ws, 'v31.content_queue')).toBe(false);
  });

  it('support reports are redacted: no credentials, no query strings, no draft text unless explicitly selected', async () => {
    const t = await world();
    const secretDraft = `Confidential launch copy ${'x'.repeat(800)} token=abcd1234secret`;
    const post = await createPost(t.ctx, t.brandA, { draft: draftFor(secretDraft, [t.conns.x]) }, randomUUID());
    const editor = await member(t.ws, [{ role: 'editor', brandId: t.brandA }]);
    const r = await createSupportReport(await editor.ctx(), {
      category: 'publishing', summary: 'Publish failed. Authorization: Bearer abc.def.ghi-123456 my email is a.person@example.com password=hunter2',
      route: `/posts/${post.id}?access_token=leak#frag`, app_version: '3.1.0', occurred_at: new Date().toISOString(),
      correlation_ids: ['8f0d1b2c-1111-2222-3333-444455556666', 'Bearer xyz secret value'],
      cookies: 'session=abc', draft_body: secretDraft, logs: ['token=1'],
    });
    const stored = (await db().query(`SELECT * FROM support_reports WHERE id=$1`, [r.id])).rows[0];
    const all = JSON.stringify(stored);
    expect(all).not.toMatch(/hunter2|a\.person@example\.com|abc\.def\.ghi|access_token|leak|session=abc|Confidential launch/);
    expect(stored.route).toBe(`/posts/${post.id}`);
    expect(stored.correlation_ids).toEqual(['8f0d1b2c-1111-2222-3333-444455556666']);
    expect(stored.attachments).toEqual({});
    expect(stored.redactions).toBeGreaterThanOrEqual(4);
    // explicit selection: bounded, redacted excerpt only
    const r2 = await createSupportReport(await editor.ctx(), { category: 'bug', summary: 'Composer issue', include_draft_post_id: post.id });
    expect(r2.attachments.draft_excerpt!.text.length).toBeLessThanOrEqual(500);
    expect(r2.attachments.draft_excerpt!.text).toMatch(/^Confidential launch copy/);
    // another brand's draft cannot be attached; listing needs audit.read
    const other = await member(t.ws, [{ role: 'editor', brandId: t.brandB }]);
    await expect(createSupportReport(await other.ctx(), { category: 'bug', summary: 'x', include_draft_post_id: post.id })).rejects.toMatchObject({ code: 'not_found' });
    await expect(listSupportReports(await editor.ctx())).rejects.toMatchObject({ code: 'forbidden' });
    expect((await listSupportReports(t.ctx)).items).toHaveLength(2);
    expect((await listSupportReports((await world()).ctx)).items).toHaveLength(0); // tenant isolation
  });

  it('release notes track per-user seen version', async () => {
    const t = await world();
    const n = await getReleaseNotes(t.ctx);
    expect(n.unseen).toBeGreaterThan(0);
    expect((await markReleaseNotesSeen(t.ctx, { version: n.notes[0]!.version })).unseen).toBe(0);
    await expect(markReleaseNotesSeen(t.ctx, { version: '9.9.9' })).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('dispatch version guard: only the pinned scheduler version may dispatch', async () => {
    expect(await dispatchVersionAllowed('3.0.0')).toBe(true); // unset = unchanged behaviour
    await setDispatchVersion('3.1.0', 'test');
    try {
      expect(await dispatchVersionAllowed('3.1.0')).toBe(true);
      expect(await dispatchVersionAllowed('3.0.0')).toBe(false);
      // the worker's gate: an old-version worker stops claiming; the pinned version (and version-less callers) continue
      expect(await dispatchEnabled(undefined, '3.0.0')).toBe(false);
      expect(await dispatchEnabled(undefined, '3.1.0')).toBe(true);
      expect(await dispatchEnabled()).toBe(true);
      await setDispatchVersion(['3.0.0', '3.1.0'], 'test');
      expect(await dispatchVersionAllowed('3.0.0')).toBe(true);
    } finally {
      await setDispatchVersion(null, 'test');
    }
  });
});

// ====================================================================== §7 onboarding
describe('§7 onboarding checklist', () => {
  it('derived from real data, resumable and role-adapted', async () => {
    const ws = await createWorkspace('Onboard WS');
    createdWorkspaces.push(ws);
    const owner = await member(ws, [{ role: 'owner' }]);
    let s = await onboardingState(await owner.ctx());
    expect(s.role_view).toBe('admin');
    expect(s.steps.map((x) => [x.key, x.status])).toEqual([['workspace', 'done'], ['brand', 'todo'], ['brand_defaults', 'todo'], ['connect_destination', 'todo'],
      ['invite_teammates', 'todo'], ['create_draft', 'todo'], ['schedule_first_post', 'todo']]);
    expect(s.next).toMatchObject({ key: 'brand', action: { href: expect.any(String) } });
    const brand = await createBrand(ws, 'First');
    const conns = await seedConnections(ws, brand);
    await updateOnboarding(await owner.ctx(), { acknowledge: 'brand_defaults' });
    await updateOnboarding(await owner.ctx(), { acknowledge: 'invite_teammates_skipped' });
    s = await onboardingState(await owner.ctx());
    expect(s.steps.filter((x) => x.status === 'done').map((x) => x.key)).toEqual(['workspace', 'brand', 'brand_defaults', 'connect_destination']);
    expect(s.steps.find((x) => x.key === 'invite_teammates')!.status).toBe('skipped');
    expect(s.next!.key).toBe('create_draft');
    expect(s.connections).toHaveLength(4);
    expect(Object.keys(s.connections[0]!.checks).sort()).toEqual(['analytics_permission', 'authorization', 'posting_permission', 'selected_account', 'supported_formats']);
    expect(s.connections[0]!.checks.authorization).toBe('ok');
    // dismiss / resume
    expect((await updateOnboarding(await owner.ctx(), { dismissed: true })).dismissed).toBe(true);
    expect((await updateOnboarding(await owner.ctx(), { dismissed: false })).dismissed).toBe(false);
    // a viewer is never told to administer; their own checklist is independent
    const viewer = await member(ws, [{ role: 'viewer' }]);
    const v = await onboardingState(await viewer.ctx());
    expect(v.role_view).toBe('reader');
    expect(v.steps.filter((x) => x.status === 'todo')).toEqual([]);
    expect(v.steps.every((x) => x.action === null || x.status === 'done')).toBe(true);
    expect(v.dismissed).toBe(false);
    // progress follows real data
    const ctx = await owner.ctx();
    const p = await createPost(ctx, brand, { draft: draftFor('First post', [conns.facebook]) }, randomUUID());
    await sched(ctx, p.id, [conns.facebook]);
    s = await onboardingState(ctx);
    expect(s.complete).toBe(true);
  });
});

// ====================================================================== tenant isolation (cross-workspace)
describe('tenant isolation', () => {
  it('another workspace sees none of it (404, never 403 with data)', async () => {
    const a = await world();
    const b = await world();
    const rule = await createBrandRule(a.ctx, a.brandA, { kind: 'prohibited_phrase', value: 'secret', severity: 'mandatory' });
    const img = await seedReadyImage(a.ws, a.brandA);
    const post = await createPost(a.ctx, a.brandA, { draft: draftFor('Hello', [a.conns.x]) }, randomUUID());
    const link = await createTrackedLink(a.ctx, { brand_id: a.brandA, url: 'https://northfield.example/' });
    const nf = { code: 'not_found' };
    await expect(getBrandProfile(b.ctx, a.brandA)).rejects.toMatchObject(nf);
    await expect(createBrandRule(b.ctx, a.brandA, { kind: 'prohibited_phrase', value: 'x', severity: 'mandatory' })).rejects.toMatchObject(nf);
    const { updateBrandRule } = await import('@social-lite/services/gov/brand-rules');
    await expect(updateBrandRule(b.ctx, rule.rule.id, { severity: 'advisory' })).rejects.toMatchObject(nf);
    await expect(listRuleReviews(b.ctx, a.brandA)).rejects.toMatchObject(nf);
    await expect(getAssetGovernance(b.ctx, img)).rejects.toMatchObject(nf);
    await expect(checkPostBrandRules(b.ctx, post.id)).rejects.toMatchObject(nf);
    await expect(reusePost(b.ctx, post.id, {})).rejects.toMatchObject(nf);
    await expect(getContentQueue(b.ctx, a.brandA)).rejects.toMatchObject(nf);
    await expect(addToContentQueue(b.ctx, post.id)).rejects.toMatchObject(nf);
    await expect(disableTrackedLink(b.ctx, link.id)).rejects.toMatchObject(nf);
    await expect(listTrackedLinks(b.ctx, a.brandA)).rejects.toMatchObject(nf);
    await expect(integrationDiagnostics(b.ctx, { connection_id: a.conns.x })).rejects.toMatchObject(nf);
    expect((await integrationDiagnostics(b.ctx)).items.every((i) => i.connection.brand_id === b.brandA)).toBe(true);
    // brand-scoped member inside the same workspace: brand B only
    const scoped = await member(a.ws, [{ role: 'brand_manager', brandId: a.brandB }]);
    await expect(getBrandProfile(await scoped.ctx(), a.brandA)).rejects.toMatchObject(nf);
    expect((await getBrandProfile(await scoped.ctx(), a.brandB)).can_edit).toBe(true);
  });
});

// ====================================================================== §17 MCP
describe('§17 MCP: get_brand_rules and get_integration_diagnostics', () => {
  function jwt(claims: Record<string, unknown>): string {
    const now = Math.floor(Date.now() / 1000);
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const body = { iss: ISS, aud: RESOURCE, azp: 'test-client', iat: now, exp: now + 300, typ: 'Bearer', scope: 'social.read', acr: 'mfa', amr: ['pwd', 'otp'], auth_time: now, ...claims };
    const data = `${enc({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${enc(body)}`;
    return `${data}.${sign('sha256', Buffer.from(data), keys.privateKey).toString('base64url')}`;
  }
  async function connect(token: string): Promise<Client> {
    const client = new Client({ name: 'gov-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(RESOURCE), { requestInit: { headers: { Authorization: `Bearer ${token}` } }, fetch: (u, i) => handleMcpHttp(new Request(u, i)) }));
    return client;
  }
  type Out = { isError?: boolean; structuredContent?: Record<string, any>; content: Array<{ text?: string }> };

  it('same services and permissions as the app; read-only; consented brands only', async () => {
    const t = await world();
    const u = await member(t.ws, [{ role: 'owner' }], { issuer: ISS });
    await createBrandRule(t.ctx, t.brandA, { kind: 'required_footer', value: '18+ only', severity: 'mandatory' });
    const client = await connect(jwt({ sub: u.sub, scope: 'social.read' }));
    await client.callTool({ name: 'list_workspaces', arguments: {} });
    const row = (await db().query<{ id: string }>(`SELECT id FROM mcp_clients WHERE owner_user_id=$1 AND status='pending'`, [u.id])).rows[0]!.id;
    await consentClient(await u.ctx(), row, { scopes: ['social.read'], brand_ids: [t.brandA] });
    const before = await counts(t.ws);
    const rules = await client.callTool({ name: 'get_brand_rules', arguments: { workspace_id: t.ws, brand_id: t.brandA } }) as Out;
    expect(rules.isError).toBeFalsy();
    expect(rules.structuredContent!.rules).toEqual([expect.objectContaining({ kind: 'required_footer', severity: 'mandatory', value: '18+ only' })]);
    const diag = await client.callTool({ name: 'get_integration_diagnostics', arguments: { workspace_id: t.ws } }) as Out;
    expect(diag.structuredContent!.read_only).toBe(true);
    expect(diag.structuredContent!.items).toHaveLength(4);
    expect(await counts(t.ws)).toEqual(before);
    // brand B was not consented → not found through MCP even though the owner can see it in the app
    const denied = await client.callTool({ name: 'get_brand_rules', arguments: { workspace_id: t.ws, brand_id: t.brandB } }) as Out;
    expect(denied.isError).toBe(true);
    expect(JSON.parse(denied.content[0]!.text!).error.code).toBe('not_found');
    const { tools } = await client.listTools();
    for (const n of ['get_brand_rules', 'get_integration_diagnostics']) expect(tools.find((x) => x.name === n)!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    await client.close();
  });
});

