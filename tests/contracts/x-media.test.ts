// V1.1 contract tests: X multi-image (2–4) posts and chunked video upload (initialize/append/finalize/STATUS).
// Exact outgoing requests, resume-from-checkpoint and the simulator. No network.
import { describe, expect, it } from 'vitest';
import { TransportError, type AdapterContext, type Checkpoint, type HttpRequest, type HttpResponse, type PublishConnection, type PublishInput, type PublishMedia, type Transport } from '@social-lite/core';
import { MemoryMockStore, mockId, type MockScenario, type MockStore } from '@social-lite/providers';
import { xAdapter, xFake, VIDEO_SEGMENT_BYTES } from '../../packages/providers/src/x/index.js';

class Clock { t = new Date('2026-11-07T12:00:00Z').getTime(); now = () => new Date(this.t); advance(ms: number) { this.t += ms; } }
class RecordingTransport implements Transport {
  readonly mode = 'mock' as const;
  calls: HttpRequest[] = [];
  constructor(private readonly handler: (req: HttpRequest) => Promise<HttpResponse>) {}
  async send(req: HttpRequest) { this.calls.push(req); return this.handler(req); }
}

const conn: PublishConnection = { id: 'cx', provider: 'x', providerAccountId: 'mock_x_user', displayName: 'Sim', username: 'sim', metadata: {}, isMock: true };
function sim(scenario: MockScenario = 'success', store: MockStore = new MemoryMockStore()) {
  const clock = new Clock();
  const state = { failOn: null as null | ((r: HttpRequest) => boolean) };
  const transport = new RecordingTransport(async (req) => {
    if (state.failOn?.(req)) { state.failOn = null; throw new TransportError('reset', 'reset', true); }
    return xFake(req, { provider: 'x', accountId: 'mock_x_user', scenario, store, now: clock.now, newId: mockId });
  });
  const ctx: AdapterContext = { transport, now: clock.now, config: {} };
  return { transport, ctx, clock, store, state };
}

const png = (n: number): PublishMedia => ({ assetId: `i${n}`, mime: 'image/png', kind: 'image', width: 800, height: 600, bytes: 4, url: `https://s.invalid/${n}`, load: async () => new Uint8Array([n, 1, 2, 3]) });
const VIDEO_BYTES = VIDEO_SEGMENT_BYTES * 2 + 1234;
const mp4 = (over: Partial<PublishMedia> = {}): PublishMedia => ({
  assetId: 'v1', mime: 'video/mp4', kind: 'video', width: 1280, height: 720, bytes: VIDEO_BYTES, durationMs: 8000, videoCodec: 'h264', audioCodec: 'aac', frameRate: 30,
  url: 'https://s.invalid/v1', load: async () => new Uint8Array(VIDEO_BYTES).fill(7), ...over,
});
const input = (media: PublishMedia[], text = 'Four up'): PublishInput => ({
  deliveryId: 'd', attemptNumber: 1, idempotencyKey: 'k', connection: conn, credentials: { kind: 'mock', token: 'tok' },
  variant: { text, link: null, format: media.length > 1 ? 'album' : 'video', buttons: [], options: {} }, media,
});

async function prepareUntilReady(s: ReturnType<typeof sim>, inp: PublishInput, start: Checkpoint | null = null) {
  let cp = start;
  for (let i = 0; i < 10; i++) {
    const o = await xAdapter.prepare(s.ctx, inp, cp);
    if (o.kind === 'ready') return o.checkpoint;
    if (o.kind === 'pending') { cp = o.checkpoint; s.clock.advance(o.checkAfterMs); continue; }
    throw new Error(JSON.stringify(o));
  }
  throw new Error('did not settle');
}

