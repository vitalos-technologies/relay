// Threads API contract: own OAuth (code → short-lived → long-lived, refresh), containers (TEXT / IMAGE / VIDEO /
// CAROUSEL with children) + status polling, threads_publish, container-status reconcile, error table, simulator
// scenarios, insights, text length rule. No network. Sources: docs/providers/threads.md (fetched 2026-11-07).
import { describe, expect, it } from 'vitest';
import { TransportError, type Checkpoint, type PublishConnection } from '@social-lite/core';
import { threadsAdapter, threadsConnector, threadsFake, threadsMetricsFetcher, threadsTextLength } from '../../packages/providers/src/threads/index.js';
import { RecordingTransport, SCENARIOS, SECRET_ACCESS, ctxWith, expectNoSecrets, image, inputOf, prepareUntilReady, res, simulated, video } from './v3-helpers.js';

const conn = (over: Partial<PublishConnection> = {}): PublishConnection => ({ id: 'c1', provider: 'threads', providerAccountId: '1789', displayName: 'Prof', username: 'prof', isMock: false, metadata: {}, ...over });
const creds = { kind: 'oauth2' as const, accessToken: SECRET_ACCESS, refreshToken: SECRET_ACCESS, expiresAt: '2027-01-06T12:00:00Z', scope: '' };
const form = (b: unknown) => Object.fromEntries(new URLSearchParams(b as string));

describe('threads oauth (own app; no Facebook Login)', () => {
  it('authorize URL on threads.com with comma scopes', () => {
    const u = new URL(threadsConnector.authorizationUrl({ clientId: '123456' }, { state: 'st', redirectUri: 'https://app.example/api/oauth/threads/callback' }));
    expect(u.origin + u.pathname).toBe('https://threads.com/oauth/authorize');
    expect(Object.fromEntries(u.searchParams)).toEqual({ client_id: '123456', redirect_uri: 'https://app.example/api/oauth/threads/callback', scope: 'threads_basic,threads_content_publish,threads_manage_insights', response_type: 'code', state: 'st' });
  });
  it('code → short-lived (POST form) → long-lived exchange (th_exchange_token); refresh (th_refresh_token)', async () => {
    const t = new RecordingTransport((r) => (r.url.includes('/oauth/access_token') ? res(200, { access_token: 'short', user_id: 1789 }) : res(200, { access_token: SECRET_ACCESS, token_type: 'bearer', expires_in: 5183944 })));
    const tokens = await threadsConnector.exchangeCode(ctxWith(t), { code: 'c', redirectUri: 'https://r/cb' });
    expect([t.requests[0]!.method, t.requests[0]!.url]).toEqual(['POST', 'https://graph.threads.com/oauth/access_token']);
    expect(form(t.requests[0]!.body)).toEqual({ client_id: 'cid', client_secret: 'csecret', code: 'c', grant_type: 'authorization_code', redirect_uri: 'https://r/cb' });
    const ex = new URL(t.requests[1]!.url);
    expect([t.requests[1]!.method, ex.origin + ex.pathname]).toEqual(['GET', 'https://graph.threads.com/access_token']);
    expect(Object.fromEntries(ex.searchParams)).toEqual({ grant_type: 'th_exchange_token', client_secret: 'csecret', access_token: 'short' });
    expect(tokens).toMatchObject({ accessToken: SECRET_ACCESS, refreshToken: SECRET_ACCESS, scopes: [], raw: { user_id: '1789' } });
    const r = new RecordingTransport(() => res(200, { access_token: 'renewed', token_type: 'bearer', expires_in: 5183944 }));
    const out = await threadsAdapter.refreshCredentials!(ctxWith(r), creds);
    expect(Object.fromEntries(new URL(r.requests[0]!.url).searchParams)).toEqual({ grant_type: 'th_refresh_token', access_token: SECRET_ACCESS });
    expect(out.credentials).toMatchObject({ accessToken: 'renewed', refreshToken: 'renewed' });
    const bad = await threadsAdapter.refreshCredentials!(ctxWith(new RecordingTransport(() => res(400, { error: { code: 190, message: `Invalid ${SECRET_ACCESS}` } }))), creds).catch((e: Error) => e);
    expect(bad).toMatchObject({ name: 'OAuthFlowError', permanent: true });
    expectNoSecrets((bad as Error).message);
  });
  it('listDestinations = the app-scoped profile (GET /v1.0/me)', async () => {
    const t = new RecordingTransport(() => res(200, { id: '1789', username: 'prof', name: 'Prof Name', threads_profile_picture_url: 'https://x/p.jpg' }));
    const [c] = await threadsConnector.listDestinations(ctxWith(t), { accessToken: SECRET_ACCESS, refreshToken: null, expiresAt: null, scopes: [] });
    const u = new URL(t.requests[0]!.url);
    expect(u.origin + u.pathname).toBe('https://graph.threads.com/v1.0/me');
    expect(u.searchParams.get('fields')).toBe('id,username,name,threads_profile_picture_url');
    expect(c).toMatchObject({ providerAccountId: '1789', displayName: 'Prof Name', username: 'prof' });
  });
});

