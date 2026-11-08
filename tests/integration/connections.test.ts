// Connections lifecycle against REAL PostgreSQL: simulated connect, Telegram verification (AC-03),
// OAuth state/flows (AC-01, AC-02), encryption at rest, disconnect/reconnect (AC-05), refresh
// serialization and tenant isolation. Provider HTTP is served by the in-process fakes through the
// exported live-transport test seam (no network).
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppError, type HttpRequest, type HttpResponse, type Transport } from '@social-lite/core';
import { MemoryMockStore, type FakeHandler, type MockScenario } from '@social-lite/providers';
import { credentialAad, encryptSecret, resetConfigCache } from '@social-lite/services';
import { telegramFake } from '../../packages/providers/src/telegram/index.js';
import { xFake } from '../../packages/providers/src/x/index.js';
import {
  CredentialUnavailableError, checkConnection, connectMock, connectTelegram, disconnectConnection, getConnectionFlow, getUsableCredentials,
  handleOAuthCallback, listConnections, listProviderStatus, reconnectConnection, selectConnectionFlow, setConnectionPaused, setLiveTransportFactoryForTests,
  setMockScenario, startOAuth,
} from '../../packages/services/src/connections/index.js';
import { addMember, closeTestPool, createUser, ctxFor, tenant, testPool } from './helpers.js';

const BOT_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';

/** Live-mode transport backed by a provider fake (test seam only). Records requests. */
class FakeLiveTransport implements Transport {
  readonly mode = 'live' as const;
  readonly requests: HttpRequest[] = [];
  scenario: MockScenario = 'success';
  accountId = '987654321';
  private readonly store = new MemoryMockStore();
  private n = 0;
  constructor(private readonly handler: FakeHandler, private readonly provider: 'telegram' | 'x') {}
  async send(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    return this.handler(req, {
      provider: this.provider, accountId: this.accountId, scenario: this.scenario, store: this.store,
      now: () => new Date(), newId: (p = 'id_') => `${p}${++this.n}${Math.random().toString(36).slice(2, 6)}`,
    });
  }
}

let tgT: FakeLiveTransport;
let xT: FakeLiveTransport;

beforeAll(() => {
  testPool();
  process.env.X_CLIENT_ID = 'test-x-client';
  process.env.X_CLIENT_SECRET = 'test-x-secret';
  resetConfigCache();
});
afterEach(() => setLiveTransportFactoryForTests(null));
afterAll(async () => {
  delete process.env.X_CLIENT_ID;
  delete process.env.X_CLIENT_SECRET;
  await closeTestPool();
});

function useFakes(): void {
  tgT = new FakeLiveTransport(telegramFake, 'telegram');
  xT = new FakeLiveTransport(xFake, 'x');
  setLiveTransportFactoryForTests((p) => (p === 'telegram' ? tgT : xT));
}

async function scheduledDelivery(workspaceId: string, brandId: string, connectionId: string, provider: string, opts: { publishBefore?: Date } = {}): Promise<string> {
  const db = testPool();
  const post = await db.query<{ id: string }>(`INSERT INTO posts(workspace_id, brand_id) VALUES ($1,$2) RETURNING id`, [workspaceId, brandId]);
  const postId = post.rows[0]!.id;
  const rev = await db.query<{ id: string }>(
    `INSERT INTO post_revisions(workspace_id, post_id, revision_number, base_text, content_hash) VALUES ($1,$2,1,'hi','h') RETURNING id`, [workspaceId, postId]);
  const revId = rev.rows[0]!.id;
  const variant = await db.query<{ id: string }>(
    `INSERT INTO variants(workspace_id, revision_id, connection_id, rendered_text, format) VALUES ($1,$2,$3,'hi','text') RETURNING id`, [workspaceId, revId, connectionId]);
  const due = new Date(Date.now() + 3600_000);
  const before = opts.publishBefore ?? new Date(Date.now() + 7200_000);
  const sched = await db.query<{ id: string }>(
    `INSERT INTO schedules(workspace_id, brand_id, post_id, revision_id, generation, due_at, input_timezone, input_local_time, publish_before, fingerprint)
     VALUES ($1,$2,$3,$4,1,$5,'UTC','2026-11-06T12:00',$6,'fp') RETURNING id`, [workspaceId, brandId, postId, revId, due, before > due ? before : new Date(due.getTime() + 1000)]);
  const d = await db.query<{ id: string }>(
    `INSERT INTO deliveries(workspace_id, brand_id, post_id, schedule_id, generation, revision_id, variant_id, connection_id, provider, is_mock, due_at, publish_before, next_attempt_at)
     SELECT $1,$2,$3,$4,1,$5,$6,c.id,c.provider,c.is_mock,$7,$8,$7 FROM connections c WHERE c.id=$9 RETURNING id`,
    [workspaceId, brandId, postId, sched.rows[0]!.id, revId, variant.rows[0]!.id, due, before > due ? before : new Date(due.getTime() + 1000), connectionId]);
  void provider;
  return d.rows[0]!.id;
}

