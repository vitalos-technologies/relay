// X adapter/connector contract: OAuth 2.0 PKCE requests, media upload, post creation, error classification,
// reconciliation, simulated-API scenarios and token hygiene. No network.
import { describe, expect, it } from 'vitest';
import { TransportError, type AdapterContext, type HttpRequest, type HttpResponse, type PublishConnection, type PublishInput, type PublishMedia, type Transport } from '@social-lite/core';
import { MemoryMockStore, MockTransport, type MockScenario } from '@social-lite/providers';
import { xAdapter, xConnector, xFake } from '../../packages/providers/src/x/index.js';
import { normalizeForMatch } from '../../packages/providers/src/x/adapter.js';

const ACCESS = 'acc-SECRET-TOKEN-value-123';
const REFRESH = 'ref-SECRET-TOKEN-value-456';
const NOW = new Date('2026-11-06T12:00:00Z');

type Responder = (req: HttpRequest) => HttpResponse | Promise<HttpResponse>;
class RecordingTransport implements Transport {
  readonly mode = 'live' as const;
  readonly requests: HttpRequest[] = [];
  constructor(private readonly respond: Responder) {}
  async send(req: HttpRequest) { this.requests.push(req); return this.respond(req); }
}
const res = (status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse => ({ status, headers, body: JSON.stringify(body) });
const ctxWith = (transport: Transport, config: AdapterContext['config'] = { clientId: 'cid', clientSecret: 'csecret' }): AdapterContext => ({ transport, now: () => NOW, config });

const conn: PublishConnection = { id: 'c1', provider: 'x', providerAccountId: '2244994945', displayName: 'Brand', username: 'brand', metadata: {}, isMock: false };
const creds = { kind: 'oauth2' as const, accessToken: ACCESS, refreshToken: REFRESH, expiresAt: '2026-11-06T14:00:00Z', scope: 'tweet.read tweet.write users.read offline.access media.write' };
const image: PublishMedia = { assetId: 'a1', mime: 'image/png', width: 1200, height: 675, bytes: 3, url: 'https://storage.invalid/a1', load: async () => new Uint8Array([9, 8, 7]) };
function input(over: Partial<PublishInput['variant']> = {}, media: PublishMedia[] = [], connection = conn, credentials: PublishInput['credentials'] = creds): PublishInput {
  return { deliveryId: 'd1', attemptNumber: 1, idempotencyKey: 'k', connection, credentials, media,
    variant: { text: 'Hello X', link: null, format: media.length ? 'image' : 'text', buttons: [], options: {}, ...over } };
}

describe('x oauth 2.0 PKCE', () => {
  it('authorization URL carries PKCE S256, exact scopes, state and redirect', () => {
    const u = new URL(xConnector.authorizationUrl({ clientId: 'cid' }, { state: 'st4te', codeChallenge: 'chal', redirectUri: 'https://app.example/api/oauth/x/callback' }));
    expect(u.origin + u.pathname).toBe('https://x.com/i/oauth2/authorize');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: 'code', client_id: 'cid', redirect_uri: 'https://app.example/api/oauth/x/callback',
      scope: 'tweet.read tweet.write users.read offline.access media.write', state: 'st4te', code_challenge: 'chal', code_challenge_method: 'S256',
    });
    expect(xConnector.usesPkce).toBe(true);
    expect(xConnector.isConfigured({})).toBe(false);
    expect(xConnector.isConfigured({ clientId: 'cid' })).toBe(true);
  });

  it('confidential client: Basic auth, form body without client_id', async () => {
    const t = new RecordingTransport(() => res(200, { token_type: 'bearer', expires_in: 7200, access_token: ACCESS, refresh_token: REFRESH, scope: creds.scope }));
    const tokens = await xConnector.exchangeCode(ctxWith(t), { code: 'the-code', codeVerifier: 'the-verifier', redirectUri: 'https://app.example/api/oauth/x/callback' });
    const r = t.requests[0]!;
    expect(r.method).toBe('POST');
    expect(r.url).toBe('https://api.x.com/2/oauth2/token');
    expect(r.headers?.['content-type']).toBe('application/x-www-form-urlencoded');
    expect(r.headers?.authorization).toBe(`Basic ${Buffer.from('cid:csecret').toString('base64')}`);
    expect(Object.fromEntries(new URLSearchParams(r.body as string))).toEqual({
      code: 'the-code', grant_type: 'authorization_code', redirect_uri: 'https://app.example/api/oauth/x/callback', code_verifier: 'the-verifier',
    });
    expect(tokens).toEqual({ accessToken: ACCESS, refreshToken: REFRESH, expiresAt: '2026-11-06T14:00:00.000Z', scopes: creds.scope.split(' ') });
  });

  it('public client: client_id in body, no Authorization header', async () => {
    const t = new RecordingTransport(() => res(200, { access_token: ACCESS, expires_in: 7200, scope: 'tweet.read' }));
    await xConnector.exchangeCode(ctxWith(t, { clientId: 'cid' }), { code: 'c', codeVerifier: 'v', redirectUri: 'https://r' });
    expect(t.requests[0]!.headers?.authorization).toBeUndefined();
    expect(new URLSearchParams(t.requests[0]!.body as string).get('client_id')).toBe('cid');
  });

  it('refresh rotates the refresh token; failure is permanent and never echoes tokens', async () => {
    const t = new RecordingTransport(() => res(200, { access_token: 'new-acc', refresh_token: 'new-ref', expires_in: 7200, scope: creds.scope }));
    const out = await xAdapter.refreshCredentials!(ctxWith(t), creds);
    expect(Object.fromEntries(new URLSearchParams(t.requests[0]!.body as string))).toEqual({ refresh_token: REFRESH, grant_type: 'refresh_token' });
    expect(out.credentials).toMatchObject({ kind: 'oauth2', accessToken: 'new-acc', refreshToken: 'new-ref', expiresAt: '2026-11-06T14:00:00.000Z' });
    const bad = new RecordingTransport(() => res(400, { error: 'invalid_request', error_description: 'Value passed for the token was invalid.' }));
    const err = await xAdapter.refreshCredentials!(ctxWith(bad), creds).catch((e: Error & { permanent?: boolean }) => e);
    expect(err).toMatchObject({ name: 'XOAuthError', permanent: true });
    expect((err as Error).message).not.toContain(REFRESH);
  });

  it('listDestinations = the authorizing user; finalize builds oauth2 credentials with health from scopes', async () => {
    const t = new RecordingTransport(() => res(200, { data: { id: '2244994945', name: 'Brand Inc', username: 'brand', profile_image_url: 'https://pbs.twimg.com/x.jpg' } }));
    const tokens = { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: '2026-11-06T14:00:00Z', scopes: creds.scope.split(' ') };
    const [c] = await xConnector.listDestinations(ctxWith(t), tokens);
    const r = t.requests[0]!;
    expect(r.url).toBe('https://api.x.com/2/users/me?user.fields=name%2Cusername%2Cprofile_image_url');
    expect(r.headers?.authorization).toBe(`Bearer ${ACCESS}`);
    expect(c).toMatchObject({ providerAccountId: '2244994945', displayName: 'Brand Inc', username: 'brand', unavailableReason: null });
    const fin = await xConnector.finalize(ctxWith(t), tokens, c!);
    expect(fin).toMatchObject({ credentials: { kind: 'oauth2', accessToken: ACCESS, refreshToken: REFRESH, expiresAt: '2026-11-06T14:00:00Z', scope: creds.scope }, health: { status: 'ready' } });
    const partial = await xConnector.finalize(ctxWith(t), { ...tokens, scopes: ['tweet.read', 'tweet.write', 'users.read'] }, c!);
    expect(partial.health).toMatchObject({ status: 'missing_permission', missingPermissions: ['offline.access', 'media.write'] });
  });
});

