// Fix stream F1 (2026-11-09) against REAL PostgreSQL:
//  H1 — the composer's TikTok creator settings (live creator_info; simulated destination answers from the simulator)
//  H3 — publish media carry the library alt text the adapters send
//  H6 — Analytics → Channels rows carry the table's measures (Engagements is no longer always "—")
//  H7 — Facebook / Instagram / X say "Analytics: Available" on connection cards, MCP list_connections and diagnostics
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectMock, getConnection, getTikTokCreatorInfo, listConnections, performHealthCheck } from '../../packages/services/src/connections/index.js';
import { loadPublishMedia } from '../../packages/services/src/media/assets.js';
import { capabilitiesFor, brandConnections } from '../../packages/services/src/posts/shared.js';
import { integrationDiagnostics } from '../../packages/services/src/gov/diagnostics.js';
import { channels } from '@social-lite/services/analytics/query';
import { addMember, closeTestPool, createUser, testPool, v2Ctx } from './helpers.js';
import { seedReadyImage } from './engine-helpers.js';
import { analyticsTenant, connection, filters, observe, publish, pt } from './v3-analytics-helpers.js';

beforeAll(() => { testPool(); });
afterAll(async () => { await closeTestPool(); });

async function world() {
  const t = await analyticsTenant();
  return t;
}

