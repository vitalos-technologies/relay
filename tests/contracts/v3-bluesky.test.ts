// Bluesky / AT Protocol contract: app-password session (clearly labelled; atproto OAuth not implemented), PDS from the
// DID document, rich-text facets with UTF-8 byte offsets, uploadBlob + images embed with alt text, deterministic TID
// record keys (no duplicates), getRecord reconcile, error table, simulator scenarios, post counts. No network.
import { describe, expect, it } from 'vitest';
import { TransportError, type Checkpoint, type PublishConnection } from '@social-lite/core';
import { APP_PASSWORD_RE, FAKE_PDS, TID_RE, blueskyAdapter, blueskyConnector, blueskyFake, blueskyMetricsFetcher, buildFacets, deliveryTid, detectFacets, tid } from '../../packages/providers/src/bluesky/index.js';
import { NOW, RecordingTransport, SCENARIOS, ctxWith, expectNoSecrets, image, inputOf, res, simulated, video } from './v3-helpers.js';

const APP_PW = 'abcd-efgh-ijkl-mnop';
const jwt = (expSec: number) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ exp: expSec })).toString('base64url')}.sig`;
const ACCESS = jwt(Math.floor(NOW.getTime() / 1000) + 7200);
const conn = (over: Partial<PublishConnection> = {}): PublishConnection => ({ id: 'c1', provider: 'bluesky', providerAccountId: 'did:plc:abc', displayName: '@me.bsky.social', username: 'me.bsky.social', isMock: false, metadata: {}, ...over });
const creds = { kind: 'atproto_app_password' as const, identifier: 'me.bsky.social', appPassword: APP_PW, did: 'did:plc:abc', service: 'https://bsky.social', pdsUrl: FAKE_PDS, accessJwt: ACCESS, refreshJwt: 'refresh-jwt', accessExpiresAt: new Date(NOW.getTime() + 7200_000).toISOString() };

describe('bluesky app-password connection', () => {
  it('createSession at the entryway; PDS taken from the DID document; credentials kept encrypted-ready', async () => {
    const s = simulated(blueskyFake, 'bluesky', 'did:plc:abc');
    const fin = await blueskyConnector.verify(s.ctx, { identifier: '@me.bsky.social', appPassword: APP_PW });
    const r = s.state.calls[0]!;
    expect([r.method, r.url]).toEqual(['POST', 'https://bsky.social/xrpc/com.atproto.server.createSession']);
    expect(JSON.parse(r.body as string)).toEqual({ identifier: 'me.bsky.social', password: APP_PW });
    expect(fin).toMatchObject({ providerAccountId: 'did:plc:abc', username: 'sim.bsky.social', credentials: { kind: 'atproto_app_password', pdsUrl: FAKE_PDS, did: 'did:plc:abc' }, metadata: { auth_method: 'app_password', pds_url: FAKE_PDS }, health: { status: 'ready' } });
    expect(fin.expiresAt).toBe(new Date(NOW.getTime() + 7200_000).toISOString());
    expect(blueskyConnector.authMethod).toBe('app_password');
  });
  it('refuses a main account password without any request; wrong credentials never echo the password', async () => {
    const t = new RecordingTransport(() => res(401, { error: 'AuthenticationRequired', message: `Invalid identifier or password ${APP_PW}` }));
    await expect(blueskyConnector.verify(ctxWith(t), { identifier: 'me.bsky.social', appPassword: 'hunter2-main-password' })).rejects.toMatchObject({ code: 'app_password_required' });
    expect(t.requests).toHaveLength(0);
    const e = await blueskyConnector.verify(ctxWith(t), { identifier: 'me.bsky.social', appPassword: APP_PW }).catch((x: Error) => x);
    expect(e).toMatchObject({ name: 'OAuthFlowError', permanent: true });
    expectNoSecrets((e as Error).message, [APP_PW]);
    expect(APP_PASSWORD_RE.test(APP_PW)).toBe(true);
  });
  it('refresh: refreshSession with the refresh JWT; on failure a new app-password session; revoked ⇒ permanent', async () => {
    const ok = simulated(blueskyFake, 'bluesky', 'did:plc:abc');
    const out = await blueskyAdapter.refreshCredentials!(ok.ctx, { ...creds, refreshJwt: jwt(1) });
    expect(ok.state.calls[0]!.url).toBe(`${FAKE_PDS}/xrpc/com.atproto.server.refreshSession`);
    expect(ok.state.calls[0]!.headers?.authorization).toBe(`Bearer ${jwt(1)}`);
    expect(out.credentials).toMatchObject({ kind: 'atproto_app_password', appPassword: APP_PW });
    const revoked = simulated(blueskyFake, 'bluesky', 'did:plc:abc', 'revoked');
    const err = await blueskyAdapter.refreshCredentials!(revoked.ctx, creds).catch((x: Error) => x);
    expect(revoked.state.calls.map((c) => c.url.split('/xrpc/')[1])).toEqual(['com.atproto.server.refreshSession', 'com.atproto.server.createSession']);
    expect(err).toMatchObject({ name: 'OAuthFlowError', permanent: true });
  });
});

describe('bluesky record keys and rich text', () => {
  it('TID: 13 base32-sortable chars, first char 2–j, deterministic per delivery, time-ordered', () => {
    expect(tid(0n, 0)).toBe('2222222222222');
    const a = deliveryTid('delivery-1', new Date('2026-11-07T12:00:00Z'));
    expect(a).toMatch(TID_RE);
    expect(deliveryTid('delivery-1', new Date('2026-11-07T12:00:00Z'))).toBe(a);
    expect(deliveryTid('delivery-2', new Date('2026-11-07T12:00:00Z'))).not.toBe(a);
    expect(deliveryTid('delivery-1', new Date('2026-11-07T12:00:01Z')) > a).toBe(true);
  });
  it('facets use UTF-8 byte offsets (emoji and accents before the entity), trimmed links, tags, mentions', () => {
    const text = 'Café 🎉 see https://example.com/x. by @alice.bsky.social #launch #123 (https://a.io/b)';
    const d = detectFacets(text);
    const enc = new TextEncoder().encode(text);
    const slice = (s: number, e: number) => new TextDecoder().decode(enc.slice(s, e));
    expect(d.map((x) => [x.kind, x.value, slice(x.byteStart, x.byteEnd)])).toEqual([
      ['link', 'https://example.com/x', 'https://example.com/x'],
      ['mention', 'alice.bsky.social', '@alice.bsky.social'],
      ['tag', 'launch', '#launch'],
      ['link', 'https://a.io/b', 'https://a.io/b'],
    ]);
    expect(d[0]!.byteStart).toBe(Buffer.byteLength('Café 🎉 see '));
    const f = buildFacets(d, { 'alice.bsky.social': 'did:plc:alice' });
    expect(f[1]).toEqual({ index: { byteStart: d[1]!.byteStart, byteEnd: d[1]!.byteEnd }, features: [{ $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:alice' }] });
    expect(buildFacets(d, {}).some((x) => x.features[0]!.$type === 'app.bsky.richtext.facet#mention')).toBe(false);
  });
  it('validation: 300 graphemes, 3000 bytes, ≤ 4 images ≤ 2,000,000 bytes, no video', () => {
    const v = (text: string, media = [image(1)]) => blueskyAdapter.validate(inputOf(conn(), creds, { text }, media)).issues.map((i) => i.code);
    expect(v('👍'.repeat(300))).toEqual([]);
    expect(v('a'.repeat(301))).toContain('too_long');
    expect(v('x', [1, 2, 3, 4, 5].map((n) => image(n)))).toContain('too_many_images');
    expect(v('x', [image(1, { bytes: 2_000_001 })])).toContain('too_large');
    expect(v('x', [video(1000)])).toContain('video_unsupported');
    expect(blueskyAdapter.capabilities(conn())).toMatchObject({ formats: ['text', 'image', 'album'], constraints: { textCounting: 'graphemes', maxImages: 4 } });
  });
});

describe('bluesky prepare → createRecord', () => {
  it('resolves mentions, uploads blobs (raw bytes + MIME) to the PDS, then createRecord with rkey, facets and alt texts', async () => {
    const s = simulated(blueskyFake, 'bluesky', 'did:plc:abc');
    const inp = inputOf(conn(), creds, { text: 'Hi @bob.bsky.social #ship', link: 'https://example.com', options: { bluesky: { altTexts: ['A chart'], langs: ['en'] } } }, [image(1, { width: 1200, height: 800 })]);
    const p = await blueskyAdapter.prepare(s.ctx, inp, null);
    expect(p.kind).toBe('ready');
    const cp = (p as { checkpoint: Checkpoint }).checkpoint;
    const [resolve, upload] = s.state.calls;
    expect(resolve!.url).toBe(`${FAKE_PDS}/xrpc/com.atproto.identity.resolveHandle?handle=bob.bsky.social`);
    expect(resolve!.headers?.authorization).toBe(`Bearer ${ACCESS}`);
    expect([upload!.method, upload!.url, upload!.headers?.['content-type'], (upload!.body as Uint8Array).byteLength]).toEqual(['POST', `${FAKE_PDS}/xrpc/com.atproto.repo.uploadBlob`, 'image/jpeg', 4]);
    expect(cp.data.rkey).toMatch(TID_RE);
    expect(cp.data.createdAt).toBe(NOW.toISOString());
    const out = await blueskyAdapter.publish(s.ctx, inp, cp);
    const r = s.state.calls.at(-1)!;
    expect([r.url, r.publishes]).toEqual([`${FAKE_PDS}/xrpc/com.atproto.repo.createRecord`, true]);
    const body = JSON.parse(r.body as string);
    expect(body).toMatchObject({ repo: 'did:plc:abc', collection: 'app.bsky.feed.post', rkey: cp.data.rkey });
    expect(body.record).toMatchObject({
      $type: 'app.bsky.feed.post', text: 'Hi @bob.bsky.social #ship\n\nhttps://example.com', createdAt: NOW.toISOString(), langs: ['en'],
      embed: { $type: 'app.bsky.embed.images', images: [{ alt: 'A chart', image: { $type: 'blob', mimeType: 'image/jpeg', size: 4 }, aspectRatio: { width: 1200, height: 800 } }] },
    });
    expect(body.record.facets.map((f: { features: Array<{ $type: string }> }) => f.features[0]!.$type)).toEqual(['app.bsky.richtext.facet#mention', 'app.bsky.richtext.facet#tag', 'app.bsky.richtext.facet#link']);
    expect(out).toMatchObject({ kind: 'confirmed', providerIds: [`at://did:plc:abc/app.bsky.feed.post/${cp.data.rkey}`, expect.stringMatching(/^bafyrei/)], url: `https://bsky.app/profile/me.bsky.social/post/${cp.data.rkey}` });
  });

  it('a re-prepare keeps the same rkey/createdAt and reuses fresh blobs; stale blobs are uploaded again', async () => {
    const s = simulated(blueskyFake, 'bluesky', 'did:plc:abc');
    const inp = inputOf(conn(), creds, { text: 'x' }, [image(1)]);
    const cp1 = ((await blueskyAdapter.prepare(s.ctx, inp, null)) as { checkpoint: Checkpoint }).checkpoint;
    s.clock.advance(60_000);
    const cp2 = ((await blueskyAdapter.prepare(s.ctx, inp, cp1)) as { checkpoint: Checkpoint }).checkpoint;
    expect([cp2.data.rkey, cp2.data.createdAt]).toEqual([cp1.data.rkey, cp1.data.createdAt]);
    expect(s.state.calls.filter((r) => r.url.endsWith('uploadBlob'))).toHaveLength(1);
    s.clock.advance(10 * 60_000);
    await blueskyAdapter.prepare(s.ctx, inp, cp2);
    expect(s.state.calls.filter((r) => r.url.endsWith('uploadBlob'))).toHaveLength(2);
  });

  it('expired access JWT ⇒ one fresh app-password session, then the request is retried', async () => {
    let first = true;
    const t = new RecordingTransport((r) => {
      if (r.url.endsWith('createSession')) return res(200, { did: 'did:plc:abc', handle: 'me.bsky.social', accessJwt: 'fresh', refreshJwt: 'r', active: true });
      if (first) { first = false; return res(400, { error: 'ExpiredToken', message: 'Token has expired' }); }
      return res(200, { uri: 'at://did:plc:abc/app.bsky.feed.post/3k', cid: 'bafy' });
    });
    const inp = inputOf(conn(), creds, { text: 'hello' });
    const out = await blueskyAdapter.publish(ctxWith(t), inp, { step: 'record_ready', data: { rkey: '3kabcdefghijk', createdAt: NOW.toISOString(), text: 'hello', facets: [], blobs: [] } });
    expect(t.requests.map((r) => r.url.split('/xrpc/')[1])).toEqual(['com.atproto.repo.createRecord', 'com.atproto.server.createSession', 'com.atproto.repo.createRecord']);
    expect(t.requests[2]!.headers?.authorization).toBe('Bearer fresh');
    expect(out.kind).toBe('confirmed');
  });
});

