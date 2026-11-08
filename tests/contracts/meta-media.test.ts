// V1.1 contract tests: Instagram carousels + Reels, Facebook multi-photo + Page video.
// Exact outgoing Graph requests, resume-from-checkpoint behaviour and the simulator scenarios. No network.
import { describe, expect, it } from 'vitest';
import {
  TransportError, type AdapterContext, type Checkpoint, type HttpRequest, type HttpResponse, type ProviderCredentials,
  type PublishConnection, type PublishInput, type PublishMedia, type PublishingAdapter, type Transport,
} from '@social-lite/core';
import { facebookAdapter, instagramAdapter, metaFake } from '../../packages/providers/src/meta/index.js';
import { MemoryMockStore, mockId, type MockScenario, type MockStore } from '../../packages/providers/src/transport/mock.js';
import { DEFAULT_GRAPH_VERSION } from '../../packages/providers/src/meta/graph.js';

const V = DEFAULT_GRAPH_VERSION;
const TOKEN = 'PAGE_TOKEN_media';

class RecordingTransport implements Transport {
  readonly mode = 'mock' as const;
  calls: HttpRequest[] = [];
  constructor(private readonly handler: (req: HttpRequest) => Promise<HttpResponse>) {}
  async send(req: HttpRequest) { this.calls.push(req); return this.handler(req); }
}
class Clock {
  t = new Date('2026-11-07T12:00:00.000Z').getTime();
  now = () => new Date(this.t);
  advance(ms: number) { this.t += ms; }
}

interface Sim { transport: RecordingTransport; ctx: AdapterContext; clock: Clock; store: MockStore; failOn?: (req: HttpRequest, n: number) => boolean }
function sim(provider: 'facebook' | 'instagram', scenario: MockScenario = 'success', store: MockStore = new MemoryMockStore(), clock = new Clock()): Sim {
  const s: Sim = { clock, store } as Sim;
  let n = 0;
  s.transport = new RecordingTransport(async (req) => {
    n++;
    if (s.failOn?.(req, n)) throw new TransportError('simulated reset', 'reset', true);
    return metaFake(req, { provider, accountId: provider === 'facebook' ? 'mock_page1' : 'mock_ig1', scenario, store, now: clock.now, newId: mockId });
  });
  s.ctx = { transport: s.transport, now: clock.now, config: { clientId: 'app', clientSecret: 'secret' } };
  return s;
}

const creds: ProviderCredentials = { kind: 'meta_page', pageAccessToken: TOKEN, userAccessToken: 'u', userTokenExpiresAt: null };
const conn = (provider: 'facebook' | 'instagram'): PublishConnection =>
  ({ id: `conn-${provider}`, provider, providerAccountId: provider === 'facebook' ? 'mock_page1' : 'mock_ig1', displayName: 'Sim', metadata: {}, isMock: true });

const img = (n: number, over: Partial<PublishMedia> = {}): PublishMedia => ({
  assetId: `img-${n}`, mime: 'image/jpeg', width: 1080, height: 1080, bytes: 300_000, kind: 'image',
  url: `https://storage.example.com/img-${n}.jpg?sig=s`, load: async () => new Uint8Array([n]), ...over,
});
const vid = (n: number, over: Partial<PublishMedia> = {}): PublishMedia => ({
  assetId: `vid-${n}`, mime: 'video/mp4', width: 720, height: 1280, bytes: 5_000_000, kind: 'video', durationMs: 12_000,
  videoCodec: 'h264', audioCodec: 'aac', frameRate: 30, url: `https://storage.example.com/vid-${n}.mp4?sig=s`,
  posterUrl: `https://storage.example.com/vid-${n}-poster.jpg?sig=s`, load: async () => new Uint8Array(2048), ...over,
});

