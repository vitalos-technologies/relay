// LinkedIn versioned REST contract: OAuth (member vs organization scopes), userinfo + organizationAcls discovery,
// Images/Videos upload (parts + ETags + finalize), POST /rest/posts with LinkedIn-Version + Rest.li headers, little-text
// escaping, error table, reconcile (organization vs member), simulator scenarios, metrics. No network.
import { describe, expect, it } from 'vitest';
import { TransportError, type Checkpoint, type PublishConnection } from '@social-lite/core';
import { LI_DEFAULT_VERSION, linkedinAdapter, linkedinConnector, linkedinFake, linkedinMetricsFetcher, littleEscape, littleUnescape } from '../../packages/providers/src/linkedin/index.js';
import { NOW, RecordingTransport, SCENARIOS, SECRET_ACCESS, ctxWith, expectNoSecrets, image, inputOf, prepareUntilReady, res, simulated, video } from './v3-helpers.js';

const member = (over: Partial<PublishConnection> = {}): PublishConnection => ({ id: 'c1', provider: 'linkedin', providerAccountId: 'urn:li:person:abc123', displayName: 'Jane', username: null, isMock: false, metadata: { account_type: 'member', granted_scopes: ['openid', 'profile', 'w_member_social'] }, ...over });
const org = (over: Partial<PublishConnection> = {}): PublishConnection => member({ providerAccountId: 'urn:li:organization:2414183', displayName: 'Acme', metadata: { account_type: 'organization', granted_scopes: ['w_organization_social', 'r_organization_social', 'rw_organization_admin'] }, ...over });
const creds = { kind: 'oauth2' as const, accessToken: SECRET_ACCESS, refreshToken: null, expiresAt: '2027-01-06T12:00:00Z', scope: 'openid profile w_member_social' };
const H = { 'linkedin-version': LI_DEFAULT_VERSION, 'x-restli-protocol-version': '2.0.0' };

describe('linkedin oauth and destinations', () => {
  it('authorize URL: member scopes by default; organization scopes only when enabled', () => {
    const u = new URL(linkedinConnector.authorizationUrl({ clientId: 'cid' }, { state: 'st', redirectUri: 'https://app.example/api/oauth/linkedin/callback' }));
    expect(u.origin + u.pathname).toBe('https://www.linkedin.com/oauth/v2/authorization');
    expect(Object.fromEntries(u.searchParams)).toEqual({ response_type: 'code', client_id: 'cid', redirect_uri: 'https://app.example/api/oauth/linkedin/callback', state: 'st', scope: 'openid profile w_member_social' });
    const o = new URL(linkedinConnector.authorizationUrl({ clientId: 'cid', features: { linkedin_organizations: true } }, { state: 's', redirectUri: 'https://r' }));
    expect(o.searchParams.get('scope')).toBe('openid profile w_member_social w_organization_social r_organization_social rw_organization_admin r_member_postAnalytics');
    expect(linkedinConnector.usesPkce).toBe(false);
  });

  it('token exchange: form with client credentials in body; 60-day expiry', async () => {
    const t = new RecordingTransport(() => res(200, { access_token: SECRET_ACCESS, expires_in: 5184000, scope: 'openid,profile,w_member_social' }));
    const tokens = await linkedinConnector.exchangeCode(ctxWith(t), { code: 'c', redirectUri: 'https://r/cb' });
    expect(t.requests[0]!.url).toBe('https://www.linkedin.com/oauth/v2/accessToken');
    expect(Object.fromEntries(new URLSearchParams(t.requests[0]!.body as string))).toEqual({ grant_type: 'authorization_code', code: 'c', redirect_uri: 'https://r/cb', client_id: 'cid', client_secret: 'csecret' });
    expect(tokens).toMatchObject({ expiresAt: '2027-01-06T12:00:00.000Z', scopes: ['openid', 'profile', 'w_member_social'] });
    const noRefresh = await linkedinAdapter.refreshCredentials!(ctxWith(t), creds).catch((e: Error) => e);
    expect(noRefresh).toMatchObject({ name: 'OAuthFlowError', permanent: true });
  });

  it('destinations: the member, plus organizations from organizationAcls (posting roles selectable, others not)', async () => {
    const t = new RecordingTransport((r) => {
      if (r.url.endsWith('/v2/userinfo')) return res(200, { sub: 'abc123', name: 'Jane Doe', picture: 'https://media.licdn.com/p.jpg' });
      if (r.url.includes('/rest/organizationAcls')) return res(200, { elements: [{ role: 'ADMINISTRATOR', state: 'APPROVED', organization: 'urn:li:organization:1' }, { role: 'ANALYST', state: 'APPROVED', organization: 'urn:li:organization:2' }] });
      return res(200, { localizedName: r.url.endsWith('/1') ? 'Acme' : 'Other' });
    });
    const tokens = { accessToken: SECRET_ACCESS, refreshToken: null, expiresAt: null, scopes: ['openid', 'profile', 'w_member_social', 'w_organization_social'] };
    const cands = await linkedinConnector.listDestinations(ctxWith(t), tokens);
    const acl = t.requests.find((r) => r.url.includes('organizationAcls'))!;
    expect(acl.url).toBe('https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&state=APPROVED&count=100');
    expect(acl.headers).toMatchObject({ ...H, authorization: `Bearer ${SECRET_ACCESS}` });
    expect(cands.map((c) => [c.providerAccountId, c.displayName, c.unavailableReason === null])).toEqual([['urn:li:person:abc123', 'Jane Doe', true], ['urn:li:organization:1', 'Acme', true], ['urn:li:organization:2', 'Other', false]]);
    const fin = await linkedinConnector.finalize(ctxWith(t), tokens, cands[1]!);
    expect(fin).toMatchObject({ providerAccountId: 'urn:li:organization:1', metadata: { account_type: 'organization', roles: ['ADMINISTRATOR'] }, health: { status: 'ready' } });
  });
});

