// TikTok Content Posting API contract: Login Kit OAuth, creator_info, Direct Post (chunked FILE_UPLOAD, last chunk =
// publish), photo posts (PULL_FROM_URL), inbox/draft handoff, status reconcile, error table, simulator scenarios,
// checkpoint resume, metrics and token hygiene. No network. Sources: docs/providers/tiktok.md (fetched 2026-11-07).
import { describe, expect, it } from 'vitest';
import { TransportError, type PublishConnection } from '@social-lite/core';
import { MemoryMockStore } from '@social-lite/providers';
import { CHUNK_BYTES, TIKTOK_INBOX_HANDOFF, chunkPlan, tiktokAdapter, tiktokConnector, tiktokFake, tiktokManualHandoff, tiktokMetricsFetcher } from '../../packages/providers/src/tiktok/index.js';
import { NOW, RecordingTransport, SCENARIOS, SECRET_ACCESS, SECRET_REFRESH, ctxWith, expectNoSecrets, image, inputOf, prepareUntilReady, res, simulated, video } from './v3-helpers.js';

const conn = (over: Partial<PublishConnection> = {}): PublishConnection => ({ id: 'c1', provider: 'tiktok', providerAccountId: 'open-id-1', displayName: 'Creator', username: 'creator', isMock: false,
  metadata: { publish_mode: 'direct', privacy_level_options: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'], granted_scopes: ['user.info.basic', 'video.publish', 'video.upload', 'video.list'] }, ...over });
const creds = { kind: 'oauth2' as const, accessToken: SECRET_ACCESS, refreshToken: SECRET_REFRESH, expiresAt: '2026-11-07T14:00:00Z', scope: 'user.info.basic,video.publish,video.upload,video.list' };
const direct = { tiktok: { privacyLevel: 'SELF_ONLY', consent: true, allowComment: true } };
const ok = (data: unknown) => res(200, { data, error: { code: 'ok', message: '', log_id: 'l' } });

describe('tiktok oauth (Login Kit web)', () => {
  it('authorize URL: client_key, comma-separated scopes, no PKCE', () => {
    const u = new URL(tiktokConnector.authorizationUrl({ clientId: 'ck' }, { state: 'st', redirectUri: 'https://app.example/api/oauth/tiktok/callback' }));
    expect(u.origin + u.pathname).toBe('https://www.tiktok.com/v2/auth/authorize/');
    expect(Object.fromEntries(u.searchParams)).toEqual({ client_key: 'ck', response_type: 'code', scope: 'user.info.basic,video.publish,video.upload,video.list', redirect_uri: 'https://app.example/api/oauth/tiktok/callback', state: 'st' });
    expect(tiktokConnector.usesPkce).toBe(false);
    expect(tiktokConnector.isConfigured({ clientId: 'ck' })).toBe(false);
    expect(tiktokConnector.isConfigured({ clientId: 'ck', clientSecret: 's' })).toBe(true);
  });

  it('code exchange: form body with client_key/client_secret; comma scopes; rotating refresh; failures never echo tokens', async () => {
    const t = new RecordingTransport(() => res(200, { access_token: SECRET_ACCESS, expires_in: 7200, refresh_token: SECRET_REFRESH, refresh_expires_in: 15552000, open_id: 'open-id-1', scope: 'user.info.basic,video.upload', token_type: 'Bearer' }));
    const tokens = await tiktokConnector.exchangeCode(ctxWith(t), { code: 'the-code', redirectUri: 'https://r/cb' });
    const r = t.requests[0]!;
    expect([r.method, r.url, r.headers?.['content-type']]).toEqual(['POST', 'https://open.tiktokapis.com/v2/oauth/token/', 'application/x-www-form-urlencoded']);
    expect(Object.fromEntries(new URLSearchParams(r.body as string))).toEqual({ client_key: 'cid', client_secret: 'csecret', code: 'the-code', grant_type: 'authorization_code', redirect_uri: 'https://r/cb' });
    expect(tokens).toMatchObject({ accessToken: SECRET_ACCESS, refreshToken: SECRET_REFRESH, expiresAt: '2026-11-07T14:00:00.000Z', scopes: ['user.info.basic', 'video.upload'] });
    const rt = new RecordingTransport(() => res(200, { access_token: 'new-a', refresh_token: 'new-r', expires_in: 7200, scope: creds.scope }));
    const out = await tiktokAdapter.refreshCredentials!(ctxWith(rt), creds);
    expect(Object.fromEntries(new URLSearchParams(rt.requests[0]!.body as string))).toEqual({ client_key: 'cid', client_secret: 'csecret', grant_type: 'refresh_token', refresh_token: SECRET_REFRESH });
    expect(out.credentials).toMatchObject({ accessToken: 'new-a', refreshToken: 'new-r' });
    const bad = await tiktokAdapter.refreshCredentials!(ctxWith(new RecordingTransport(() => res(400, { error: 'invalid_grant', error_description: `bad ${SECRET_REFRESH}` }))), creds).catch((e: Error) => e);
    expect(bad).toMatchObject({ name: 'OAuthFlowError', permanent: true });
    expectNoSecrets((bad as Error).message);
  });

  it('listDestinations: user info + creator_info; finalize derives the publish mode from granted scopes', async () => {
    const t = new RecordingTransport((r) => (r.url.includes('/v2/user/info/') ? ok({ user: { open_id: 'open-id-1', display_name: 'Disp', avatar_url: 'https://p/a.jpg' } })
      : ok({ creator_username: 'creator', creator_nickname: 'Nick', privacy_level_options: ['SELF_ONLY'], max_video_post_duration_sec: 300 })));
    const tokens = { accessToken: SECRET_ACCESS, refreshToken: SECRET_REFRESH, expiresAt: null, scopes: ['user.info.basic', 'video.publish', 'video.upload', 'video.list'] };
    const [c] = await tiktokConnector.listDestinations(ctxWith(t), tokens);
    expect(t.requests[0]!.url).toBe('https://open.tiktokapis.com/v2/user/info/?fields=open_id%2Cunion_id%2Cavatar_url%2Cdisplay_name');
    expect(t.requests[0]!.headers?.authorization).toBe(`Bearer ${SECRET_ACCESS}`);
    expect([t.requests[1]!.method, t.requests[1]!.url, t.requests[1]!.headers?.['content-type']]).toEqual(['POST', 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/', 'application/json; charset=UTF-8']);
    expect(c).toMatchObject({ providerAccountId: 'open-id-1', displayName: 'Nick', username: 'creator', metadata: { publish_mode: 'direct', privacy_level_options: ['SELF_ONLY'] } });
    const fin = await tiktokConnector.finalize(ctxWith(t, { clientId: 'c', clientSecret: 's', features: { tiktok_direct_post_audited: false } }), tokens, c!);
    expect(fin).toMatchObject({ credentials: { kind: 'oauth2', scope: 'user.info.basic,video.publish,video.upload,video.list' }, metadata: { publish_mode: 'direct', direct_post_audited: false }, health: { status: 'ready' } });
    const inbox = await tiktokConnector.finalize(ctxWith(t), { ...tokens, scopes: ['user.info.basic', 'video.upload'] }, c!);
    expect(inbox.metadata.publish_mode).toBe('inbox');
    expect(inbox.health.message).toMatch(/manual handoff/i);
  });
});

describe('tiktok capabilities and required Direct Post fields', () => {
  it('capabilities per mode: direct (unaudited ⇒ restricted), inbox ⇒ draft handoff, manual ⇒ cannot publish', () => {
    expect(tiktokAdapter.capabilities(conn())).toMatchObject({ canPublish: true, publishMode: 'direct', eligibility: { status: 'restricted' }, requiredOptions: ['tiktok.privacyLevel', 'tiktok.consent'] });
    expect(tiktokAdapter.capabilities(conn({ metadata: { publish_mode: 'direct', direct_post_audited: true } })).eligibility?.status).toBe('eligible');
    expect(tiktokAdapter.capabilities(conn({ metadata: { publish_mode: 'inbox' } }))).toMatchObject({ canPublish: true, publishMode: 'draft_handoff' });
    expect(tiktokAdapter.capabilities(conn({ metadata: { publish_mode: 'manual' } }))).toMatchObject({ canPublish: false, publishMode: 'manual', eligibility: { status: 'unsupported' } });
  });

  it('validation: privacy (no default), express consent, branded content not private, media rules', () => {
    const v = (opts: Record<string, unknown>, media = [video(1000)], c = conn()) => tiktokAdapter.validate(inputOf(c, creds, { options: opts, format: 'video' }, media)).issues.map((i) => i.code);
    expect(v({})).toEqual(expect.arrayContaining(['tiktok_privacy_required', 'tiktok_consent_required']));
    expect(v(direct)).toEqual([]);
    expect(v({ tiktok: { privacyLevel: 'FOLLOWER_OF_CREATOR', consent: true } })).toContain('tiktok_privacy_unavailable');
    expect(v({ tiktok: { privacyLevel: 'SELF_ONLY', consent: true, brandContent: true } })).toContain('tiktok_branded_private');
    expect(v({ tiktok: { consent: true } }, [video(1000)], conn({ metadata: { publish_mode: 'inbox' } }))).toEqual([]);
    expect(v(direct, [], conn())).toContain('media_required');
    expect(v(direct, [video(1000, { width: 320, height: 240 })])).toContain('video_dimensions');
    expect(v(direct, [video(1000, { frameRate: 20 })])).toContain('frame_rate');
    expect(v(direct, [image(1, { mime: 'image/png' })])).toContain('mime');
    expect(v(direct, [video(1000)], conn({ metadata: { publish_mode: 'manual' } }))).toContain('tiktok_manual_only');
  });

  it('manual handoff package is labelled manual and makes no request', () => {
    expect(tiktokManualHandoff(inputOf(conn(), creds, { text: 'Caption #tag' }, [video(10)]))).toEqual({
      label: 'Manual handoff', caption: 'Caption #tag', media: [{ url: 'https://storage.example/vid1.mp4', mime: 'video/mp4' }], openUrl: 'https://www.tiktok.com/upload',
      instructions: expect.stringMatching(/does not publish this automatically/),
    });
  });
});

describe('tiktok Direct Post video upload', () => {
  it('chunk plan: whole file ≤ 64 MB, else 10 MB chunks with the remainder in the last', () => {
    expect(chunkPlan(3_000_000)).toEqual({ chunkSize: 3_000_000, totalChunks: 1 });
    expect(chunkPlan(64 * 1024 * 1024)).toEqual({ chunkSize: 64 * 1024 * 1024, totalChunks: 1 });
    expect(chunkPlan(70 * 1024 * 1024 + 5)).toEqual({ chunkSize: CHUNK_BYTES, totalChunks: 7 });
  });

  it('small video: prepare = creator_info + init (exact body); publish = single PUT with Content-Range (publishes)', async () => {
    const t = new RecordingTransport((r) => {
      if (r.url.endsWith('/creator_info/query/')) return ok({ privacy_level_options: ['SELF_ONLY', 'PUBLIC_TO_EVERYONE'], max_video_post_duration_sec: 600 });
      if (r.url.endsWith('/video/init/')) return ok({ publish_id: 'v_pub_file~v2.1', upload_url: 'https://open-upload.tiktokapis.com/video/?upload_id=1&upload_token=t' });
      return { status: 201, headers: {}, body: '' };
    });
    const inp = inputOf(conn(), creds, { text: 'My clip', options: { tiktok: { ...direct.tiktok, isAigc: true, brandOrganic: true } }, format: 'video' }, [video(1000)]);
    const p = await tiktokAdapter.prepare(ctxWith(t), inp, null);
    expect(p).toMatchObject({ kind: 'ready', checkpoint: { step: 'upload_ready', data: { publishId: 'v_pub_file~v2.1', nextChunk: 0, totalChunks: 1, chunkSize: 1000, videoSize: 1000, mode: 'direct' } } });
    const init = t.requests[1]!;
    expect([init.method, init.url, init.headers?.authorization, init.headers?.['content-type']]).toEqual(['POST', 'https://open.tiktokapis.com/v2/post/publish/video/init/', `Bearer ${SECRET_ACCESS}`, 'application/json; charset=UTF-8']);
    expect(JSON.parse(init.body as string)).toEqual({
      post_info: { title: 'My clip', privacy_level: 'SELF_ONLY', disable_comment: false, disable_duet: true, disable_stitch: true, brand_content_toggle: false, brand_organic_toggle: true, is_aigc: true },
      source_info: { source: 'FILE_UPLOAD', video_size: 1000, chunk_size: 1000, total_chunk_count: 1 },
    });
    expect(t.requests).toHaveLength(2);
    const out = await tiktokAdapter.publish(ctxWith(t), inp, p.kind === 'ready' ? p.checkpoint : null);
    const put = t.requests[2]!;
    expect([put.method, put.url, put.publishes]).toEqual(['PUT', 'https://open-upload.tiktokapis.com/video/?upload_id=1&upload_token=t', true]);
    expect(put.headers).toMatchObject({ 'content-type': 'video/mp4', 'content-length': '1000', 'content-range': 'bytes 0-999/1000' });
    expect((put.body as Uint8Array).byteLength).toBe(1000);
    expect(out).toMatchObject({ kind: 'processing', providerIds: ['v_pub_file~v2.1'], checkpoint: { step: 'submitted' } });
    expectNoSecrets(out);
  });

  it('70 MB video: prepare uploads chunks 0–5 (206), publish sends chunk 6 (201); a failed chunk resumes without re-sending', async () => {
    const size = 70 * 1024 * 1024 + 123;
    const s = simulated(tiktokFake, 'tiktok', 'mock_tt_1');
    const c = conn({ providerAccountId: 'mock_tt_1', isMock: true });
    const inp = inputOf(c, { kind: 'mock', token: 'tok' }, { options: direct, format: 'video' }, [video(size)]);
    let n = 0;
    s.state.failOn = (r) => r.method === 'PUT' && ++n === 3;
    const first = await tiktokAdapter.prepare(s.ctx, inp, null);
    expect(first).toMatchObject({ kind: 'retryable', checkpoint: { step: 'uploading', data: { nextChunk: 2, totalChunks: 7 } } });
    const cp = (first as { checkpoint: import('@social-lite/core').Checkpoint }).checkpoint;
    const { checkpoint } = await prepareUntilReady(tiktokAdapter, s.ctx, s.clock, inp, cp);
    const ranges = s.state.calls.filter((r) => r.method === 'PUT').map((r) => r.headers?.['content-range']);
    const C = CHUNK_BYTES;
    expect(ranges).toEqual([`bytes 0-${C - 1}/${size}`, `bytes ${C}-${2 * C - 1}/${size}`, `bytes ${2 * C}-${3 * C - 1}/${size}`, // 3rd failed, re-sent once
      `bytes ${2 * C}-${3 * C - 1}/${size}`, `bytes ${3 * C}-${4 * C - 1}/${size}`, `bytes ${4 * C}-${5 * C - 1}/${size}`, `bytes ${5 * C}-${6 * C - 1}/${size}`]);
    expect(s.state.calls.filter((r) => r.url.endsWith('/video/init/'))).toHaveLength(1);
    expect(checkpoint).toMatchObject({ step: 'upload_ready', data: { nextChunk: 6 } });
    const out = await tiktokAdapter.publish(s.ctx, inp, checkpoint);
    const last = s.state.calls.at(-1)!;
    expect(last.headers?.['content-range']).toBe(`bytes ${6 * C}-${size - 1}/${size}`);
    expect(out.kind).toBe('processing');
    const rec = await tiktokAdapter.reconcile(s.ctx, { deliveryId: 'd-1', connection: c, credentials: inp.credentials, variantText: '', providerIds: (out as { providerIds: string[] }).providerIds, checkpoint: null, sentAt: null });
    expect(rec).toMatchObject({ kind: 'published', url: null });
  });

  it('publish without a prepared upload sends nothing; an expired upload URL is a safe retry', async () => {
    const t = new RecordingTransport(() => res(201, ''));
    const inp = inputOf(conn(), creds, { options: direct, format: 'video' }, [video(1000)]);
    expect((await tiktokAdapter.publish(ctxWith(t), inp, null)).kind).toBe('rejected_safe_to_retry');
    const stale = { step: 'upload_ready', data: { mode: 'direct', assetId: 'vid1', publishId: 'p', uploadUrl: 'https://open-upload.tiktokapis.com/x', uploadExpiresAt: '2026-11-07T11:00:00Z', videoSize: 1000, chunkSize: 1000, totalChunks: 1, nextChunk: 0 } };
    expect(await tiktokAdapter.publish(ctxWith(t), inp, stale)).toMatchObject({ kind: 'rejected_safe_to_retry', code: 'tiktok_upload_url_expired' });
    expect(t.requests).toHaveLength(0);
  });

  it('creator_info re-check at post time: privacy no longer offered ⇒ permanent; too long for the creator ⇒ permanent', async () => {
    const t = new RecordingTransport(() => ok({ privacy_level_options: ['PUBLIC_TO_EVERYONE'], max_video_post_duration_sec: 10 }));
    expect(await tiktokAdapter.prepare(ctxWith(t), inputOf(conn(), creds, { options: direct, format: 'video' }, [video(1000)]), null)).toMatchObject({ kind: 'permanent', code: 'tiktok_privacy_mismatch' });
    const t2 = new RecordingTransport(() => ok({ privacy_level_options: ['SELF_ONLY'], max_video_post_duration_sec: 10 }));
    expect(await tiktokAdapter.prepare(ctxWith(t2), inputOf(conn(), creds, { options: direct, format: 'video' }, [video(1000)]), null)).toMatchObject({ kind: 'permanent', code: 'tiktok_video_too_long' });
  });
});

describe('tiktok photo posts and inbox (draft) handoff', () => {
  it('photo Direct Post: content/init with PULL_FROM_URL, photo_images, DIRECT_POST, PHOTO', async () => {
    const t = new RecordingTransport((r) => (r.url.endsWith('/creator_info/query/') ? ok({ privacy_level_options: ['SELF_ONLY'] }) : ok({ publish_id: 'p_pub_url~v2.9' })));
    const inp = inputOf(conn(), creds, { text: 'Two photos', options: { tiktok: { ...direct.tiktok, title: 'Title', autoAddMusic: true } } }, [image(1), image(2)]);
    const p = await tiktokAdapter.prepare(ctxWith(t), inp, null);
    expect(p).toMatchObject({ kind: 'ready', checkpoint: { step: 'photo_ready' } });
    const out = await tiktokAdapter.publish(ctxWith(t), inp, (p as { checkpoint: import('@social-lite/core').Checkpoint }).checkpoint);
    const r = t.requests.at(-1)!;
    expect([r.url, r.publishes]).toEqual(['https://open.tiktokapis.com/v2/post/publish/content/init/', true]);
    expect(JSON.parse(r.body as string)).toEqual({
      post_info: { title: 'Title', description: 'Two photos', privacy_level: 'SELF_ONLY', disable_comment: false, auto_add_music: true, brand_content_toggle: false, brand_organic_toggle: false },
      source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: ['https://storage.example/img1.jpg', 'https://storage.example/img2.jpg'] },
      post_mode: 'DIRECT_POST', media_type: 'PHOTO',
    });
    expect(out).toMatchObject({ kind: 'processing', providerIds: ['p_pub_url~v2.9'] });
  });

  it('inbox mode: inbox init (source_info only), status SEND_TO_USER_INBOX ⇒ explicit manual handoff (never "published")', async () => {
    const s = simulated(tiktokFake, 'tiktok', 'mock_tt_2');
    const c = conn({ providerAccountId: 'mock_tt_2', isMock: true, metadata: { publish_mode: 'inbox' } });
    const inp = inputOf(c, { kind: 'mock', token: 'tok' }, { options: { tiktok: { consent: true } }, format: 'video' }, [video(2000)]);
    const { checkpoint } = await prepareUntilReady(tiktokAdapter, s.ctx, s.clock, inp);
    const init = s.state.calls.find((r) => r.url.endsWith('/inbox/video/init/'))!;
    expect(JSON.parse(init.body as string)).toEqual({ source_info: { source: 'FILE_UPLOAD', video_size: 2000, chunk_size: 2000, total_chunk_count: 1 } });
    expect(s.state.calls.some((r) => r.url.includes('creator_info'))).toBe(false);
    const out = await tiktokAdapter.publish(s.ctx, inp, checkpoint);
    expect(out.kind).toBe('processing');
    const rec = await tiktokAdapter.reconcile(s.ctx, { deliveryId: 'd', connection: c, credentials: inp.credentials, variantText: '', providerIds: (out as { providerIds: string[] }).providerIds, checkpoint: null, sentAt: null });
    // V3 engine: an explicit manual-handoff outcome (known state; never 'published', never ambiguous 'unknown').
    expect(rec).toEqual({ kind: 'handoff', reason: TIKTOK_INBOX_HANDOFF, providerIds: (out as { providerIds: string[] }).providerIds.slice(0, 1) });
  });
});

describe('tiktok error table (photo init = the publishing request)', () => {
  const inp = inputOf(conn(), creds, { options: direct }, [image(1)]);
  const e = (status: number, code: string) => () => res(status, { error: { code, message: `m ${SECRET_ACCESS}`, log_id: 'l' } });
  const cases: Array<[string, () => ReturnType<typeof res>, Record<string, unknown>]> = [
    ['401 access_token_invalid ⇒ reconnect', e(401, 'access_token_invalid'), { kind: 'permanent_failure', blocking: 'reconnect' }],
    ['401 scope_not_authorized ⇒ permission', e(401, 'scope_not_authorized'), { kind: 'permanent_failure', blocking: 'permission', code: 'tiktok_scope_missing' }],
    ['403 unaudited ⇒ permission (eligibility)', e(403, 'unaudited_client_can_only_post_to_private_accounts'), { kind: 'permanent_failure', blocking: 'permission', code: 'tiktok_unaudited_client' }],
    ['403 url_ownership_unverified ⇒ permission', e(403, 'url_ownership_unverified'), { kind: 'permanent_failure', blocking: 'permission', code: 'tiktok_url_unverified' }],
    ['403 reached_active_user_cap ⇒ budget', e(403, 'reached_active_user_cap'), { kind: 'permanent_failure', blocking: 'budget' }],
    ['403 spam_risk_too_many_posts ⇒ retry in 6 h', e(403, 'spam_risk_too_many_posts'), { kind: 'rejected_safe_to_retry', code: 'tiktok_daily_post_cap', retryAfterMs: 6 * 3600_000 }],
    ['403 privacy mismatch ⇒ permanent', e(403, 'privacy_level_option_mismatch'), { kind: 'permanent_failure', code: 'tiktok_privacy_mismatch' }],
    ['429 ⇒ retry 60 s', e(429, 'rate_limit_exceeded'), { kind: 'rejected_safe_to_retry', code: 'rate_limited', retryAfterMs: 60_000 }],
    ['400 invalid_param ⇒ permanent', e(400, 'invalid_param'), { kind: 'permanent_failure' }],
    ['500 ⇒ unknown', () => res(500, {}), { kind: 'unknown' }],
  ];
  it.each(cases)('%s', async (_n, respond, expected) => {
    const out = await tiktokAdapter.publish(ctxWith(new RecordingTransport(respond)), inp, { step: 'photo_ready', data: { mode: 'direct' } });
    expect(out).toMatchObject(expected);
    expectNoSecrets(out);
  });
  it('transport: pre-connect ⇒ safe retry; after send ⇒ unknown; HTTP 200 with error.code is an error', async () => {
    const pub = (fn: () => never) => tiktokAdapter.publish(ctxWith(new RecordingTransport(fn)), inp, { step: 'photo_ready', data: {} });
    expect((await pub(() => { throw new TransportError('x', 'connect', false); })).kind).toBe('rejected_safe_to_retry');
    expect((await pub(() => { throw new TransportError('x', 'reset', true); })).kind).toBe('unknown');
    const p = await tiktokAdapter.prepare(ctxWith(new RecordingTransport(() => res(200, { data: {}, error: { code: 'spam_risk_user_banned_from_posting', message: 'banned' } }))), inp, null);
    expect(p).toMatchObject({ kind: 'permanent', blocking: 'permission', code: 'tiktok_user_banned' });
  });
});

describe('tiktok status reconcile', () => {
  const ref = (providerIds: string[], checkpoint: import('@social-lite/core').Checkpoint | null = null) => ({ deliveryId: 'd', connection: conn(), credentials: creds, variantText: '', providerIds, checkpoint, sentAt: null });
  it('POST status/fetch {publish_id}; PUBLISH_COMPLETE ⇒ published (public post id + URL); FAILED ⇒ not published; processing', async () => {
    // Raw int64 in the JSON text (JSON.parse would round it): the adapter must keep every digit.
    const t = new RecordingTransport(() => ({ status: 200, headers: {}, body: '{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7123456789012345678]},"error":{"code":"ok","message":"","log_id":"l"}}' }));
    const out = await tiktokAdapter.reconcile(ctxWith(t), ref(['v_pub_file~v2.1']));
    expect(JSON.parse(t.requests[0]!.body as string)).toEqual({ publish_id: 'v_pub_file~v2.1' });
    expect(t.requests[0]!.url).toBe('https://open.tiktokapis.com/v2/post/publish/status/fetch/');
    expect(out).toEqual({ kind: 'published', providerIds: ['v_pub_file~v2.1', '7123456789012345678'], url: 'https://www.tiktok.com/@creator/video/7123456789012345678' });
    expect(await tiktokAdapter.reconcile(ctxWith(new RecordingTransport(() => ok({ status: 'FAILED', fail_reason: 'duration_check_failed' }))), ref(['p']))).toMatchObject({ kind: 'not_published', reason: expect.stringContaining('duration_check_failed') });
    expect((await tiktokAdapter.reconcile(ctxWith(new RecordingTransport(() => ok({ status: 'PROCESSING_UPLOAD' }))), ref(['p']))).kind).toBe('processing');
  });
  it('a lost final chunk is resolved from the checkpoint publish_id', async () => {
    const t = new RecordingTransport(() => ok({ status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [] }));
    const out = await tiktokAdapter.reconcile(ctxWith(t), ref([], { step: 'upload_ready', data: { publishId: 'from-cp' } }));
    expect(JSON.parse(t.requests[0]!.body as string)).toEqual({ publish_id: 'from-cp' });
    expect(out).toMatchObject({ kind: 'published', providerIds: ['from-cp'], url: null });
  });
});

describe('tiktok simulator scenarios (prepare → publish → reconcile)', () => {
  async function run(scenario: (typeof SCENARIOS)[number]) {
    const s = simulated(tiktokFake, 'tiktok', 'mock_tt_s', scenario, new MemoryMockStore());
    const c = conn({ providerAccountId: 'mock_tt_s', isMock: true });
    const inp = inputOf(c, { kind: 'mock', token: 'tok' }, { text: `post ${scenario}`, options: direct, format: 'video' }, [video(4096)]);
    const prep = await tiktokAdapter.prepare(s.ctx, inp, null);
    let first = prep.kind === 'ready' ? await tiktokAdapter.publish(s.ctx, inp, prep.checkpoint) : null;
    let prep2 = prep;
    if (prep.kind === 'retryable') { prep2 = await tiktokAdapter.prepare(s.ctx, inp, prep.checkpoint ?? null); first = prep2.kind === 'ready' ? await tiktokAdapter.publish(s.ctx, inp, prep2.checkpoint) : null; }
    const second = first?.kind === 'rejected_safe_to_retry' && prep2.kind === 'ready' ? await tiktokAdapter.publish(s.ctx, inp, prep2.checkpoint) : null;
    const ids = (second ?? first) && 'providerIds' in (second ?? first)! ? ((second ?? first) as { providerIds?: string[] }).providerIds ?? [] : [];
    const cp = prep2.kind === 'ready' ? prep2.checkpoint : null;
    const recon = async () => tiktokAdapter.reconcile(s.ctx, { deliveryId: 'd', connection: c, credentials: inp.credentials, variantText: '', providerIds: ids, checkpoint: cp, sentAt: null });
    return { prep, first, second, recon };
  }
  it('success ⇒ processing then published', async () => { const r = await run('success'); expect(r.first?.kind).toBe('processing'); expect((await r.recon()).kind).toBe('published'); });
  it('processing ⇒ processing polls, then published', async () => {
    const r = await run('processing');
    expect((await r.recon()).kind).toBe('processing');
    expect((await r.recon()).kind).toBe('processing');
    expect((await r.recon()).kind).toBe('published');
  });
  it('fail_permanent ⇒ FAILED ⇒ not published', async () => { const r = await run('fail_permanent'); expect(r.first?.kind).toBe('processing'); expect((await r.recon()).kind).toBe('not_published'); });
  it('fail_transient_once ⇒ safe retry then processing', async () => { const r = await run('fail_transient_once'); expect(r.first?.kind).toBe('rejected_safe_to_retry'); expect(r.second?.kind).toBe('processing'); });
  it('rate_limited_once ⇒ init retried after 429', async () => { const r = await run('rate_limited_once'); expect(r.prep).toMatchObject({ kind: 'retryable', code: 'rate_limited' }); expect(r.first?.kind).toBe('processing'); });
  it('timeout_after_send ⇒ unknown, reconciled as published', async () => { const r = await run('timeout_after_send'); expect(r.first?.kind).toBe('unknown'); expect((await r.recon()).kind).toBe('published'); });
  it('revoked ⇒ reconnect', async () => { const r = await run('revoked'); expect(r.prep).toMatchObject({ kind: 'permanent', blocking: 'reconnect' }); });
  it('missing_permission ⇒ permission', async () => { const r = await run('missing_permission'); expect(r.prep).toMatchObject({ kind: 'permanent', blocking: 'permission' }); });
});

describe('tiktok metrics', () => {
  it('POST /v2/video/query/ with fields + video_ids; private deliveries are unsupported (never 0)', async () => {
    const t = new RecordingTransport(() => ok({ videos: [{ id: '7123456789012345678', view_count: 10, like_count: 2, comment_count: 1 }] }));
    const target = (ids: string[]) => ({ connection: conn(), credentials: creds, providerIds: ids, publishedAt: NOW.toISOString() });
    const out = await tiktokMetricsFetcher.fetch(ctxWith(t), target(['v_pub', '7123456789012345678']));
    expect(t.requests[0]!.url).toBe('https://open.tiktokapis.com/v2/video/query/?fields=id%2Cview_count%2Clike_count%2Ccomment_count%2Cshare_count');
    expect(JSON.parse(t.requests[0]!.body as string)).toEqual({ filters: { video_ids: ['7123456789012345678'] } });
    expect(out).toMatchObject({ kind: 'ok', points: [{ name: 'view_count', value: 10 }, { name: 'like_count', value: 2 }, { name: 'comment_count', value: 1 }], unavailable: [{ name: 'share_count' }] });
    expect((await tiktokMetricsFetcher.fetch(ctxWith(t), target(['v_pub_only']))).kind).toBe('unsupported');
  });
});
