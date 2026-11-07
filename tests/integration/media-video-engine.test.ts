// V1.1 engine test: a multi-image post (Instagram carousel, Facebook multi-photo, Telegram album, X 3 images)
// published through the REAL adapters over MockTransport + simulators, with the durable engine on REAL
// PostgreSQL. Also: a carousel whose children are still processing resumes from the persisted checkpoint
// (no duplicate child containers, one media_publish).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Provider, PublishMedia } from '@social-lite/core';
import { claimDelivery, createPost, processDelivery, publishNow, type EngineDeps } from '@social-lite/services';
import { getAdapter, MemoryMockStore, transportFor, type MockScenario, type MockStore } from '@social-lite/providers';
import { closeTestPool, tenant, testPool } from './helpers.js';
import { seedConnections, seedReadyImage } from './engine-helpers.js';

afterAll(closeTestPool);

beforeEach(async () => {
  await testPool().query(`UPDATE deliveries SET state='cancelled' WHERE state IN ('scheduled','retry_wait','processing','preparing','publishing')`);
  await testPool().query(`UPDATE system_flags SET value='true' WHERE key='dispatch_enabled'`);
  await testPool().query(`DELETE FROM provider_circuits`);
});

function realDeps(store: MockStore, scenarios: Partial<Record<Provider, MockScenario>> = {}): EngineDeps {
  return {
    adapterFor: getAdapter,
    getCredentials: async (connectionId) => {
      const c = (await testPool().query<{ id: string; provider: Provider; provider_account_id: string; display_name: string; username: string | null; metadata: Record<string, unknown>; is_mock: boolean }>(
        `SELECT * FROM connections WHERE id=$1`, [connectionId])).rows[0]!;
      return { credentials: { kind: 'mock', token: 'sim' }, connection: { id: c.id, provider: c.provider, providerAccountId: c.provider_account_id, displayName: c.display_name, username: c.username, metadata: c.metadata, isMock: c.is_mock } };
    },
    adapterContext: async (provider, connection) => ({
      transport: transportFor({ provider, providerAccountId: connection.providerAccountId, isMock: true, mockProvidersEnabled: true, mockStore: store, mockScenario: scenarios[provider] ?? 'success' }),
      now: () => new Date(), config: {},
    }),
    loadMedia: async (_ws, ids) => {
      const kinds = new Map((await testPool().query<{ id: string; media_kind: string }>(`SELECT id, media_kind FROM assets WHERE id = ANY($1::uuid[])`, [ids])).rows.map((r) => [r.id, r.media_kind]));
      return ids.map((id, i): PublishMedia => (kinds.get(id) === 'video'
        ? { assetId: id, mime: 'video/mp4', kind: 'video', width: 720, height: 1280, bytes: 4096, durationMs: 10_000, videoCodec: 'h264', audioCodec: 'aac', frameRate: 30,
          url: `https://storage.example.com/${id}.mp4?sig=x`, posterUrl: `https://storage.example.com/${id}-poster.jpg?sig=x`, load: async () => new Uint8Array(4096).fill(1) }
        : { assetId: id, mime: 'image/jpeg', kind: 'image', width: 1080, height: 1350, bytes: 900,
          url: `https://storage.example.com/${id}.jpg?sig=x`, load: async () => new Uint8Array([0xff, 0xd8, i]) }));
    },
  };
}

/** A ready 10 s 720×1280 H.264/AAC video with its video_publish derivative (no bytes needed). */
async function seedReadyVideo(workspaceId: string, brandId: string): Promise<string> {
  const id = randomUUID();
  await testPool().query(
    `INSERT INTO assets(id, workspace_id, brand_id, object_key, mime, bytes, width, height, status, checksum_sha256, media_kind, duration_ms, video_codec, audio_codec, frame_rate)
     VALUES ($1,$2,$3,$4,'video/mp4',4096,720,1280,'ready','x','video',10000,'h264','aac',30)`, [id, workspaceId, brandId, `originals/${id}`]);
  await testPool().query(
    `INSERT INTO asset_derivatives(workspace_id, asset_id, variant, object_key, mime, bytes, width, height, checksum_sha256, transform_version, duration_ms, video_codec, audio_codec, frame_rate)
     VALUES ($1,$2,'video_publish',$3,'video/mp4',4096,720,1280,'y',1,10000,'h264','aac',30)`, [workspaceId, id, `derivatives/${id}.mp4`]);
  return id;
}

