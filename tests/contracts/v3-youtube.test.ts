// YouTube Data API v3 contract: Google OAuth (PKCE + offline), channel discovery, resumable upload (256 KiB-multiple
// chunks, 308 Range resume, final chunk = publish), explicit privacy, native scheduling (publishAt) + cancellation,
// processing reconcile, error table, simulator scenarios, Analytics metrics. No network. Sources: docs/providers/youtube.md.
import { describe, expect, it } from 'vitest';
import { TransportError, type Checkpoint, type PublishConnection } from '@social-lite/core';
import { MemoryMockStore } from '@social-lite/providers';
import { YOUTUBE_SCOPES, YT_CHUNK_BYTES, youtubeAdapter, youtubeConnector, youtubeFake, youtubeMetricsFetcher } from '../../packages/providers/src/youtube/index.js';
import { NOW, RecordingTransport, SCENARIOS, SECRET_ACCESS, SECRET_REFRESH, ctxWith, expectNoSecrets, inputOf, prepareUntilReady, res, simulated, video } from './v3-helpers.js';

const S = 'https://www.googleapis.com/auth/';
const ALL = YOUTUBE_SCOPES.join(' ');
const conn = (over: Partial<PublishConnection> = {}): PublishConnection => ({ id: 'c1', provider: 'youtube', providerAccountId: 'UC123', displayName: 'Channel', username: '@chan', isMock: false, metadata: { native_scheduling: true, granted_scopes: YOUTUBE_SCOPES }, ...over });
const creds = { kind: 'oauth2' as const, accessToken: SECRET_ACCESS, refreshToken: SECRET_REFRESH, expiresAt: '2026-11-07T13:00:00Z', scope: ALL };
const yt = (over: Record<string, unknown> = {}) => ({ youtube: { title: 'My video', privacyStatus: 'unlisted', madeForKids: false, ...over } });
const gErr = (status: number, reason: string) => () => res(status, { error: { code: status, message: `msg ${SECRET_ACCESS}`, errors: [{ reason, domain: 'youtube' }] } });

describe('youtube google oauth', () => {
  it('authorize URL: PKCE S256, offline + consent, granular scopes, state', () => {
    const u = new URL(youtubeConnector.authorizationUrl({ clientId: 'x.apps.googleusercontent.com' }, { state: 'st', codeChallenge: 'chal', redirectUri: 'https://app.example/api/oauth/youtube/callback' }));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: 'x.apps.googleusercontent.com', redirect_uri: 'https://app.example/api/oauth/youtube/callback', response_type: 'code',
      scope: `${S}youtube.upload ${S}youtube.readonly ${S}yt-analytics.readonly ${S}youtube.force-ssl`, access_type: 'offline', prompt: 'consent',
      include_granted_scopes: 'true', state: 'st', code_challenge: 'chal', code_challenge_method: 'S256',
    });
    expect(youtubeConnector.usesPkce).toBe(true);
  });

  it('token exchange and non-rotating refresh; errors never echo tokens', async () => {
    const t = new RecordingTransport(() => res(200, { access_token: SECRET_ACCESS, expires_in: 3599, refresh_token: SECRET_REFRESH, scope: `${S}youtube.upload ${S}youtube.readonly`, token_type: 'Bearer' }));
    const tokens = await youtubeConnector.exchangeCode(ctxWith(t), { code: 'c0de', codeVerifier: 'ver', redirectUri: 'https://r/cb' });
    expect([t.requests[0]!.url, t.requests[0]!.headers?.['content-type']]).toEqual(['https://oauth2.googleapis.com/token', 'application/x-www-form-urlencoded']);
    expect(Object.fromEntries(new URLSearchParams(t.requests[0]!.body as string))).toEqual({ client_id: 'cid', client_secret: 'csecret', code: 'c0de', code_verifier: 'ver', grant_type: 'authorization_code', redirect_uri: 'https://r/cb' });
    expect(tokens.scopes).toEqual([`${S}youtube.upload`, `${S}youtube.readonly`]);
    const r = new RecordingTransport(() => res(200, { access_token: 'new', expires_in: 3599, scope: ALL }));
    const out = await youtubeAdapter.refreshCredentials!(ctxWith(r), creds);
    expect(Object.fromEntries(new URLSearchParams(r.requests[0]!.body as string))).toEqual({ client_id: 'cid', client_secret: 'csecret', refresh_token: SECRET_REFRESH, grant_type: 'refresh_token' });
    expect(out.credentials).toMatchObject({ accessToken: 'new', refreshToken: SECRET_REFRESH });
    const bad = await youtubeAdapter.refreshCredentials!(ctxWith(new RecordingTransport(() => res(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }))), creds).catch((e: Error) => e);
    expect(bad).toMatchObject({ name: 'OAuthFlowError', permanent: true });
    expectNoSecrets((bad as Error).message);
  });

  it('channels.list mine=true ⇒ candidates; native scheduling only with youtube.force-ssl', async () => {
    const t = new RecordingTransport(() => res(200, { items: [{ id: 'UC123', snippet: { title: 'Chan', customUrl: '@chan' }, status: { longUploadsStatus: 'allowed' } }] }));
    const tokens = { accessToken: SECRET_ACCESS, refreshToken: SECRET_REFRESH, expiresAt: null, scopes: [`${S}youtube.upload`, `${S}youtube.readonly`] };
    const [c] = await youtubeConnector.listDestinations(ctxWith(t), tokens);
    expect(t.requests[0]!.url).toBe('https://www.googleapis.com/youtube/v3/channels?part=snippet%2Cstatus&mine=true');
    expect(c).toMatchObject({ providerAccountId: 'UC123', displayName: 'Chan', username: '@chan', unavailableReason: null, metadata: { long_uploads: 'allowed' } });
    const fin = await youtubeConnector.finalize(ctxWith(t), tokens, c!);
    expect(fin).toMatchObject({ health: { status: 'ready' }, metadata: { native_scheduling: false } });
    const noUpload = await youtubeConnector.listDestinations(ctxWith(t), { ...tokens, scopes: [`${S}youtube.readonly`] });
    expect(noUpload[0]!.unavailableReason).toMatch(/youtube\.upload/);
  });
});

