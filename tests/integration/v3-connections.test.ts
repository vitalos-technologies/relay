// V3 connections against REAL PostgreSQL (migration 014 provider_kind values): Bluesky app-password connect stores an
// encrypted credential and never the app password in clear; V3 OAuth providers start a state-bound redirect.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { HttpRequest, HttpResponse, Transport } from '@social-lite/core';
import { MemoryMockStore, mockId } from '@social-lite/providers';
import { resetConfigCache } from '@social-lite/services';
import { blueskyFake } from '../../packages/providers/src/bluesky/index.js';
import { connectBluesky, isOAuthProvider, reconnectConnection, setLiveTransportFactoryForTests, startOAuth } from '../../packages/services/src/connections/index.js';
import { closeTestPool, tenant, testPool } from './helpers.js';

const APP_PW = 'abcd-efgh-ijkl-mnop';
class BskyLive implements Transport {
  readonly mode = 'live' as const;
  readonly requests: HttpRequest[] = [];
  private readonly store = new MemoryMockStore();
  async send(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    return blueskyFake(req, { provider: 'bluesky', accountId: 'did:plc:v3test', scenario: 'success', store: this.store, now: () => new Date(), newId: mockId });
  }
}

beforeAll(() => {
  testPool();
  process.env.TIKTOK_CLIENT_KEY = 'tt-client-key';
  process.env.TIKTOK_CLIENT_SECRET = 'tt-secret';
  resetConfigCache();
});
afterEach(() => setLiveTransportFactoryForTests(null));
afterAll(async () => {
  delete process.env.TIKTOK_CLIENT_KEY;
  delete process.env.TIKTOK_CLIENT_SECRET;
  await closeTestPool();
});

describe('V3 connections', () => {
  it('Bluesky app password: verified, stored as an encrypted credential, labelled, app password never in clear', async () => {
    const t = await tenant();
    const live = new BskyLive();
    setLiveTransportFactoryForTests(() => live);
    const c = await connectBluesky(t.ownerCtx, t.brandId, { handle: '@sim.bsky.social', app_password: APP_PW });
    expect(c).toMatchObject({ provider: 'bluesky', provider_account_id: 'did:plc:v3test', status: 'ready', is_mock: false });
    expect(live.requests[0]!.url).toBe('https://bsky.social/xrpc/com.atproto.server.createSession');
    const dump = JSON.stringify((await testPool().query(`SELECT c.*, cr.* FROM connections c LEFT JOIN credentials cr ON cr.id=c.credential_id WHERE c.id=$1`, [c.id])).rows);
    expect(dump).not.toContain(APP_PW);
    expect(dump).toContain('app_password');
    await expect(connectBluesky(t.ownerCtx, t.brandId, { handle: 'sim.bsky.social', app_password: 'my-main-password' })).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('self-hosted Bluesky servers need an operator allow-list entry', async () => {
    const t = await tenant();
    const live = new BskyLive();
    setLiveTransportFactoryForTests(() => live);
    await expect(connectBluesky(t.ownerCtx, t.brandId, { handle: 'me.example.org', app_password: APP_PW, service: 'https://pds.example.org' }))
      .rejects.toMatchObject({ code: 'validation_failed', message: expect.stringContaining('not enabled') });
    expect(live.requests).toHaveLength(0);
    process.env.BLUESKY_SELF_HOSTED_HOSTS = 'pds.example.org';
    try {
      await connectBluesky(t.ownerCtx, t.brandId, { handle: 'me.example.org', app_password: APP_PW, service: 'https://pds.example.org' }).catch(() => undefined);
      expect(live.requests[0]?.url).toBe('https://pds.example.org/xrpc/com.atproto.server.createSession');
    } finally { delete process.env.BLUESKY_SELF_HOSTED_HOSTS; }
  });

  it('Bluesky reconnect re-verifies the same account with a new app password (no new connection)', async () => {
    const t = await tenant();
    const live = new BskyLive();
    setLiveTransportFactoryForTests(() => live);
    const c = await connectBluesky(t.ownerCtx, t.brandId, { handle: 'sim.bsky.social', app_password: APP_PW });
    await testPool().query(`UPDATE connections SET status='reconnect_required' WHERE id=$1`, [c.id]);
    await expect(reconnectConnection(t.ownerCtx, c.id, {})).rejects.toMatchObject({ code: 'validation_failed' });
    const r = await reconnectConnection(t.ownerCtx, c.id, { app_password: 'wxyz-abcd-efgh-ijkl' });
    expect(r).toMatchObject({ id: c.id, provider: 'bluesky', status: 'ready' });
    expect(JSON.parse(String(live.requests.at(-1)!.body)).identifier).toBe('sim.bsky.social');
    const n = await testPool().query(`SELECT count(*)::int n FROM connections WHERE brand_id=$1 AND provider='bluesky'`, [t.brandId]);
    expect(n.rows[0].n).toBe(1);
  });

  it('V3 OAuth providers are registered: TikTok start returns the Login Kit URL with a state', async () => {
    const t = await tenant();
    expect(['tiktok', 'youtube', 'linkedin', 'threads', 'pinterest'].every(isOAuthProvider)).toBe(true);
    expect(isOAuthProvider('bluesky')).toBe(false);
    const { authorization_url } = await startOAuth(t.ownerCtx, t.brandId, 'tiktok');
    const u = new URL(authorization_url);
    expect(u.origin + u.pathname).toBe('https://www.tiktok.com/v2/auth/authorize/');
    expect(u.searchParams.get('client_key')).toBe('tt-client-key');
    expect(u.searchParams.get('redirect_uri')).toMatch(/\/api\/oauth\/tiktok\/callback$/);
    expect(u.searchParams.get('state')).toBeTruthy();
    await expect(startOAuth(t.ownerCtx, t.brandId, 'youtube')).rejects.toMatchObject({ code: 'provider_not_configured', message: expect.stringContaining('YouTube') });
  });
});