describe('X multi-image', () => {
  it('uploads each image (simple upload, tweet_image) and posts media_ids in order', async () => {
    const s = sim();
    const inp = input([png(1), png(2), png(3), png(4)]);
    const cp = await prepareUntilReady(s, inp);
    const uploads = s.transport.calls.filter((c) => c.op === 'x.media.upload');
    expect(uploads).toHaveLength(4);
    for (const u of uploads) {
      expect(u.url).toBe('https://api.x.com/2/media/upload');
      expect((u.body as FormData).get('media_category')).toBe('tweet_image');
      expect(u.headers?.authorization).toBe('Bearer tok');
    }
    expect(cp).toMatchObject({ step: 'media_ready' });
    const ids = cp.data.mediaIds as string[];
    expect(ids).toHaveLength(4);
    const out = await xAdapter.publish(s.ctx, inp, cp);
    expect(out).toMatchObject({ kind: 'confirmed' });
    const post = s.transport.calls.at(-1)!;
    expect(post.url).toBe('https://api.x.com/2/tweets');
    expect(post.publishes).toBe(true);
    expect(JSON.parse(post.body as string)).toEqual({ text: 'Four up', media: { media_ids: ids } });
  });

  it('resume: images already uploaded are not uploaded again', async () => {
    const s = sim();
    let n = 0;
    s.state.failOn = (r) => r.op === 'x.media.upload' && ++n === 2;
    const inp = input([png(1), png(2), png(3)]);
    const o = await xAdapter.prepare(s.ctx, inp, null);
    expect(o).toMatchObject({ kind: 'retryable', checkpoint: { step: 'media_ready' } });
    const cp1 = (o as { checkpoint: Checkpoint }).checkpoint;
    expect((cp1.data.items as unknown[]).length).toBe(1);
    s.transport.calls = [];
    const cp = await prepareUntilReady(s, inp, cp1);
    expect(s.transport.calls.filter((c) => c.op === 'x.media.upload')).toHaveLength(2);
    expect((cp.data.mediaIds as string[])[0]).toBe((cp1.data.mediaIds as string[])[0]);
  });

  it('validation: 5 images, or a video with an image, are refused before any upload', async () => {
    const s = sim();
    const five = input([png(1), png(2), png(3), png(4), png(5)]);
    expect(xAdapter.validate(five).issues.map((i) => i.code)).toEqual(['too_many_images']);
    expect(await xAdapter.prepare(s.ctx, five, null)).toMatchObject({ kind: 'permanent', code: 'invalid_content' });
    expect(xAdapter.validate(input([png(1), mp4()])).issues.map((i) => i.code)).toEqual(['mixed_media_unsupported']);
    expect(xAdapter.validate(input([mp4({ width: 1080, height: 1920 })])).issues).toEqual([
      expect.objectContaining({ code: 'video_dimensions', message: 'X: video is 1080×1920; at most 1280×1024 (either orientation).' }),
    ]);
    expect(s.transport.calls).toHaveLength(0);
    expect(xAdapter.capabilities(conn).formats).toEqual(['text', 'image', 'album', 'video']);
  });
});