describe('threads text rule and validation', () => {
  it('500 characters with emojis counted as their UTF-8 bytes', () => {
    expect(threadsTextLength('abc')).toBe(3);
    expect(threadsTextLength('hi 👍')).toBe(3 + 4);
    expect(threadsTextLength('👨‍👩‍👧')).toBe(18);
    const v = (text: string) => threadsAdapter.validate(inputOf(conn(), creds, { text })).issues.map((i) => i.code);
    expect(v('a'.repeat(500))).toEqual([]);
    expect(v('a'.repeat(490) + '👍👍👍')).toEqual(['too_long']);
    expect(threadsAdapter.validate(inputOf(conn(), creds, {}, Array.from({ length: 21 }, (_, i) => image(i)))).issues.map((i) => i.code)).toContain('too_many_images');
  });
});

describe('threads containers and publish', () => {
  it('text post: TEXT container with link_attachment, status FINISHED, then threads_publish (publishes)', async () => {
    const t = new RecordingTransport((r) => {
      if (r.url.endsWith('/1789/threads')) return res(200, { id: 'ctr1' });
      if (r.url.includes('/ctr1?')) return res(200, { id: 'ctr1', status: 'FINISHED' });
      if (r.url.endsWith('/threads_publish')) return res(200, { id: 'media9' });
      return res(200, { id: 'media9', permalink: 'https://www.threads.com/@prof/post/abc' });
    });
    const inp = inputOf(conn(), creds, { text: 'Hello', link: 'https://example.com' });
    const p = await threadsAdapter.prepare(ctxWith(t), inp, null);
    expect([t.requests[0]!.method, t.requests[0]!.url]).toEqual(['POST', 'https://graph.threads.com/v1.0/1789/threads']);
    expect(form(t.requests[0]!.body)).toEqual({ media_type: 'TEXT', text: 'Hello', link_attachment: 'https://example.com', access_token: SECRET_ACCESS });
    expect(t.requests[0]!.url).not.toContain(SECRET_ACCESS);
    expect(Object.fromEntries(new URL(t.requests[1]!.url).searchParams)).toEqual({ fields: 'status,error_message', access_token: SECRET_ACCESS });
    expect(p).toMatchObject({ kind: 'ready', checkpoint: { step: 'container_ready', data: { parentId: 'ctr1' } } });
    const out = await threadsAdapter.publish(ctxWith(t), inp, (p as { checkpoint: Checkpoint }).checkpoint);
    const pub = t.requests.find((r) => r.url.endsWith('/threads_publish'))!;
    expect([pub.method, pub.publishes]).toEqual(['POST', true]);
    expect(form(pub.body)).toEqual({ creation_id: 'ctr1', access_token: SECRET_ACCESS });
    expect(out).toEqual({ kind: 'confirmed', providerIds: ['media9'], url: 'https://www.threads.com/@prof/post/abc', publishedAt: '2026-11-07T12:00:00.000Z' });
  });

  it('carousel: children with is_carousel_item, polled to FINISHED, then CAROUSEL parent with children; link appended to text', async () => {
    const s = simulated(threadsFake, 'threads', 'mock_th_1', 'processing');
    const c = conn({ providerAccountId: 'mock_th_1', isMock: true });
    const inp = inputOf(c, { kind: 'mock', token: 'tok' }, { text: 'Album', link: 'https://example.com' }, [image(1), video(1000)]);
    const { checkpoint, polls } = await prepareUntilReady(threadsAdapter, s.ctx, s.clock, inp);
    expect(polls).toBeGreaterThan(0);
    const creates = s.state.calls.filter((r) => r.method === 'POST' && r.url.endsWith('/threads')).map((r) => form(r.body));
    expect(creates[0]).toEqual({ media_type: 'IMAGE', image_url: 'https://storage.example/img1.jpg', is_carousel_item: 'true', access_token: 'tok' });
    expect(creates[1]).toEqual({ media_type: 'VIDEO', video_url: 'https://storage.example/vid1.mp4', is_carousel_item: 'true', access_token: 'tok' });
    expect(creates[2]).toMatchObject({ media_type: 'CAROUSEL', text: 'Album\n\nhttps://example.com' });
    expect(creates[2]!.children!.split(',')).toEqual((checkpoint.data.items as Array<{ containerId: string }>).map((i) => i.containerId));
    expect(creates).toHaveLength(3); // polling never re-creates containers
    expect((await threadsAdapter.publish(s.ctx, inp, checkpoint)).kind).toBe('confirmed');
  });

  it('container ERROR ⇒ permanent with the Threads error; EXPIRED ⇒ recreated', async () => {
    const t = new RecordingTransport((r) => (r.method === 'POST' ? res(200, { id: 'c1' }) : res(200, { status: 'ERROR', error_message: 'INVALID_DURATION' })));
    expect(await threadsAdapter.prepare(ctxWith(t), inputOf(conn(), creds, {}, [video(1000)]), null)).toMatchObject({ kind: 'permanent', code: 'threads_media_failed', message: expect.stringContaining('INVALID_DURATION') });
    const e = new RecordingTransport((r) => (r.method === 'POST' ? res(200, { id: 'c1' }) : res(200, { status: 'EXPIRED' })));
    expect(await threadsAdapter.prepare(ctxWith(e), inputOf(conn(), creds, {}, [image(1)]), null)).toMatchObject({ kind: 'retryable', code: 'threads_container_expired', checkpoint: { step: 'restart' } });
  });
});

