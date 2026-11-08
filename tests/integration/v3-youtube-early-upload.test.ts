// V3 YouTube-held release (scheduling owner = provider): Relay's schedule stays the source of truth. The delivery is
// dispatched EARLY so upload/processing finish in time, and YouTube is told publishAt = the schedule's due time.
// With too little lead time left, it falls back to app-owned publication AT the due time (never early, never silent).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { toLocalInput, type PublishInput, type PublishMedia } from '@social-lite/core';
import { getAdapter } from '@social-lite/providers';

const youtubeAdapter = getAdapter('youtube');
import { claimDelivery, createPost, EARLY_UPLOAD_MINUTES, processDelivery, schedulePost, type EngineDeps } from '@social-lite/services';
import { closeTestPool, tenant, testPool } from './helpers.js';
import { scriptedWorld } from './engine-helpers.js';

afterAll(closeTestPool);

beforeEach(async () => {
  await testPool().query(`UPDATE deliveries SET state='cancelled' WHERE state IN ('scheduled','retry_wait','processing','preparing','publishing')`);
  await testPool().query(`UPDATE system_flags SET value='true' WHERE key='dispatch_enabled'`);
  await testPool().query(`DELETE FROM provider_circuits`);
});

/** A ready 10 s H.264/AAC video with its publish derivative (no bytes needed for scripted adapters). */
async function seedVideo(workspaceId: string, brandId: string): Promise<string> {
  const id = randomUUID();
  await testPool().query(
    `INSERT INTO assets(id, workspace_id, brand_id, object_key, mime, bytes, width, height, status, checksum_sha256, media_kind, duration_ms, video_codec, audio_codec, frame_rate)
     VALUES ($1,$2,$3,$4,'video/mp4',4096,1920,1080,'ready','x','video',10000,'h264','aac',30)`, [id, workspaceId, brandId, `originals/${id}`]);
  await testPool().query(
    `INSERT INTO asset_derivatives(workspace_id, asset_id, variant, object_key, mime, bytes, width, height, checksum_sha256, transform_version, duration_ms, video_codec, audio_codec, frame_rate)
     VALUES ($1,$2,'video_publish',$3,'video/mp4',4096,1920,1080,'y',1,10000,'h264','aac',30)`, [workspaceId, id, `derivatives/${id}.mp4`]);
  return id;
}

async function youtubeSetup(owner: 'provider' | 'app', dueInMs: number) {
  const t = await tenant();
  const conn = (await testPool().query<{ id: string }>(
    `INSERT INTO connections(workspace_id, brand_id, provider, provider_account_id, display_name, username, status, is_mock, capabilities)
     VALUES ($1,$2,'youtube',$3,'Demo YouTube','demo_yt','ready',true,$4) RETURNING id`,
    [t.workspaceId, t.brandId, `mock_youtube_${randomUUID().slice(0, 8)}`, JSON.stringify(youtubeAdapter.capabilities({ id: '', provider: 'youtube', providerAccountId: '', displayName: '', metadata: {}, isMock: true }))])).rows[0]!.id;
  const video = await seedVideo(t.workspaceId, t.brandId);
  const world = scriptedWorld();
  const inputs: PublishInput[] = [];
  const base = world.deps.adapterFor;
  // Dispatch-time validation uses the REAL YouTube rules, so the injected publishAt must be valid for YouTube.
  const deps: EngineDeps = { ...world.deps,
    adapterFor: (p) => {
      const a = base(p);
      return { ...a, validate: youtubeAdapter.validate, publish: async (ctx, input, cp) => { inputs.push(input); return a.publish(ctx, input, cp); } };
    },
    loadMedia: async (_ws, ids) => ids.map((id): PublishMedia => ({ assetId: id, mime: 'video/mp4', kind: 'video', width: 1920, height: 1080, bytes: 4096, durationMs: 10_000, videoCodec: 'h264', audioCodec: 'aac', frameRate: 30, url: `https://storage.invalid/${id}.mp4`, load: async () => new Uint8Array() })),
  };
  const draft = { baseText: 'Launch video', baseLink: null, baseAssetIds: [video], variants: [{ connectionId: conn, inheritText: true, inheritMedia: true, options: { youtube: { title: 'Launch', privacyStatus: 'public', madeForKids: false, schedulingOwner: owner } } }] };
  const { id } = await createPost(t.ownerCtx, t.brandId, { title: 'YT', draft }, randomUUID());
  const due = new Date(Date.now() + dueInMs);
  await schedulePost(t.ownerCtx, id, { expected_version: 1, connection_ids: [conn], input_local_time: toLocalInput(due, 'Europe/London'), timezone: 'Europe/London' }, randomUUID());
  const row = async () => (await testPool().query<{ id: string; state: string; scheduling_owner: string; due_at: Date; next_attempt_at: Date; remote_schedule: Record<string, unknown> | null; last_error_code: string | null; attempt_count: number }>(
    `SELECT id, state, scheduling_owner, due_at, next_attempt_at, remote_schedule, last_error_code, attempt_count FROM deliveries WHERE post_id=$1`, [id])).rows[0]!;
  return { deps, inputs, row };
}

