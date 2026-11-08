// V1.1 contract tests: Telegram albums (sendMediaGroup) and videos (sendVideo). Exact outgoing multipart
// requests, ambiguous-outcome handling and the simulator. No network.
import { describe, expect, it } from 'vitest';
import { TransportError, type AdapterContext, type HttpRequest, type HttpResponse, type PublishConnection, type PublishInput, type PublishMedia, type Transport } from '@social-lite/core';
import { MemoryMockStore, MockTransport, type MockScenario } from '@social-lite/providers';
import { telegramAdapter, telegramFake } from '../../packages/providers/src/telegram/index.js';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';

class RecordingTransport implements Transport {
  readonly mode = 'live' as const;
  readonly requests: HttpRequest[] = [];
  constructor(private readonly respond: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>) {}
  async send(req: HttpRequest) { this.requests.push(req); return this.respond(req); }
}
const tg = (result: unknown): HttpResponse => ({ status: 200, headers: {}, body: JSON.stringify({ ok: true, result }) });
const ctxWith = (transport: Transport): AdapterContext => ({ transport, now: () => new Date('2026-11-07T12:00:00Z'), config: {} });
const conn: PublishConnection = { id: 'c1', provider: 'telegram', providerAccountId: '-1001234567890', displayName: 'News', username: 'newschan', metadata: {}, isMock: false };
const mockConn: PublishConnection = { ...conn, providerAccountId: 'mock_tg_channel', username: null, isMock: true };

const photo = (n: number): PublishMedia => ({ assetId: `p${n}`, mime: 'image/jpeg', kind: 'image', width: 1080, height: 1080, bytes: 3, url: `https://s.invalid/p${n}`, load: async () => new Uint8Array([n, n, n]) });
const video = (n: number, over: Partial<PublishMedia> = {}): PublishMedia => ({
  assetId: `v${n}`, mime: 'video/mp4', kind: 'video', width: 1280, height: 720, bytes: 5, durationMs: 12_400, videoCodec: 'h264', audioCodec: 'aac', frameRate: 30,
  url: `https://s.invalid/v${n}`, load: async () => new Uint8Array([9, 9, 9, 9, 9]), ...over,
});

function input(media: PublishMedia[], over: Partial<PublishInput['variant']> = {}, connection = conn): PublishInput {
  return {
    deliveryId: 'd1', attemptNumber: 1, idempotencyKey: 'k1', connection,
    credentials: connection.isMock ? { kind: 'mock', token: TOKEN } : { kind: 'telegram_bot', botToken: TOKEN },
    variant: { text: 'Album caption', link: 'https://example.com/a', format: 'album', buttons: [], options: {}, ...over }, media,
  };
}