function input(provider: 'facebook' | 'instagram', media: PublishMedia[], over: Partial<PublishInput['variant']> = {}): PublishInput {
  return {
    deliveryId: 'd-media', attemptNumber: 1, idempotencyKey: 'k', connection: conn(provider), credentials: creds,
    variant: { text: 'Matchday #launch', link: null, format: 'album', buttons: [], options: {}, ...over }, media,
  };
}

const params = (r: HttpRequest) => new URLSearchParams(typeof r.body === 'string' ? r.body : new URL(r.url).search);
const path = (r: HttpRequest) => new URL(r.url).pathname;

async function prepareUntilReady(adapter: PublishingAdapter, s: Sim, inp: PublishInput, start: Checkpoint | null = null) {
  let cp = start;
  const kinds: string[] = [];
  for (let i = 0; i < 20; i++) {
    const o = await adapter.prepare(s.ctx, inp, cp);
    kinds.push(o.kind);
    if (o.kind === 'ready') return { cp: o.checkpoint, kinds };
    if (o.kind === 'pending') { cp = o.checkpoint; s.clock.advance(o.checkAfterMs); continue; }
    throw new Error(`prepare ended ${JSON.stringify(o)}`);
  }
  throw new Error('prepare did not settle');
}

// ------------------------------------------------------------------ Instagram Reels
describe('Instagram Reels', () => {
  it('creates a REELS container with video_url, caption, share_to_feed and cover_url, then media_publish', async () => {
    const s = sim('instagram');
    const inp = input('instagram', [vid(1)], { format: 'reel' });
    const { cp } = await prepareUntilReady(instagramAdapter, s, inp);
    const create = s.transport.calls[0]!;
    expect(create.method).toBe('POST');
    expect(path(create)).toBe(`/${V}/mock_ig1/media`);
    const p = params(create);
    expect(Object.fromEntries([...p].filter(([k]) => !['access_token', 'appsecret_proof'].includes(k)))).toEqual({
      media_type: 'REELS', video_url: vid(1).url, caption: 'Matchday #launch', share_to_feed: 'true', cover_url: vid(1).posterUrl,
    });
    expect(p.has('image_url')).toBe(false);
    expect(create.op).toBe('meta.instagram.media_create');
    expect(create.publishes).toBeFalsy();
    expect(cp.data).toMatchObject({ kind: 'reel' });

    const out = await instagramAdapter.publish(s.ctx, inp, cp);
    expect(out).toMatchObject({ kind: 'confirmed' });
    const pub = s.transport.calls.find((c) => c.op === 'meta.instagram.media_publish')!;
    expect(params(pub).get('creation_id')).toBe(cp.data.containerId);
    expect(pub.publishes).toBe(true);
    const media = await s.store.list('instagram', 'mock_ig1', 'media');
    expect(media).toHaveLength(1);
    expect(media[0]!.data).toMatchObject({ media_type: 'VIDEO', media_product_type: 'REELS' });
  });

  it('processing: IN_PROGRESS ⇒ pending with video back-off; resumes from the checkpoint without a new container', async () => {
    const s = sim('instagram', 'processing');
    const inp = input('instagram', [vid(1)], { format: 'reel' });
    const first = await instagramAdapter.prepare(s.ctx, inp, null);
    expect(first).toMatchObject({ kind: 'pending', checkAfterMs: 10_000 });
    const { kinds } = await prepareUntilReady(instagramAdapter, s, inp, (first as { checkpoint: Checkpoint }).checkpoint);
    expect(kinds.at(-1)).toBe('ready');
    expect(s.transport.calls.filter((c) => c.op === 'meta.instagram.media_create')).toHaveLength(1);
  });

  it('validation: a 2-second clip is rejected for Reels with the exact minimum, before any request', async () => {
    const s = sim('instagram');
    const r = instagramAdapter.validate(input('instagram', [vid(1, { durationMs: 2000 })]));
    expect(r.ok).toBe(false);
    expect(r.issues).toEqual([expect.objectContaining({ code: 'video_too_short', message: 'Instagram: video is 2 s long; at least 3 s is required.' })]);
    expect(await instagramAdapter.prepare(s.ctx, input('instagram', [vid(1, { durationMs: 2000 })]), null)).toMatchObject({ kind: 'permanent', code: 'invalid_content' });
    expect(s.transport.calls).toHaveLength(0);
    expect(instagramAdapter.validate(input('instagram', [vid(1, { frameRate: 15 })])).issues.map((i) => i.code)).toEqual(['frame_rate']);
    expect(instagramAdapter.validate(input('instagram', [vid(1, { width: 2160, height: 3840 })])).issues.map((i) => i.code)).toEqual(['video_dimensions']);
  });
});

