import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { draftText, receiveTipsignal, signTipsignal } from '@social-lite/services/tipsignal';
import { resetConfigCache } from '@social-lite/services';
import { closeTestPool, tenant, testPool } from './helpers.js';
import { seedConnections } from './engine-helpers.js';
import { ensureBucket } from '@social-lite/services/storage';

const SECRET = 'test-tipsignal-secret-0123456789abcdef';
let brandId = '';
afterAll(closeTestPool);
beforeAll(async () => {
  testPool();
  process.env.TIPSIGNAL_SIGNING_SECRET = SECRET;
  resetConfigCache();
  await ensureBucket();
  const t = await tenant();
  brandId = t.brandId;
  await seedConnections(t.workspaceId, t.brandId);
  await testPool().query(`DELETE FROM integration_bindings WHERE kind='tipsignal'`);
  await testPool().query(`INSERT INTO integration_bindings(kind, workspace_id, brand_id, acting_user_id) VALUES ('tipsignal',$1,$2,$3)`, [t.workspaceId, t.brandId, t.owner.id]);
});

const kickoff = new Date(Date.now() + 86_400_000).toISOString();
const pick = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  schema_version: 1, event_id: id, type: 'picks.ready', occurred_at: new Date().toISOString(),
  data: { record_id: 'rec-1', source_url: 'https://tipsignal.example/r/1', fixture: { home: 'Northfield', away: 'Southport', competition: 'League One', kickoff_at: kickoff },
    market: 'Match result', selection: 'Northfield', probability: 0.6234, ...extra },
});

describe('TipSignal events', () => {
  it('creates exactly one draft with exact facts and a validated graphic; retries are deduplicated', async () => {
    const raw = pick(`evt-${Date.now()}`);
    const r = await receiveTipsignal(raw, signTipsignal(SECRET, raw));
    expect(r.status).toBe(201);
    const again = await receiveTipsignal(raw, signTipsignal(SECRET, raw));
    expect(again.body).toMatchObject({ duplicate: true, status: 'draft_created' });
    const post = await testPool().query(`SELECT draft, source FROM posts WHERE id=$1`, [(r.body as { post_id: string }).post_id]);
    expect(post.rows[0].draft.baseText).toContain('Model probability: 62.3%. Probabilities are estimates, not promises.');
    expect(post.rows[0].source.record_id).toBe('rec-1');
    const asset = await testPool().query(`SELECT status FROM assets WHERE id=$1`, [post.rows[0].draft.baseAssetIds[0]]);
    expect(asset.rows[0].status).toBe('ready');
    const sched = await testPool().query(`SELECT count(*)::int n FROM schedules WHERE post_id=$1`, [(r.body as { post_id: string }).post_id]);
    expect(sched.rows[0].n).toBe(0); // draft only, never auto-published
  });

  it('rejects bad signatures, stale timestamps, destination overrides and expired picks', async () => {
    const raw = pick(`evt-sig-${Date.now()}`);
    await expect(receiveTipsignal(raw, signTipsignal('wrong', raw))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(receiveTipsignal(raw, signTipsignal(SECRET, raw, Math.floor(Date.now() / 1000) - 3600))).rejects.toMatchObject({ code: 'forbidden' });
    const override = pick(`evt-ovr-${Date.now()}`, { destination: 'some-other-channel' });
    await expect(receiveTipsignal(override, signTipsignal(SECRET, override))).rejects.toMatchObject({ code: 'validation_failed' });
    const late = JSON.stringify({ ...JSON.parse(pick(`evt-late-${Date.now()}`)), data: { ...JSON.parse(pick('x')).data, fixture: { ...JSON.parse(pick('x')).data.fixture, kickoff_at: new Date(Date.now() - 60_000).toISOString() } } });
    const r = await receiveTipsignal(late, signTipsignal(SECRET, late));
    expect(r.status).toBe(422);
  });

  it('result copy uses only validated facts', () => {
    const text = draftText({ schema_version: 1, event_id: 'e', type: 'results.settled', occurred_at: kickoff,
      data: { record_id: 'r', source_url: 'https://t.example/1', fixture: { home: 'A', away: 'B', competition: 'Cup', kickoff_at: kickoff }, market: 'BTTS', selection: 'Yes',
        settled: true, settled_at: kickoff, result: 'won', final_score: '2-1' } }, 'Europe/London');
    expect(text).toContain('A 2-1 B');
    expect(text).toContain('Pick: Yes (BTTS) — Won');
    expect(brandId).toBeTruthy();
  });
});