describe('bluesky error table (createRecord)', () => {
  const inp = inputOf(conn(), creds, { text: 'hello' });
  const cp = { step: 'record_ready', data: { rkey: '3kabcdefghijk', createdAt: NOW.toISOString(), text: 'hello', facets: [], blobs: [] } };
  const e = (status: number, error: string, message = 'm', headers: Record<string, string> = {}) => () => res(status, { error, message: `${message} ${ACCESS}` }, headers);
  const cases: Array<[string, () => ReturnType<typeof res>, Record<string, unknown>]> = [
    ['record already exists ⇒ unknown (reconciled, never a 2nd post)', e(400, 'InvalidRequest', 'Record already exists'), { kind: 'unknown', code: 'bluesky_record_exists' }],
    ['AccountTakedown ⇒ permission', e(400, 'AccountTakedown'), { kind: 'permanent_failure', blocking: 'permission' }],
    ['429 ⇒ retry at ratelimit-reset', e(429, 'RateLimitExceeded', 'm', { 'ratelimit-reset': String(Math.floor(NOW.getTime() / 1000) + 30) }), { kind: 'rejected_safe_to_retry', code: 'rate_limited', retryAfterMs: 30_000 }],
    ['400 invalid record ⇒ permanent', e(400, 'InvalidRequest', 'Invalid app.bsky.feed.post record'), { kind: 'permanent_failure' }],
    ['502 ⇒ unknown', e(502, 'UpstreamFailure'), { kind: 'unknown' }],
  ];
  it.each(cases)('%s', async (_n, respond, expected) => {
    const out = await blueskyAdapter.publish(ctxWith(new RecordingTransport(respond)), inp, cp);
    expect(out).toMatchObject(expected);
    expectNoSecrets(out, [ACCESS, APP_PW]);
  });
  it('transport: pre-connect ⇒ safe retry; after send ⇒ unknown; unprepared ⇒ nothing sent', async () => {
    expect((await blueskyAdapter.publish(ctxWith(new RecordingTransport(() => { throw new TransportError('x', 'connect', false); })), inp, cp)).kind).toBe('rejected_safe_to_retry');
    expect((await blueskyAdapter.publish(ctxWith(new RecordingTransport(() => { throw new TransportError('x', 'reset', true); })), inp, cp)).kind).toBe('unknown');
    const none = new RecordingTransport(() => res(200, {}));
    expect((await blueskyAdapter.publish(ctxWith(none), inp, null)).kind).toBe('rejected_safe_to_retry');
    expect(none.requests).toHaveLength(0);
  });
});