async function drain(deps: EngineDeps, max = 40): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < max; i++) {
    const c = await claimDelivery('media-w1');
    if (!c) break;
    out.push(await processDelivery(deps, c));
  }
  return out;
}

async function states(postId: string): Promise<Record<string, string>> {
  const r = await testPool().query<{ provider: string; state: string }>(`SELECT provider, state FROM deliveries WHERE post_id=$1`, [postId]);
  return Object.fromEntries(r.rows.map((x) => [x.provider, x.state]));
}

async function albumPost(t: Awaited<ReturnType<typeof tenant>>, conns: Record<string, string>, providers: Provider[]) {
  const images = [await seedReadyImage(t.workspaceId, t.brandId), await seedReadyImage(t.workspaceId, t.brandId), await seedReadyImage(t.workspaceId, t.brandId)];
  const draft = { baseText: 'Matchday gallery', baseLink: null, baseAssetIds: images, variants: providers.map((p) => ({ connectionId: conns[p]!, inheritText: true, inheritMedia: true })) };
  const { id } = await createPost(t.ownerCtx, t.brandId, { title: 'Gallery', draft }, randomUUID());
  return { id, images, ids: providers.map((p) => conns[p]!) };
}

describe('multi-image publishing through the real adapters (V1.1)', () => {
  it('one 3-image post → IG carousel, FB multi-photo, Telegram album, X 3 images — each published exactly once', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const store = new MemoryMockStore();
    const deps = realDeps(store);
    const { id, ids } = await albumPost(t, conns, ['instagram', 'facebook', 'telegram', 'x']);
    await publishNow(t.ownerCtx, id, { expected_version: 1, connection_ids: ids }, randomUUID());
    const v = await testPool().query<{ format: string }>(`SELECT DISTINCT format FROM variants v JOIN deliveries d ON d.variant_id=v.id WHERE d.post_id=$1`, [id]);
    expect(v.rows.map((r) => r.format)).toEqual(['album']);

    const results = await drain(deps);
    expect(results.sort()).toEqual(['published', 'published', 'published', 'published']);
    expect(await states(id)).toEqual({ instagram: 'published', facebook: 'published', telegram: 'published', x: 'published' });

    const acct = async (p: Provider) => (await testPool().query<{ provider_account_id: string }>(`SELECT provider_account_id FROM connections WHERE id=$1`, [conns[p]])).rows[0]!.provider_account_id;
    const igMedia = await store.list('instagram', await acct('instagram'), 'media');
    expect(igMedia).toHaveLength(1);
    expect(igMedia[0]!.data).toMatchObject({ media_type: 'CAROUSEL_ALBUM', caption: 'Matchday gallery' });
    expect(igMedia[0]!.data.children).toHaveLength(3);
    const fbPosts = await store.list('facebook', await acct('facebook'), 'post');
    expect(fbPosts).toHaveLength(1);
    expect(fbPosts[0]!.data.attached_media).toHaveLength(3);
    const tg = await store.list('telegram', await acct('telegram'), 'message');
    expect(tg).toHaveLength(3);
    expect(new Set(tg.map((m) => m.data.media_group_id)).size).toBe(1);
    const xPosts = await store.list('x', await acct('x'), 'post');
    expect(xPosts).toHaveLength(1);
    expect(xPosts[0]!.data.media_ids).toHaveLength(3);

    const d = await testPool().query<{ provider: string; provider_ids: string[] }>(`SELECT provider, provider_ids FROM deliveries WHERE post_id=$1`, [id]);
    expect(d.rows.find((r) => r.provider === 'telegram')!.provider_ids).toHaveLength(3);
  });

  it('a carousel whose items are still processing resumes from the persisted checkpoint without duplicating items or publication', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const store = new MemoryMockStore();
    const deps = realDeps(store, { instagram: 'processing' });
    const { id, ids } = await albumPost(t, conns, ['instagram']);
    await publishNow(t.ownerCtx, id, { expected_version: 1, connection_ids: ids }, randomUUID());

    expect(await drain(deps)).toEqual(['scheduled']); // children IN_PROGRESS ⇒ pending, not a failed attempt
    const row = (await testPool().query<{ preparation: { step: string; data: { children: Array<{ containerId: string; finished: boolean }> } }; attempt_count: number }>(
      `SELECT preparation, attempt_count FROM deliveries WHERE post_id=$1`, [id])).rows[0]!;
    expect(row.preparation.step).toBe('carousel_children');
    expect(row.preparation.data.children).toHaveLength(3);
    expect(row.attempt_count).toBe(0);

    for (let i = 0; i < 8 && (await states(id)).instagram !== 'published'; i++) {
      await testPool().query(`UPDATE deliveries SET next_attempt_at=now() - interval '1 second' WHERE post_id=$1 AND state IN ('scheduled','retry_wait')`, [id]);
      await drain(deps);
    }
    expect(await states(id)).toEqual({ instagram: 'published' });
    const account = (await testPool().query<{ provider_account_id: string }>(`SELECT provider_account_id FROM connections WHERE id=$1`, [conns.instagram])).rows[0]!.provider_account_id;
    const containers = await store.list('instagram', account, 'container');
    expect(containers.filter((c) => c.data.carousel_item)).toHaveLength(3);
    expect(containers.filter((c) => c.data.media_type === 'CAROUSEL')).toHaveLength(1);
    expect(await store.list('instagram', account, 'media')).toHaveLength(1);
    const finalCp = (await testPool().query<{ preparation: { data: { children: Array<{ containerId: string }> } } }>(`SELECT preparation FROM deliveries WHERE post_id=$1`, [id])).rows[0]!;
    expect(finalCp.preparation.data.children.map((c) => c.containerId)).toEqual(row.preparation.data.children.map((c) => c.containerId));
  });

  it('one video → IG Reel, FB Page video (processing → polled → published), Telegram sendVideo, X chunked upload', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const store = new MemoryMockStore();
    const deps = realDeps(store, { facebook: 'processing' });
    const video = await seedReadyVideo(t.workspaceId, t.brandId);
    const providers: Provider[] = ['instagram', 'facebook', 'telegram', 'x'];
    const draft = { baseText: 'Highlights', baseLink: null, baseAssetIds: [video], variants: providers.map((p) => ({ connectionId: conns[p]!, inheritText: true, inheritMedia: true })) };
    const { id } = await createPost(t.ownerCtx, t.brandId, { title: 'Clip', draft }, randomUUID());
    await publishNow(t.ownerCtx, id, { expected_version: 1, connection_ids: providers.map((p) => conns[p]!) }, randomUUID());
    for (let i = 0; i < 10 && Object.values(await states(id)).some((s) => s !== 'published'); i++) {
      await testPool().query(`UPDATE deliveries SET next_attempt_at=now() - interval '1 second' WHERE post_id=$1 AND state IN ('scheduled','retry_wait','processing')`, [id]);
      await drain(deps);
    }
    expect(await states(id)).toEqual({ instagram: 'published', facebook: 'published', telegram: 'published', x: 'published' });
    const acct = async (p: Provider) => (await testPool().query<{ provider_account_id: string }>(`SELECT provider_account_id FROM connections WHERE id=$1`, [conns[p]])).rows[0]!.provider_account_id;
    expect((await store.list('instagram', await acct('instagram'), 'media'))[0]!.data).toMatchObject({ media_type: 'VIDEO', media_product_type: 'REELS' });
    expect(await store.list('facebook', await acct('facebook'), 'video')).toHaveLength(1);
    expect((await store.list('telegram', await acct('telegram'), 'message'))[0]!.data).toMatchObject({ has_video: true, duration: 10 });
    expect((await store.list('x', await acct('x'), 'post'))).toHaveLength(1);
    const fb = (await testPool().query<{ provider_url: string; provider_ids: string[] }>(`SELECT provider_url, provider_ids FROM deliveries WHERE post_id=$1 AND provider='facebook'`, [id])).rows[0]!;
    expect(fb.provider_url).toMatch(/^https:\/\/www\.facebook\.com\/mock_.*\/videos\//);
  });
});