describe('linkedin little text and validation', () => {
  it('escapes every reserved character except #hashtags; unescape round-trips', () => {
    expect(littleEscape('Hi (team) @all [x] {y} <z> a_b *c* ~d~ | e \\ #launch #2026_q4!')).toBe('Hi \\(team\\) \\@all \\[x\\] \\{y\\} \\<z\\> a\\_b \\*c\\* \\~d\\~ \\| e \\\\ #launch #2026_q4!');
    expect(littleUnescape(littleEscape('a_b (c) #tag'))).toBe('a_b (c) #tag');
    expect(littleUnescape('Follow {hashtag|\\#|coding}')).toBe('Follow #coding');
  });
  it('validation: 3000 chars, 2–20 images, pixel limit, MP4 3 s – 30 min, org visibility', () => {
    const v = (over: Record<string, unknown>, media = [image(1)], c = member()) => linkedinAdapter.validate(inputOf(c, creds, over, media)).issues.map((i) => i.code);
    expect(v({})).toEqual([]);
    expect(v({ text: 'x'.repeat(3001) }, [])).toContain('too_long');
    expect(v({}, Array.from({ length: 21 }, (_, i) => image(i)))).toContain('too_many_images');
    expect(v({}, [image(1, { width: 8000, height: 5000 })])).toContain('linkedin_too_many_pixels');
    expect(v({}, [video(500_000, { durationMs: 2000 })])).toContain('video_too_short');
    expect(v({}, [video(10_000)])).toContain('video_too_small');
    expect(v({ options: { linkedin: { visibility: 'CONNECTIONS' } } }, [], org())).toContain('linkedin_visibility');
  });
});