describe('youtube required fields and capabilities', () => {
  it('title, explicit privacy and made-for-kids are required; description bytes; native schedule rules', () => {
    const v = (opts: Record<string, unknown>, c = conn(), text = 'Description') => youtubeAdapter.validate(inputOf(c, creds, { text, options: opts, format: 'video' }, [video(1000)])).issues.map((i) => i.code);
    expect(v({})).toEqual(expect.arrayContaining(['youtube_title_required', 'youtube_privacy_required', 'youtube_made_for_kids_required']));
    expect(v(yt())).toEqual([]);
    expect(v(yt({ title: 'x'.repeat(101) }))).toContain('youtube_title_too_long');
    expect(v(yt(), conn(), 'a < b')).toContain('youtube_angle_brackets');
    expect(v(yt(), conn(), 'é'.repeat(2600))).toContain('too_long');
    expect(v(yt({ privacyStatus: 'public', schedulingOwner: 'provider' }))).toEqual([]); // publishAt comes from Relay's schedule at dispatch
    expect(v(yt({ privacyStatus: 'public', schedulingOwner: 'provider', publishAt: 'not a date' }))).toContain('youtube_publish_at_invalid');
    expect(v(yt({ privacyStatus: 'public', schedulingOwner: 'provider', publishAt: '2026-11-08T10:00:00Z' }))).toEqual([]);
    expect(v(yt({ privacyStatus: 'public', schedulingOwner: 'provider', publishAt: '2026-11-08T10:00:00Z' }), conn({ metadata: { native_scheduling: false } }))).toContain('youtube_native_schedule_unavailable');
    expect(youtubeAdapter.validate(inputOf(conn(), creds, { options: yt() })).issues.map((i) => i.code)).toContain('youtube_video_required');
  });
  it('capabilities: video only, native scheduling flag, long uploads only when allowed', () => {
    expect(youtubeAdapter.capabilities(conn())).toMatchObject({ formats: ['video'], nativeScheduling: true, requiredOptions: ['youtube.title', 'youtube.privacyStatus', 'youtube.madeForKids'], constraints: { maxVideoSeconds: 900 } });
    expect(youtubeAdapter.capabilities(conn({ metadata: { long_uploads: 'allowed', native_scheduling: false } }))).toMatchObject({ nativeScheduling: false, constraints: { maxVideoSeconds: 43_200 } });
  });
});