describe('x media upload and post creation', () => {
  it('prepare uploads the image as multipart (media + media_category=tweet_image)', async () => {
    const t = new RecordingTransport(() => res(200, { data: { id: '1880028106020515840', media_key: '3_1880028106020515840', size: 3, expires_after_secs: 86400 } }));
    const out = await xAdapter.prepare(ctxWith(t), input({}, [image]), null);
    const r = t.requests[0]!;
    expect(r.method).toBe('POST');
    expect(r.url).toBe('https://api.x.com/2/media/upload');
    expect(r.headers?.authorization).toBe(`Bearer ${ACCESS}`);
    const f = r.body as FormData;
    expect([...f.keys()].sort()).toEqual(['media', 'media_category']);
    expect(f.get('media_category')).toBe('tweet_image');
    expect(new Uint8Array(await (f.get('media') as File).arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
    expect((f.get('media') as File).type).toBe('image/png');
    expect(out).toEqual({ kind: 'ready', checkpoint: { step: 'media_ready', data: { mediaId: '1880028106020515840', expiresAt: '2026-11-07T12:00:00.000Z' }, expiresAt: '2026-11-07T12:00:00.000Z' } });
  });

  it('processing_info => pending, then STATUS poll => ready (media id preserved)', async () => {
    const t1 = new RecordingTransport(() => res(200, { data: { id: '77', expires_after_secs: 86400, processing_info: { state: 'pending', check_after_secs: 3 } } }));
    const p = await xAdapter.prepare(ctxWith(t1), input({}, [image]), null);
    expect(p).toMatchObject({ kind: 'pending', checkAfterMs: 3000, checkpoint: { step: 'media_processing', data: { mediaId: '77' } } });
    const t2 = new RecordingTransport(() => res(200, { data: { id: '77', processing_info: { state: 'succeeded', progress_percent: 100 } } }));
    const p2 = await xAdapter.prepare(ctxWith(t2), input({}, [image]), p.kind === 'pending' ? p.checkpoint : null);
    expect(t2.requests[0]!.method).toBe('GET');
    expect(t2.requests[0]!.url).toBe('https://api.x.com/2/media/upload?command=STATUS&media_id=77');
    expect(p2).toMatchObject({ kind: 'ready', checkpoint: { step: 'media_ready', data: { mediaId: '77' } } });
    const t3 = new RecordingTransport(() => res(200, { data: { id: '77', processing_info: { state: 'failed' } } }));
    expect((await xAdapter.prepare(ctxWith(t3), input({}, [image]), p.kind === 'pending' ? p.checkpoint : null)).kind).toBe('permanent');
  });

  it('a valid ready checkpoint is reused without re-uploading; text-only needs no upload', async () => {
    const t = new RecordingTransport(() => { throw new Error('should not be called'); });
    const cp = { step: 'media_ready', data: { mediaId: '5', expiresAt: '2026-11-07T00:00:00Z' }, expiresAt: '2026-11-07T00:00:00Z' };
    expect(await xAdapter.prepare(ctxWith(t), input({}, [image]), cp)).toEqual({ kind: 'ready', checkpoint: cp });
    expect((await xAdapter.prepare(ctxWith(t), input(), null)).kind).toBe('ready');
    expect(t.requests).toHaveLength(0);
  });

  it('publish: POST /2/tweets with text (link appended) and media.media_ids', async () => {
    const t = new RecordingTransport(() => res(201, { data: { id: '1445880548472328192', text: 'x', edit_history_post_ids: ['1445880548472328192'] } }));
    const out = await xAdapter.publish(ctxWith(t), input({ text: 'Launch day', link: 'https://example.com/l' }, [image]), { step: 'media_ready', data: { mediaId: '99' } });
    const r = t.requests[0]!;
    expect(r.url).toBe('https://api.x.com/2/tweets');
    expect(r.publishes).toBe(true);
    expect(r.headers).toMatchObject({ authorization: `Bearer ${ACCESS}`, 'content-type': 'application/json' });
    expect(JSON.parse(r.body as string)).toEqual({ text: 'Launch day\n\nhttps://example.com/l', media: { media_ids: ['99'] } });
    expect(out).toEqual({ kind: 'confirmed', providerIds: ['1445880548472328192'], url: 'https://x.com/brand/status/1445880548472328192', publishedAt: NOW.toISOString() });
  });

  it('publish with media but no prepared media id sends nothing', async () => {
    const t = new RecordingTransport(() => res(201, {}));
    expect((await xAdapter.publish(ctxWith(t), input({}, [image]), null)).kind).toBe('rejected_safe_to_retry');
    expect(t.requests).toHaveLength(0);
  });
});

describe('x error classification (publish)', () => {
  const reset = String(Math.floor(NOW.getTime() / 1000) + 120);
  const cases: Array<[string, () => HttpResponse, Record<string, unknown>]> = [
    ['401 => reconnect', () => res(401, { title: 'Unauthorized', type: 'about:blank', status: 401, detail: 'Unauthorized' }), { kind: 'permanent_failure', blocking: 'reconnect' }],
    ['403 duplicate => unknown', () => res(403, { detail: 'You are not allowed to create a Tweet with duplicate content.', type: 'about:blank', title: 'Forbidden', status: 403 }), { kind: 'unknown', code: 'duplicate_content' }],
    ['402 credits => budget', () => res(402, { title: 'CreditsDepleted', detail: 'Your enrolled account does not have any credits to fulfill this request.', type: 'https://api.x.com/2/problems/credits' }), { kind: 'permanent_failure', blocking: 'budget' }],
    ['429 usage-capped => budget', () => res(429, { title: 'Usage cap exceeded', detail: 'Usage cap exceeded: Monthly product cap', type: 'https://api.x.com/2/problems/usage-capped' }), { kind: 'permanent_failure', blocking: 'budget' }],
    ['403 client-not-enrolled => permission', () => res(403, { title: 'Client Forbidden', reason: 'client-not-enrolled', type: 'https://api.x.com/2/problems/client-forbidden', detail: 'This request must be made using an approved developer account that is enrolled in the requested endpoint.' }), { kind: 'permanent_failure', blocking: 'permission', code: 'x_app_not_enrolled' }],
    ['429 => retry at x-rate-limit-reset', () => res(429, { title: 'Too Many Requests', detail: 'Too Many Requests', type: 'about:blank' }, { 'x-rate-limit-reset': reset, 'x-rate-limit-remaining': '0' }), { kind: 'rejected_safe_to_retry', code: 'rate_limited', retryAfterMs: 120_000 }],
    ['400 => permanent', () => res(400, { title: 'Invalid Request', detail: 'One or more parameters to your request was invalid.', type: 'https://api.x.com/2/problems/invalid-request' }), { kind: 'permanent_failure' }],
    ['503 => unknown', () => res(503, { title: 'Service Unavailable' }), { kind: 'unknown' }],
  ];
  it.each(cases)('%s', async (_n, respond, expected) => {
    const out = await xAdapter.publish(ctxWith(new RecordingTransport(respond)), input(), null);
    expect(out).toMatchObject(expected);
    expect(JSON.stringify(out)).not.toContain(ACCESS);
  });
  it('transport: pre-connect => safe retry; after send => unknown', async () => {
    const pre = await xAdapter.publish(ctxWith(new RecordingTransport(() => { throw new TransportError('connection failed', 'connect', false); })), input(), null);
    expect(pre.kind).toBe('rejected_safe_to_retry');
    const post = await xAdapter.publish(ctxWith(new RecordingTransport(() => { throw new TransportError('reset', 'reset', true); })), input(), null);
    expect(post.kind).toBe('unknown');
  });
  it('prepare errors: upload 5xx/timeout retryable, 401 reconnect, 402 budget', async () => {
    const p = (r: Responder) => xAdapter.prepare(ctxWith(new RecordingTransport(r)), input({}, [image]), null);
    expect((await p(() => res(500, {}))).kind).toBe('retryable');
    expect((await p(() => { throw new TransportError('t', 'timeout', true); })).kind).toBe('retryable');
    expect(await p(() => res(401, {}))).toMatchObject({ kind: 'permanent', blocking: 'reconnect' });
    expect(await p(() => res(402, {}))).toMatchObject({ kind: 'permanent', blocking: 'budget' });
  });
});

describe('x reconcile and health', () => {
  it('reconcile searches the user timeline from sentAt-10min and matches text despite t.co wrapping', async () => {
    const t = new RecordingTransport(() => res(200, { data: [
      { id: '1', text: 'Something else https://t.co/aaa' },
      { id: '2', text: 'Launch &amp; party\n\nhttps://t.co/AbC123 https://t.co/pic' },
    ], meta: { result_count: 2 } }));
    const ref = { deliveryId: 'd', connection: conn, credentials: creds, variantText: 'Launch & party\n\nhttps://example.com/l', providerIds: [], checkpoint: null, sentAt: '2026-11-06T11:50:00Z' };
    const out = await xAdapter.reconcile(ctxWith(t), ref);
    const u = new URL(t.requests[0]!.url);
    expect(u.pathname).toBe('/2/users/2244994945/tweets');
    expect(u.searchParams.get('start_time')).toBe('2026-11-06T11:40:00Z');
    expect(u.searchParams.get('exclude')).toBe('replies,retweets');
    expect(out).toMatchObject({ kind: 'published', providerIds: ['2'], url: 'https://x.com/brand/status/2' });
    const none = await xAdapter.reconcile(ctxWith(new RecordingTransport(() => res(200, { meta: { result_count: 0 } }))), ref);
    expect(none.kind).toBe('still_unknown');
    expect(normalizeForMatch('A  b\nhttps://t.co/x')).toBe('a b');
  });

  it('health: ready / reconnect on 401 / different account / missing scopes', async () => {
    const ok = new RecordingTransport(() => res(200, { data: { id: '2244994945', username: 'brand', name: 'Brand' } }));
    expect(await xAdapter.health(ctxWith(ok), conn, creds)).toMatchObject({ status: 'ready', metadata: { username: 'brand' } });
    expect((await xAdapter.health(ctxWith(new RecordingTransport(() => res(401, {}))), conn, creds)).status).toBe('reconnect_required');
    const other = new RecordingTransport(() => res(200, { data: { id: '1', username: 'someone' } }));
    expect((await xAdapter.health(ctxWith(other), conn, creds)).status).toBe('reconnect_required');
    expect(await xAdapter.health(ctxWith(ok), conn, { ...creds, scope: 'tweet.read users.read' })).toMatchObject({ status: 'missing_permission', missingPermissions: ['tweet.write', 'offline.access', 'media.write'] });
  });

  it('validates 280 weighted chars (links count 23), single JPEG/PNG up to 5 MB, no buttons', () => {
    const v = (variant: Partial<PublishInput['variant']>, media: PublishMedia[] = []) => xAdapter.validate({ connection: conn, media, variant: { text: '', link: null, format: 'text', buttons: [], options: {}, ...variant } });
    expect(v({ text: 'a'.repeat(255), link: 'https://example.com/a/very/long/path/that/still/counts/as/23' }).ok).toBe(true);
    expect(v({ text: 'a'.repeat(281) }).issues[0]?.code).toBe('too_long');
    expect(v({ text: 'x' }, [{ ...image, mime: 'image/gif' }]).issues[0]?.code).toBe('mime');
    expect(v({ text: 'x' }, [{ ...image, bytes: 6 * 1024 * 1024 }]).issues[0]?.code).toBe('too_large');
    expect(v({ text: 'x', buttons: [{ text: 'b', url: 'https://e.com' }] }).issues[0]?.code).toBe('buttons_unsupported');
  });
});

describe('x simulated API (fake) scenarios through prepare -> publish', () => {
  const mockConn = { ...conn, providerAccountId: 'mock_x_abc', isMock: true, username: null };
  async function run(scenario: MockScenario, withImage = true) {
    const store = new MemoryMockStore();
    const ctx = ctxWith(new MockTransport(xFake, { provider: 'x', accountId: 'mock_x_abc', scenario, store }), {});
    const inp = input({ text: `post ${scenario}` }, withImage ? [image] : [], mockConn, { kind: 'mock', token: 'mock-token' });
    let prep = await xAdapter.prepare(ctx, inp, null);
    let polls = 0;
    while (prep.kind === 'pending' && polls++ < 5) prep = await xAdapter.prepare(ctx, inp, prep.checkpoint);
    const cp = prep.kind === 'ready' ? prep.checkpoint : null;
    const first = await xAdapter.publish(ctx, inp, cp);
    const second = await xAdapter.publish(ctx, inp, cp);
    return { prep, polls, first, second, store, ctx, inp };
  }
  it('success', async () => {
    const r = await run('success');
    expect(r.first).toMatchObject({ kind: 'confirmed', url: null });
    expect((r.first as { providerIds: string[] }).providerIds[0]).toMatch(/^mock_/);
    expect(r.second).toMatchObject({ kind: 'unknown', code: 'duplicate_content' }); // X rejects duplicates
  });
  it('processing: pending until STATUS succeeds', async () => {
    const r = await run('processing');
    expect(r.polls).toBeGreaterThan(0);
    expect(r.prep.kind).toBe('ready');
    expect(r.first.kind).toBe('confirmed');
  });
  it('fail_permanent', async () => expect((await run('fail_permanent', false)).first.kind).toBe('permanent_failure'));
  it('fail_transient_once', async () => {
    const r = await run('fail_transient_once', false);
    expect(r.first.kind).toBe('rejected_safe_to_retry');
    expect(r.second.kind).toBe('confirmed');
  });
  it('rate_limited_once', async () => {
    const r = await run('rate_limited_once', false);
    expect(r.first).toMatchObject({ kind: 'rejected_safe_to_retry', code: 'rate_limited' });
    expect(r.second.kind).toBe('confirmed');
  });
  it('timeout_after_send => unknown, reconcile finds it', async () => {
    const r = await run('timeout_after_send', false);
    expect(r.first.kind).toBe('unknown');
    const rec = await xAdapter.reconcile(r.ctx, { deliveryId: 'd', connection: mockConn, credentials: r.inp.credentials, variantText: r.inp.variant.text, providerIds: [], checkpoint: null, sentAt: NOW.toISOString() });
    expect(rec.kind).toBe('published');
  });
  it('revoked => reconnect (and refresh fails permanently)', async () => {
    const r = await run('revoked', false);
    expect(r.prep.kind).toBe('ready');
    expect(r.first).toMatchObject({ kind: 'permanent_failure', blocking: 'reconnect' });
  });
  it('missing_permission => permission', async () => expect((await run('missing_permission', false)).first).toMatchObject({ kind: 'permanent_failure', blocking: 'permission' }));
});