describe('linkedin posts and media', () => {
  it('text post: POST /rest/posts with version + Rest.li headers, exact body, x-restli-id ⇒ confirmed URL', async () => {
    const t = new RecordingTransport(() => res(201, '', { 'x-restli-id': 'urn:li:share:6844785523593134080' }));
    const inp = inputOf(member(), creds, { text: 'Launch (beta) #news', link: 'https://example.com/a_b' });
    expect((await linkedinAdapter.prepare(ctxWith(t), inp, null)).kind).toBe('ready');
    const out = await linkedinAdapter.publish(ctxWith(t), inp, { step: 'no_media', data: {} });
    const r = t.requests[0]!;
    expect([r.method, r.url, r.publishes]).toEqual(['POST', 'https://api.linkedin.com/rest/posts', true]);
    expect(r.headers).toMatchObject({ ...H, 'content-type': 'application/json', authorization: `Bearer ${SECRET_ACCESS}` });
    expect(JSON.parse(r.body as string)).toEqual({
      author: 'urn:li:person:abc123', commentary: 'Launch \\(beta\\) #news\n\nhttps://example.com/a\\_b', visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
    });
    expect(out).toEqual({ kind: 'confirmed', providerIds: ['urn:li:share:6844785523593134080'], url: 'https://www.linkedin.com/feed/update/urn:li:share:6844785523593134080/', publishedAt: '2026-11-07T12:00:00.000Z' });
  });

  it('member multi-image: initializeUpload per image (owner = author), PUT bytes, no GET (write-only token), multiImage with alt texts', async () => {
    const s = simulated(linkedinFake, 'linkedin', 'mock_li_member');
    const c = member({ providerAccountId: 'mock_li_member', isMock: true });
    const inp = inputOf(c, { kind: 'mock', token: 'tok' }, { text: 'Two', options: { linkedin: { altTexts: ['first', 'second'] } } }, [image(1), image(2)]);
    const { checkpoint } = await prepareUntilReady(linkedinAdapter, s.ctx, s.clock, inp);
    const inits = s.state.calls.filter((r) => r.url.endsWith('/rest/images?action=initializeUpload'));
    expect(inits).toHaveLength(2);
    expect(JSON.parse(inits[0]!.body as string)).toEqual({ initializeUploadRequest: { owner: 'mock_li_member' } });
    expect(inits[0]!.headers).toMatchObject(H);
    const puts = s.state.calls.filter((r) => r.method === 'PUT');
    expect(puts.map((p) => [p.headers?.['content-type'], (p.body as Uint8Array).byteLength])).toEqual([['application/octet-stream', 4], ['application/octet-stream', 4]]);
    expect(s.state.calls.some((r) => r.method === 'GET')).toBe(false);
    const out = await linkedinAdapter.publish(s.ctx, inp, checkpoint);
    const body = JSON.parse(s.state.calls.at(-1)!.body as string);
    expect(body.content).toEqual({ multiImage: { images: [{ id: expect.stringMatching(/^urn:li:image:/), altText: 'first' }, { id: expect.stringMatching(/^urn:li:image:/), altText: 'second' }] } });
    expect(out.kind).toBe('confirmed');
  });

  it('video: initializeUpload(fileSizeBytes) → PUT each 4 MB part → finalize with ETags → poll AVAILABLE; resumes from the next part', async () => {
    const size = 4 * 1024 * 1024 * 2 + 77;
    const s = simulated(linkedinFake, 'linkedin', 'mock_li_org', 'processing');
    const c = org({ providerAccountId: 'mock_li_org', isMock: true });
    const inp = inputOf(c, { kind: 'mock', token: 'tok' }, { text: 'Vid', options: { linkedin: { videoTitle: 'Title' } }, format: 'video' }, [video(size)]);
    let n = 0;
    s.state.failOn = (r) => r.method === 'PUT' && ++n === 2;
    const first = await linkedinAdapter.prepare(s.ctx, inp, null);
    expect(first).toMatchObject({ kind: 'retryable', checkpoint: { step: 'media_uploading', data: { items: [{ state: 'uploading', etags: [expect.any(String)] }] } } });
    const { checkpoint, polls } = await prepareUntilReady(linkedinAdapter, s.ctx, s.clock, inp, (first as { checkpoint: Checkpoint }).checkpoint);
    expect(polls).toBeGreaterThan(0);
    const init = s.state.calls.find((r) => r.url.endsWith('/rest/videos?action=initializeUpload'))!;
    expect(JSON.parse(init.body as string)).toEqual({ initializeUploadRequest: { owner: 'mock_li_org', fileSizeBytes: size, uploadCaptions: false, uploadThumbnail: false } });
    const parts = s.state.calls.filter((r) => r.method === 'PUT').map((r) => (r.body as Uint8Array).byteLength);
    expect(parts).toEqual([4194304, 4194304, 4194304, 77]); // part 2 retried once
    const fin = s.state.calls.find((r) => r.url.endsWith('action=finalizeUpload'))!;
    expect(JSON.parse(fin.body as string).finalizeUploadRequest.uploadedPartIds).toHaveLength(3);
    await linkedinAdapter.publish(s.ctx, inp, checkpoint);
    expect(JSON.parse(s.state.calls.at(-1)!.body as string).content).toEqual({ media: { id: expect.stringMatching(/^urn:li:video:/), title: 'Title' } });
  });

  it('publish with unprepared media sends nothing', async () => {
    const t = new RecordingTransport(() => res(201, ''));
    expect((await linkedinAdapter.publish(ctxWith(t), inputOf(member(), creds, {}, [image(1)]), null)).kind).toBe('rejected_safe_to_retry');
    expect(t.requests).toHaveLength(0);
  });
});