describe('youtube resumable upload', () => {
  const total = YT_CHUNK_BYTES * 2 + 100;
  const mk = (scenario: (typeof SCENARIOS)[number] = 'success') => {
    const s = simulated(youtubeFake, 'youtube', 'mock_UC', scenario, new MemoryMockStore());
    const c = conn({ providerAccountId: 'mock_UC', isMock: true });
    return { s, c, inp: inputOf(c, { kind: 'mock', token: 'tok' }, { text: 'Desc', link: 'https://example.com/x', options: yt({ tags: ['a b', 'c'], categoryId: '22' }), format: 'video' }, [video(total)]) };
  };

  it('init (exact URL, headers, explicit privacy), chunks with Content-Range (308), final chunk publishes (201 ⇒ processing)', async () => {
    const { s, c, inp } = mk();
    const { checkpoint } = await prepareUntilReady(youtubeAdapter, s.ctx, s.clock, inp);
    const [init, p0, p1] = s.state.calls;
    expect([init!.method, init!.url]).toEqual(['POST', 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet%2Cstatus']);
    expect(init!.headers).toMatchObject({ authorization: 'Bearer tok', 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-length': String(total), 'x-upload-content-type': 'video/mp4' });
    expect(JSON.parse(init!.body as string)).toEqual({ snippet: { title: 'My video', description: 'Desc\n\nhttps://example.com/x', tags: ['a b', 'c'], categoryId: '22' }, status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false } });
    expect([p0!.method, p0!.headers?.['content-range'], p0!.headers?.['content-type']]).toEqual(['PUT', `bytes 0-${YT_CHUNK_BYTES - 1}/${total}`, 'video/mp4']);
    expect(p1!.headers?.['content-range']).toBe(`bytes ${YT_CHUNK_BYTES}-${2 * YT_CHUNK_BYTES - 1}/${total}`);
    expect(YT_CHUNK_BYTES % (256 * 1024)).toBe(0);
    expect(s.state.calls).toHaveLength(3);
    expect(checkpoint).toMatchObject({ step: 'upload_ready', data: { nextByte: 2 * YT_CHUNK_BYTES, total } });
    const out = await youtubeAdapter.publish(s.ctx, inp, checkpoint);
    const fin = s.state.calls.at(-1)!;
    expect([fin.method, fin.publishes, fin.headers?.['content-range']]).toEqual(['PUT', true, `bytes ${2 * YT_CHUNK_BYTES}-${total - 1}/${total}`]);
    expect(out).toMatchObject({ kind: 'processing', checkpoint: { step: 'uploaded' } });
    const id = (out as { providerIds: string[] }).providerIds[0]!;
    const rec = await youtubeAdapter.reconcile(s.ctx, { deliveryId: 'd', connection: c, credentials: inp.credentials, variantText: '', providerIds: [id], checkpoint: null, sentAt: null });
    expect(s.state.calls.at(-1)!.url).toBe(`https://www.googleapis.com/youtube/v3/videos?part=status%2CprocessingDetails&id=${id}`);
    expect(rec).toMatchObject({ kind: 'published', providerIds: [id], url: null });
  });

  it('resume after a failed chunk: session status query (bytes */total) then continue — never re-init', async () => {
    const { s, inp } = mk();
    let n = 0;
    s.state.failOn = (r) => r.method === 'PUT' && ++n === 2;
    const first = await youtubeAdapter.prepare(s.ctx, inp, null);
    expect(first).toMatchObject({ kind: 'retryable', checkpoint: { step: 'uploading', data: { nextByte: YT_CHUNK_BYTES } } });
    const { checkpoint } = await prepareUntilReady(youtubeAdapter, s.ctx, s.clock, inp, (first as { checkpoint: Checkpoint }).checkpoint);
    const status = s.state.calls.find((r) => r.headers?.['content-range'] === `bytes */${total}`)!;
    expect(status.headers?.['content-length']).toBe('0');
    expect(s.state.calls.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(checkpoint.data.nextByte).toBe(2 * YT_CHUNK_BYTES);
  });

  it('lost final response ⇒ unknown; reconcile asks the session (201 ⇒ video id) instead of uploading again', async () => {
    const { s, c, inp } = mk('timeout_after_send');
    const { checkpoint } = await prepareUntilReady(youtubeAdapter, s.ctx, s.clock, inp);
    expect((await youtubeAdapter.publish(s.ctx, inp, checkpoint)).kind).toBe('unknown');
    const rec = await youtubeAdapter.reconcile(s.ctx, { deliveryId: 'd', connection: c, credentials: inp.credentials, variantText: '', providerIds: [], checkpoint, sentAt: null });
    expect(rec.kind).toBe('published');
    // And a re-prepare from the same checkpoint sees the completed session (no second upload).
    const again = await youtubeAdapter.prepare(s.ctx, inp, checkpoint);
    expect(again).toMatchObject({ kind: 'ready', checkpoint: { step: 'uploaded' } });
    expect((await youtubeAdapter.publish(s.ctx, inp, (again as { checkpoint: Checkpoint }).checkpoint)).kind).toBe('processing');
    expect(s.state.calls.filter((r) => r.publishes)).toHaveLength(1);
  });

  it('session expired (404) on resume ⇒ a new session; on the final chunk ⇒ safe retry (no video)', async () => {
    const t = new RecordingTransport((r) => (r.method === 'PUT' ? res(404, { error: { code: 404, message: 'gone', errors: [{ reason: 'notFound' }] } }) : { status: 200, headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=new' }, body: '' }));
    const inp = inputOf(conn(), creds, { options: yt(), format: 'video' }, [video(1000)]);
    const old = { step: 'uploading', data: { assetId: 'vid1', sessionUri: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=old', total: 1000, nextByte: 0, chunkSize: YT_CHUNK_BYTES, mime: 'video/mp4' } };
    const p = await youtubeAdapter.prepare(ctxWith(t), inp, old);
    expect(p).toMatchObject({ kind: 'ready', checkpoint: { data: { sessionUri: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=new' } } });
    expect(await youtubeAdapter.publish(ctxWith(t), inp, (p as { checkpoint: Checkpoint }).checkpoint)).toMatchObject({ kind: 'rejected_safe_to_retry', code: 'youtube_session_expired' });
  });
});

describe('youtube error table (final chunk)', () => {
  const inp = inputOf(conn(), creds, { options: yt(), format: 'video' }, [video(1000)]);
  const cp = { step: 'upload_ready', data: { assetId: 'vid1', sessionUri: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=u', total: 1000, nextByte: 0, chunkSize: YT_CHUNK_BYTES, mime: 'video/mp4' } };
  const cases: Array<[string, () => ReturnType<typeof res>, Record<string, unknown>]> = [
    ['403 quotaExceeded ⇒ budget', gErr(403, 'quotaExceeded'), { kind: 'permanent_failure', blocking: 'budget', code: 'youtube_quota_exceeded' }],
    ['400 uploadLimitExceeded ⇒ retry in 24 h', gErr(400, 'uploadLimitExceeded'), { kind: 'rejected_safe_to_retry', retryAfterMs: 24 * 3600_000 }],
    ['403 rateLimitExceeded ⇒ retry', gErr(403, 'rateLimitExceeded'), { kind: 'rejected_safe_to_retry', code: 'rate_limited' }],
    ['401 ⇒ reconnect', gErr(401, 'authError'), { kind: 'permanent_failure', blocking: 'reconnect' }],
    ['401 youtubeSignupRequired ⇒ permission', gErr(401, 'youtubeSignupRequired'), { kind: 'permanent_failure', blocking: 'permission', code: 'youtube_channel_required' }],
    ['403 forbidden ⇒ permission', gErr(403, 'forbidden'), { kind: 'permanent_failure', blocking: 'permission' }],
    ['400 invalidTitle ⇒ permanent', gErr(400, 'invalidTitle'), { kind: 'permanent_failure', code: 'youtube_invalidTitle' }],
    ['503 ⇒ unknown', gErr(503, 'backendError'), { kind: 'unknown' }],
  ];
  it.each(cases)('%s', async (_n, respond, expected) => {
    const out = await youtubeAdapter.publish(ctxWith(new RecordingTransport(respond)), inp, cp);
    expect(out).toMatchObject(expected);
    expectNoSecrets(out);
  });
  it('transport before connect ⇒ safe retry; after send ⇒ unknown', async () => {
    expect((await youtubeAdapter.publish(ctxWith(new RecordingTransport(() => { throw new TransportError('x', 'connect', false); })), inp, cp)).kind).toBe('rejected_safe_to_retry');
    expect((await youtubeAdapter.publish(ctxWith(new RecordingTransport(() => { throw new TransportError('x', 'timeout', true); })), inp, cp)).kind).toBe('unknown');
  });
});

describe('youtube native scheduling (publishAt) and pause cancellation', () => {
  it('provider-held release: private + publishAt in the request; checkpoint carries remoteSchedule; reconcile waits until release', async () => {
    const s = simulated(youtubeFake, 'youtube', 'mock_UC2');
    const c = conn({ providerAccountId: 'mock_UC2', isMock: true });
    const inp = inputOf(c, { kind: 'mock', token: 'tok' }, { options: yt({ privacyStatus: 'public', schedulingOwner: 'provider', publishAt: '2026-11-09T09:00:00Z' }), format: 'video' }, [video(5000)]);
    const { checkpoint } = await prepareUntilReady(youtubeAdapter, s.ctx, s.clock, inp);
    expect(JSON.parse(s.state.calls[0]!.body as string).status).toEqual({ privacyStatus: 'private', publishAt: '2026-11-09T09:00:00.000Z', selfDeclaredMadeForKids: false });
    const out = await youtubeAdapter.publish(s.ctx, inp, checkpoint);
    expect(out).toMatchObject({ kind: 'processing', checkpoint: { data: { remoteSchedule: { provider: 'youtube', publishAt: '2026-11-09T09:00:00.000Z' } } } });
    const ref = { deliveryId: 'd', connection: c, credentials: inp.credentials, variantText: '', providerIds: (out as { providerIds: string[] }).providerIds, checkpoint: (out as { checkpoint: Checkpoint }).checkpoint, sentAt: null };
    expect(await youtubeAdapter.reconcile(s.ctx, ref)).toMatchObject({ kind: 'processing', checkAfterMs: 3_600_000 });
    // Pause: videos.update(status) without publishAt, then re-read ⇒ cancelled.
    const cancel = await youtubeAdapter.cancelRemoteSchedule!(s.ctx, ref);
    const upd = s.state.calls.find((r) => r.method === 'PUT' && r.url.includes('/youtube/v3/videos?part=status'))!;
    expect(upd.url).toBe('https://www.googleapis.com/youtube/v3/videos?part=status');
    expect(JSON.parse(upd.body as string)).toEqual({ id: ref.providerIds[0], status: { privacyStatus: 'private', selfDeclaredMadeForKids: false } });
    expect(cancel).toMatchObject({ kind: 'cancelled' });
    expect(await youtubeAdapter.reconcile(s.ctx, ref)).toMatchObject({ kind: 'published' }); // stays private, never released
  });

  it('cancellation reports residual risk honestly: uncertain on failure, too_late when public, unsupported without force-ssl', async () => {
    const ref = (c = creds) => ({ deliveryId: 'd', connection: conn(), credentials: c, variantText: '', providerIds: ['vid'], checkpoint: null, sentAt: null });
    const scheduled = res(200, { items: [{ id: 'vid', status: { uploadStatus: 'processed', privacyStatus: 'private', publishAt: '2026-11-09T09:00:00Z' } }] });
    const failing = new RecordingTransport((r) => (r.method === 'GET' ? scheduled : res(503, { error: { code: 503, message: 'x', errors: [{ reason: 'backendError' }] } })));
    expect(await youtubeAdapter.cancelRemoteSchedule!(ctxWith(failing), ref())).toMatchObject({ kind: 'uncertain', scheduledFor: '2026-11-09T09:00:00Z' });
    const stillScheduled = new RecordingTransport((r) => (r.method === 'GET' ? scheduled : res(200, {})));
    expect((await youtubeAdapter.cancelRemoteSchedule!(ctxWith(stillScheduled), ref())).kind).toBe('uncertain');
    const pub = new RecordingTransport(() => res(200, { items: [{ id: 'vid', status: { uploadStatus: 'processed', privacyStatus: 'public' } }] }));
    expect((await youtubeAdapter.cancelRemoteSchedule!(ctxWith(pub), ref())).kind).toBe('too_late');
    expect((await youtubeAdapter.cancelRemoteSchedule!(ctxWith(pub), ref({ ...creds, scope: `${S}youtube.upload ${S}youtube.readonly` }))).kind).toBe('unsupported');
  });
});

describe('youtube simulator scenarios', () => {
  async function run(scenario: (typeof SCENARIOS)[number]) {
    const s = simulated(youtubeFake, 'youtube', 'mock_UCs', scenario);
    const c = conn({ providerAccountId: 'mock_UCs', isMock: true });
    const inp = inputOf(c, { kind: 'mock', token: 'tok' }, { options: yt(), format: 'video' }, [video(3000)]);
    let prep = await youtubeAdapter.prepare(s.ctx, inp, null);
    if (prep.kind === 'retryable') prep = await youtubeAdapter.prepare(s.ctx, inp, prep.checkpoint ?? null);
    const cp = prep.kind === 'ready' ? prep.checkpoint : null;
    let first = cp ? await youtubeAdapter.publish(s.ctx, inp, cp) : null;
    if (first?.kind === 'rejected_safe_to_retry' && cp) first = await youtubeAdapter.publish(s.ctx, inp, cp);
    const ids = first && 'providerIds' in first ? first.providerIds ?? [] : [];
    const recon = () => youtubeAdapter.reconcile(s.ctx, { deliveryId: 'd', connection: c, credentials: inp.credentials, variantText: '', providerIds: ids, checkpoint: cp, sentAt: null });
    return { prep, first, recon };
  }
  it('success', async () => { const r = await run('success'); expect(r.first?.kind).toBe('processing'); expect((await r.recon()).kind).toBe('published'); });
  it('processing ⇒ polls then published', async () => { const r = await run('processing'); expect((await r.recon()).kind).toBe('processing'); expect((await r.recon()).kind).toBe('processing'); expect((await r.recon()).kind).toBe('published'); });
  it('fail_permanent ⇒ not published (codec)', async () => { const r = await run('fail_permanent'); expect(await r.recon()).toMatchObject({ kind: 'not_published', reason: expect.stringContaining('codec') }); });
  it('fail_transient_once ⇒ retried safely', async () => { const r = await run('fail_transient_once'); expect(r.first?.kind).toBe('processing'); });
  it('rate_limited_once ⇒ init retried', async () => { const r = await run('rate_limited_once'); expect(r.prep.kind).toBe('ready'); expect(r.first?.kind).toBe('processing'); });
  it('timeout_after_send ⇒ unknown ⇒ reconciled', async () => { const r = await run('timeout_after_send'); expect(r.first?.kind).toBe('unknown'); expect((await r.recon()).kind).toBe('published'); });
  it('revoked ⇒ reconnect', async () => { const r = await run('revoked'); expect(r.prep).toMatchObject({ kind: 'permanent', blocking: 'reconnect' }); });
  it('missing_permission ⇒ permission', async () => { const r = await run('missing_permission'); expect(r.prep).toMatchObject({ kind: 'permanent', blocking: 'permission' }); });
});

describe('youtube analytics metrics', () => {
  it('reports query: ids=channel==MINE, dates, metric list, filters=video==ID; rows absent ⇒ unavailable (not 0)', async () => {
    const t = new RecordingTransport(() => res(200, { kind: 'youtubeAnalytics#resultTable', columnHeaders: [{ name: 'views' }, { name: 'likes' }], rows: [[120, 7]] }));
    const target = { connection: conn(), credentials: creds, providerIds: ['vid1'], publishedAt: '2026-11-01T10:00:00Z' };
    const out = await youtubeMetricsFetcher.fetch(ctxWith(t), target);
    const u = new URL(t.requests[0]!.url);
    expect(u.origin + u.pathname).toBe('https://youtubeanalytics.googleapis.com/v2/reports');
    expect(Object.fromEntries(u.searchParams)).toEqual({ ids: 'channel==MINE', startDate: '2026-11-01', endDate: NOW.toISOString().slice(0, 10), metrics: 'views,estimatedMinutesWatched,averageViewDuration,likes,comments,shares,subscribersGained', filters: 'video==vid1' });
    expect(out).toMatchObject({ kind: 'ok', points: [{ name: 'views', value: 120 }, { name: 'likes', value: 7 }] });
    expect((out as { unavailable: unknown[] }).unavailable).toHaveLength(5);
    const empty = await youtubeMetricsFetcher.fetch(ctxWith(new RecordingTransport(() => res(200, { columnHeaders: [] }))), target);
    expect(empty).toMatchObject({ kind: 'ok', points: [] });
    expect((await youtubeMetricsFetcher.fetch(ctxWith(t), { ...target, credentials: { ...creds, scope: `${S}youtube.upload` } })).kind).toBe('permission_missing');
    expect((await youtubeMetricsFetcher.fetch(ctxWith(new RecordingTransport(gErr(403, 'quotaExceeded'))), target)).kind).toBe('budget');
  });
});