describe('bluesky reconcile (deterministic rkey)', () => {
  it('getRecord: found ⇒ published; RecordNotFound ⇒ not published (definitive)', async () => {
    const cp = { step: 'record_ready', data: { rkey: '3kabcdefghijk', createdAt: NOW.toISOString(), text: 'x', facets: [], blobs: [] } };
    const ref = { deliveryId: 'd', connection: conn(), credentials: creds, variantText: 'x', providerIds: [], checkpoint: cp, sentAt: null };
    const t = new RecordingTransport(() => res(200, { uri: 'at://did:plc:abc/app.bsky.feed.post/3kabcdefghijk', cid: 'bafy', value: {} }));
    expect(await blueskyAdapter.reconcile(ctxWith(t), ref)).toMatchObject({ kind: 'published', providerIds: ['at://did:plc:abc/app.bsky.feed.post/3kabcdefghijk', 'bafy'] });
    expect(t.requests[0]!.url).toBe(`${FAKE_PDS}/xrpc/com.atproto.repo.getRecord?repo=did%3Aplc%3Aabc&collection=app.bsky.feed.post&rkey=3kabcdefghijk`);
    const nf = new RecordingTransport(() => res(400, { error: 'RecordNotFound', message: 'Could not locate record' }));
    expect((await blueskyAdapter.reconcile(ctxWith(nf), ref)).kind).toBe('not_published');
  });
});