describe('linkedin error table (POST /rest/posts)', () => {
  const inp = inputOf(member(), creds);
  const e = (status: number, code: string, message = 'm') => () => res(status, { status, code, message: `${message} ${SECRET_ACCESS}` });
  const cases: Array<[string, () => ReturnType<typeof res>, Record<string, unknown>]> = [
    ['401 ⇒ reconnect', e(401, 'EMPTY_ACCESS_TOKEN'), { kind: 'permanent_failure', blocking: 'reconnect' }],
    ['403 ACCESS_DENIED ⇒ permission', e(403, 'ACCESS_DENIED'), { kind: 'permanent_failure', blocking: 'permission' }],
    ['422 duplicate ⇒ unknown', e(422, 'DUPLICATE_POST', 'Content is a duplicate'), { kind: 'unknown', code: 'duplicate_content' }],
    ['422 other ⇒ permanent', e(422, 'UNPROCESSABLE_ENTITY'), { kind: 'permanent_failure' }],
    ['400 FIELD_LENGTH_TOO_LONG ⇒ permanent', e(400, 'FIELD_LENGTH_TOO_LONG'), { kind: 'permanent_failure', code: 'linkedin_text_too_long' }],
    ['409 CONFLICT ⇒ unknown', e(409, 'CONFLICT'), { kind: 'unknown' }],
    ['429 ⇒ retry in 1 h', e(429, 'TOO_MANY_REQUESTS'), { kind: 'rejected_safe_to_retry', retryAfterMs: 3_600_000 }],
    ['500 ⇒ unknown', e(500, 'INTERNAL_SERVER_ERROR'), { kind: 'unknown' }],
  ];
  it.each(cases)('%s', async (_n, respond, expected) => {
    const out = await linkedinAdapter.publish(ctxWith(new RecordingTransport(respond)), inp, { step: 'no_media', data: {} });
    expect(out).toMatchObject(expected);
    expectNoSecrets(out);
  });
  it('transport: pre-connect ⇒ safe retry; after send ⇒ unknown', async () => {
    expect((await linkedinAdapter.publish(ctxWith(new RecordingTransport(() => { throw new TransportError('x', 'connect', false); })), inp, { step: 'no_media', data: {} })).kind).toBe('rejected_safe_to_retry');
    expect((await linkedinAdapter.publish(ctxWith(new RecordingTransport(() => { throw new TransportError('x', 'reset', true); })), inp, { step: 'no_media', data: {} })).kind).toBe('unknown');
  });
});