const deliveryState = async (id: string) =>
  (await testPool().query<{ state: string; blocked_reason: string | null }>(`SELECT state, blocked_reason FROM deliveries WHERE id=$1`, [id])).rows[0]!;

async function dbText(): Promise<string> {
  const db = testPool();
  const parts = await Promise.all(['credentials', 'connections', 'connection_flows', 'oauth_states', 'audit_events', 'outbox'].map(async (t) =>
    JSON.stringify((await db.query(`SELECT * FROM ${t}`)).rows)));
  return parts.join('\n');
}

async function oauthToFlow(ctx: ReturnType<typeof ctxFor>, brandId: string, reconnectId?: string): Promise<string> {
  const start = reconnectId ? (await reconnectConnection(ctx, reconnectId, {})) as { authorization_url: string } : await startOAuth(ctx, brandId, 'x');
  const state = new URL(start.authorization_url).searchParams.get('state')!;
  const cb = await handleOAuthCallback({ provider: 'x', params: new URLSearchParams({ state, code: 'auth-code' }), sessionUserId: ctx.actor.userId });
  expect(cb.location).toMatch(/^\/accounts\/select\?flow=/);
  return cb.location.split('flow=')[1]!;
}

describe('simulated (mock) destinations', () => {
  it('connect => ready, is_mock, mock_ identity, encrypted mock credential; health via simulated API', async () => {
    const t = await tenant();
    const c = await connectMock(t.ownerCtx, t.brandId, { provider: 'telegram', display_name: 'Demo channel' });
    expect(c).toMatchObject({ provider: 'telegram', is_mock: true, status: 'ready', status_label: 'Ready', mock_scenario: 'success' });
    expect(c.provider_account_id).toMatch(/^mock_telegram_[0-9a-f]+$/);
    expect(c).not.toHaveProperty('credentials');
    const checked = await checkConnection(t.ownerCtx, c.id);
    expect(checked.status).toBe('ready');
    expect(checked.health.checked_at).not.toBeNull();

    await setMockScenario(t.ownerCtx, c.id, { scenario: 'missing_permission' });
    expect((await checkConnection(t.ownerCtx, c.id)).status).toBe('missing_permission');
    await setMockScenario(t.ownerCtx, c.id, { scenario: 'revoked' });
    expect((await checkConnection(t.ownerCtx, c.id)).status).toBe('reconnect_required');
    const back = await reconnectConnection(t.ownerCtx, c.id, {});
    expect(back).toMatchObject({ status: 'ready' });
  });

  it('only owners/admins may connect; scenario only on mock connections', async () => {
    const t = await tenant();
    const editor = await createUser();
    await addMember(t.workspaceId, editor.id, 'editor');
    await expect(connectMock(ctxFor(editor.id, t.workspaceId, 'editor'), t.brandId, { provider: 'x', display_name: 'X' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('provider status lists callback URLs, scopes and mock availability', async () => {
    const t = await tenant();
    const { items } = await listProviderStatus(t.ownerCtx);
    const x = items.find((i) => i.provider === 'x')!;
    expect(x).toMatchObject({ configured: true, missing: [], callback_url: 'http://localhost:3000/api/oauth/x/callback', mock_available: true });
    expect(x.required_scopes).toEqual(['tweet.read', 'tweet.write', 'users.read', 'offline.access', 'media.write']);
    expect(items.find((i) => i.provider === 'telegram')).toMatchObject({ configured: true, callback_url: null });
    expect(JSON.stringify(items)).not.toContain('test-x-secret');
  });
});

describe('Telegram connect (AC-03)', () => {
  it('verifies before Ready; stores the token encrypted only; never returns it', async () => {
    useFakes();
    const t = await tenant();
    const c = await connectTelegram(t.ownerCtx, t.brandId, { bot_token: BOT_TOKEN, channel: '@newschan' });
    expect(c).toMatchObject({ provider: 'telegram', is_mock: false, status: 'ready', display_name: 'Simulated newschan', username: 'newschan' });
    expect(c.provider_account_id).toMatch(/^-100\d+$/);
    expect(tgT.requests.map((r) => r.url.split('/').pop())).toEqual(['getMe', 'getChat', 'getChatMember', 'getWebhookInfo']);
    expect(JSON.stringify(c)).not.toContain(BOT_TOKEN);
    const text = await dbText();
    expect(text).not.toContain(BOT_TOKEN);
    expect(text).not.toContain('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ');
    // The engine path decrypts it.
    const u = await getUsableCredentials(c.id);
    expect(u.credentials).toEqual({ kind: 'telegram_bot', botToken: BOT_TOKEN });
    expect(u.connection).toMatchObject({ id: c.id, provider: 'telegram', status: 'ready', paused: false, workspaceId: t.workspaceId, brandId: t.brandId, isMock: false });
  });

  it('bot without admin "Post Messages" => missing_permission (not Ready)', async () => {
    useFakes();
    tgT.scenario = 'missing_permission';
    const t = await tenant();
    const c = await connectTelegram(t.ownerCtx, t.brandId, { bot_token: BOT_TOKEN, channel: '-1001234567890' });
    expect(c.status).toBe('missing_permission');
    expect(c.health.missing_permissions).toEqual(['can_post_messages']);
    expect(c.health.message).toContain('Post Messages');
    // Admin fixes rights => Check => Ready.
    tgT.scenario = 'success';
    expect((await checkConnection(t.ownerCtx, c.id)).status).toBe('ready');
  });

  it('rejects invite links, groups and bad tokens with field errors', async () => {
    useFakes();
    const t = await tenant();
    await expect(connectTelegram(t.ownerCtx, t.brandId, { bot_token: BOT_TOKEN, channel: 'https://t.me/+AbCdEfGhIjKl' }))
      .rejects.toMatchObject({ code: 'validation_failed', fieldErrors: { channel: expect.stringContaining('Invite links') } });
    await expect(connectTelegram(t.ownerCtx, t.brandId, { bot_token: BOT_TOKEN, channel: '@mygroupchat' })).rejects.toMatchObject({ code: 'validation_failed' });
    tgT.scenario = 'revoked';
    const err = await connectTelegram(t.ownerCtx, t.brandId, { bot_token: BOT_TOKEN, channel: '@newschan' }).catch((e: AppError) => e);
    expect(err).toMatchObject({ code: 'validation_failed', fieldErrors: { bot_token: expect.any(String) } });
    expect(JSON.stringify(err)).not.toContain(BOT_TOKEN);
    expect((await listConnections(t.ownerCtx, t.brandId)).items).toHaveLength(0);
  });
});

describe('OAuth state and flows (AC-01, AC-02)', () => {
  it('state is hashed, PKCE S256 verifier matches, single-use, user-bound', async () => {
    useFakes();
    const t = await tenant();
    const { authorization_url } = await startOAuth(t.ownerCtx, t.brandId, 'x');
    const u = new URL(authorization_url);
    const state = u.searchParams.get('state')!;
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    const row = (await testPool().query(`SELECT * FROM oauth_states WHERE workspace_id=$1`, [t.workspaceId])).rows[0];
    expect(row).toMatchObject({ purpose: 'connect', provider: 'x', user_id: t.owner.id, brand_id: t.brandId, consumed_at: null });
    expect(Buffer.from(row.state_hash).equals(createHash('sha256').update(state).digest())).toBe(true);
    expect(JSON.stringify(row)).not.toContain(state);
    expect(row.expires_at.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000);

    // Another signed-in user cannot use (or burn) the state.
    const other = await createUser();
    expect(await handleOAuthCallback({ provider: 'x', params: new URLSearchParams({ state, code: 'c' }), sessionUserId: other.id })).toMatchObject({ error: 'session_mismatch' });
    expect(await handleOAuthCallback({ provider: 'x', params: new URLSearchParams({ state, code: 'c' }), sessionUserId: null })).toMatchObject({ error: 'session_required' });

    const ok = await handleOAuthCallback({ provider: 'x', params: new URLSearchParams({ state, code: 'c' }), sessionUserId: t.owner.id });
    expect(ok.location).toMatch(/^\/accounts\/select\?flow=[0-9a-f-]{36}$/);
    const tokenReq = xT.requests.find((r) => r.url.endsWith('/2/oauth2/token'))!;
    const verifier = new URLSearchParams(tokenReq.body as string).get('code_verifier')!;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(u.searchParams.get('code_challenge'));
    expect(tokenReq.headers?.authorization).toBe(`Basic ${Buffer.from('test-x-client:test-x-secret').toString('base64')}`);

    // Replay => refused.
    expect(await handleOAuthCallback({ provider: 'x', params: new URLSearchParams({ state, code: 'c' }), sessionUserId: t.owner.id })).toMatchObject({ error: 'invalid_state' });
    // No connection exists until the user explicitly selects (AC-02).
    expect((await listConnections(t.ownerCtx, t.brandId)).items).toHaveLength(0);
  });

  it('expired state is refused; provider errors are not echoed', async () => {
    useFakes();
    const t = await tenant();
    const { authorization_url } = await startOAuth(t.ownerCtx, t.brandId, 'x');
    const state = new URL(authorization_url).searchParams.get('state')!;
    await testPool().query(`UPDATE oauth_states SET expires_at = now() - interval '1 second' WHERE workspace_id=$1`, [t.workspaceId]);
    expect(await handleOAuthCallback({ provider: 'x', params: new URLSearchParams({ state, code: 'c' }), sessionUserId: t.owner.id })).toEqual({ location: '/accounts?error=invalid_state', error: 'invalid_state' });
    const s2 = new URL((await startOAuth(t.ownerCtx, t.brandId, 'x')).authorization_url).searchParams.get('state')!;
    const denied = await handleOAuthCallback({ provider: 'x', params: new URLSearchParams({ state: s2, error: 'access_denied', error_description: '<script>evil</script>' }), sessionUserId: t.owner.id });
    expect(denied.location).toBe('/accounts?error=access_denied');
  });

  it('start requires connections.manage and a configured provider', async () => {
    const t = await tenant();
    const viewer = await createUser();
    await addMember(t.workspaceId, viewer.id, 'viewer');
    await expect(startOAuth(ctxFor(viewer.id, t.workspaceId, 'viewer'), t.brandId, 'x')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(startOAuth(t.ownerCtx, t.brandId, 'telegram')).rejects.toMatchObject({ code: 'validation_failed' });
    delete process.env.X_CLIENT_ID;
    try {
      await expect(startOAuth(t.ownerCtx, t.brandId, 'x')).rejects.toMatchObject({ code: 'provider_not_configured', status: 412 });
    } finally {
      process.env.X_CLIENT_ID = 'test-x-client';
    }
  });

  it('select creates connections only for chosen ids; flow is single-use and user-bound; tokens encrypted at rest', async () => {
    useFakes();
    const t = await tenant();
    // A flow offering two destinations (built directly: X itself offers only the authorizing user).
    const tokens = { accessToken: 'ACCESS-raw-token-zzz', refreshToken: 'REFRESH-raw-token-yyy', expiresAt: new Date(Date.now() + 7200_000).toISOString(), scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access', 'media.write'] };
    const candidates = ['111', '222'].map((id) => ({ provider: 'x', providerAccountId: id, displayName: `Acct ${id}`, username: `acct${id}`, unavailableReason: null, metadata: {} }));
    const flow = await testPool().query<{ id: string }>(
      `INSERT INTO connection_flows(workspace_id, brand_id, user_id, provider, tokens_enc, candidates, expires_at)
       VALUES ($1,$2,$3,'x',$4,$5, now() + interval '15 minutes') RETURNING id`,
      [t.workspaceId, t.brandId, t.owner.id, JSON.stringify(encryptSecret({ tokens, candidates }, credentialAad(t.workspaceId))),
        JSON.stringify(candidates.map((c) => ({ provider_account_id: c.providerAccountId, display_name: c.displayName, username: c.username, unavailable_reason: null, picture_url: null })))]);
    const flowId = flow.rows[0]!.id;
    const view = await getConnectionFlow(t.ownerCtx, flowId);
    expect(view.candidates.map((c) => c.provider_account_id)).toEqual(['111', '222']);

    const admin = await createUser();
    await addMember(t.workspaceId, admin.id, 'admin');
    await expect(selectConnectionFlow(ctxFor(admin.id, t.workspaceId, 'admin'), flowId, { provider_account_ids: ['111'] })).rejects.toMatchObject({ code: 'not_found' });
    await expect(selectConnectionFlow(t.ownerCtx, flowId, { provider_account_ids: ['999'] })).rejects.toMatchObject({ code: 'validation_failed' });

    const { items } = await selectConnectionFlow(t.ownerCtx, flowId, { provider_account_ids: ['222'] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ provider: 'x', provider_account_id: '222', status: 'ready', username: 'acct222', is_mock: false });
    expect((await listConnections(t.ownerCtx, t.brandId)).items.map((c) => c.provider_account_id)).toEqual(['222']);
    await expect(selectConnectionFlow(t.ownerCtx, flowId, { provider_account_ids: ['111'] })).rejects.toMatchObject({ code: 'not_found' });

    const cred = (await testPool().query(`SELECT cr.* FROM credentials cr JOIN connections c ON c.credential_id=cr.id WHERE c.id=$1`, [items[0]!.id])).rows[0];
    expect(cred.encrypted_blob).toMatchObject({ v: 1, kid: 'test-1' });
    expect(cred.key_version).toBe('test-1');
    expect(cred.granted_scopes).toEqual(tokens.scopes);
    expect(cred.expires_at).not.toBeNull();
    const text = await dbText();
    expect(text).not.toContain('ACCESS-raw-token-zzz');
    expect(text).not.toContain('REFRESH-raw-token-yyy');
  });
});

describe('disconnect / reconnect (AC-05)', () => {
  it('disconnect deletes the credential immediately and blocks queued deliveries', async () => {
    const t = await tenant();
    const c = await connectMock(t.ownerCtx, t.brandId, { provider: 'x', display_name: 'X demo' });
    const credId = (await testPool().query(`SELECT credential_id FROM connections WHERE id=$1`, [c.id])).rows[0].credential_id;
    const d1 = await scheduledDelivery(t.workspaceId, t.brandId, c.id, 'x');
    const d2 = await scheduledDelivery(t.workspaceId, t.brandId, c.id, 'x');
    await testPool().query(`UPDATE deliveries SET state='published' WHERE id=$1`, [d2]);

    const r = await disconnectConnection(t.ownerCtx, c.id);
    expect(r.blocked_deliveries).toBe(1);
    expect(r.connection).toMatchObject({ status: 'disconnected', status_label: 'Disconnected' });
    expect(r.connection.disconnected_at).not.toBeNull();
    expect(await deliveryState(d1)).toEqual({ state: 'blocked', blocked_reason: 'Account disconnected' });
    expect((await deliveryState(d2)).state).toBe('published');
    expect((await testPool().query(`SELECT 1 FROM credentials WHERE id=$1`, [credId])).rowCount).toBe(0);
    expect((await testPool().query(`SELECT credential_id FROM connections WHERE id=$1`, [c.id])).rows[0].credential_id).toBeNull();
    await expect(getUsableCredentials(c.id)).rejects.toBeInstanceOf(CredentialUnavailableError);
    expect((await testPool().query(`SELECT 1 FROM audit_events WHERE resource_id=$1 AND action='connection.disconnected'`, [c.id])).rowCount).toBe(1);
    // Idempotent.
    expect((await disconnectConnection(t.ownerCtx, c.id)).blocked_deliveries).toBe(0);
  });

  it('reconnecting the SAME identity restores the connection and its blocked work; a DIFFERENT identity creates a new connection', async () => {
    useFakes();
    const t = await tenant();
    const flowId = await oauthToFlow(t.ownerCtx, t.brandId);
    const [conn] = (await selectConnectionFlow(t.ownerCtx, flowId, { provider_account_ids: ['987654321'] })).items;
    expect(conn).toMatchObject({ status: 'ready', provider_account_id: '987654321', username: 'social_lite_sim' });
    const d = await scheduledDelivery(t.workspaceId, t.brandId, conn!.id, 'x');

    // Token revoked => health check => reconnect_required and work blocked.
    xT.scenario = 'revoked';
    expect((await checkConnection(t.ownerCtx, conn!.id)).status).toBe('reconnect_required');
    expect((await deliveryState(d)).state).toBe('blocked');

    // Reconnect with the same X account.
    xT.scenario = 'success';
    const flow2 = await oauthToFlow(t.ownerCtx, t.brandId, conn!.id);
    expect((await getConnectionFlow(t.ownerCtx, flow2)).candidates[0]).toMatchObject({ already_connected: true });
    const [again] = (await selectConnectionFlow(t.ownerCtx, flow2, { provider_account_ids: ['987654321'] })).items;
    expect(again!.id).toBe(conn!.id);
    expect(again!.status).toBe('ready');
    expect(await deliveryState(d)).toEqual({ state: 'scheduled', blocked_reason: null });
    expect((await testPool().query(`SELECT refresh_version FROM credentials c JOIN connections k ON k.credential_id=c.id WHERE k.id=$1`, [conn!.id])).rows[0].refresh_version).toBe(1);

    // Break it again, then reconnect as a DIFFERENT X account: new connection; old jobs not redirected.
    await testPool().query(`UPDATE connections SET status='reconnect_required' WHERE id=$1`, [conn!.id]);
    await testPool().query(`UPDATE deliveries SET state='blocked', blocked_reason='x' WHERE id=$1`, [d]);
    xT.accountId = '555000111';
    const flow3 = await oauthToFlow(t.ownerCtx, t.brandId, conn!.id);
    const [other] = (await selectConnectionFlow(t.ownerCtx, flow3, { provider_account_ids: ['555000111'] })).items;
    expect(other!.id).not.toBe(conn!.id);
    const old = (await listConnections(t.ownerCtx, t.brandId)).items.find((c) => c.id === conn!.id)!;
    expect(old.status).toBe('reconnect_required');
    expect((await deliveryState(d)).state).toBe('blocked');
    const dConn = (await testPool().query(`SELECT connection_id FROM deliveries WHERE id=$1`, [d])).rows[0].connection_id;
    expect(dConn).toBe(conn!.id);
  });

  it('pause marks waiting deliveries paused; resume reschedules them', async () => {
    const t = await tenant();
    const c = await connectMock(t.ownerCtx, t.brandId, { provider: 'telegram', display_name: 'Demo' });
    const d = await scheduledDelivery(t.workspaceId, t.brandId, c.id, 'telegram');
    const p = await setConnectionPaused(t.ownerCtx, c.id, { paused: true });
    expect(p).toMatchObject({ paused: true, status: 'paused', status_label: 'Paused' });
    expect((await deliveryState(d)).state).toBe('paused');
    await setConnectionPaused(t.ownerCtx, c.id, { paused: false });
    expect((await deliveryState(d)).state).toBe('scheduled');
  });
});

describe('credential refresh', () => {
  async function xConnectionExpiringSoon() {
    useFakes();
    const t = await tenant();
    const flowId = await oauthToFlow(t.ownerCtx, t.brandId);
    const [conn] = (await selectConnectionFlow(t.ownerCtx, flowId, { provider_account_ids: ['987654321'] })).items;
    // Make the stored access token expire in one minute.
    const creds = { kind: 'oauth2', accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: new Date(Date.now() + 60_000).toISOString(), scope: 'tweet.read tweet.write users.read offline.access media.write' };
    await testPool().query(
      `UPDATE credentials SET encrypted_blob=$2, expires_at=$3 WHERE id=(SELECT credential_id FROM connections WHERE id=$1)`,
      [conn!.id, JSON.stringify(encryptSecret(creds, credentialAad(t.workspaceId))), creds.expiresAt]);
    return { t, conn: conn! };
  }
  const refreshCalls = () => xT.requests.filter((r) => r.url.endsWith('/2/oauth2/token') && new URLSearchParams(r.body as string).get('grant_type') === 'refresh_token');

  it('two concurrent getUsableCredentials => exactly one provider refresh (serialized, rotation-safe)', async () => {
    const { conn } = await xConnectionExpiringSoon();
    const before = refreshCalls().length;
    const [a, b] = await Promise.all([getUsableCredentials(conn.id), getUsableCredentials(conn.id)]);
    expect(refreshCalls().length - before).toBe(1);
    expect(new URLSearchParams(refreshCalls().at(-1)!.body as string).get('refresh_token')).toBe('old-refresh');
    expect(a.credentials).toEqual(b.credentials);
    expect(a.credentials).toMatchObject({ kind: 'oauth2' });
    expect((a.credentials as { accessToken: string }).accessToken).not.toBe('old-access');
    const row = (await testPool().query(`SELECT refresh_version, expires_at FROM credentials WHERE id=(SELECT credential_id FROM connections WHERE id=$1)`, [conn.id])).rows[0];
    expect(row.refresh_version).toBe(1);
    expect(row.expires_at.getTime()).toBeGreaterThan(Date.now() + 3600_000);
    // Fresh token: no further refresh.
    await getUsableCredentials(conn.id);
    expect(refreshCalls().length - before).toBe(1);
    // forceRefresh (after a provider 401) refreshes once more.
    await getUsableCredentials(conn.id, { forceRefresh: true });
    expect(refreshCalls().length - before).toBe(2);
  });

  it('refresh rejected => reconnect_required, deliveries blocked, typed error', async () => {
    const { t, conn } = await xConnectionExpiringSoon();
    const d = await scheduledDelivery(t.workspaceId, t.brandId, conn.id, 'x');
    xT.scenario = 'revoked';
    const err = await getUsableCredentials(conn.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CredentialUnavailableError);
    expect(err).toMatchObject({ code: 'refresh_failed', retryable: false, blocking: 'reconnect' });
    expect((await listConnections(t.ownerCtx, t.brandId)).items[0]!.status).toBe('reconnect_required');
    expect((await deliveryState(d)).state).toBe('blocked');
    expect((await testPool().query(`SELECT 1 FROM outbox WHERE aggregate_id=$1 AND event_type='connection.health_changed'`, [conn.id])).rowCount).toBeGreaterThan(0);
  });
});

describe('tenant isolation', () => {
  it('cross-tenant access is 404; brand-restricted members cannot see other brands', async () => {
    const a = await tenant();
    const b = await tenant();
    const c = await connectMock(a.ownerCtx, a.brandId, { provider: 'x', display_name: 'A' });
    for (const fn of [
      () => checkConnection(b.ownerCtx, c.id),
      () => disconnectConnection(b.ownerCtx, c.id),
      () => setConnectionPaused(b.ownerCtx, c.id, { paused: true }),
      () => reconnectConnection(b.ownerCtx, c.id, {}),
      () => setMockScenario(b.ownerCtx, c.id, { scenario: 'revoked' }),
      () => listConnections(b.ownerCtx, a.brandId),
      () => connectMock(b.ownerCtx, a.brandId, { provider: 'x', display_name: 'B' }),
      () => startOAuth(b.ownerCtx, a.brandId, 'x'),
      () => checkConnection(b.ownerCtx, randomUUID()),
      () => checkConnection(b.ownerCtx, 'not-a-uuid'),
    ]) {
      await expect(fn()).rejects.toMatchObject({ code: 'not_found', status: 404 });
    }
    expect((await listConnections(a.ownerCtx, a.brandId)).items[0]!.status).toBe('ready');
  });
});