describe('YouTube early upload (provider-held release)', () => {
  it('dispatches early and tells YouTube to release at the due time', async () => {
    const h = await youtubeSetup('provider', 24 * 3600_000);
    const d = await h.row();
    expect(d.scheduling_owner).toBe('provider');
    expect(d.due_at.getTime() - d.next_attempt_at.getTime()).toBe(EARLY_UPLOAD_MINUTES * 60_000);
    expect(await claimDelivery('w')).toBeNull(); // not due yet
    await testPool().query(`UPDATE deliveries SET next_attempt_at=now() WHERE id=$1`, [d.id]);
    expect(await processDelivery(h.deps, (await claimDelivery('w'))!)).toBe('published');
    expect(h.inputs).toHaveLength(1);
    const yt = h.inputs[0]!.variant.options.youtube as Record<string, unknown>;
    expect(yt).toMatchObject({ schedulingOwner: 'provider', publishAt: d.due_at.toISOString() });
  });

  it('app-owned YouTube deliveries are dispatched at the due time without publishAt', async () => {
    const h = await youtubeSetup('app', 24 * 3600_000);
    const d = await h.row();
    expect(d.scheduling_owner).toBe('app');
    expect(d.next_attempt_at.getTime()).toBe(d.due_at.getTime());
    await testPool().query(`UPDATE deliveries SET next_attempt_at=now(), due_at=now() WHERE id=$1`, [d.id]);
    expect(await processDelivery(h.deps, (await claimDelivery('w'))!)).toBe('published');
    expect((h.inputs[0]!.variant.options.youtube as Record<string, unknown>).publishAt).toBeUndefined();
  });

  it('too little lead time: falls back to app-owned publication at the due time, recorded', async () => {
    const h = await youtubeSetup('provider', 10 * 60_000); // 10 min < 15 min minimum lead
    const d = await h.row();
    expect(d.next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000); // dispatched now
    expect(await processDelivery(h.deps, (await claimDelivery('w'))!)).toBe('scheduled');
    expect(h.inputs).toHaveLength(0); // nothing sent early
    const after = await h.row();
    expect(after).toMatchObject({ state: 'scheduled', scheduling_owner: 'app', last_error_code: 'provider_schedule_fallback', remote_schedule: { fallback: true, reason: 'insufficient_lead' }, attempt_count: 0 });
    expect(after.next_attempt_at.getTime()).toBe(after.due_at.getTime());
    // at the due time it publishes normally, without publishAt
    await testPool().query(`UPDATE deliveries SET next_attempt_at=now(), due_at=now() WHERE id=$1`, [d.id]);
    expect(await processDelivery(h.deps, (await claimDelivery('w'))!)).toBe('published');
    const yt = h.inputs[0]!.variant.options.youtube as Record<string, unknown>;
    expect(yt.schedulingOwner).toBe('app');
    expect(yt.publishAt).toBeUndefined();
  });
});
