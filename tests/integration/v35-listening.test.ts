// V3.5 stream D — social listening through the REAL policy path (v2Ctx) and real Postgres, on the SIMULATED Facebook Page
// (connected-source monitoring from the inbox). Brief §22 acceptance tests 10 (alert links to real observations + states
// coverage), 12 (revocation), 13 (outages/incomplete collection never look like success) + DM exclusion, Boolean searches,
// versioning, dedupe, sentiment correction, share of voice, deletion propagation, tenant/brand isolation, insight actions.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectMock } from '@social-lite/services/connections/index';
import { enableChannel, ingestItems, simulateInbound, handleInboxEvent, resetInboxHooksForTests } from '@social-lite/services/inbox/index';
import {
  archiveSearch, correctSentiment, createFromInsight, createRule, createSearch, evaluateRule, getAlert, getMention, listAlerts, listSearches, listeningSources,
  observeMessage, previewSearch, registerListeningHooks, rematchSearch, reprocessEdited, runBackfills, searchMentions, searchSentiment, searchSummary, searchTimeline,
  searchTopics, setChannelListening, setExcluded, shareOfVoice, sweepIngest, updateSearch, createDashboard, listDashboards, listeningAdminOverview, pendingRematches, sweepAlertRules,
} from '@social-lite/services/listening/index';
import type { Ctx } from '@social-lite/services';
import { addMember, closeTestPool, createBrand, createUser, createWorkspace, grant, testPool, v2Ctx } from './helpers.js';

afterAll(async () => { await closeTestPool(); });
beforeAll(() => { testPool(); });

const key = () => randomUUID().replace(/-/g, '');

async function member(ws: string, role: string, brandId?: string, name = 'Member') {
  const u = await createUser(undefined, name);
  await testPool().query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, [ws, u.id]);
  await grant(ws, u.id, role, brandId);
  return u;
}

interface World { ws: string; brand: string; brandB: string; owner: Ctx; analyst: Ctx; analystId: string; agent: Ctx; outsider: Ctx; channelId: string; pageId: string }

async function world(): Promise<World> {
  const ws = await createWorkspace('Listening');
  const brand = await createBrand(ws, 'Vitalos Café');
  const brandB = await createBrand(ws, 'Other brand');
  const o = await createUser(undefined, 'Olive Owner');
  await addMember(ws, o.id, 'owner');
  const an = await member(ws, 'analyst', brand, 'Ana Analyst');
  const ag = await member(ws, 'care_agent', brand, 'Cal Care');
  const out = await member(ws, 'analyst', brandB, 'Otto Outsider');
  const owner = await v2Ctx(o.id, ws);
  const conn = await connectMock(owner, brand, { provider: 'facebook', display_name: 'Simulated Café Page', scenario: 'success' });
  const ch = await enableChannel(owner, { connection_id: conn.id });
  return { ws, brand, brandB, owner, analyst: await v2Ctx(an.id, ws), analystId: an.id, agent: await v2Ctx(ag.id, ws), outsider: await v2Ctx(out.id, ws), channelId: ch.id, pageId: conn.provider_account_id };
}

/** Simulated inbound item (through the real inbox ingestion), then observed by listening. */
async function comment(w: World, text: string, minutesAgo = 0, kind: 'comment' | 'dm' = 'comment') {
  const r = await simulateInbound(w.owner, w.channelId, { kind, text, name: 'Pat Public', minutes_ago: minutesAgo });
  const m = (await testPool().query<{ id: string }>(`SELECT id FROM inbox_messages WHERE external_id=$1`, [r.external_id])).rows[0]!;
  const res = await observeMessage(m.id);
  return { messageId: m.id, externalId: r.external_id, observationId: res.observationId, res };
}

const own = (w: World, extra: Record<string, unknown> = {}) => createSearch(w.owner, { brand_id: w.brand, name: 'Vitalos', role: 'own', terms: ['Vitalos', 'Vitalos Café'], keywords: [], exclusions: ['job'], boolean: null, languages: [], sources: [], kinds: [], ...extra } as never);