describe('threads error table (threads_publish)', () => {
  const inp = inputOf(conn(), creds);
  const cp = { step: 'container_ready', data: { items: [], parentId: 'ctr', parentStatus: 'FINISHED', createdAt: '2026-11-07T11:59:00Z' } };
  const g = (status: number, code: number, message = 'm') => () => res(status, { error: { message: `${message} ${SECRET_ACCESS}`, type: 'OAuthException', code } });
  const cases: Array<[string, () => ReturnType<typeof res>, Record<string, unknown>]> = [
    ['190 ⇒ reconnect', g(400, 190), { kind: 'permanent_failure', blocking: 'reconnect' }],
    ['10 ⇒ permission', g(403, 10), { kind: 'permanent_failure', blocking: 'permission' }],
    ['4 ⇒ rate limited', g(400, 4), { kind: 'rejected_safe_to_retry', code: 'rate_limited', retryAfterMs: 900_000 }],
    ['publishing limit ⇒ budget', g(400, 9, 'User reached the publishing limit'), { kind: 'permanent_failure', blocking: 'budget' }],
    ['100 ⇒ permanent', g(400, 100), { kind: 'permanent_failure' }],
    ['500 ⇒ unknown', g(500, 2), { kind: 'unknown' }],
  ];
  it.each(cases)('%s', async (_n, respond, expected) => {
    const out = await threadsAdapter.publish(ctxWith(new RecordingTransport(respond)), inp, cp);
    expect(out).toMatchObject(expected);
    expectNoSecrets(out);
  });
  it('transport: pre-connect ⇒ safe retry; after send ⇒ unknown; not prepared ⇒ nothing sent', async () => {
    expect((await threadsAdapter.publish(ctxWith(new RecordingTransport(() => { throw new TransportError('x', 'connect', false); })), inp, cp)).kind).toBe('rejected_safe_to_retry');
    expect((await threadsAdapter.publish(ctxWith(new RecordingTransport(() => { throw new TransportError('x', 'reset', true); })), inp, cp)).kind).toBe('unknown');
    const none = new RecordingTransport(() => res(200, {}));
    expect((await threadsAdapter.publish(ctxWith(none), inp, null)).kind).toBe('rejected_safe_to_retry');
    expect(none.requests).toHaveLength(0);
  });
});

describe('threads reconcile (container status is definitive)', () => {
  const ref = (cp: Checkpoint | null) => ({ deliveryId: 'd', connection: conn(), credentials: creds, variantText: 'Hello there', providerIds: [], checkpoint: cp, sentAt: '2026-11-07T11:59:00Z' });
  const cp = { step: 'container_ready', data: { items: [], parentId: 'ctr', parentStatus: 'FINISHED', createdAt: '2026-11-07T11:58:00Z' } };
  it('PUBLISHED ⇒ find the media id in recent threads; FINISHED ⇒ not published; EXPIRED ⇒ not published', async () => {
    const t = new RecordingTransport((r) => (r.url.includes('/ctr?') ? res(200, { status: 'PUBLISHED' }) : res(200, { data: [{ id: 'm1', text: 'Hello  there', timestamp: '2026-11-07T11:59:30+0000', permalink: 'https://www.threads.com/@prof/post/x' }] })));
    const out = await threadsAdapter.reconcile(ctxWith(t), ref(cp));
    const list = new URL(t.requests[1]!.url);
    expect(list.pathname).toBe('/v1.0/1789/threads');
    expect(list.searchParams.get('fields')).toBe('id,text,timestamp,permalink');
    expect(list.searchParams.get('since')).toBe(String(Math.floor(Date.parse('2026-11-07T11:59:00Z') / 1000) - 600));
    expect(out).toMatchObject({ kind: 'published', providerIds: ['m1'], url: 'https://www.threads.com/@prof/post/x' });
    expect((await threadsAdapter.reconcile(ctxWith(new RecordingTransport(() => res(200, { status: 'FINISHED' }))), ref(cp))).kind).toBe('not_published');
    expect((await threadsAdapter.reconcile(ctxWith(new RecordingTransport(() => res(200, { status: 'EXPIRED' }))), ref(cp))).kind).toBe('not_published');
    expect((await threadsAdapter.reconcile(ctxWith(t), ref(null))).kind).toBe('still_unknown');
  });
});