describe('linkedin reconcile and health', () => {
  it('organization: FINDER posts by author since the send time, matched on unescaped commentary; member: manual', async () => {
    const t = new RecordingTransport(() => res(200, { elements: [{ id: 'urn:li:share:9', commentary: 'Launch \\(beta\\)', createdAt: Date.parse('2026-11-07T11:55:00Z') }] }));
    const ref = { deliveryId: 'd', connection: org(), credentials: creds, variantText: 'Launch (beta)', providerIds: [], checkpoint: null, sentAt: '2026-11-07T11:54:00Z' };
    const out = await linkedinAdapter.reconcile(ctxWith(t), ref);
    expect(t.requests[0]!.url).toBe('https://api.linkedin.com/rest/posts?author=urn%3Ali%3Aorganization%3A2414183&q=author&count=20&sortBy=CREATED');
    expect(t.requests[0]!.headers).toMatchObject({ ...H, 'x-restli-method': 'FINDER' });
    expect(out).toMatchObject({ kind: 'published', providerIds: ['urn:li:share:9'] });
    expect((await linkedinAdapter.reconcile(ctxWith(t), { ...ref, connection: member() })).kind).toBe('still_unknown');
  });
  it('health: member mismatch ⇒ reconnect; organization role lost ⇒ missing permission; 7-day expiry warning', async () => {
    const t = (sub: string, acls: unknown[]) => new RecordingTransport((r) => (r.url.endsWith('/v2/userinfo') ? res(200, { sub }) : res(200, { elements: acls })));
    expect((await linkedinAdapter.health(ctxWith(t('other', [])), member(), creds)).status).toBe('reconnect_required');
    expect((await linkedinAdapter.health(ctxWith(t('abc123', [{ role: 'ANALYST', state: 'APPROVED', organization: 'urn:li:organization:2414183' }])), org(), creds)).status).toBe('missing_permission');
    expect((await linkedinAdapter.health(ctxWith(t('abc123', [])), member(), { ...creds, expiresAt: '2026-11-10T00:00:00Z' })).status).toBe('expiring');
    expect((await linkedinAdapter.health(ctxWith(t('abc123', [])), member(), creds)).status).toBe('ready');
  });

  // Fix (F1, lead follow-up 2026-11-09): simulated member connections flipped to reconnect_required at the first health
  // sweep because their id (`mock_linkedin_…`, no URN prefix) never equalled `urn:li:person:<sub>`.
  it('health: a simulated member connection (id = the simulator\'s sub) stays ready through the real simulator', async () => {
    const id = 'mock_linkedin_0a1b2c3d4e5f';
    const s = simulated(linkedinFake, 'linkedin', id);
    const h = await linkedinAdapter.health(s.ctx, { id: 'c-sim', provider: 'linkedin', providerAccountId: id, displayName: 'Sim', username: null, isMock: true, metadata: {} }, { kind: 'mock', token: 'tok' });
    expect(h.status).toBe('ready');
    expect(s.state.calls.some((r) => r.url.endsWith('/v2/userinfo'))).toBe(true);
  });

  it('health: a real member is still strict — a bare sub equal to the id, or another member, flips to reconnect', async () => {
    const t = (sub: string) => new RecordingTransport(() => res(200, { sub }));
    // Live connection whose id is not a URN must not pass the simulated-only comparison.
    expect((await linkedinAdapter.health(ctxWith(t('mock_linkedin_x')), member({ providerAccountId: 'mock_linkedin_x' }), creds)).status).toBe('reconnect_required');
    expect((await linkedinAdapter.health(ctxWith(t('someone-else')), member(), creds)).status).toBe('reconnect_required');
    // A simulated connection answered by a different simulated member also flips.
    expect((await linkedinAdapter.health(ctxWith(t('mock_linkedin_other')), member({ providerAccountId: 'mock_linkedin_x', isMock: true, metadata: {} }), { kind: 'mock', token: 'tok' })).status).toBe('reconnect_required');
  });
});