describe('H1 TikTok creator settings for the composer', () => {
  it('returns the creator’s current privacy options and the interactions turned off in TikTok', async () => {
    const t = await world();
    const tt = await connectMock(t.ctx, t.brandId, { provider: 'tiktok', display_name: 'Sim TikTok' });
    const info = await getTikTokCreatorInfo(t.ctx, tt.id);
    expect(info).toMatchObject({
      connection_id: tt.id, simulated: true,
      privacy_level_options: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
      interactions: { comment_disabled: false, duet_disabled: false, stitch_disabled: true },
      max_video_post_duration_sec: 600,
    });
    expect(JSON.stringify(info)).not.toMatch(/token/i);
  });

  it('only for TikTok, only for people who can edit drafts on the brand, never across workspaces', async () => {
    const t = await world();
    const x = await connectMock(t.ctx, t.brandId, { provider: 'x', display_name: 'Sim X' });
    await expect(getTikTokCreatorInfo(t.ctx, x.id)).rejects.toMatchObject({ code: 'invalid_state' });
    const tt = await connectMock(t.ctx, t.brandId, { provider: 'tiktok', display_name: 'Sim TikTok' });
    const viewer = await createUser();
    await addMember(t.workspaceId, viewer.id, 'viewer');
    await expect(getTikTokCreatorInfo(await v2Ctx(viewer.id, t.workspaceId), tt.id)).rejects.toMatchObject({ code: 'forbidden' });
    const other = await world();
    await expect(getTikTokCreatorInfo(other.ctx, tt.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('H3 library alt text reaches the publish input', () => {
  it('loadPublishMedia carries assets.alt_text (null when there is none)', async () => {
    const t = await world();
    const a = await seedReadyImage(t.workspaceId, t.brandId);
    const b = await seedReadyImage(t.workspaceId, t.brandId);
    await testPool().query(`UPDATE assets SET alt_text=$2 WHERE id=$1`, [a, 'Barista pouring latte art']);
    const media = await loadPublishMedia(testPool(), t.workspaceId, [a, b]);
    expect(media.map((m) => [m.assetId, m.altText])).toEqual([[a, 'Barista pouring latte art'], [b, null]]);
  });
});

describe('H6 Channels table measures', () => {
  it('Engagements (and views) per account equal the comparison totals; unsupported networks say so', async () => {
    const t = await world();
    const tt = await connection(t.workspaceId, t.brandId, 'tiktok');
    const tg = await connection(t.workspaceId, t.brandId, 'telegram');
    const p1 = await publish(t, t.brandId, tt, 'tiktok', '2026-02-03T12:00:00Z', { format: 'video' });
    const p2 = await publish(t, t.brandId, tt, 'tiktok', '2026-02-04T12:00:00Z', { format: 'video' });
    await publish(t, t.brandId, tg, 'telegram', '2026-02-04T12:00:00Z', { format: 'text' });
    await observe(p1, [pt('view_count', 900), pt('like_count', 9), pt('comment_count', 3), pt('share_count', 2)], '2026-02-10T12:00:00Z');
    await observe(p2, [pt('view_count', 100), pt('like_count', 1)], '2026-02-10T12:00:00Z');
    const ch = await channels(t.ctx, filters({ from: '2026-02-01', to: '2026-02-07', compare: 'none' }));
    const row = ch.rows.find((r) => r.connection_id === tt)!;
    const m = Object.fromEntries(row.measures.map((x) => [x.measure, x]));
    expect(row.measures.map((x) => x.measure)).toEqual(['engagements', 'views', 'impressions', 'reach']);
    expect(m.engagements).toMatchObject({ value: 15, status: 'ok', posts_with_data: 2 });
    expect(m.views).toMatchObject({ value: 1000, status: 'ok' });
    expect(m.impressions).toMatchObject({ value: null, status: 'unsupported' });
    const card = ch.comparison.groups.flatMap((g) => g.rows).find((r) => r.connection_id === tt)!;
    expect(card.value).toBe(m.engagements!.value); // the table and the comparison card agree
    const tgRow = ch.rows.find((r) => r.connection_id === tg)!;
    expect(tgRow.measures.find((x) => x.measure === 'engagements')).toMatchObject({ value: null, status: 'unsupported' });
  });
});

describe('H7 analytics capability on cards, MCP and diagnostics', () => {
  it('simulated Facebook, Instagram and X read metrics; Telegram does not — everywhere the flag is shown', async () => {
    const t = await world();
    const made: Record<string, string> = {};
    for (const p of ['facebook', 'instagram', 'x', 'telegram'] as const) made[p] = (await connectMock(t.ctx, t.brandId, { provider: p, display_name: `Sim ${p}` })).id;
    // Stored capabilities written before the fix must not matter: the cards use the adapter's current capabilities.
    await testPool().query(`UPDATE connections SET capabilities = jsonb_set(capabilities, '{canReadMetrics}', 'false') WHERE brand_id=$1`, [t.brandId]);
    const expected = { facebook: true, instagram: true, x: true, telegram: false } as Record<string, boolean>;
    const cards = (await listConnections(t.ctx, t.brandId)).items;
    for (const [p, id] of Object.entries(made)) {
      expect((cards.find((c) => c.id === id)!.capabilities as { canReadMetrics?: boolean }).canReadMetrics, `card ${p}`).toBe(expected[p]);
      expect(((await getConnection(t.ctx, id)).capabilities as { canReadMetrics?: boolean }).canReadMetrics).toBe(expected[p]);
    }
    // MCP list_connections → can_read_metrics comes from posts/shared capabilitiesFor (services/src/mcp/tools.ts).
    const rows = await brandConnections(testPool(), t.workspaceId, t.brandId);
    for (const r of rows) expect(capabilitiesFor(r)!.canReadMetrics, `mcp ${r.provider}`).toBe(expected[r.provider]);
    const d = await integrationDiagnostics(t.ctx, { brand_id: t.brandId });
    for (const item of d.items) {
      const check = item.checks.find((c) => c.key === 'analytics')!;
      const p = item.connection.provider;
      expect(item.analytics.supported, `diagnostics ${p}`).toBe(expected[p]);
      expect(item.capabilities.can_read_metrics).toBe(expected[p]);
      if (expected[p]) expect(check.status).not.toBe('not_applicable');
      else expect(check.detail).toMatch(/not available/);
    }
  });

  it('a live Facebook Page without the insights permission honestly says analytics are not available', async () => {
    const t = await world();
    const id = await connection(t.workspaceId, t.brandId, 'facebook');
    await testPool().query(`UPDATE connections SET metadata = $2 WHERE id=$1`, [id, JSON.stringify({ page_id: 'p1', granted_scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'] })]);
    expect(((await getConnection(t.ctx, id)).capabilities as { canReadMetrics?: boolean }).canReadMetrics).toBe(false);
    await testPool().query(`UPDATE connections SET metadata = $2 WHERE id=$1`, [id, JSON.stringify({ page_id: 'p1', granted_scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'read_insights'] })]);
    expect(((await getConnection(t.ctx, id)).capabilities as { canReadMetrics?: boolean }).canReadMetrics).toBe(true);
  });
});

describe('LinkedIn simulated member health (lead follow-up)', () => {
  it('a simulated LinkedIn member stays ready through the health sweep (live mismatch: contracts/v3-linkedin)', async () => {
    const t = await world();
    const li = await connectMock(t.ctx, t.brandId, { provider: 'linkedin', display_name: 'Sim LinkedIn member' });
    expect(li.provider_account_id).toMatch(/^mock_linkedin/);
    expect(await performHealthCheck(li.id, { service: 'test' })).toBe('checked');
    const after = await getConnection(t.ctx, li.id);
    expect(after.status).toBe('ready');
  });
});
