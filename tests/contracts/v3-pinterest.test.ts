// Pinterest API v5 contract: OAuth (Basic auth, continuous refresh), boards as destinations, Pins with image_url /
// multiple_image_urls / video_id (media register → S3 form upload → status), destination link, error table, board
// reconcile, simulator scenarios, Pin analytics. No network. Source: official OpenAPI v5.28.0 (2026-11-07).
import { describe, expect, it } from 'vitest';
import { TransportError, type Checkpoint, type PublishConnection } from '@social-lite/core';
import { pinterestAdapter, pinterestConnector, pinterestFake, pinterestMetricsFetcher } from '../../packages/providers/src/pinterest/index.js';
import { NOW, RecordingTransport, SCENARIOS, SECRET_ACCESS, SECRET_REFRESH, ctxWith, expectNoSecrets, image, inputOf, prepareUntilReady, res, simulated, video } from './v3-helpers.js';

const conn = (over: Partial<PublishConnection> = {}): PublishConnection => ({ id: 'c1', provider: 'pinterest', providerAccountId: '549755885175', displayName: 'Brand · Recipes', username: 'brand', isMock: false, metadata: { user_id: '42', access_tier: 'standard' }, ...over });
const creds = { kind: 'oauth2' as const, accessToken: SECRET_ACCESS, refreshToken: SECRET_REFRESH, expiresAt: '2026-12-07T12:00:00Z', scope: 'boards:read,pins:read,pins:write,user_accounts:read' };

describe('pinterest oauth and boards', () => {
  it('authorize URL (comma scopes); token exchange with Basic auth + continuous_refresh; rotating refresh', async () => {
    const u = new URL(pinterestConnector.authorizationUrl({ clientId: '1234' }, { state: 'st', redirectUri: 'https://app.example/api/oauth/pinterest/callback' }));
    expect(u.origin + u.pathname).toBe('https://www.pinterest.com/oauth/');
    expect(Object.fromEntries(u.searchParams)).toEqual({ client_id: '1234', redirect_uri: 'https://app.example/api/oauth/pinterest/callback', response_type: 'code', scope: 'boards:read,pins:read,pins:write,user_accounts:read', state: 'st' });
    const t = new RecordingTransport(() => res(200, { access_token: SECRET_ACCESS, refresh_token: SECRET_REFRESH, expires_in: 2592000, refresh_token_expires_in: 5184000, scope: 'boards:read,pins:read,pins:write,user_accounts:read', token_type: 'bearer' }));
    const tokens = await pinterestConnector.exchangeCode(ctxWith(t), { code: 'c', redirectUri: 'https://r/cb' });
    expect(t.requests[0]!.url).toBe('https://api.pinterest.com/v5/oauth/token');
    expect(t.requests[0]!.headers?.authorization).toBe(`Basic ${Buffer.from('cid:csecret').toString('base64')}`);
    expect(Object.fromEntries(new URLSearchParams(t.requests[0]!.body as string))).toEqual({ grant_type: 'authorization_code', code: 'c', redirect_uri: 'https://r/cb', continuous_refresh: 'true' });
    expect(tokens).toMatchObject({ expiresAt: '2026-12-07T12:00:00.000Z', scopes: ['boards:read', 'pins:read', 'pins:write', 'user_accounts:read'] });
    const r = new RecordingTransport(() => res(200, { access_token: 'a2', refresh_token: 'r2', expires_in: 2592000, scope: creds.scope }));
    const out = await pinterestAdapter.refreshCredentials!(ctxWith(r), creds);
    expect(Object.fromEntries(new URLSearchParams(r.requests[0]!.body as string))).toEqual({ grant_type: 'refresh_token', refresh_token: SECRET_REFRESH });
    expect(out.credentials).toMatchObject({ accessToken: 'a2', refreshToken: 'r2' });
  });
  it('destinations are boards (explicit choice); secret boards are not offered as selectable', async () => {
    const t = new RecordingTransport((r) => (r.url.includes('/user_account') ? res(200, { id: '42', username: 'brand', account_type: 'BUSINESS', business_name: 'Brand' })
      : res(200, { items: [{ id: '1', name: 'Recipes', privacy: 'PUBLIC' }, { id: '2', name: 'Drafts', privacy: 'SECRET' }], bookmark: null })));
    const cands = await pinterestConnector.listDestinations(ctxWith(t), { accessToken: SECRET_ACCESS, refreshToken: null, expiresAt: null, scopes: creds.scope.split(',') });
    expect(t.requests[1]!.url).toBe('https://api.pinterest.com/v5/boards?page_size=100');
    expect(cands.map((c) => [c.providerAccountId, c.displayName, c.unavailableReason === null])).toEqual([['1', 'Brand · Recipes', true], ['2', 'Brand · Drafts', false]]);
    const fin = await pinterestConnector.finalize(ctxWith(t, { clientId: 'c', clientSecret: 's' }), { accessToken: SECRET_ACCESS, refreshToken: null, expiresAt: null, scopes: creds.scope.split(',') }, cands[0]!);
    expect(fin.metadata).toMatchObject({ board_name: 'Recipes', access_tier: 'trial' });
    expect(pinterestAdapter.capabilities(conn({ metadata: { access_tier: 'trial' } })).eligibility).toMatchObject({ status: 'restricted' });
  });
});