describe('sendMediaGroup (albums)', () => {
  it('multipart: chat_id, media JSON with attach://fileN, caption (link appended) on the first item only, files in order', async () => {
    const t = new RecordingTransport(() => tg([{ message_id: 10, date: 1_790_000_000 }, { message_id: 11 }, { message_id: 12 }]));
    const out = await telegramAdapter.publish(ctxWith(t), input([photo(1), video(2), photo(3)]), null);
    expect(t.requests).toHaveLength(1);
    const r = t.requests[0]!;
    expect(r.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMediaGroup`);
    expect(r.op).toBe('telegram.sendMediaGroup');
    expect(r.publishes).toBe(true);
    const form = r.body as FormData;
    expect(form.get('chat_id')).toBe('-1001234567890');
    expect(JSON.parse(form.get('media') as string)).toEqual([
      { type: 'photo', media: 'attach://file0', caption: 'Album caption\n\nhttps://example.com/a' },
      { type: 'video', media: 'attach://file1', width: 1280, height: 720, duration: 12, supports_streaming: true },
      { type: 'photo', media: 'attach://file2' },
    ]);
    expect([...form.keys()].sort()).toEqual(['chat_id', 'file0', 'file1', 'file2', 'media']);
    expect((form.get('file1') as Blob).type).toBe('video/mp4');
    expect(new Uint8Array(await (form.get('file2') as Blob).arrayBuffer())).toEqual(new Uint8Array([3, 3, 3]));
    expect(form.has('reply_markup')).toBe(false);
    expect(out).toEqual({ kind: 'confirmed', providerIds: ['10', '11', '12'], url: 'https://t.me/newschan/10', publishedAt: new Date(1_790_000_000_000).toISOString() });
  });

  it('validation: buttons cannot ride on an album; 2–10 items; video ≤ 50 MB', () => {
    const v = (media: PublishMedia[], over: Partial<PublishInput['variant']> = {}) => telegramAdapter.validate(input(media, over));
    expect(v([photo(1), photo(2)], { buttons: [{ text: 'Read', url: 'https://example.com' }] }).issues.map((i) => i.code)).toEqual(['album_buttons_unsupported']);
    expect(v(Array.from({ length: 11 }, (_, i) => photo(i))).issues.map((i) => i.code)).toEqual(['too_many_images']);
    expect(v([video(1, { bytes: 60 * 1024 * 1024 })]).issues).toEqual([expect.objectContaining({ code: 'video_too_large', message: 'Telegram: video is 60.0 MB; the limit is 50 MB.' })]);
    expect(v([video(1)], { buttons: [{ text: 'Read', url: 'https://example.com' }] }).ok).toBe(true);
    expect(telegramAdapter.capabilities({} as PublishConnection).formats).toEqual(['text', 'image', 'album', 'video']);
  });

  it('a 5xx or a lost response after sending an album is Unknown (manual resolution), pre-connect failure is a safe retry', async () => {
    const t5 = new RecordingTransport(() => ({ status: 502, headers: {}, body: JSON.stringify({ ok: false, error_code: 502, description: 'Bad Gateway' }) }));
    expect(await telegramAdapter.publish(ctxWith(t5), input([photo(1), photo(2)]), null)).toMatchObject({ kind: 'unknown', code: 'telegram_server_error' });
    const lost = new RecordingTransport(() => { throw new TransportError('reset', 'reset', true); });
    expect(await telegramAdapter.publish(ctxWith(lost), input([photo(1), photo(2)]), null)).toMatchObject({ kind: 'unknown', code: 'response_lost' });
    const pre = new RecordingTransport(() => { throw new TransportError('refused', 'connect', false); });
    expect(await telegramAdapter.publish(ctxWith(pre), input([photo(1), photo(2)]), null)).toMatchObject({ kind: 'rejected_safe_to_retry' });
    const broken = { ...photo(2), load: async () => { throw new Error('storage down'); } };
    const none = new RecordingTransport(() => tg([]));
    expect(await telegramAdapter.publish(ctxWith(none), input([photo(1), broken]), null)).toMatchObject({ kind: 'rejected_safe_to_retry', code: 'media_unavailable' });
    expect(none.requests).toHaveLength(0);
  });
});

describe('sendVideo', () => {
  it('multipart: video bytes, duration/width/height, supports_streaming, caption and reply_markup', async () => {
    const t = new RecordingTransport(() => tg({ message_id: 77, date: 1_790_000_000 }));
    const out = await telegramAdapter.publish(ctxWith(t), input([video(1)], { format: 'video', buttons: [{ text: 'Watch', url: 'https://example.com/w' }] }), null);
    const r = t.requests[0]!;
    expect(r.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendVideo`);
    expect(r.publishes).toBe(true);
    const f = r.body as FormData;
    expect(Object.fromEntries([...f.entries()].filter(([, v]) => typeof v === 'string'))).toEqual({
      chat_id: '-1001234567890', duration: '12', width: '1280', height: '720', supports_streaming: 'true',
      caption: 'Album caption\n\nhttps://example.com/a', reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Watch', url: 'https://example.com/w' }]] }),
    });
    expect((f.get('video') as Blob).size).toBe(5);
    expect(out).toMatchObject({ kind: 'confirmed', providerIds: ['77'], url: 'https://t.me/newschan/77' });
  });
});

describe('telegramFake media scenarios', () => {
  const run = (scenario: MockScenario, store = new MemoryMockStore()) => {
    const transport = new MockTransport(telegramFake, { provider: 'telegram', accountId: 'mock_tg_channel', scenario, store });
    return { store, ctx: ctxWith(transport) };
  };

  it('album and video are stored as messages (album shares a media_group_id; caption on the first)', async () => {
    const { store, ctx } = run('success');
    const a = await telegramAdapter.publish(ctx, input([photo(1), video(2)], {}, mockConn), null);
    expect(a.kind).toBe('confirmed');
    const v = await telegramAdapter.publish(ctx, input([video(3)], { link: null }, mockConn), null);
    expect(v.kind).toBe('confirmed');
    const msgs = await store.list('telegram', 'mock_tg_channel', 'message');
    const group = msgs.filter((m) => m.data.media_group_id);
    expect(group).toHaveLength(2);
    expect(new Set(group.map((m) => m.data.media_group_id)).size).toBe(1);
    expect(group.find((m) => m.data.position === 0)!.data.text).toBe('Album caption\n\nhttps://example.com/a');
    expect(msgs.find((m) => m.data.has_video)!.data).toMatchObject({ duration: 12, width: 1280, height: 720, supports_streaming: true });
  });

  it('rate_limited_once ⇒ retry with retry_after; timeout_after_send ⇒ Unknown and reconcile is manual', async () => {
    const rl = run('rate_limited_once');
    expect(await telegramAdapter.publish(rl.ctx, input([photo(1), photo(2)], {}, mockConn), null)).toMatchObject({ kind: 'rejected_safe_to_retry', retryAfterMs: 3000 });
    expect(await telegramAdapter.publish(rl.ctx, input([photo(1), photo(2)], {}, mockConn), null)).toMatchObject({ kind: 'confirmed' });
    const lost = run('timeout_after_send');
    expect(await telegramAdapter.publish(lost.ctx, input([video(1)], {}, mockConn), null)).toMatchObject({ kind: 'unknown' });
    expect(await telegramAdapter.reconcile(lost.ctx, { deliveryId: 'd', connection: mockConn, credentials: { kind: 'mock', token: TOKEN }, variantText: 'x', providerIds: [], checkpoint: null, sentAt: null })).toMatchObject({ kind: 'unsupported' });
    const bad = run('fail_permanent');
    expect(await telegramAdapter.publish(bad.ctx, input([video(1)], {}, mockConn), null)).toMatchObject({ kind: 'permanent_failure', code: 'video_rejected' });
  });
});
