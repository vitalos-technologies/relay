// Contract tests for the Meta (Facebook Page + Instagram) adapters, connectors and simulation.
// No network: a recording Transport either replays scripted Graph responses or routes to metaFake.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  TransportError, type AdapterContext, type Checkpoint, type HttpRequest, type HttpResponse, type ProviderCredentials,
  type PublishConnection, type PublishInput, type PublishingAdapter, type Transport,
} from '@social-lite/core';
import {
  facebookAdapter, facebookConnector, instagramAdapter, instagramConnector, metaFake,
} from '../../packages/providers/src/meta/index.js';
import { MemoryMockStore, mockId, type MockScenario, type MockStore } from '../../packages/providers/src/transport/mock.js';
import { redactProviderUrl } from '../../packages/providers/src/transport/http.js';
import { DEFAULT_GRAPH_VERSION } from '../../packages/providers/src/meta/graph.js';
import { publishOutcomeFromGraphError, publishOutcomeFromTransportError, prepareOutcomeFromGraphError } from '../../packages/providers/src/meta/errors.js';
import { NO_IG_ACCOUNT_REASON, NO_POSTING_TASK_REASON } from '../../packages/providers/src/meta/connector.js';

// ------------------------------------------------------------------ harness
const PAGE_TOKEN = 'PAGE_TOKEN_SECRET_abc';
const USER_TOKEN = 'USER_TOKEN_SECRET_xyz';
const APP_SECRET = 'app-secret-123';
const V = DEFAULT_GRAPH_VERSION;

class RecordingTransport implements Transport {
  readonly mode = 'mock' as const;
  calls: HttpRequest[] = [];
  constructor(private readonly handler: (req: HttpRequest) => Promise<HttpResponse>) {}
  async send(req: HttpRequest) {
    this.calls.push(req);
    return this.handler(req);
  }
}

class Clock {
  t = new Date('2026-11-06T12:00:00.000Z').getTime();
  now = () => new Date(this.t);
  advance(ms: number) { this.t += ms; }
}