describe('pinterest pins', () => {
  it('image Pin: POST /v5/pins {board_id, title, description, link, alt_text, media_source:image_url}', async () => {
    const t = new RecordingTransport(() => res(201, { id: '813744226420795884' }));
    const inp = inputOf(conn(), creds, { text: 'Best soup', link: 'https://example.com/soup', options: { pinterest: { title: 'Soup', altText: 'A bowl of soup' } } }, [image(1)]);
    const p = await pinterestAdapter.prepare(ctxWith(t), inp, null);
    expect(p).toMatchObject({ kind: 'ready' });
    expect(t.requests).toHaveLength(0);
    const out = await pinterestAdapter.publish(ctxWith(t), inp, (p as { checkpoint: Checkpoint }).checkpoint);
    const r = t.requests[0]!;
    expect([r.method, r.url, r.publishes, r.headers?.authorization]).toEqual(['POST', 'https://api.pinterest.com/v5/pins', true, `Bearer ${SECRET_ACCESS}`]);
    expect(JSON.parse(r.body as string)).toEqual({ board_id: '549755885175', title: 'Soup', description: 'Best soup', link: 'https://example.com/soup', alt_text: 'A bowl of soup', media_source: { source_type: 'image_url', url: 'https://storage.example/img1.jpg' } });
    expect(out).toEqual({ kind: 'confirmed', providerIds: ['813744226420795884'], url: 'https://www.pinterest.com/pin/813744226420795884/', publishedAt: NOW.toISOString() });
  });
  it('carousel (2–5): multiple_image_urls; validation of limits', async () => {
    const t = new RecordingTransport(() => res(201, { id: '1' }));
    await pinterestAdapter.publish(ctxWith(t), inputOf(conn(), creds, {}, [image(1), image(2)]), { step: 'images_by_url', data: {} });
    expect(JSON.parse(t.requests[0]!.body as string).media_source).toEqual({ source_type: 'multiple_image_urls', items: [{ url: 'https://storage.example/img1.jpg' }, { url: 'https://storage.example/img2.jpg' }] });
    const v = (over: Record<string, unknown>, media = [image(1)]) => pinterestAdapter.validate(inputOf(conn(), creds, over, media)).issues.map((i) => i.code);
    expect(v({}, [])).toContain('media_required');
    expect(v({}, Array.from({ length: 6 }, (_, i) => image(i)))).toContain('too_many_images');
    expect(v({ text: 'x'.repeat(801) })).toContain('too_long');
    expect(v({ options: { pinterest: { title: 'x'.repeat(101) } } })).toContain('pinterest_title_too_long');
    expect(v({ link: 'https://example.com/' + 'a'.repeat(2048) })).toContain('pinterest_link_too_long');
  });
  it('video Pin: register media → multipart POST to upload_url (upload_parameters + file, no Pinterest token) → status → video_id Pin', async () => {
    const s = simulated(pinterestFake, 'pinterest', 'mock_board_1', 'processing');
    const c = conn({ providerAccountId: 'mock_board_1', isMock: true });
    const inp = inputOf(c, { kind: 'mock', token: 'tok' }, { text: 'Clip', format: 'video' }, [video(5000, { posterUrl: 'https://storage.example/poster.jpg' })]);
    const { checkpoint, polls } = await prepareUntilReady(pinterestAdapter, s.ctx, s.clock, inp);
    expect(polls).toBeGreaterThan(0);
    const reg = s.state.calls[0]!;
    expect([reg.url, JSON.parse(reg.body as string)]).toEqual(['https://api.pinterest.com/v5/media', { media_type: 'video' }]);
    const up = s.state.calls[1]!;
    expect([up.method, up.url, up.headers?.authorization]).toEqual(['POST', 'https://pinterest-media-upload.s3-accelerate.amazonaws.com/', undefined]);
    const f = up.body as FormData;
    expect([...f.keys()]).toEqual(['x-amz-date', 'x-amz-signature', 'x-amz-security-token', 'x-amz-algorithm', 'key', 'policy', 'x-amz-credential', 'Content-Type', 'file']);
    expect((f.get('file') as File).size).toBe(5000);
    expect(s.state.calls.filter((r) => r.url.includes('/v5/media/') && r.method === 'GET').length).toBe(polls + 1);
    await pinterestAdapter.publish(s.ctx, inp, checkpoint);
    expect(JSON.parse(s.state.calls.at(-1)!.body as string).media_source).toEqual({ source_type: 'video_id', media_id: checkpoint.data.mediaId, cover_image_url: 'https://storage.example/poster.jpg' });
    // Resume: a processing checkpoint never re-registers or re-uploads.
    const again = await pinterestAdapter.prepare(s.ctx, inp, { step: 'video_processing', data: { ...checkpoint.data, status: 'processing' } });
    expect(again.kind).toBe('ready');
    expect(s.state.calls.filter((r) => r.url === 'https://api.pinterest.com/v5/media')).toHaveLength(1);
  });
});