// ------------------------------------------------------------------ Instagram carousel
describe('Instagram carousels', () => {
  const media = [img(1), vid(2), img(3)];

  it('children with is_carousel_item (no caption), then a CAROUSEL parent with ordered children and the caption', async () => {
    const s = sim('instagram');
    const inp = input('instagram', media);
    const { cp } = await prepareUntilReady(instagramAdapter, s, inp);
    const creates = s.transport.calls.filter((c) => c.method === 'POST');
    expect(creates.map((c) => c.op)).toEqual(['meta.instagram.carousel_item_create', 'meta.instagram.carousel_item_create', 'meta.instagram.carousel_item_create', 'meta.instagram.media_create']);
    const strip = (r: HttpRequest) => Object.fromEntries([...params(r)].filter(([k]) => !['access_token', 'appsecret_proof'].includes(k)));
    expect(strip(creates[0]!)).toEqual({ image_url: img(1).url, is_carousel_item: 'true' });
    expect(strip(creates[1]!)).toEqual({ media_type: 'VIDEO', video_url: vid(2).url, is_carousel_item: 'true' });
    expect(strip(creates[2]!)).toEqual({ image_url: img(3).url, is_carousel_item: 'true' });
    const children = (cp.data.children as Array<{ containerId: string; assetId: string }>);
    expect(children.map((c) => c.assetId)).toEqual(['img-1', 'vid-2', 'img-3']);
    expect(strip(creates[3]!)).toEqual({ media_type: 'CAROUSEL', children: children.map((c) => c.containerId).join(','), caption: 'Matchday #launch' });
    expect(cp.data.containerId).toBeTruthy();

    const out = await instagramAdapter.publish(s.ctx, inp, cp);
    expect(out).toMatchObject({ kind: 'confirmed' });
    expect(s.transport.calls.filter((c) => c.op === 'meta.instagram.media_publish')).toHaveLength(1);
    const [m] = await s.store.list('instagram', 'mock_ig1', 'media');
    expect(m!.data).toMatchObject({ media_type: 'CAROUSEL_ALBUM', children: children.map((c) => c.containerId) });
  });

  it('resumes after a failure mid-way: created children are reused, only the missing one is created', async () => {
    const s = sim('instagram');
    let creates = 0;
    s.failOn = (req) => req.op === 'meta.instagram.carousel_item_create' && ++creates === 3;
    const inp = input('instagram', media);
    const o1 = await instagramAdapter.prepare(s.ctx, inp, null);
    expect(o1).toMatchObject({ kind: 'retryable', checkpoint: { step: 'carousel_children' } });
    const cp1 = (o1 as { checkpoint: Checkpoint }).checkpoint;
    const kept = (cp1.data.children as Array<{ containerId: string }>).map((c) => c.containerId);
    expect(kept).toHaveLength(2);

    s.transport.calls = [];
    const { cp } = await prepareUntilReady(instagramAdapter, s, inp, cp1);
    expect(s.transport.calls.filter((c) => c.op === 'meta.instagram.carousel_item_create')).toHaveLength(1);
    expect((cp.data.children as Array<{ containerId: string }>).map((c) => c.containerId).slice(0, 2)).toEqual(kept);
    expect(await instagramAdapter.publish(s.ctx, inp, cp)).toMatchObject({ kind: 'confirmed' });
  });

  it('processing video child ⇒ pending; the parent is created only once every child is FINISHED', async () => {
    const s = sim('instagram', 'processing');
    const inp = input('instagram', [img(1), vid(2)]);
    const o = await instagramAdapter.prepare(s.ctx, inp, null);
    expect(o).toMatchObject({ kind: 'pending', checkpoint: { step: 'carousel_children' } });
    expect(s.transport.calls.some((c) => params(c).get('media_type') === 'CAROUSEL')).toBe(false);
    const { cp } = await prepareUntilReady(instagramAdapter, s, inp, (o as { checkpoint: Checkpoint }).checkpoint);
    expect(s.transport.calls.filter((c) => c.op === 'meta.instagram.carousel_item_create')).toHaveLength(2);
    expect(s.transport.calls.filter((c) => params(c).get('media_type') === 'CAROUSEL')).toHaveLength(1);
    expect(cp.step).toBe('container_ready');
  });

  it('never republishes: an expired checkpoint whose parent is PUBLISHED resolves the media without media_publish', async () => {
    const s = sim('instagram');
    const inp = input('instagram', [img(1), img(2)]);
    const { cp } = await prepareUntilReady(instagramAdapter, s, inp);
    expect(await instagramAdapter.publish(s.ctx, inp, cp)).toMatchObject({ kind: 'confirmed' });
    s.clock.advance(25 * 60 * 60_000);
    s.transport.calls = [];
    const again = await instagramAdapter.prepare(s.ctx, inp, cp);
    expect(again).toMatchObject({ kind: 'ready', checkpoint: { step: 'container_published' } });
    expect(s.transport.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    const out = await instagramAdapter.publish(s.ctx, inp, (again as { checkpoint: Checkpoint }).checkpoint);
    expect(out).toMatchObject({ kind: 'confirmed' });
    expect(s.transport.calls.filter((c) => c.op === 'meta.instagram.media_publish')).toHaveLength(0);
    expect(await s.store.list('instagram', 'mock_ig1', 'media')).toHaveLength(1);
  });

  it('a lost media_publish response is Unknown; reconcile finds the carousel by container status', async () => {
    const s = sim('instagram', 'timeout_after_send');
    const inp = input('instagram', [img(1), img(2)]);
    const { cp } = await prepareUntilReady(instagramAdapter, s, inp);
    expect(await instagramAdapter.publish(s.ctx, inp, cp)).toMatchObject({ kind: 'unknown', code: 'response_lost' });
    const r = await instagramAdapter.reconcile(s.ctx, { deliveryId: 'd', connection: conn('instagram'), credentials: creds, variantText: 'Matchday #launch', providerIds: [], checkpoint: cp, sentAt: s.clock.now().toISOString() });
    expect(r).toMatchObject({ kind: 'published' });
  });

  it('validation: 21 items, captions and per-item image rules are checked per destination', () => {
    const many = Array.from({ length: 21 }, (_, i) => img(i));
    expect(instagramAdapter.validate(input('instagram', many)).issues.map((i) => i.code)).toEqual(['too_many_images']);
    expect(instagramAdapter.validate(input('instagram', [img(1), img(2, { width: 1080, height: 1920 })])).issues.map((i) => i.code)).toEqual(['aspect']);
    expect(instagramAdapter.validate(input('instagram', [img(1), vid(2)])).ok).toBe(true);
    expect(instagramAdapter.capabilities(conn('instagram')).formats).toEqual(['image', 'album', 'reel']);
  });
});

// ------------------------------------------------------------------ Facebook multi-photo
describe('Facebook multi-photo posts', () => {
  it('stages each photo unpublished, then posts /feed with attached_media in order', async () => {
    const s = sim('facebook');
    const inp = input('facebook', [img(1), img(2), img(3)], { link: 'https://example.com/x' });
    const prep = await facebookAdapter.prepare(s.ctx, inp, null);
    expect(prep).toMatchObject({ kind: 'ready', checkpoint: { step: 'album_photos' } });
    const staged = s.transport.calls;
    expect(staged).toHaveLength(3);
    for (const [i, r] of staged.entries()) {
      expect(path(r)).toBe(`/${V}/mock_page1/photos`);
      expect(params(r).get('url')).toBe(img(i + 1).url);
      expect(params(r).get('published')).toBe('false');
      expect(params(r).has('caption')).toBe(false);
      expect(r.publishes).toBeFalsy();
    }
    const cp = (prep as { checkpoint: Checkpoint }).checkpoint;
    const ids = (cp.data.photos as Array<{ photoId: string }>).map((p) => p.photoId);

    const out = await facebookAdapter.publish(s.ctx, inp, cp);
    expect(out).toMatchObject({ kind: 'confirmed', url: expect.stringMatching(/^https:\/\/www\.facebook\.com\/mock_page1_/) });
    const feed = s.transport.calls.at(-1)!;
    expect(path(feed)).toBe(`/${V}/mock_page1/feed`);
    expect(feed.publishes).toBe(true);
    const p = params(feed);
    expect(p.get('message')).toBe('Matchday #launch\n\nhttps://example.com/x');
    expect([0, 1, 2].map((i) => p.get(`attached_media[${i}]`))).toEqual(ids.map((id) => JSON.stringify({ media_fbid: id })));
    expect(p.has('attached_media[3]')).toBe(false);
    expect(p.has('link')).toBe(false);
  });

  it('resume: staged photos are reused after a failure; never re-staged', async () => {
    const s = sim('facebook');
    let n = 0;
    s.failOn = (req) => req.op === 'meta.facebook.photo_stage' && ++n === 2;
    const inp = input('facebook', [img(1), img(2)]);
    const o1 = await facebookAdapter.prepare(s.ctx, inp, null);
    expect(o1).toMatchObject({ kind: 'retryable', checkpoint: { step: 'album_photos' } });
    const cp1 = (o1 as { checkpoint: Checkpoint }).checkpoint;
    expect(cp1.data.photos).toHaveLength(1);
    s.transport.calls = [];
    const o2 = await facebookAdapter.prepare(s.ctx, inp, cp1);
    expect(o2.kind).toBe('ready');
    expect(s.transport.calls).toHaveLength(1);
    expect(params(s.transport.calls[0]!).get('url')).toBe(img(2).url);
    // Lost /feed response ⇒ Unknown (ambiguous final publish), never a blind resend.
    const t = sim('facebook', 'timeout_after_send', s.store);
    expect(await facebookAdapter.publish(t.ctx, inp, (o2 as { checkpoint: Checkpoint }).checkpoint)).toMatchObject({ kind: 'unknown', code: 'response_lost' });
  });

  it('expired staging (≥ 20 h) is re-uploaded; publish without staged photos is a safe retry', async () => {
    const s = sim('facebook');
    const inp = input('facebook', [img(1), img(2)]);
    const o = await facebookAdapter.prepare(s.ctx, inp, null);
    s.clock.advance(21 * 60 * 60_000);
    s.transport.calls = [];
    await facebookAdapter.prepare(s.ctx, inp, (o as { checkpoint: Checkpoint }).checkpoint);
    expect(s.transport.calls.filter((c) => c.op === 'meta.facebook.photo_stage')).toHaveLength(2);
    expect(await facebookAdapter.publish(s.ctx, inp, null)).toMatchObject({ kind: 'rejected_safe_to_retry', code: 'not_prepared' });
  });

  it('validation: video with photos and 11 photos are refused with exact fixes', () => {
    expect(facebookAdapter.validate(input('facebook', [img(1), vid(2)])).issues.map((i) => i.code)).toEqual(['mixed_media_unsupported']);
    expect(facebookAdapter.validate(input('facebook', Array.from({ length: 11 }, (_, i) => img(i)))).issues).toEqual([
      expect.objectContaining({ code: 'too_many_images', message: 'Facebook: at most 10 images per post in this release. Remove 1.' }),
    ]);
  });
});

// ------------------------------------------------------------------ Facebook video
describe('Facebook Page video', () => {
  it('POST /videos with file_url + description ⇒ processing; reconcile polls the video status until ready', async () => {
    const s = sim('facebook', 'processing');
    const inp = input('facebook', [vid(1, { width: 1280, height: 720 })], { format: 'video' });
    const prep = await facebookAdapter.prepare(s.ctx, inp, null);
    expect(prep).toMatchObject({ kind: 'ready', checkpoint: { step: 'video_ready', data: { kind: 'video' } } });
    expect(s.transport.calls).toHaveLength(0);
    const out = await facebookAdapter.publish(s.ctx, inp, (prep as { checkpoint: Checkpoint }).checkpoint);
    expect(out).toMatchObject({ kind: 'processing', checkAfterMs: 30_000 });
    const r = s.transport.calls[0]!;
    expect(path(r)).toBe(`/${V}/mock_page1/videos`);
    expect(r.op).toBe('meta.facebook.videos');
    expect(r.publishes).toBe(true);
    expect(Object.fromEntries([...params(r)].filter(([k]) => !['access_token', 'appsecret_proof'].includes(k))))
      .toEqual({ file_url: vid(1).url, description: 'Matchday #launch', published: 'true' });
    const o = out as Extract<typeof out, { kind: 'processing' }>;
    const ref = { deliveryId: 'd', connection: conn('facebook'), credentials: creds, variantText: 'Matchday #launch', providerIds: o.providerIds, checkpoint: o.checkpoint!, sentAt: null };
    expect(await facebookAdapter.reconcile(s.ctx, ref)).toEqual({ kind: 'processing', checkAfterMs: 30_000 });
    expect(await facebookAdapter.reconcile(s.ctx, ref)).toEqual({ kind: 'processing', checkAfterMs: 30_000 });
    const done = await facebookAdapter.reconcile(s.ctx, ref);
    expect(done).toMatchObject({ kind: 'published', providerIds: o.providerIds, url: `https://www.facebook.com/mock_page1/videos/${o.providerIds[0]}/` });
    expect(s.transport.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('video status error ⇒ not_published; lost response ⇒ Unknown, reconciled by the Page post search', async () => {
    const t = new RecordingTransport(async () => ({ status: 200, headers: {}, body: JSON.stringify({ id: 'v1', status: { video_status: 'error' } }) }));
    const ctx: AdapterContext = { transport: t, now: () => new Date(), config: {} };
    const ref = { deliveryId: 'd', connection: conn('facebook'), credentials: creds, variantText: 'x', providerIds: ['v1'], checkpoint: { step: 'video_processing', data: { kind: 'video', videoId: 'v1' } }, sentAt: null };
    expect(await facebookAdapter.reconcile(ctx, ref)).toMatchObject({ kind: 'not_published' });

    const s = sim('facebook', 'timeout_after_send');
    const inp = input('facebook', [vid(1)], { format: 'video' });
    const out = await facebookAdapter.publish(s.ctx, inp, { step: 'video_ready', data: { kind: 'video' } });
    expect(out).toMatchObject({ kind: 'unknown', code: 'response_lost' });
    const r = await facebookAdapter.reconcile(s.ctx, { ...ref, providerIds: [], checkpoint: { step: 'video_ready', data: { kind: 'video' } }, variantText: 'Matchday #launch', sentAt: s.clock.now().toISOString() });
    expect(r).toMatchObject({ kind: 'published' });
  });
});