describe('bluesky simulator scenarios', () => {
  async function run(scenario: (typeof SCENARIOS)[number]) {
    const s = simulated(blueskyFake, 'bluesky', 'mock_bsky', scenario);
    const c = conn({ providerAccountId: 'mock_bsky', isMock: true });
    const inp = inputOf(c, { kind: 'mock', token: 'tok' }, { text: `post ${scenario} #tag` }, [image(1)], `d-${scenario}`);
    const prep = await blueskyAdapter.prepare(s.ctx, inp, null);
    const cp = prep.kind === 'ready' ? prep.checkpoint : null;
    const first = await blueskyAdapter.publish(s.ctx, inp, cp);
    const second = await blueskyAdapter.publish(s.ctx, inp, cp);
    const recon = () => blueskyAdapter.reconcile(s.ctx, { deliveryId: inp.deliveryId, connection: c, credentials: inp.credentials, variantText: '', providerIds: [], checkpoint: cp, sentAt: null });
    return { prep, first, second, recon };
  }
  it('success; a repeated create with the same rkey cannot duplicate (unknown ⇒ reconciled)', async () => {
    const r = await run('success');
    expect(r.first.kind).toBe('confirmed');
    expect(r.second).toMatchObject({ kind: 'unknown', code: 'bluesky_record_exists' });
    expect((await r.recon()).kind).toBe('published');
  });
  it('processing (no async processing on Bluesky) ⇒ confirmed', async () => { expect((await run('processing')).first.kind).toBe('confirmed'); });
  it('fail_permanent ⇒ permanent', async () => { expect((await run('fail_permanent')).first.kind).toBe('permanent_failure'); });
  it('fail_transient_once ⇒ safe retry ⇒ confirmed', async () => { const r = await run('fail_transient_once'); expect(r.first.kind).toBe('rejected_safe_to_retry'); expect(r.second.kind).toBe('confirmed'); });
  it('rate_limited_once ⇒ retry ⇒ confirmed', async () => { const r = await run('rate_limited_once'); expect(r.first).toMatchObject({ kind: 'rejected_safe_to_retry', code: 'rate_limited' }); expect(r.second.kind).toBe('confirmed'); });
  it('timeout_after_send ⇒ unknown ⇒ getRecord finds it', async () => { const r = await run('timeout_after_send'); expect(r.first.kind).toBe('unknown'); expect((await r.recon()).kind).toBe('published'); });
  it('revoked ⇒ reconnect', async () => { expect((await run('revoked')).prep).toMatchObject({ kind: 'permanent', blocking: 'reconnect' }); });
  it('missing_permission ⇒ permission (account deactivated)', async () => { expect((await run('missing_permission')).first).toMatchObject({ kind: 'permanent_failure', blocking: 'permission' }); });
});

describe('bluesky metrics', () => {
  it('public AppView getPosts?uris=…; counts only (no impressions exist)', async () => {
    const uri = 'at://did:plc:abc/app.bsky.feed.post/3kabcdefghijk';
    const t = new RecordingTransport(() => res(200, { posts: [{ uri, likeCount: 4, repostCount: 1, replyCount: 0, quoteCount: 0 }] }));
    const out = await blueskyMetricsFetcher.fetch(ctxWith(t), { connection: conn(), credentials: creds, providerIds: [uri], publishedAt: null });
    expect(t.requests[0]!.url).toBe(`https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`);
    expect(t.requests[0]!.headers?.authorization).toBeUndefined();
    expect(out).toMatchObject({ kind: 'ok', points: [{ name: 'likeCount', value: 4 }, { name: 'repostCount', value: 1 }, { name: 'replyCount', value: 0 }, { name: 'quoteCount', value: 0 }], unavailable: [{ name: 'bookmarkCount' }] });
    expect((await blueskyMetricsFetcher.fetch(ctxWith(new RecordingTransport(() => res(200, { posts: [] }))), { connection: conn(), credentials: creds, providerIds: [uri], publishedAt: null })).kind).toBe('not_found');
  });
});