const resp = (status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse =>
  ({ status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

function scripted(responses: Array<HttpResponse | Error>): RecordingTransport {
  let i = 0;
  return new RecordingTransport(async () => {
    const r = responses[Math.min(i++, responses.length - 1)]!;
    if (r instanceof Error) throw r;
    return r;
  });
}

interface Sim { transport: RecordingTransport; ctx: AdapterContext; clock: Clock; store: MockStore }

function sim(provider: 'facebook' | 'instagram', scenario: MockScenario, store: MockStore = new MemoryMockStore(), clock = new Clock(), accountId = provider === 'facebook' ? 'mock_page1' : 'mock_ig1'): Sim {
  const transport = new RecordingTransport((req) => metaFake(req, { provider, accountId, scenario, store, now: clock.now, newId: mockId }));
  return { transport, clock, store, ctx: { transport, now: clock.now, config: { clientId: 'app123', clientSecret: APP_SECRET } } };
}

function ctxWith(transport: Transport, config: AdapterContext['config'] = { clientId: 'app123', clientSecret: APP_SECRET }, clock = new Clock()): AdapterContext {
  return { transport, now: clock.now, config };
}

const creds: ProviderCredentials = { kind: 'meta_page', pageAccessToken: PAGE_TOKEN, userAccessToken: USER_TOKEN, userTokenExpiresAt: null };

function conn(provider: 'facebook' | 'instagram', accountId = provider === 'facebook' ? 'mock_page1' : 'mock_ig1'): PublishConnection {
  return { id: `conn-${provider}`, provider, providerAccountId: accountId, displayName: 'Sim', metadata: {}, isMock: true };
}

const jpeg = (over: Partial<PublishInput['media'][number]> = {}): PublishInput['media'][number] => ({
  assetId: 'asset-1', mime: 'image/jpeg', width: 1080, height: 1350, bytes: 400_000,
  url: 'https://storage.example.com/signed/asset-1.jpg?sig=abc', load: async () => new Uint8Array(), ...over,
});

function input(provider: 'facebook' | 'instagram', over: Partial<PublishInput['variant']> = {}, media: PublishInput['media'] = provider === 'instagram' ? [jpeg()] : []): PublishInput {
  return {
    deliveryId: 'd1', attemptNumber: 1, idempotencyKey: 'k1', connection: conn(provider), credentials: creds,
    variant: { text: 'Hello from Social Lite #launch', link: null, format: media.length ? 'image' : 'text', buttons: [], options: {}, ...over },
    media,
  };
}

const bodyParams = (r: HttpRequest) => new URLSearchParams(typeof r.body === 'string' ? r.body : '');
const urlOf = (r: HttpRequest) => new URL(r.url);
const proof = (token: string) => createHmac('sha256', APP_SECRET).update(token).digest('hex');

/** Drive prepare to ready, advancing the clock by checkAfterMs between polls. */
async function prepareUntilReady(adapter: PublishingAdapter, s: Sim, inp: PublishInput, start: Checkpoint | null = null) {
  let cp = start;
  const outcomes: string[] = [];
  for (let i = 0; i < 10; i++) {
    const o = await adapter.prepare(s.ctx, inp, cp);
    outcomes.push(o.kind);
    if (o.kind === 'ready') return { cp: o.checkpoint, outcomes, last: o };
    if (o.kind === 'pending') { cp = o.checkpoint; s.clock.advance(o.checkAfterMs); continue; }
    return { cp, outcomes, last: o };
  }
  throw new Error('prepare did not settle');
}

// ------------------------------------------------------------------ outgoing request shapes
describe('Graph request shapes', () => {
  it('Facebook text post: POST /<ver>/<page>/feed with message+link, token+proof in urlencoded body', async () => {
    const t = scripted([resp(200, { id: '111_222' })]);
    const out = await facebookAdapter.publish(ctxWith(t), input('facebook', { link: 'https://example.com/a' }), null);
    expect(out).toMatchObject({ kind: 'confirmed', providerIds: ['111_222'], url: 'https://www.facebook.com/111_222' });
    const [r] = t.calls;
    expect(r!.method).toBe('POST');
    expect(urlOf(r!).origin + urlOf(r!).pathname).toBe(`https://graph.facebook.com/${V}/mock_page1/feed`);
    expect(urlOf(r!).search).toBe('');
    expect(r!.headers?.['content-type']).toBe('application/x-www-form-urlencoded');
    const b = bodyParams(r!);
    expect(b.get('message')).toBe('Hello from Social Lite #launch');
    expect(b.get('link')).toBe('https://example.com/a');
    expect(b.get('access_token')).toBe(PAGE_TOKEN);
    expect(b.get('appsecret_proof')).toBe(proof(PAGE_TOKEN));
    expect(r!.op).toBe('meta.facebook.feed');
    expect(r!.publishes).toBe(true);
    expect(r!.url).not.toContain(PAGE_TOKEN);
  });

  it('Facebook image post: POST /photos with url + caption (link appended), published=true, no deprecated message', async () => {
    const t = scripted([resp(200, { id: '999', post_id: '111_999' })]);
    const out = await facebookAdapter.publish(ctxWith(t), input('facebook', { link: 'https://example.com/a' }, [jpeg()]), null);
    expect(out).toMatchObject({ kind: 'confirmed', providerIds: ['111_999', '999'], url: 'https://www.facebook.com/111_999' });
    const r = t.calls[0]!;
    expect(urlOf(r).pathname).toBe(`/${V}/mock_page1/photos`);
    const b = bodyParams(r);
    expect(b.get('url')).toBe(jpeg().url);
    expect(b.get('caption')).toBe('Hello from Social Lite #launch\n\nhttps://example.com/a');
    expect(b.get('published')).toBe('true');
    expect(b.has('message')).toBe(false);
    expect(r.op).toBe('meta.facebook.photos');
    expect(r.publishes).toBe(true);
  });

  it('uses config.apiVersion when valid, the pinned default otherwise, and omits appsecret_proof without a secret', async () => {
    const t1 = scripted([resp(200, { id: '1_2' })]);
    await facebookAdapter.publish(ctxWith(t1, { clientId: 'a', clientSecret: 's', apiVersion: 'v25.0' }), input('facebook'), null);
    expect(urlOf(t1.calls[0]!).pathname.startsWith('/v25.0/')).toBe(true);
    const t2 = scripted([resp(200, { id: '1_2' })]);
    await facebookAdapter.publish(ctxWith(t2, { clientId: 'a', apiVersion: '../evil' }), input('facebook'), null);
    expect(urlOf(t2.calls[0]!).pathname.startsWith(`/${V}/`)).toBe(true);
    expect(bodyParams(t2.calls[0]!).has('appsecret_proof')).toBe(false);
  });

  it('Instagram prepare + publish: container create, status poll, quota check, media_publish, permalink lookup', async () => {
    const s = sim('instagram', 'success');
    const inp = input('instagram');
    const prep = await instagramAdapter.prepare(s.ctx, inp, null);
    expect(prep.kind).toBe('ready');
    const [create, poll] = s.transport.calls;
    expect(create!.method).toBe('POST');
    expect(urlOf(create!).pathname).toBe(`/${V}/mock_ig1/media`);
    expect(bodyParams(create!).get('image_url')).toBe(jpeg().url);
    expect(bodyParams(create!).get('caption')).toBe(inp.variant.text);
    expect(bodyParams(create!).get('access_token')).toBe(PAGE_TOKEN);
    expect(create!.op).toBe('meta.instagram.media_create');
    expect(create!.publishes).toBeFalsy();
    expect(poll!.method).toBe('GET');
    expect(urlOf(poll!).searchParams.get('fields')).toBe('status_code,status');
    expect(poll!.op).toBe('meta.instagram.container_status');
    // GET requests carry the token in the query (documented Graph form) — logs must redact it.
    expect(poll!.url).toContain(PAGE_TOKEN);
    expect(redactProviderUrl(poll!.url)).not.toContain(PAGE_TOKEN);
    expect(redactProviderUrl(poll!.url)).not.toContain(proof(PAGE_TOKEN));

    s.transport.calls = [];
    if (prep.kind !== 'ready') throw new Error('unreachable');
    const out = await instagramAdapter.publish(s.ctx, inp, prep.checkpoint);
    expect(out.kind).toBe('confirmed');
    const ops = s.transport.calls.map((c) => c.op);
    expect(ops).toEqual(['meta.instagram.publishing_limit', 'meta.instagram.media_publish', 'meta.instagram.media_lookup']);
    const pub = s.transport.calls[1]!;
    expect(pub.method).toBe('POST');
    expect(urlOf(pub).pathname).toBe(`/${V}/mock_ig1/media_publish`);
    expect(bodyParams(pub).get('creation_id')).toBe((prep.checkpoint.data as { containerId: string }).containerId);
    expect(pub.publishes).toBe(true);
    expect(s.transport.calls.filter((c) => c.publishes).length).toBe(1);
    if (out.kind === 'confirmed') {
      expect(out.providerIds[0]).toMatch(/^mock_/);
      expect(out.url).toMatch(/^https:\/\/www\.instagram\.com\/p\//);
    }
  });

  it('every request carries a meta.* op label and only final publish calls set publishes', async () => {
    const s = sim('instagram', 'success');
    const { cp } = await prepareUntilReady(instagramAdapter, s, input('instagram'));
    await instagramAdapter.publish(s.ctx, input('instagram'), cp);
    await instagramAdapter.health(s.ctx, conn('instagram'), creds);
    for (const c of s.transport.calls) {
      expect(c.op).toMatch(/^meta\./);
      expect(Boolean(c.publishes)).toBe(c.op === 'meta.instagram.media_publish');
    }
  });
});

// ------------------------------------------------------------------ error normalisation
describe('Graph error normalisation', () => {
  const RAW = 'RAW provider text with access_token=LEAK';
  const ge = (code: number | null, subcode: number | null = null, isTransient = false, httpStatus = 400) =>
    ({ httpStatus, code, subcode, type: 'OAuthException', isTransient, rawMessage: RAW, fbtraceId: 'x' });

  const table: Array<[string, ReturnType<typeof ge>, Record<string, string>, Record<string, unknown>]> = [
    ['190 expired token', ge(190, 463), {}, { kind: 'permanent_failure', code: 'token_invalid', blocking: 'reconnect' }],
    ['190 password changed', ge(190, 460), {}, { kind: 'permanent_failure', blocking: 'reconnect' }],
    ['102 session', ge(102), {}, { kind: 'permanent_failure', blocking: 'reconnect' }],
    ['10 permission denied', ge(10), {}, { kind: 'permanent_failure', code: 'permission_denied', blocking: 'permission' }],
    ['200 permission', ge(200, null, false, 403), {}, { kind: 'permanent_failure', blocking: 'permission' }],
    ['299 permission', ge(299), {}, { kind: 'permanent_failure', blocking: 'permission' }],
    ['492 page role', ge(190, 492), {}, { kind: 'permanent_failure', code: 'page_role_missing', blocking: 'permission' }],
    ['4 app limit', ge(4), {}, { kind: 'rejected_safe_to_retry', code: 'rate_limited', retryAfterMs: 15 * 60_000 }],
    ['17 user limit', ge(17), {}, { kind: 'rejected_safe_to_retry', retryAfterMs: 15 * 60_000 }],
    ['32 pages limit', ge(32), {}, { kind: 'rejected_safe_to_retry' }],
    ['613 custom limit', ge(613), {}, { kind: 'rejected_safe_to_retry' }],
    ['80001 BUC header', ge(80001), { 'X-Business-Use-Case-Usage': JSON.stringify({ '1': [{ type: 'pages', estimated_time_to_regain_access: 7 }] }) }, { kind: 'rejected_safe_to_retry', retryAfterMs: 7 * 60_000 }],
    ['80002 IG BUC', ge(80002), {}, { kind: 'rejected_safe_to_retry' }],
    ['IG daily limit 9/2207042', ge(9, 2207042), {}, { kind: 'rejected_safe_to_retry', code: 'ig_publish_limit' }],
    ['1 transient', ge(1, null, true, 500), {}, { kind: 'rejected_safe_to_retry', code: 'provider_transient' }],
    ['2 transient', ge(2, null, true, 503), {}, { kind: 'rejected_safe_to_retry', code: 'provider_transient' }],
    ['2 without is_transient on publish', ge(2, null, false, 500), {}, { kind: 'unknown', code: 'provider_unavailable' }],
    ['bare 500', ge(null, null, false, 500), {}, { kind: 'unknown' }],
    ['506 duplicate', ge(506), {}, { kind: 'unknown', code: 'duplicate_post' }],
    ['100 invalid', ge(100), {}, { kind: 'permanent_failure', code: 'invalid_request' }],
    ['100/33 inaccessible', ge(100, 33), {}, { kind: 'permanent_failure', code: 'object_inaccessible', blocking: 'permission' }],
    ['368 policy', ge(368), {}, { kind: 'permanent_failure', code: 'policy_block' }],
    ['1609005 link', ge(1609005), {}, { kind: 'permanent_failure', code: 'link_unreachable' }],
    ['IG aspect 36003/2207009', ge(36003, 2207009), {}, { kind: 'permanent_failure', code: 'aspect_ratio' }],
    ['IG aspect code only', ge(36003), {}, { kind: 'permanent_failure', code: 'aspect_ratio' }],
    ['IG caption 2207010', ge(36004, 2207010), {}, { kind: 'permanent_failure', code: 'caption_too_long' }],
    ['IG not ready 9007', ge(9007, 2207027), {}, { kind: 'rejected_safe_to_retry', code: 'ig_media_not_ready' }],
    ['IG container expired 24/2207008', ge(24, 2207008), {}, { kind: 'rejected_safe_to_retry', code: 'ig_container_expired' }],
    ['IG spam 4/2207051', ge(4, 2207051), {}, { kind: 'permanent_failure', code: 'ig_spam_flagged' }],
    ['IG restricted 25/2207050', ge(25, 2207050), {}, { kind: 'permanent_failure', blocking: 'permission' }],
    ['IG fetch failed 9004', ge(9004, 2207052), {}, { kind: 'permanent_failure', code: 'image_fetch_failed' }],
  ];

  it.each(table)('%s', (_name, err, headers, expected) => {
    const out = publishOutcomeFromGraphError(err, headers);
    expect(out).toMatchObject(expected);
    expect(JSON.stringify(out)).not.toContain('RAW');
    expect(JSON.stringify(out)).not.toContain('LEAK');
  });

  it('non-publish calls: rate limits and server errors are retryable, invalid content permanent', () => {
    expect(prepareOutcomeFromGraphError(ge(80002))).toMatchObject({ kind: 'retryable' });
    expect(prepareOutcomeFromGraphError(ge(null, null, false, 502))).toMatchObject({ kind: 'retryable' });
    expect(prepareOutcomeFromGraphError(ge(36003, 2207009))).toMatchObject({ kind: 'permanent', code: 'aspect_ratio' });
    expect(prepareOutcomeFromGraphError(ge(190))).toMatchObject({ kind: 'permanent', blocking: 'reconnect' });
  });

  it('TransportError: maybe-sent publish ⇒ unknown; pre-connect ⇒ safe retry', () => {
    expect(publishOutcomeFromTransportError(new TransportError('t', 'timeout', true))).toMatchObject({ kind: 'unknown', code: 'response_lost' });
    expect(publishOutcomeFromTransportError(new TransportError('c', 'connect', false))).toMatchObject({ kind: 'rejected_safe_to_retry' });
  });

  it('adapters apply the TransportError policy on real calls', async () => {
    const lost = scripted([new TransportError('reset', 'reset', true)]);
    expect(await facebookAdapter.publish(ctxWith(lost), input('facebook'), null)).toMatchObject({ kind: 'unknown' });
    const refused = scripted([new TransportError('refused', 'connect', false)]);
    expect(await facebookAdapter.publish(ctxWith(refused), input('facebook'), null)).toMatchObject({ kind: 'rejected_safe_to_retry' });
    // container creation creates nothing visible: even a maybe-sent failure is retryable
    const igLost = scripted([new TransportError('t', 'timeout', true)]);
    expect(await instagramAdapter.prepare(ctxWith(igLost), input('instagram'), null)).toMatchObject({ kind: 'retryable' });
    // media_publish lost ⇒ unknown
    const igPub = scripted([resp(200, { data: [{ quota_usage: 0, config: { quota_total: 50 } }] }), new TransportError('t', 'timeout', true)]);
    const cp: Checkpoint = { step: 'container_ready', data: { containerId: 'c1', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), polls: 1 } };
    expect(await instagramAdapter.publish(ctxWith(igPub), input('instagram'), cp)).toMatchObject({ kind: 'unknown', code: 'response_lost' });
  });
});

// ------------------------------------------------------------------ full flows against metaFake
describe('Facebook flows (metaFake)', () => {
  it('success: text and image', async () => {
    const s = sim('facebook', 'success');
    const r = await prepareUntilReady(facebookAdapter, s, input('facebook'));
    expect(r.last.kind).toBe('ready');
    const out = await facebookAdapter.publish(s.ctx, input('facebook'), r.cp);
    expect(out).toMatchObject({ kind: 'confirmed' });
    if (out.kind === 'confirmed') expect(out.providerIds[0]).toMatch(/^mock_page1_/);
    const img = await facebookAdapter.publish(s.ctx, input('facebook', {}, [jpeg()]), null);
    expect(img.kind).toBe('confirmed');
    if (img.kind === 'confirmed') expect(img.providerIds.every((id) => id.startsWith('mock_'))).toBe(true);
  });

  it('fail_permanent ⇒ permanent_failure, no retry', async () => {
    const s = sim('facebook', 'fail_permanent');
    expect(await facebookAdapter.publish(s.ctx, input('facebook'), null)).toMatchObject({ kind: 'permanent_failure', code: 'invalid_request' });
  });

  it('fail_transient_once ⇒ safe retry, then confirmed', async () => {
    const s = sim('facebook', 'fail_transient_once');
    expect(await facebookAdapter.publish(s.ctx, input('facebook'), null)).toMatchObject({ kind: 'rejected_safe_to_retry', code: 'provider_transient' });
    expect(await facebookAdapter.publish(s.ctx, input('facebook'), null)).toMatchObject({ kind: 'confirmed' });
  });

  it('rate_limited_once ⇒ retry after X-Business-Use-Case-Usage time, then confirmed', async () => {
    const s = sim('facebook', 'rate_limited_once');
    expect(await facebookAdapter.publish(s.ctx, input('facebook'), null)).toMatchObject({ kind: 'rejected_safe_to_retry', code: 'rate_limited', retryAfterMs: 120_000 });
    expect(await facebookAdapter.publish(s.ctx, input('facebook'), null)).toMatchObject({ kind: 'confirmed' });
  });

  it('timeout_after_send ⇒ unknown; reconcile after a restart finds the post', async () => {
    const store = new MemoryMockStore();
    const s = sim('facebook', 'timeout_after_send', store);
    const sentAt = s.clock.now().toISOString();
    const out = await facebookAdapter.publish(s.ctx, input('facebook', { link: 'https://example.com/x' }, [jpeg()]), null);
    expect(out).toMatchObject({ kind: 'unknown', code: 'response_lost' });
    const [stored] = await store.list('facebook', 'mock_page1', 'post');
    // new transport + context (worker restart), same durable store
    const s2 = sim('facebook', 'timeout_after_send', store, s.clock);
    s2.clock.advance(60_000);
    const rec = await facebookAdapter.reconcile(s2.ctx, { deliveryId: 'd1', connection: conn('facebook'), credentials: creds, variantText: input('facebook').variant.text, providerIds: [], checkpoint: null, sentAt });
    expect(rec).toMatchObject({ kind: 'published', providerIds: [stored!.objectId] });
    expect(s2.transport.calls.some((c) => c.publishes)).toBe(false);
    const q = urlOf(s2.transport.calls.at(-1)!);
    expect(q.pathname).toBe(`/${V}/mock_page1/published_posts`);
    expect(Number(q.searchParams.get('since'))).toBe(Math.floor((Date.parse(sentAt) - 10 * 60_000) / 1000));
  });

  it('reconcile with no match ⇒ still_unknown (never not_published)', async () => {
    const s = sim('facebook', 'success');
    const rec = await facebookAdapter.reconcile(s.ctx, { deliveryId: 'd1', connection: conn('facebook'), credentials: creds, variantText: 'never posted', providerIds: [], checkpoint: null, sentAt: s.clock.now().toISOString() });
    expect(rec.kind).toBe('still_unknown');
  });

  it('processing scenario does not affect Facebook', async () => {
    const s = sim('facebook', 'processing');
    expect(await facebookAdapter.publish(s.ctx, input('facebook'), null)).toMatchObject({ kind: 'confirmed' });
  });

  it('revoked ⇒ reconnect block; health reconnect_required', async () => {
    const s = sim('facebook', 'revoked');
    expect(await facebookAdapter.publish(s.ctx, input('facebook'), null)).toMatchObject({ kind: 'permanent_failure', blocking: 'reconnect' });
    expect(await facebookAdapter.health(s.ctx, conn('facebook'), creds)).toMatchObject({ status: 'reconnect_required' });
  });

  it('missing_permission ⇒ permission block; health lists the missing scope', async () => {
    const s = sim('facebook', 'missing_permission');
    expect(await facebookAdapter.publish(s.ctx, input('facebook'), null)).toMatchObject({ kind: 'permanent_failure', blocking: 'permission' });
    const h = await facebookAdapter.health(s.ctx, conn('facebook'), creds);
    expect(h).toMatchObject({ status: 'missing_permission', missingPermissions: ['pages_manage_posts'] });
    const permCall = s.transport.calls.find((c) => c.op === 'meta.permissions')!;
    expect(urlOf(permCall).searchParams.get('access_token')).toBe(USER_TOKEN);
  });

  it('health ready for a good connection', async () => {
    const s = sim('facebook', 'success');
    expect(await facebookAdapter.health(s.ctx, conn('facebook'), creds)).toMatchObject({ status: 'ready', metadata: { page_name: 'Simulated Page' } });
  });
});

describe('Instagram flows (metaFake)', () => {
  it('success', async () => {
    const s = sim('instagram', 'success');
    const r = await prepareUntilReady(instagramAdapter, s, input('instagram'));
    expect(r.outcomes).toEqual(['ready']);
    expect(r.cp?.expiresAt).toBe(new Date(s.clock.t + 24 * 3_600_000).toISOString());
    expect(await instagramAdapter.publish(s.ctx, input('instagram'), r.cp)).toMatchObject({ kind: 'confirmed' });
  });

  it('processing ⇒ pending for two polls (5–10s), then ready and confirmed', async () => {
    const s = sim('instagram', 'processing');
    const first = await instagramAdapter.prepare(s.ctx, input('instagram'), null);
    expect(first).toMatchObject({ kind: 'pending' });
    if (first.kind === 'pending') {
      expect(first.checkAfterMs).toBeGreaterThanOrEqual(5_000);
      expect(first.checkAfterMs).toBeLessThanOrEqual(10_000);
      expect(first.checkpoint.data.containerId).toMatch(/^mock_/);
    }
    const r = await prepareUntilReady(instagramAdapter, s, input('instagram'), first.kind === 'pending' ? first.checkpoint : null);
    expect(r.outcomes).toEqual(['pending', 'ready']);
    expect(s.transport.calls.filter((c) => c.op === 'meta.instagram.media_create')).toHaveLength(1);
    expect(await instagramAdapter.publish(s.ctx, input('instagram'), r.cp)).toMatchObject({ kind: 'confirmed' });
  });

  it('fail_permanent ⇒ permanent at prepare with exact fix', async () => {
    const s = sim('instagram', 'fail_permanent');
    const o = await instagramAdapter.prepare(s.ctx, input('instagram'), null);
    expect(o).toMatchObject({ kind: 'permanent', code: 'aspect_ratio' });
    if (o.kind === 'permanent') expect(o.message).toContain('4:5');
  });

  it('fail_transient_once ⇒ safe retry, then confirmed', async () => {
    const s = sim('instagram', 'fail_transient_once');
    const { cp } = await prepareUntilReady(instagramAdapter, s, input('instagram'));
    expect(await instagramAdapter.publish(s.ctx, input('instagram'), cp)).toMatchObject({ kind: 'rejected_safe_to_retry' });
    const again = await prepareUntilReady(instagramAdapter, s, input('instagram'), cp);
    expect(again.cp?.data.containerId).toBe(cp?.data.containerId); // container reused
    expect(await instagramAdapter.publish(s.ctx, input('instagram'), again.cp)).toMatchObject({ kind: 'confirmed' });
  });

  it('rate_limited_once ⇒ retry after header time, then confirmed', async () => {
    const s = sim('instagram', 'rate_limited_once');
    const { cp } = await prepareUntilReady(instagramAdapter, s, input('instagram'));
    expect(await instagramAdapter.publish(s.ctx, input('instagram'), cp)).toMatchObject({ kind: 'rejected_safe_to_retry', retryAfterMs: 120_000 });
    expect(await instagramAdapter.publish(s.ctx, input('instagram'), cp)).toMatchObject({ kind: 'confirmed' });
  });

  it('timeout_after_send ⇒ unknown; reconcile finds the media; re-prepare never republishes', async () => {
    const store = new MemoryMockStore();
    const s = sim('instagram', 'timeout_after_send', store);
    const { cp } = await prepareUntilReady(instagramAdapter, s, input('instagram'));
    const sentAt = s.clock.now().toISOString();
    expect(await instagramAdapter.publish(s.ctx, input('instagram'), cp)).toMatchObject({ kind: 'unknown', code: 'response_lost' });
    const [media] = await store.list('instagram', 'mock_ig1', 'media');

    const s2 = sim('instagram', 'timeout_after_send', store, s.clock);
    const rec = await instagramAdapter.reconcile(s2.ctx, { deliveryId: 'd1', connection: conn('instagram'), credentials: creds, variantText: input('instagram').variant.text, providerIds: [], checkpoint: cp, sentAt });
    expect(rec).toMatchObject({ kind: 'published', providerIds: [media!.objectId] });
    expect(s2.transport.calls.some((c) => c.publishes)).toBe(false);

    // If the engine re-enters prepare with the same checkpoint, the PUBLISHED container is detected
    // and publish resolves the existing media instead of calling media_publish again.
    s2.transport.calls = [];
    const again = await prepareUntilReady(instagramAdapter, s2, input('instagram'), cp);
    expect(again.cp?.step).toBe('container_published');
    const out = await instagramAdapter.publish(s2.ctx, input('instagram'), again.cp);
    expect(out).toMatchObject({ kind: 'confirmed', providerIds: [media!.objectId] });
    expect(s2.transport.calls.some((c) => c.op === 'meta.instagram.media_publish' || c.op === 'meta.instagram.media_create')).toBe(false);
  });

  it('container expiry: past expiresAt or EXPIRED status ⇒ a fresh container is created', async () => {
    const s = sim('instagram', 'success');
    const { cp } = await prepareUntilReady(instagramAdapter, s, input('instagram'));
    const oldId = cp!.data.containerId;
    s.clock.advance(25 * 3_600_000);
    const r1 = await instagramAdapter.prepare(s.ctx, input('instagram'), cp);
    expect(r1.kind).toBe('ready');
    if (r1.kind === 'ready') expect(r1.checkpoint.data.containerId).not.toBe(oldId);

    // Checkpoint claims a future expiry, but the provider reports EXPIRED.
    const s2 = sim('instagram', 'success');
    const { cp: cp2 } = await prepareUntilReady(instagramAdapter, s2, input('instagram'));
    s2.clock.advance(25 * 3_600_000);
    const lying: Checkpoint = { ...cp2!, data: { ...cp2!.data, expiresAt: new Date(s2.clock.t + 3_600_000).toISOString() } };
    const r2 = await instagramAdapter.prepare(s2.ctx, input('instagram'), lying);
    expect(r2.kind).toBe('ready');
    if (r2.kind === 'ready') expect(r2.checkpoint.data.containerId).not.toBe(cp2!.data.containerId);
    expect(s2.transport.calls.filter((c) => c.op === 'meta.instagram.media_create')).toHaveLength(2);
  });

  it('reconcile: EXPIRED container and no media ⇒ not_published', async () => {
    const s = sim('instagram', 'success');
    const { cp } = await prepareUntilReady(instagramAdapter, s, input('instagram'));
    const sentAt = s.clock.now().toISOString();
    s.clock.advance(25 * 3_600_000);
    const rec = await instagramAdapter.reconcile(s.ctx, { deliveryId: 'd1', connection: conn('instagram'), credentials: creds, variantText: input('instagram').variant.text, providerIds: [], checkpoint: cp, sentAt });
    expect(rec.kind).toBe('not_published');
  });

  it('reconcile: FINISHED container shortly after send ⇒ still_unknown', async () => {
    const s = sim('instagram', 'success');
    const { cp } = await prepareUntilReady(instagramAdapter, s, input('instagram'));
    const rec = await instagramAdapter.reconcile(s.ctx, { deliveryId: 'd1', connection: conn('instagram'), credentials: creds, variantText: input('instagram').variant.text, providerIds: [], checkpoint: cp, sentAt: s.clock.now().toISOString() });
    expect(rec.kind).toBe('still_unknown');
  });

  it('revoked ⇒ reconnect block at prepare; health reconnect_required', async () => {
    const s = sim('instagram', 'revoked');
    expect(await instagramAdapter.prepare(s.ctx, input('instagram'), null)).toMatchObject({ kind: 'permanent', blocking: 'reconnect' });
    expect(await instagramAdapter.health(s.ctx, conn('instagram'), creds)).toMatchObject({ status: 'reconnect_required' });
  });

  it('missing_permission ⇒ permission block; health lists instagram_content_publish', async () => {
    const s = sim('instagram', 'missing_permission');
    expect(await instagramAdapter.prepare(s.ctx, input('instagram'), null)).toMatchObject({ kind: 'permanent', blocking: 'permission' });
    expect(await instagramAdapter.health(s.ctx, conn('instagram'), creds)).toMatchObject({ status: 'missing_permission', missingPermissions: ['instagram_content_publish'] });
  });

  it('exhausted content_publishing_limit ⇒ rate_limit block without calling media_publish', async () => {
    const t = scripted([resp(200, { data: [{ quota_usage: 50, config: { quota_total: 50, quota_duration: 86400 } }] })]);
    const cp: Checkpoint = { step: 'container_ready', data: { containerId: 'c1', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), polls: 1 } };
    expect(await instagramAdapter.publish(ctxWith(t), input('instagram'), cp)).toMatchObject({ kind: 'permanent_failure', blocking: 'rate_limit', code: 'ig_publish_limit' });
    expect(t.calls.some((c) => c.publishes)).toBe(false);
  });

  it('fake validates like the API: missing image_url ⇒ error 100', async () => {
    const store = new MemoryMockStore();
    const res = await metaFake({ method: 'POST', url: `https://graph.facebook.com/${V}/mock_ig1/media`, body: 'caption=x&access_token=t', op: 'test' },
      { provider: 'instagram', accountId: 'mock_ig1', scenario: 'success', store, now: () => new Date(), newId: mockId });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe(100);
  });
});

// ------------------------------------------------------------------ validation
describe('validation', () => {
  it('Instagram: link is flagged (not clickable), never silently dropped; PNG and missing media rejected', () => {
    const withLink = instagramAdapter.validate(input('instagram', { link: 'https://example.com' }));
    expect(withLink.ok).toBe(false);
    expect(withLink.issues.map((i) => i.code)).toContain('link_unsupported');
    expect(instagramAdapter.validate(input('instagram', {}, [jpeg({ mime: 'image/png' })])).issues.map((i) => i.code)).toContain('mime');
    expect(instagramAdapter.validate(input('instagram', {}, [])).issues.map((i) => i.code)).toContain('media_required');
    expect(instagramAdapter.validate(input('instagram', {}, [jpeg({ width: 1000, height: 1400 })])).issues.map((i) => i.code)).toContain('aspect');
    expect(instagramAdapter.validate(input('instagram', { text: Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ') })).issues.map((i) => i.code)).toContain('too_many_hashtags');
  });

  it('Instagram prepare refuses an invalid variant before any request', async () => {
    const t = scripted([resp(200, {})]);
    const o = await instagramAdapter.prepare(ctxWith(t), input('instagram', { link: 'https://example.com' }), null);
    expect(o).toMatchObject({ kind: 'permanent', code: 'invalid_content' });
    expect(t.calls).toHaveLength(0);
  });

  it('Facebook: link is a separate field for text posts; capabilities describe text+image', () => {
    const long = 'a'.repeat(9_990);
    expect(facebookAdapter.validate(input('facebook', { text: long, link: 'https://example.com/a-long-link-path' })).ok).toBe(true);
    expect(facebookAdapter.validate(input('facebook', { text: long, link: 'https://example.com/a-long-link-path' }, [jpeg()])).ok).toBe(false);
    const caps = facebookAdapter.capabilities(conn('facebook'));
    expect(caps.formats).toEqual(['text', 'image', 'album', 'video']); // V1.1: album + video (tests/contracts/meta-media.test.ts)
    expect(caps.constraints.textCounting).toBe('codepoints');
    expect(instagramAdapter.capabilities(conn('instagram')).constraints).toMatchObject({ requiresMedia: true, imageMimes: ['image/jpeg'], supportsLink: false, maxCaptionLength: 2200 });
  });
});

// ------------------------------------------------------------------ OAuth connectors
describe('connectors', () => {
  const config = { clientId: 'app123', clientSecret: APP_SECRET, redirectUri: 'https://app.example.com/api/oauth/facebook/callback' };

  it('isConfigured needs client id and secret; PKCE not used', () => {
    expect(facebookConnector.isConfigured({ clientId: 'a', clientSecret: 'b' })).toBe(true);
    expect(instagramConnector.isConfigured({ clientId: 'a' })).toBe(false);
    expect(facebookConnector.usesPkce).toBe(false);
  });

  it('authorization URL: versioned dialog with client_id, redirect_uri, state, scope, response_type=code', () => {
    const u = new URL(instagramConnector.authorizationUrl(config, { state: 'st8', redirectUri: 'https://app.example.com/api/oauth/instagram/callback' }));
    expect(u.origin + u.pathname).toBe(`https://www.facebook.com/${V}/dialog/oauth`);
    expect(u.searchParams.get('client_id')).toBe('app123');
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/oauth/instagram/callback');
    expect(u.searchParams.get('state')).toBe('st8');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('scope')!.split(',')).toEqual(['pages_show_list', 'pages_read_engagement', 'instagram_basic', 'instagram_content_publish']);
    expect(u.toString()).not.toContain(APP_SECRET);
    const f = new URL(facebookConnector.authorizationUrl(config, { state: 's', redirectUri: config.redirectUri }));
    expect(f.searchParams.get('scope')).toBe('pages_show_list,pages_read_engagement,pages_manage_posts');
  });

  it('exchangeCode: code ⇒ short-lived ⇒ long-lived (fb_exchange_token) ⇒ granted permissions only', async () => {
    const s = sim('facebook', 'missing_permission');
    s.ctx.config = config;
    const tokens = await facebookConnector.exchangeCode(s.ctx, { code: 'CODE123', redirectUri: config.redirectUri });
    const [c1, c2, c3] = s.transport.calls;
    expect(c1!.method).toBe('GET');
    expect(urlOf(c1!).pathname).toBe(`/${V}/oauth/access_token`);
    expect(Object.fromEntries(urlOf(c1!).searchParams)).toEqual({ client_id: 'app123', redirect_uri: config.redirectUri, client_secret: APP_SECRET, code: 'CODE123' });
    expect(c1!.op).toBe('meta.oauth.exchange_code');
    expect(urlOf(c2!).searchParams.get('grant_type')).toBe('fb_exchange_token');
    expect(urlOf(c2!).searchParams.get('fb_exchange_token')).toMatch(/^mock_short_user_token_/);
    expect(c2!.op).toBe('meta.oauth.long_lived');
    for (const c of [c1!, c2!]) {
      const red = redactProviderUrl(c.url);
      expect(red).not.toContain(APP_SECRET);
      expect(red).not.toContain('CODE123');
      expect(red).not.toContain('mock_short_user_token_');
    }
    expect(urlOf(c3!).pathname).toBe(`/${V}/me/permissions`);
    expect(tokens.accessToken).toMatch(/^mock_long_user_token_/);
    expect(tokens.expiresAt).toBe(new Date(s.clock.t + 5_183_944_000).toISOString());
    expect(tokens.scopes).toContain('pages_show_list');
    expect(tokens.scopes).not.toContain('pages_manage_posts'); // declined ⇒ not granted
  });

  it('listDestinations (Facebook): Pages with unavailable reason when tasks lack CREATE_CONTENT/MANAGE', async () => {
    const s = sim('facebook', 'success');
    const list = await facebookConnector.listDestinations(s.ctx, { accessToken: USER_TOKEN, scopes: [] });
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ provider: 'facebook', providerAccountId: 'mock_page1', displayName: 'Simulated Page', unavailableReason: null });
    expect(list[1]).toMatchObject({ unavailableReason: NO_POSTING_TASK_REASON });
    expect(JSON.stringify(list)).not.toContain('token');
    const req = s.transport.calls[0]!;
    expect(urlOf(req).pathname).toBe(`/${V}/me/accounts`);
    expect(urlOf(req).searchParams.get('fields')).toContain('tasks');
  });

  it('listDestinations (Instagram): linked IG accounts, and Pages without one are unavailable', async () => {
    const s = sim('instagram', 'success');
    const list = await instagramConnector.listDestinations(s.ctx, { accessToken: USER_TOKEN, scopes: [] });
    expect(list[0]).toMatchObject({ provider: 'instagram', providerAccountId: 'mock_ig1', username: 'simulated.account', unavailableReason: null, metadata: { page_id: 'mock_ig1_page', ig_user_id: 'mock_ig1' } });
    expect(list[1]).toMatchObject({ unavailableReason: NO_IG_ACCOUNT_REASON });
    expect(urlOf(s.transport.calls[0]!).searchParams.get('fields')).toContain('instagram_business_account');
  });

  it('finalize: meta_page credentials (Page token from page lookup), metadata and health', async () => {
    const s = sim('instagram', 'success');
    const tokens = { accessToken: USER_TOKEN, expiresAt: '2027-01-05T00:00:00.000Z', scopes: ['pages_show_list', 'pages_read_engagement', 'instagram_basic', 'instagram_content_publish'] };
    const [cand] = await instagramConnector.listDestinations(s.ctx, tokens);
    const fin = await instagramConnector.finalize(s.ctx, tokens, cand!);
    expect(fin.credentials).toEqual({ kind: 'meta_page', pageAccessToken: 'mock_page_token_mock_ig1_page', userAccessToken: USER_TOKEN, userTokenExpiresAt: '2027-01-05T00:00:00.000Z' });
    expect(fin.metadata).toMatchObject({ page_id: 'mock_ig1_page', ig_user_id: 'mock_ig1', page_name: 'Simulated Page', graph_version: V });
    expect(fin.health.status).toBe('ready');
    expect(fin.expiresAt).toBeNull();
    expect(JSON.stringify(fin.metadata)).not.toContain('token');
  });

  it('finalize refuses an unavailable candidate', async () => {
    const s = sim('instagram', 'success');
    const list = await instagramConnector.listDestinations(s.ctx, { accessToken: USER_TOKEN, scopes: [] });
    await expect(instagramConnector.finalize(s.ctx, { accessToken: USER_TOKEN, scopes: [] }, list[1]!)).rejects.toThrow(NO_IG_ACCOUNT_REASON);
  });

  it('connector errors never echo provider bodies', async () => {
    const t = scripted([resp(400, { error: { message: 'secret detail TOKEN=abc', code: 100, type: 'OAuthException' } })]);
    await expect(facebookConnector.exchangeCode(ctxWith(t, config), { code: 'c', redirectUri: config.redirectUri })).rejects.toThrow(/Meta returned an error \(invalid_request\)/);
    const t2 = scripted([resp(400, { error: { message: 'secret detail TOKEN=abc', code: 100, type: 'OAuthException' } })]);
    await expect(facebookConnector.exchangeCode(ctxWith(t2, config), { code: 'c', redirectUri: config.redirectUri })).rejects.not.toThrow(/secret detail/);
  });
});