describe('pinterest error table', () => {
  const inp = inputOf(conn(), creds, {}, [image(1)]);
  const cp = { step: 'images_by_url', data: {} };
  const e = (status: number, code: number) => () => res(status, { code, message: `m ${SECRET_ACCESS}` });
  const cases: Array<[string, () => ReturnType<typeof res>, Record<string, unknown>]> = [
    ['401 ⇒ reconnect', e(401, 2), { kind: 'permanent_failure', blocking: 'reconnect' }],
    ['403 ⇒ permission', e(403, 29), { kind: 'permanent_failure', blocking: 'permission' }],
    ['404 board ⇒ permission (choose a board)', e(404, 40), { kind: 'permanent_failure', blocking: 'permission', code: 'pinterest_board_not_found' }],
    ['429 ⇒ retry', e(429, 8), { kind: 'rejected_safe_to_retry', code: 'rate_limited', retryAfterMs: 60_000 }],
    ['400 ⇒ permanent', e(400, 1), { kind: 'permanent_failure', code: 'pinterest_invalid_request' }],
    ['500 ⇒ unknown', e(500, 3), { kind: 'unknown' }],
  ];
  it.each(cases)('%s', async (_n, respond, expected) => {
    const out = await pinterestAdapter.publish(ctxWith(new RecordingTransport(respond)), inp, cp);
    expect(out).toMatchObject(expected);
    expectNoSecrets(out);
  });
  it('transport: pre-connect ⇒ safe retry; after send ⇒ unknown', async () => {
    expect((await pinterestAdapter.publish(ctxWith(new RecordingTransport(() => { throw new TransportError('x', 'connect', false); })), inp, cp)).kind).toBe('rejected_safe_to_retry');
    expect((await pinterestAdapter.publish(ctxWith(new RecordingTransport(() => { throw new TransportError('x', 'timeout', true); })), inp, cp)).kind).toBe('unknown');
  });
});