describe('threads simulator scenarios', () => {
  async function run(scenario: (typeof SCENARIOS)[number], media = [image(1)]) {
    const s = simulated(threadsFake, 'threads', 'mock_th_s', scenario);
    const c = conn({ providerAccountId: 'mock_th_s', isMock: true });
    const inp = inputOf(c, { kind: 'mock', token: 'tok' }, { text: `post ${scenario}` }, media);
    let prep = await threadsAdapter.prepare(s.ctx, inp, null);
    for (let i = 0; i < 6 && prep.kind === 'pending'; i++) prep = await threadsAdapter.prepare(s.ctx, inp, prep.checkpoint);
    const cp = prep.kind === 'ready' ? prep.checkpoint : null;
    const first = await threadsAdapter.publish(s.ctx, inp, cp);
    const second = await threadsAdapter.publish(s.ctx, inp, cp);
    const recon = () => threadsAdapter.reconcile(s.ctx, { deliveryId: 'd', connection: c, credentials: inp.credentials, variantText: inp.variant.text, providerIds: [], checkpoint: cp, sentAt: new Date(Date.now() - 60_000).toISOString() });
    return { prep, first, second, recon };
  }
  it('success; publishing the same container twice is refused (no duplicate)', async () => { const r = await run('success'); expect(r.first.kind).toBe('confirmed'); expect(r.second.kind).toBe('permanent_failure'); });
  it('processing ⇒ container polled to FINISHED', async () => { const r = await run('processing'); expect(r.prep.kind).toBe('ready'); expect(r.first.kind).toBe('confirmed'); });
  it('fail_permanent ⇒ video container ERROR', async () => { expect((await run('fail_permanent', [video(500)])).prep).toMatchObject({ kind: 'permanent', code: 'threads_media_failed' }); });
  it('fail_transient_once ⇒ safe retry then confirmed', async () => { const r = await run('fail_transient_once'); expect(r.first.kind).toBe('rejected_safe_to_retry'); expect(r.second.kind).toBe('confirmed'); });
  it('rate_limited_once ⇒ retry then confirmed', async () => { const r = await run('rate_limited_once'); expect(r.first.kind).toBe('rejected_safe_to_retry'); expect(r.second.kind).toBe('confirmed'); });
  it('timeout_after_send ⇒ unknown ⇒ reconciled (container PUBLISHED)', async () => { const r = await run('timeout_after_send'); expect(r.first.kind).toBe('unknown'); expect((await r.recon()).kind).toBe('published'); });
  it('revoked ⇒ reconnect', async () => { expect((await run('revoked')).prep).toMatchObject({ kind: 'permanent', blocking: 'reconnect' }); });
  it('missing_permission ⇒ permission', async () => { expect((await run('missing_permission')).prep).toMatchObject({ kind: 'permanent', blocking: 'permission' }); });
});

describe('threads insights', () => {
  it('GET /{media}/insights?metric=…; values[] and total_value parsed; missing metrics unavailable', async () => {
    const t = new RecordingTransport(() => res(200, { data: [{ name: 'likes', period: 'lifetime', values: [{ value: 5 }] }, { name: 'views', period: 'lifetime', total_value: { value: 80 } }] }));
    const out = await threadsMetricsFetcher.fetch(ctxWith(t), { connection: conn(), credentials: creds, providerIds: ['m1'], publishedAt: null });
    const u = new URL(t.requests[0]!.url);
    expect(u.pathname).toBe('/v1.0/m1/insights');
    expect(u.searchParams.get('metric')).toBe('views,likes,replies,reposts,quotes,shares');
    expect(out).toMatchObject({ kind: 'ok', points: [{ name: 'likes', value: 5 }, { name: 'views', value: 80 }] });
    expect((out as { unavailable: unknown[] }).unavailable).toHaveLength(4);
    expect((await threadsMetricsFetcher.fetch(ctxWith(new RecordingTransport(() => res(400, { error: { code: 190, message: 'x' } }))), { connection: conn(), credentials: creds, providerIds: ['m1'], publishedAt: null })).kind).toBe('reconnect');
  });
});