describe('X video (chunked v2 upload)', () => {
  it('initialize (JSON) → append segments (multipart, 4 MB) → finalize → STATUS until succeeded → post', async () => {
    const s = sim();
    const inp = input([mp4()], 'Clip');
    const first = await xAdapter.prepare(s.ctx, inp, null);
    expect(first).toMatchObject({ kind: 'pending', checkAfterMs: 1000, checkpoint: { step: 'media_processing' } });
    const [init, ...rest] = s.transport.calls;
    expect(init!.url).toBe('https://api.x.com/2/media/upload/initialize');
    expect(init!.headers?.['content-type']).toBe('application/json');
    expect(JSON.parse(init!.body as string)).toEqual({ media_type: 'video/mp4', total_bytes: VIDEO_BYTES, media_category: 'tweet_video' });
    const appends = rest.filter((c) => c.op === 'x.media.append');
    expect(appends).toHaveLength(3);
    const id = (first as { checkpoint: Checkpoint }).checkpoint.data.mediaIds as string[];
    appends.forEach((a, i) => {
      expect(a.url).toBe(`https://api.x.com/2/media/upload/${id[0]}/append`);
      const f = a.body as FormData;
      expect(f.get('segment_index')).toBe(String(i));
      expect((f.get('media') as Blob).size).toBe(i < 2 ? VIDEO_SEGMENT_BYTES : 1234);
    });
    const fin = rest.find((c) => c.op === 'x.media.finalize')!;
    expect(fin.url).toBe(`https://api.x.com/2/media/upload/${id[0]}/finalize`);
    expect(fin.body).toBeUndefined();
    expect(s.transport.calls.some((c) => /command=(INIT|APPEND|FINALIZE)/.test(c.url))).toBe(false);

    const cp = await prepareUntilReady(s, inp, (first as { checkpoint: Checkpoint }).checkpoint);
    const status = s.transport.calls.filter((c) => c.op === 'x.media.status');
    expect(status.length).toBeGreaterThanOrEqual(1);
    expect(new URL(status[0]!.url).search).toBe(`?command=STATUS&media_id=${id[0]}`);
    const out = await xAdapter.publish(s.ctx, inp, cp);
    expect(out).toMatchObject({ kind: 'confirmed' });
    expect(JSON.parse(s.transport.calls.at(-1)!.body as string)).toEqual({ text: 'Clip', media: { media_ids: id } });
  });

  it('resume mid-upload: continues from the next segment of the same media id (no new initialize)', async () => {
    const s = sim();
    let appends = 0;
    s.state.failOn = (r) => r.op === 'x.media.append' && ++appends === 2;
    const inp = input([mp4()], 'Resume');
    const o = await xAdapter.prepare(s.ctx, inp, null);
    expect(o).toMatchObject({ kind: 'retryable', checkpoint: { step: 'media_uploading' } });
    const cp1 = (o as { checkpoint: Checkpoint }).checkpoint;
    expect(cp1.data.items).toEqual([expect.objectContaining({ state: 'uploading', nextSegment: 1 })]);
    s.transport.calls = [];
    const cp = await prepareUntilReady(s, inp, cp1);
    expect(s.transport.calls.filter((c) => c.op === 'x.media.initialize')).toHaveLength(0);
    expect(s.transport.calls.filter((c) => c.op === 'x.media.append').map((c) => (c.body as FormData).get('segment_index'))).toEqual(['1', '2']);
    expect(cp.data.mediaIds).toEqual(cp1.data.mediaIds);
    expect(await xAdapter.publish(s.ctx, inp, cp)).toMatchObject({ kind: 'confirmed' });
  });

  it('a lost finalize response is resumed by finalize-then-STATUS, never a re-upload', async () => {
    const s = sim();
    s.state.failOn = (r) => r.op === 'x.media.finalize';
    const inp = input([mp4()], 'Lost finalize');
    const o = await xAdapter.prepare(s.ctx, inp, null);
    expect(o).toMatchObject({ kind: 'retryable', checkpoint: { step: 'media_uploading' } });
    s.transport.calls = [];
    await prepareUntilReady(s, inp, (o as { checkpoint: Checkpoint }).checkpoint);
    expect(s.transport.calls.filter((c) => c.op === 'x.media.initialize' || c.op === 'x.media.append')).toHaveLength(0);
  });

  it('processing failed ⇒ permanent with the exact fix; publish without a ready video is a safe retry; lost post ⇒ Unknown', async () => {
    const s = sim('fail_permanent');
    const inp = input([mp4()], 'Bad');
    let o = await xAdapter.prepare(s.ctx, inp, null);
    while (o.kind === 'pending') o = await xAdapter.prepare(s.ctx, inp, o.checkpoint);
    expect(o).toMatchObject({ kind: 'permanent', code: 'x_media_processing_failed' });
    expect(await xAdapter.publish(s.ctx, inp, null)).toMatchObject({ kind: 'rejected_safe_to_retry', code: 'media_not_prepared' });

    const t = sim('timeout_after_send');
    const ok = input([mp4()], 'Lost post');
    const cp = await prepareUntilReady(t, ok);
    expect(await xAdapter.publish(t.ctx, ok, cp)).toMatchObject({ kind: 'unknown' });
    const r = await xAdapter.reconcile(t.ctx, { deliveryId: 'd', connection: conn, credentials: ok.credentials, variantText: 'Lost post', providerIds: [], checkpoint: cp, sentAt: t.clock.now().toISOString() });
    expect(r).toMatchObject({ kind: 'published' });
  });
});