describe('linkedin simulator scenarios', () => {
  async function run(scenario: (typeof SCENARIOS)[number]) {
    const s = simulated(linkedinFake, 'linkedin', 'mock_li_s', scenario);
    const c = org({ providerAccountId: 'mock_li_s', isMock: true });
    const inp = inputOf(c, { kind: 'mock', token: 'tok' }, { text: `post ${scenario}` }, [image(1)]);
    let prep = await linkedinAdapter.prepare(s.ctx, inp, null);
    for (let i = 0; i < 5 && prep.kind === 'pending'; i++) prep = await linkedinAdapter.prepare(s.ctx, inp, prep.checkpoint);
    const cp = prep.kind === 'ready' ? prep.checkpoint : null;
    const first = await linkedinAdapter.publish(s.ctx, inp, cp);
    const second = await linkedinAdapter.publish(s.ctx, inp, cp);
    const recon = () => linkedinAdapter.reconcile(s.ctx, { deliveryId: 'd', connection: c, credentials: inp.credentials, variantText: inp.variant.text, providerIds: [], checkpoint: cp, sentAt: new Date(NOW.getTime() - 60_000).toISOString() });
    return { prep, first, second, recon };
  }
  it('success; a repeat is refused as duplicate ⇒ unknown', async () => { const r = await run('success'); expect(r.first.kind).toBe('confirmed'); expect(r.second).toMatchObject({ kind: 'unknown', code: 'duplicate_content' }); });
  it('processing ⇒ media polled until AVAILABLE', async () => { const r = await run('processing'); expect(r.prep.kind).toBe('ready'); expect(r.first.kind).toBe('confirmed'); });
  it('fail_permanent ⇒ permanent', async () => { expect((await run('fail_permanent')).first.kind).toBe('permanent_failure'); });
  it('fail_transient_once ⇒ safe retry then confirmed', async () => { const r = await run('fail_transient_once'); expect(r.first.kind).toBe('rejected_safe_to_retry'); expect(r.second.kind).toBe('confirmed'); });
  it('rate_limited_once ⇒ retry then confirmed', async () => { const r = await run('rate_limited_once'); expect(r.first).toMatchObject({ kind: 'rejected_safe_to_retry', code: 'rate_limited' }); expect(r.second.kind).toBe('confirmed'); });
  it('timeout_after_send ⇒ unknown ⇒ reconciled by author search', async () => { const r = await run('timeout_after_send'); expect(r.first.kind).toBe('unknown'); expect((await r.recon()).kind).toBe('published'); });
  it('revoked ⇒ reconnect', async () => { expect((await run('revoked')).prep).toMatchObject({ kind: 'permanent', blocking: 'reconnect' }); });
  it('missing_permission ⇒ permission', async () => { expect((await run('missing_permission')).prep).toMatchObject({ kind: 'permanent', blocking: 'permission' }); });
});

describe('linkedin metrics', () => {
  it('organization share statistics (Rest.li List syntax); member analytics one call per metric', async () => {
    const t = new RecordingTransport(() => res(200, { elements: [{ share: 'urn:li:share:1', totalShareStatistics: { impressionCount: 50, clickCount: 3, likeCount: 2, commentCount: 1, shareCount: 0, uniqueImpressionsCount: 40 } }] }));
    const out = await linkedinMetricsFetcher.fetch(ctxWith(t), { connection: org(), credentials: { ...creds, scope: 'rw_organization_admin w_organization_social' }, providerIds: ['urn:li:share:1'], publishedAt: null });
    expect(t.requests[0]!.url).toBe('https://api.linkedin.com/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=urn%3Ali%3Aorganization%3A2414183&shares=List(urn%3Ali%3Ashare%3A1)');
    expect(out).toMatchObject({ kind: 'ok', points: expect.arrayContaining([{ name: 'impressionCount', dimension: null, value: 50, period: 'lifetime', windowEnd: null }]) });
    const m = new RecordingTransport(() => res(200, { elements: [{ count: 9, metricType: 'IMPRESSION' }] }));
    const mo = await linkedinMetricsFetcher.fetch(ctxWith(m), { connection: member(), credentials: { ...creds, scope: 'w_member_social r_member_postAnalytics' }, providerIds: ['urn:li:ugcPost:7'], publishedAt: null });
    expect(m.requests.map((r) => r.url)).toContain('https://api.linkedin.com/rest/memberCreatorPostAnalytics?q=entity&entity=(ugc:urn%3Ali%3AugcPost%3A7)&queryType=IMPRESSION&aggregation=TOTAL');
    expect(m.requests).toHaveLength(5);
    expect(mo.kind).toBe('ok');
    expect((await linkedinMetricsFetcher.fetch(ctxWith(m), { connection: member(), credentials: creds, providerIds: ['urn:li:share:1'], publishedAt: null })).kind).toBe('permission_missing');
  });
});
