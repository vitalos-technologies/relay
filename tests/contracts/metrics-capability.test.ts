// Fix H7 (2026-11-09): capabilities.canReadMetrics says what Relay really reads. Facebook/Instagram insights need the
// insights permissions (recorded as metadata.granted_scopes at connect and by every health check); X public metrics
// are always read (billable, x.read budget). Telegram has no metrics.
import { describe, expect, it } from 'vitest';
import type { PublishConnection } from '@social-lite/core';
import { getAdapter } from '../../packages/providers/src/index.js';
import { metricsFetcherFor } from '../../packages/providers/src/metrics.js';
import { metaFake } from '../../packages/providers/src/meta/index.js';
import { FACEBOOK_INSIGHTS_SCOPES, INSTAGRAM_INSIGHTS_SCOPES } from '../../packages/providers/src/meta/metrics.js';
import { simulated } from './v3-helpers.js';

const conn = (provider: PublishConnection['provider'], metadata: Record<string, unknown> = {}, isMock = false): PublishConnection =>
  ({ id: 'c', provider, providerAccountId: provider === 'instagram' ? 'mock_ig1' : 'mock_page1', displayName: 'D', username: null, metadata, isMock });
const caps = (c: PublishConnection) => getAdapter(c.provider).capabilities(c);

describe('canReadMetrics reflects the metric reads Relay performs', () => {
  it('Facebook / Instagram: true when the insights permissions were granted, false when they were not', () => {
    expect(caps(conn('facebook', { granted_scopes: ['pages_manage_posts', ...FACEBOOK_INSIGHTS_SCOPES] })).canReadMetrics).toBe(true);
    expect(caps(conn('facebook', { granted_scopes: ['pages_manage_posts', 'pages_read_engagement'] })).canReadMetrics).toBe(false);
    expect(caps(conn('instagram', { granted_scopes: ['instagram_content_publish', ...INSTAGRAM_INSIGHTS_SCOPES] })).canReadMetrics).toBe(true);
    expect(caps(conn('instagram', { granted_scopes: ['instagram_basic', 'instagram_content_publish'] })).canReadMetrics).toBe(false);
  });

  it('unknown grants (older connections) and simulated destinations ⇒ true; every true has a real fetcher', () => {
    for (const p of ['facebook', 'instagram'] as const) {
      expect(caps(conn(p)).canReadMetrics).toBe(true);
      expect(caps(conn(p, { granted_scopes: ['x'] }, true)).canReadMetrics).toBe(true);
      expect(metricsFetcherFor(p).metricNames.length).toBeGreaterThan(0);
    }
  });

  it('X: true (public metrics, billable reads); Telegram: false (no post statistics)', () => {
    expect(caps(conn('x')).canReadMetrics).toBe(true);
    expect(metricsFetcherFor('x')).toMatchObject({ billableRead: true });
    expect(caps(conn('telegram', { chat_id: '-100' })).canReadMetrics).toBe(false);
    expect(metricsFetcherFor('telegram').metricNames).toHaveLength(0);
  });

  it('Meta health records the granted permissions, so the flag follows what the user allowed', async () => {
    const s = simulated(metaFake, 'facebook', 'mock_page1');
    const h = await getAdapter('facebook').health(s.ctx, conn('facebook', { page_id: 'mock_page1' }), { kind: 'meta_page', pageAccessToken: 'P', userAccessToken: 'U', userTokenExpiresAt: null });
    expect(h.status).toBe('ready');
    const granted = h.metadata?.granted_scopes as string[];
    expect(granted).toContain('pages_manage_posts');
    // The simulator grants no insights permission ⇒ a live connection like this one would honestly say "Not available".
    expect(caps(conn('facebook', { granted_scopes: granted })).canReadMetrics).toBe(false);
  });
});
