// Provider status names each provider's own settings; the posts list honours status=draft.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { toLocalInput } from '@social-lite/core';
import { createPost, listPosts, schedulePost } from '@social-lite/services';
import { listProviderStatus } from '@social-lite/services/connections/index';
import { closeTestPool, tenant } from './helpers.js';
import { seedConnections } from './engine-helpers.js';

afterAll(closeTestPool);

describe('provider status', () => {
  it('reports each provider\'s own missing settings (never Meta keys for non-Meta networks)', async () => {
    const t = await tenant();
    const { items } = await listProviderStatus(t.ownerCtx);
    const by = Object.fromEntries(items.map((i) => [i.provider, i]));
    const expected: Record<string, string> = { tiktok: 'TIKTOK_CLIENT_KEY', youtube: 'GOOGLE_CLIENT_ID', linkedin: 'LINKEDIN_CLIENT_ID', threads: 'THREADS_APP_ID', pinterest: 'PINTEREST_APP_ID' };
    for (const [p, key] of Object.entries(expected)) {
      if (!by[p]!.configured) expect(by[p]!.missing).toContain(key);
      expect(by[p]!.missing.some((m: string) => m.startsWith('META_'))).toBe(false);
    }
    expect(by.bluesky).toMatchObject({ configured: true, missing: [] });
    expect(by.telegram).toMatchObject({ configured: true, missing: [] });
  });
});

describe('posts list', () => {
  it('status=draft returns only never-scheduled posts; other values are refused', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const draft = { baseText: 'x', baseLink: null, baseAssetIds: [], variants: [{ connectionId: conns.facebook, inheritText: true, inheritMedia: true }] };
    const a = await createPost(t.ownerCtx, t.brandId, { title: 'Draft only', draft }, randomUUID());
    const b = await createPost(t.ownerCtx, t.brandId, { title: 'Scheduled', draft }, randomUUID());
    await schedulePost(t.ownerCtx, b.id, { expected_version: 1, connection_ids: [conns.facebook], input_local_time: toLocalInput(new Date(Date.now() + 3600_000), 'Europe/London'), timezone: 'Europe/London' }, randomUUID());
    const drafts = await listPosts(t.ownerCtx, t.brandId, { status: 'draft' });
    expect(drafts.items.map((i) => i.id)).toEqual([a.id]);
    expect((await listPosts(t.ownerCtx, t.brandId, {})).items.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());
    await expect(listPosts(t.ownerCtx, t.brandId, { status: 'nope' })).rejects.toMatchObject({ code: 'validation_failed' });
  });
});