describe('pinterest simulator scenarios', () => {
  async function run(scenario: (typeof SCENARIOS)[number]) {
    const s = simulated(pinterestFake, 'pinterest', 'mock_board_s', scenario);
    const c = conn({ providerAccountId: 'mock_board_s', isMock: true });
    const inp = inputOf(c, { kind: 'mock', token: 'tok' }, { text: `pin ${scenario}`, link: 'https://example.com' }, [image(1)]);
    const prep = await pinterestAdapter.prepare(s.ctx, inp, null);
    const cp = prep.kind === 'ready' ? prep.checkpoint : null;
    const first = await pinterestAdapter.publish(s.ctx, inp, cp);
    const second = first.kind === 'rejected_safe_to_retry' ? await pinterestAdapter.publish(s.ctx, inp, cp) : null;
    const recon = () => pinterestAdapter.reconcile(s.ctx, { deliveryId: 'd', connection: c, credentials: inp.credentials, variantText: inp.variant.text, providerIds: [], checkpoint: cp, sentAt: new Date(Date.now() - 60_000).toISOString() });
    return { prep, first, second, recon };
  }
  it('success', async () => { expect((await run('success')).first.kind).toBe('confirmed'); });
  it('processing (images need no processing) ⇒ confirmed', async () => { expect((await run('processing')).first.kind).toBe('confirmed'); });
  it('fail_permanent ⇒ permanent', async () => { expect((await run('fail_permanent')).first.kind).toBe('permanent_failure'); });
  it('fail_transient_once ⇒ safe retry ⇒ confirmed', async () => { const r = await run('fail_transient_once'); expect(r.first.kind).toBe('rejected_safe_to_retry'); expect(r.second?.kind).toBe('confirmed'); });
  it('rate_limited_once ⇒ retry ⇒ confirmed', async () => { const r = await run('rate_limited_once'); expect(r.first.kind).toBe('rejected_safe_to_retry'); expect(r.second?.kind).toBe('confirmed'); });
  it('timeout_after_send ⇒ unknown ⇒ reconciled from the board', async () => { const r = await run('timeout_after_send'); expect(r.first.kind).toBe('unknown'); expect((await r.recon()).kind).toBe('published'); });
  it('revoked ⇒ reconnect', async () => { expect((await run('revoked')).first).toMatchObject({ kind: 'permanent_failure', blocking: 'reconnect' }); });
  it('missing_permission ⇒ permission', async () => { expect((await run('missing_permission')).first).toMatchObject({ kind: 'permanent_failure', blocking: 'permission' }); });
});

describe('pinterest health and analytics', () => {
  it('health: board deleted ⇒ missing permission; other account ⇒ reconnect', async () => {
    const gone = new RecordingTransport((r) => (r.url.endsWith('/user_account') ? res(200, { id: '42' }) : res(404, { code: 40, message: 'Board not found.' })));
    expect((await pinterestAdapter.health(ctxWith(gone), conn(), creds)).status).toBe('missing_permission');
    const other = new RecordingTransport(() => res(200, { id: '99' }));
    expect((await pinterestAdapter.health(ctxWith(other), conn(), creds)).status).toBe('reconnect_required');
  });
  it('GET /v5/pins/{id}/analytics with dates (≤ 90 days) and metric_types; summary_metrics parsed', async () => {
    const t = new RecordingTransport(() => res(200, { ALL: { summary_metrics: { IMPRESSION: 240, SAVE: 20, PIN_CLICK: 37, OUTBOUND_CLICK: 20 }, daily_metrics: [], lifetime_metrics: {} } }));
    const out = await pinterestMetricsFetcher.fetch(ctxWith(t), { connection: conn(), credentials: creds, providerIds: ['813744226420795884'], publishedAt: '2026-01-01T00:00:00Z' });
    const u = new URL(t.requests[0]!.url);
    expect(u.pathname).toBe('/v5/pins/813744226420795884/analytics');
    expect(Object.fromEntries(u.searchParams)).toEqual({ start_date: '2026-08-10', end_date: '2026-11-07', metric_types: 'IMPRESSION,SAVE,PIN_CLICK,OUTBOUND_CLICK,TOTAL_COMMENTS,TOTAL_REACTIONS' });
    expect(out).toMatchObject({ kind: 'ok', points: [{ name: 'IMPRESSION', value: 240, period: '2026-08-10..2026-11-07' }, { name: 'SAVE' }, { name: 'PIN_CLICK' }, { name: 'OUTBOUND_CLICK' }], unavailable: [{ name: 'TOTAL_COMMENTS' }, { name: 'TOTAL_REACTIONS' }] });
  });
});