describe('V3.5 listening — connected-source monitoring', () => {
  it('observes public comments only (DMs never), classifies transparently, matches Boolean searches with versions', async () => {
    const w = await world();
    const s = await own(w);
    expect(s).toMatchObject({ version: 1, role: 'own', can_manage: true });
    const c1 = await comment(w, 'I love the flat white at Vitalos — best in town!');
    const c2 = await comment(w, 'Vitalos charged me twice and nobody replied. Terrible.');
    const c3 = await comment(w, 'Vitalos is hiring? Any job openings?');            // excluded term "job"
    const dm = await comment(w, 'Vitalos refund please', 0, 'dm');                   // private: never observed
    expect(dm.observationId).toBeNull();
    expect((await testPool().query(`SELECT count(*)::int AS n FROM listening_observations WHERE workspace_id=$1`, [w.ws])).rows[0].n).toBe(3);
    expect((await testPool().query(`SELECT count(*)::int AS n FROM listening_observations o JOIN inbox_messages m ON m.id=o.inbox_message_id JOIN inbox_conversations c ON c.id=m.conversation_id WHERE c.kind='dm'`)).rows[0].n).toBe(0);
    expect(c1.res.matched).toEqual([s.id]);
    expect(c3.res.matched).toEqual([]);

    const ments = await searchMentions(w.analyst, s.id, { days: 7 });
    expect(ments.items.map((m) => m.text)).toEqual(expect.arrayContaining([expect.stringContaining('flat white'), expect.stringContaining('charged me twice')]));
    expect(ments.items).toHaveLength(2);
    const neg = ments.items.find((m) => m.id === c2.observationId)!;
    expect(neg.sentiment).toMatchObject({ label: 'negative', method: 'lexicon_v1', effective: 'negative' });
    expect(neg.sentiment.evidence.length).toBeGreaterThan(0);
    expect(neg.is_simulated).toBe(true);
    expect(ments.coverage).toMatchObject({ dataset: 'simulated', query_version: 1, state: 'matches', sample: { unique: 2 } });
    expect(ments.coverage.sources.map((x) => x.key)).toEqual(['connected:facebook_page']);
    expect(ments.coverage.awaiting.length).toBeGreaterThan(0);
    expect(ments.coverage.limitations.join(' ')).toMatch(/Private messages are never included/);

    // Boolean query + versioning: new version re-matches stored mentions.
    await expect(updateSearch(w.owner, s.id, { boolean: '(flat AND', expected_version: 1 })).rejects.toMatchObject({ code: 'validation_failed' });
    const v2 = await updateSearch(w.owner, s.id, { boolean: '"flat white" OR coffee*', expected_version: 1 });
    expect(v2.version).toBe(2);
    await expect(updateSearch(w.owner, s.id, { name: 'stale', expected_version: 1 })).rejects.toMatchObject({ code: 'version_conflict' });
    await rematchSearch(s.id);
    const m2 = await searchMentions(w.analyst, s.id, { days: 7 });
    expect(m2.items.map((m) => m.id)).toEqual([c1.observationId]);
    expect(m2.coverage.query_version).toBe(2);
    const prev = await previewSearch(w.analyst, { brand_id: w.brand, terms: ['Vitalos'], keywords: [], exclusions: [], boolean: 'twice', languages: [], sources: [], kinds: [] });
    expect(prev).toMatchObject({ matched: 1, dataset: 'simulated' });

    // Only managers define searches.
    await expect(own(w, { brand_id: w.brand })).resolves.toBeTruthy();
    await expect(createSearch(w.analyst, { brand_id: w.brand, name: 'x', role: 'own', terms: ['x'], keywords: [], exclusions: [], boolean: null, languages: [], sources: [], kinds: [] })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('honest metrics: repeats count once, zero matches vs not collected vs incomplete, corrections change counts', async () => {
    const w = await world();
    const s = await own(w);
    const a = await comment(w, 'Vitalos lemon tart was stale today, disappointing');
    const b = await comment(w, 'Vitalos lemon tart was stale today, disappointing!!');      // same normalised text → repeat
    expect((await testPool().query(`SELECT duplicate_of FROM listening_observations WHERE id=$1`, [b.observationId])).rows[0].duplicate_of).toBe(a.observationId);
    let sen = await searchSentiment(w.analyst, s.id, { days: 7 });
    expect(sen.denominator).toBe(1);
    expect(sen.counts.negative).toBe(1);
    expect((await searchMentions(w.analyst, s.id, { days: 7 })).coverage.sample).toMatchObject({ observations: 2, unique: 1, duplicates_collapsed: 1 });

    // Correction (managers only) changes the effective label everywhere; the inferred label stays visible.
    await expect(correctSentiment(w.analyst, a.observationId!, { label: 'neutral' })).rejects.toMatchObject({ code: 'forbidden' });
    await correctSentiment(w.owner, a.observationId!, { label: 'neutral' });
    sen = await searchSentiment(w.analyst, s.id, { days: 7 });
    expect(sen).toMatchObject({ counts: { negative: 0, neutral: 1 }, corrected: 1 });
    const mm = await getMention(w.analyst, a.observationId!);
    expect(mm.sentiment).toMatchObject({ label: 'negative', effective: 'neutral', corrected: { label: 'neutral' } });

    // Zero matches (collected) vs not collected (no source) vs incomplete (source failing).
    const empty = await createSearch(w.owner, { brand_id: w.brand, name: 'Nobody', role: 'competitor', terms: ['zzqx'], keywords: [], exclusions: [], boolean: null, languages: [], sources: [], kinds: [] });
    expect((await searchTimeline(w.analyst, empty.id, { days: 7 })).coverage.state).toBe('no_matches');
    const other = await createSearch(w.owner, { brand_id: w.brandB, name: 'B', role: 'own', terms: ['vitalos'], keywords: [], exclusions: [], boolean: null, languages: [], sources: [], kinds: [] });
    const tlB = await searchTimeline(w.owner, other.id, { days: 7 });
    expect(tlB.coverage.state).toBe('not_collected');
    expect(tlB.buckets.every((x) => x.unique === null)).toBe(true);                        // never drawn as zero
    await testPool().query(`UPDATE inbox_channels SET status='error', status_detail='Token expired' WHERE id=$1`, [w.channelId]);
    const tlErr = await searchTimeline(w.analyst, empty.id, { days: 7 });
    expect(tlErr.coverage.state).toBe('incomplete');
    expect(tlErr.coverage.incomplete).toEqual([{ channel: 'Simulated Café Page', reason: 'Token expired' }]);

    // Exclusion removes a mention from every metric.
    await setExcluded(w.owner, b.observationId!, { excluded: true, reason: 'Spam' });
    expect((await searchMentions(w.analyst, s.id, { days: 7, repeats: 'include' })).items).toHaveLength(1);
  });

  it('timeline, topics, share of voice within observed data, summary with source links', async () => {
    const w = await world();
    const ours = await own(w);
    const rival = await createSearch(w.owner, { brand_id: w.brand, name: 'Brewly', role: 'competitor', terms: ['Brewly'], keywords: [], exclusions: [], boolean: null, languages: [], sources: [], kinds: [] });
    for (const t of ['Vitalos oat latte is great', 'Vitalos oat latte too sweet', 'Vitalos oat latte again, lovely', 'Brewly oat latte was better than Vitalos', 'Brewly queue was slow'])
      await comment(w, t, 90);
    await comment(w, 'Vitalos at Brewly prices? no thanks', 0, 'dm');                          // DM: never in share of voice
    const tl = await searchTimeline(w.analyst, ours.id, { days: 2 });
    expect(tl.interval).toBe('hour');
    expect(tl.totals.unique).toBe(4);
    expect(tl.buckets.some((x) => x.collected && x.unique === 0)).toBe(true);
    const topics = await searchTopics(w.analyst, ours.id, { days: 7 });
    expect(topics.topics[0]).toMatchObject({ label: 'oat latte', count: 4 });
    expect(topics.topics.find((t) => t.label === 'vitalos')).toBeUndefined();                 // search terms excluded
    const sov = await shareOfVoice(w.analyst, { search_ids: `${ours.id},${rival.id}`, days: 7 });
    expect(sov.denominator).toBe(6);
    expect(sov.rows.map((r) => [r.search.name, r.count, r.share])).toEqual([['Vitalos', 4, 0.667], ['Brewly', 2, 0.333]]);
    expect(sov.note).toMatch(/observed data only/);
    const restricted = await createSearch(w.owner, { brand_id: w.brand, name: 'IG only', role: 'competitor', terms: ['brewly'], keywords: [], exclusions: [], boolean: null, languages: [], sources: ['connected:instagram'], kinds: [] });
    const sov2 = await shareOfVoice(w.analyst, { search_ids: `${ours.id},${restricted.id}`, days: 7 });
    expect(sov2.comparable_sources).toEqual(['connected:instagram']);
    expect(sov2.denominator).toBe(0);                                                         // comparable sources only, never mixed
    const sum = await searchSummary(w.analyst, ours.id, { days: 7 });
    expect(sum.highlights.length).toBeGreaterThan(0);
    expect(sum.highlights[0]!.mention.links.conversation_id).toBeTruthy();
    expect(sum.method).toMatch(/no generated text/);
    const dash = await createDashboard(w.analyst, { brand_id: w.brand, name: 'Weekly', widgets: [{ type: 'share_of_voice', search_ids: [ours.id, rival.id], days: 7 }], shared: false });
    expect((await listDashboards(w.analyst)).items.map((d) => d.id)).toContain(dash.id);
    expect((await listDashboards(w.owner)).items.map((d) => d.id)).not.toContain(dash.id); // personal
  });

  it('AT10: a spike alert needs minimum sample + baseline, links to real observations, states coverage, dedupes and cools down', async () => {
    const w = await world();
    const s = await own(w);
    // Baseline: one mention in each of the previous 6 hourly windows (monitoring history), then a burst now.
    for (let k = 1; k <= 6; k++) await comment(w, `Vitalos visit number ${k} was fine`, 60 * k + 30);
    const rule = await createRule(w.owner, { search_id: s.id, name: 'Mention spike', metric: 'volume', window_minutes: 60, baseline_days: 1, min_sample: 5, multiplier: 2, min_baseline_windows: 3, cooldown_minutes: 120, recipients: [w.analystId, w.owner.actor.userId], enabled: true });
    let r = await evaluateRule(rule.id);
    expect(r[0]).toMatchObject({ dataset: 'simulated', reason: 'below_minimum_sample' });
    const burst: Array<Awaited<ReturnType<typeof comment>>> = [];
    for (let i = 0; i < 7; i++) burst.push(await comment(w, `Vitalos is down again? order ${i} failed`));
    r = await evaluateRule(rule.id);
    expect(r[0]).toMatchObject({ reason: 'fired', observed: 7 });
    const alertId = r[0]!.alertId!;
    expect((await evaluateRule(rule.id))[0]!.reason).toBe('already_alerted');                // dedupe per window

    const a = await getAlert(w.analyst, alertId);
    expect(a.observed).toBe(7);
    expect(a.baseline.windows).toBeGreaterThanOrEqual(3);
    expect(a.threshold).toBeGreaterThanOrEqual(5);
    expect(a.is_simulated).toBe(true);
    expect(a.mentions.map((m) => m.id).sort()).toEqual(burst.map((b) => b.observationId).sort());
    const real = await testPool().query(`SELECT count(*)::int AS n FROM listening_observations o JOIN inbox_messages m ON m.id=o.inbox_message_id WHERE o.id = ANY($1::uuid[])`, [a.mentions.map((m) => m.id)]);
    expect(real.rows[0].n).toBe(7);                                                           // every evidence item is a real stored message
    expect(a.coverage).toMatchObject({ dataset: 'simulated', query_version: 1, sources: [{ key: 'connected:facebook_page', status: 'active', channels: 1 }] });
    expect(a.coverage.history_from).not.toBeNull();
    expect(a.coverage.limitations.join(' ')).toMatch(/Simulated data/);
    const notes = await testPool().query(`SELECT user_id, link_path FROM notifications WHERE kind='listening.alert' AND reference_id=$1`, [alertId]);
    expect(notes.rows).toHaveLength(2);
    expect(notes.rows[0].link_path).toBe(`/listening/alerts/${alertId}`);
    expect((await testPool().query(`SELECT count(*)::int AS n FROM outbox WHERE event_type='listening.alert_fired' AND aggregate_id=$1`, [alertId])).rows[0].n).toBe(1);
    expect((await listAlerts(w.analyst, {})).items.map((x) => x.id)).toEqual([alertId]);

    // Cooldown: pretend that alert belonged to the previous window (fired 20 min ago); this window's spike is held back.
    await testPool().query(`UPDATE listening_alerts SET dedupe_key = dedupe_key || ':prev', created_at = now() - interval '20 minutes' WHERE id=$1`, [alertId]);
    expect((await evaluateRule(rule.id))[0]!.reason).toBe('cooldown');
    await testPool().query(`UPDATE listening_alerts SET created_at = now() - interval '3 hours' WHERE id=$1`, [alertId]);
    const again = (await evaluateRule(rule.id))[0]!;
    expect(again.reason).toBe('fired');                                                       // after the cooldown, a new window alerts again
    await testPool().query(`DELETE FROM listening_alerts WHERE id=$1`, [again.alertId]);
    await testPool().query(`UPDATE listening_alerts SET dedupe_key = replace(dedupe_key, ':prev', ''), created_at = now() WHERE id=$1`, [alertId]);

    // Insight → task (idempotent, no customer text copied) and → draft.
    const k1 = key();
    const t1 = await createFromInsight(w.owner, { action: 'task', alert_id: alertId, idempotency_key: k1 });
    const t2 = await createFromInsight(w.owner, { action: 'task', alert_id: alertId, idempotency_key: k1 });
    expect(t2).toMatchObject({ target_id: t1.target_id, existing: true });
    const task = (await testPool().query(`SELECT title, description, brand_id FROM collab_tasks WHERE id=$1`, [t1.target_id])).rows[0];
    expect(task.brand_id).toBe(w.brand);
    expect(task.description).toContain(`/listening/alerts/${alertId}`);
    expect(task.description).not.toContain('order 3 failed');
    const d = await createFromInsight(w.owner, { action: 'draft', alert_id: alertId, idempotency_key: key() });
    expect((await testPool().query(`SELECT brand_id FROM posts WHERE id=$1`, [d.target_id])).rows[0].brand_id).toBe(w.brand);
    expect((await getAlert(w.owner, alertId)).actions.map((x) => x.action)).toEqual(['task', 'draft']);
  });

  it('insufficient baseline: a new source never alerts on its first burst', async () => {
    const w = await world();
    const s = await own(w);
    const rule = await createRule(w.owner, { search_id: s.id, name: 'Spike', metric: 'volume', window_minutes: 60, baseline_days: 7, min_sample: 3, multiplier: 2, min_baseline_windows: 24, cooldown_minutes: 60, recipients: [], enabled: true });
    for (let i = 0; i < 6; i++) await comment(w, `Vitalos burst ${i}`);
    expect((await evaluateRule(rule.id))[0]!.reason).toBe('insufficient_baseline');
    expect((await listAlerts(w.owner, {})).items).toHaveLength(0);
  });

  it('deletion + edit propagation: index, counts and alert evidence follow the source', async () => {
    const w = await world();
    const s = await own(w);
    for (let k = 1; k <= 4; k++) await comment(w, `Vitalos regular visit ${k}`, 60 * k + 30);
    const rule = await createRule(w.owner, { search_id: s.id, name: 'Spike', metric: 'volume', window_minutes: 60, baseline_days: 1, min_sample: 3, multiplier: 2, min_baseline_windows: 3, cooldown_minutes: 60, recipients: [], enabled: true });
    const items: Array<Awaited<ReturnType<typeof comment>>> = [];
    for (let i = 0; i < 4; i++) items.push(await comment(w, `Vitalos outage report ${i}`));
    const alertId = (await evaluateRule(rule.id))[0]!.alertId!;
    expect(alertId).toBeTruthy();
    const before = (await searchTimeline(w.analyst, s.id, { days: 1 })).totals.unique;

    // Provider deletion (verified webhook path → inbox ingest) erases the listening copy in the same transaction.
    await ingestItems('facebook_page', [{ type: 'delete', accountId: w.pageId, externalId: items[0]!.externalId, occurredAt: new Date().toISOString() }], { simulated: true });
    const o = (await testPool().query(`SELECT body, removed_at, terms FROM listening_observations WHERE id=$1`, [items[0]!.observationId])).rows[0];
    expect(o).toMatchObject({ body: null, terms: [] });
    expect(o.removed_at).not.toBeNull();
    expect((await testPool().query(`SELECT count(*)::int AS n FROM listening_matches WHERE observation_id=$1`, [items[0]!.observationId])).rows[0].n).toBe(0);
    expect((await testPool().query(`SELECT count(*)::int AS n FROM listening_observations WHERE body_tsv @@ plainto_tsquery('simple','outage report 0') AND id=$1`, [items[0]!.observationId])).rows[0].n).toBe(0);
    expect((await searchTimeline(w.analyst, s.id, { days: 1 })).totals.unique).toBe(before - 1);
    const a = await getAlert(w.analyst, alertId);
    expect(a.observed).toBe(4);                                                                // fire-time fact kept…
    expect(a.evidence).toMatchObject({ total: 4, available: 3, removed_at_source: 1 });      // …removal shown
    expect(a.mentions.find((m) => m.id === items[0]!.observationId)).toMatchObject({ text: null, removed_at_source: true });
    expect((await searchMentions(w.analyst, s.id, { days: 1 })).coverage.sample.removed_at_source).toBe(1);

    // Edit at source: re-classified and re-matched.
    await ingestItems('facebook_page', [{ type: 'edit', accountId: w.pageId, externalId: items[1]!.externalId, text: 'Sorry, wrong page — all good here', occurredAt: new Date().toISOString() }], { simulated: true });
    expect((await testPool().query(`SELECT needs_reprocess FROM listening_observations WHERE id=$1`, [items[1]!.observationId])).rows[0].needs_reprocess).toBe(true);
    await reprocessEdited();
    expect((await searchMentions(w.analyst, s.id, { days: 1 })).items.map((m) => m.id)).not.toContain(items[1]!.observationId);
  });

  it('AT12 + isolation: revocation blocks listening reads and alert delivery; brand/tenant/permission scoping', async () => {
    const w = await world();
    const s = await own(w);
    await comment(w, 'Vitalos scones are lovely');
    // Care agent (no listening.read), outsider (other brand), other tenant: nothing.
    await expect(listSearches(w.agent)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await listSearches(w.outsider)).items).toHaveLength(0);
    await expect(searchMentions(w.outsider, s.id, { days: 7 })).rejects.toMatchObject({ code: 'not_found' });
    const other = await world();
    await expect(searchTimeline(other.owner, s.id, { days: 7 })).rejects.toMatchObject({ code: 'not_found' });
    expect((await listeningSources(other.owner)).items.find((x) => x.key === 'connected:facebook_page')!.channels.map((c) => c.id)).not.toContain(w.channelId);

    // Rule notifies the analyst; revoke the analyst → reads fail immediately and the next alert is not delivered to them.
    for (let k = 1; k <= 4; k++) await comment(w, `Vitalos baseline ${k}`, 60 * k + 30);
    const rule = await createRule(w.owner, { search_id: s.id, name: 'Spike', metric: 'volume', window_minutes: 60, baseline_days: 1, min_sample: 3, multiplier: 2, min_baseline_windows: 3, cooldown_minutes: 60, recipients: [w.analystId], enabled: true });
    expect((await searchMentions(w.analyst, s.id, { days: 7 })).items.length).toBeGreaterThan(0);
    await testPool().query(`UPDATE scoped_role_grants SET revoked_at=now() WHERE workspace_id=$1 AND user_id=$2`, [w.ws, w.analystId]);
    await expect(v2Ctx(w.analystId, w.ws).then((c) => searchMentions(c, s.id, { days: 7 }))).rejects.toBeTruthy();
    for (let i = 0; i < 4; i++) await comment(w, `Vitalos spike ${i}`);
    const r = await evaluateRule(rule.id);
    expect(r[0]!.reason).toBe('fired');
    expect((await testPool().query(`SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='listening.alert'`, [w.analystId])).rows[0].n).toBe(0);
    await expect(createRule(w.owner, { search_id: s.id, name: 'x', metric: 'volume', window_minutes: 60, baseline_days: 1, min_sample: 3, multiplier: 2, min_baseline_windows: 3, cooldown_minutes: 60, recipients: [w.analystId], enabled: true }))
      .rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('insight → case links the mention’s conversation once; channel opt-out removes and backfill restores; hook + sweep ingest', async () => {
    const w = await world();
    const s = await own(w);
    const c = await comment(w, 'Vitalos my cake order never arrived');
    const k = key();
    const r1 = await createFromInsight(w.owner, { action: 'case', observation_id: c.observationId!, idempotency_key: k });
    const r2 = await createFromInsight(w.owner, { action: 'case', observation_id: c.observationId!, idempotency_key: key() });
    expect(r2.target_id).toBe(r1.target_id);                                                  // already a case: linked, not duplicated
    expect((await testPool().query(`SELECT case_id FROM inbox_conversations WHERE id=(SELECT conversation_id FROM listening_observations WHERE id=$1)`, [c.observationId])).rows[0].case_id).toBe(r1.target_id);
    await expect(createFromInsight(w.analyst, { action: 'case', observation_id: c.observationId!, idempotency_key: key() })).rejects.toMatchObject({ code: 'not_found' }); // analyst has no inbox access
    expect((await getMention(w.owner, c.observationId!)).links.case_id).toBe(r1.target_id);

    // Opt a channel out: its mentions leave listening (the inbox keeps them); coverage says so; re-include backfills.
    const out = await setChannelListening(w.owner, w.channelId, { excluded: true });
    expect(out.removed).toBe(1);
    const tl = await searchTimeline(w.owner, s.id, { days: 7 });
    expect(tl.coverage.incomplete[0]).toMatchObject({ reason: 'Excluded from listening' });
    expect((await simulateInbound(w.owner, w.channelId, { kind: 'comment', text: 'Vitalos while excluded' })).external_id).toBeTruthy();
    expect((await testPool().query(`SELECT count(*)::int AS n FROM listening_observations WHERE channel_id=$1`, [w.channelId])).rows[0].n).toBe(0);
    await setChannelListening(w.owner, w.channelId, { excluded: false });
    await runBackfills();
    expect((await searchMentions(w.owner, s.id, { days: 7 })).items).toHaveLength(2);

    // Fast path: inbox hook → outbox 'listening.ingest_requested' (public only). Sweep path: cursor catches up.
    resetInboxHooksForTests();
    registerListeningHooks();
    const pub = await simulateInbound(w.owner, w.channelId, { kind: 'comment', text: 'Vitalos hook test' });
    const priv = await simulateInbound(w.owner, w.channelId, { kind: 'dm', text: 'Vitalos private' });
    for (const ext of [pub.external_id, priv.external_id]) {
      const row = (await testPool().query(`SELECT o.* FROM outbox o JOIN inbox_messages m ON m.id::text = o.payload->>'messageId' WHERE m.external_id=$1 AND o.event_type='inbox.message_received'`, [ext])).rows[0];
      await handleInboxEvent({ event_type: row.event_type, workspace_id: row.workspace_id, aggregate_id: row.aggregate_id, payload: row.payload });
    }
    const req = await testPool().query(`SELECT count(*)::int AS n FROM outbox WHERE event_type='listening.ingest_requested' AND workspace_id=$1`, [w.ws]);
    expect(req.rows[0].n).toBe(1);
    await testPool().query(`UPDATE inbox_messages SET received_at = received_at - interval '2 minutes' WHERE workspace_id=$1`, [w.ws]);
    for (let i = 0; i < 50; i++) if ((await sweepIngest(500)).scanned < 500) break;
    expect((await testPool().query(`SELECT count(*)::int AS n FROM listening_observations WHERE workspace_id=$1`, [w.ws])).rows[0].n).toBe(3); // case comment + backfilled one + hook test (DM never)
    const adm = await listeningAdminOverview(w.owner);
    expect(adm.observations.total).toBe(3);
    expect(adm.sources.find((x) => x.key === 'broad:x_recent_search')!.status).toBe('awaiting_activation');

    await archiveSearch(w.owner, s.id);
    expect((await listSearches(w.owner)).items).toHaveLength(0);
  });

  it('worker paths: rematch queue recovery, sweep evaluation after new matches, admin backlog', async () => {
    const w = await world();
    const s = await own(w);
    expect(await pendingRematches(100)).toContain(s.id);                                       // new search ⇒ pending re-match
    await rematchSearch(s.id);
    expect(await pendingRematches(100)).not.toContain(s.id);
    for (let k = 1; k <= 4; k++) await comment(w, `Vitalos calm ${k}`, 60 * k + 30);
    const rule = await createRule(w.owner, { search_id: s.id, name: 'Spike', metric: 'volume', window_minutes: 60, baseline_days: 1, min_sample: 3, multiplier: 2, min_baseline_windows: 3, cooldown_minutes: 60, recipients: [], enabled: true });
    await testPool().query(`UPDATE listening_alert_rules SET last_evaluated_at = now() WHERE id=$1`, [rule.id]); // just evaluated (throttle)
    for (let i = 0; i < 3; i++) await comment(w, `Vitalos burst ${i}`);
    await testPool().query(`UPDATE listening_matches SET matched_at = now() + interval '1 second' WHERE search_id=$1`, [s.id]);
    expect(await sweepAlertRules()).toBeGreaterThanOrEqual(1);                                 // new matches since last check ⇒ evaluated
    expect((await listAlerts(w.owner, { search_id: s.id })).items).toHaveLength(1);
    const adm = await listeningAdminOverview(w.owner);
    expect(adm.alerts).toMatchObject({ open: 1, rules: 1 });
  });

  it('representative load: 20k mentions in a search — reads stay bounded (indexed, paginated)', async () => {
    const w = await world();
    const s = await own(w);
    // Fixture rows (broad layer: no inbox message needed) — test-only, never shown as a real source.
    await testPool().query(
      `INSERT INTO listening_observations(workspace_id, brand_id, layer, source_key, external_id, conversation_kind, body, language, terms, sentiment_label, sentiment_confidence, occurred_at, is_simulated)
       SELECT $1, $2, 'broad', 'broad:news_web', 'perf-' || g, 'mention', 'Vitalos perf item ' || g || CASE WHEN g % 3 = 0 THEN ' oat latte' ELSE ' scones' END, 'en',
              CASE WHEN g % 3 = 0 THEN ARRAY['oat','oat latte','latte'] ELSE ARRAY['scones'] END, CASE WHEN g % 4 = 0 THEN 'negative' ELSE 'positive' END, 0.7,
              now() - (g || ' minutes')::interval, true
         FROM generate_series(1, 20000) g`, [w.ws, w.brand]);
    await testPool().query(`INSERT INTO listening_matches(search_id, observation_id, workspace_id, query_version, occurred_at) SELECT $1, id, workspace_id, 1, occurred_at FROM listening_observations WHERE brand_id=$2 AND layer='broad'`, [s.id, w.brand]);
    await testPool().query('ANALYZE listening_observations; ANALYZE listening_matches');
    const timings: Record<string, number> = {};
    const time = async (k: string, fn: () => Promise<unknown>) => { const t = performance.now(); await fn(); timings[k] = Math.round(performance.now() - t); };
    await time('timeline_30d', () => searchTimeline(w.analyst, s.id, { days: 30 }));
    await time('timeline_30d_again', () => searchTimeline(w.analyst, s.id, { days: 30 }));
    await time('coverage_probe', () => searchMentions(w.analyst, s.id, { days: 30, limit: 1, sentiment: 'mixed' }));
    await time('sentiment_30d', () => searchSentiment(w.analyst, s.id, { days: 30 }));
    await time('topics_30d', () => searchTopics(w.analyst, s.id, { days: 30 }));
    await time('mentions_page', () => searchMentions(w.analyst, s.id, { days: 30, limit: 30 }));
    await time('mentions_text', () => searchMentions(w.analyst, s.id, { days: 30, text: 'latte' }));
    console.log(JSON.stringify({ listening_perf_ms: timings }));
    for (const v of Object.values(timings)) expect(v).toBeLessThan(3000);
    expect((await searchSentiment(w.analyst, s.id, { days: 30 })).denominator).toBe(20000);
  });
});

