// V1.1 video pipeline against REAL PostgreSQL + REAL S3-compatible storage + the real ffprobe/ffmpeg binaries.
// Test clips are generated with ffmpeg at test time (TEST_SCRATCH_DIR, else the OS temp dir).
// upload (presigned POST) → completeUpload (quarantined + outbox 'asset.uploaded', no processing in the request)
// → worker handler (probe, poster, remux|transcode) → ready derivatives → per-destination validation.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPost, validatePost } from '@social-lite/services';
import {
  assetFacts, completeUpload, createUploadIntent, getAsset, loadPublishMedia, publishFacts,
} from '../../packages/services/src/media/assets.js';
import { handleAssetUploaded, processVideoAsset } from '../../packages/services/src/media/video-worker.js';
import { ensureBucket, getObjectBytes, headObject } from '../../packages/services/src/storage.js';
import { closeTestPool, tenant, testPool } from './helpers.js';

const dir = mkdtempSync(join(process.env.TEST_SCRATCH_DIR ?? tmpdir(), 'socialite-video-test-'));
const ff = (args: string[]) => execFileSync('/usr/bin/ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], { timeout: 60_000 });
const probe = (path: string) => JSON.parse(execFileSync('/usr/bin/ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], { timeout: 20_000 }).toString()) as {
  format: { tags?: Record<string, string>; duration: string; format_name: string }; streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; pix_fmt?: string }>;
};

let clipH264: Buffer;    // 2 s 640×360 H.264/AAC MP4 → remux path
let clipMpeg4: Buffer;   // 2 s 1920×1080 MPEG-4 Part 2 + PCM MOV with a GPS location tag → transcode path

let t: Awaited<ReturnType<typeof tenant>>;

beforeAll(async () => {
  testPool();
  await ensureBucket();
  t = await tenant();
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(dir, 'h264.mp4')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=duration=2',
    '-c:v', 'mpeg4', '-c:a', 'pcm_s16le', '-metadata', 'location=+51.5074-000.1278/', '-movflags', 'use_metadata_tags', join(dir, 'mpeg4.mov')]);
  clipH264 = readFileSync(join(dir, 'h264.mp4'));
  clipMpeg4 = readFileSync(join(dir, 'mpeg4.mov'));
});
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await closeTestPool();
});

async function upload(intent: { upload: { url: string; fields: Record<string, string> } }, body: Buffer): Promise<number> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(intent.upload.fields)) fd.append(k, v);
  fd.append('file', new Blob([new Uint8Array(body)]));
  const res = await fetch(intent.upload.url, { method: 'POST', body: fd });
  await res.arrayBuffer();
  return res.status;
}

async function uploadVideo(body: Buffer, contentType = 'video/mp4', filename = 'clip.mp4', ten = t) {
  const intent = await createUploadIntent(ten.ownerCtx, { brand_id: ten.brandId, filename, content_type: contentType, bytes: body.length });
  expect(intent.max_bytes).toBe(300 * 1024 * 1024);
  expect(await upload(intent, body)).toBeLessThan(300);
  return { id: intent.asset_id, dto: await completeUpload(ten.ownerCtx, intent.asset_id) };
}

const runWorker = (assetId: string, workspaceId = t.workspaceId) => handleAssetUploaded({ workspace_id: workspaceId, aggregate_id: assetId, payload: { assetId } });

describe('video upload → worker → derivatives (V1.1)', () => {
  it('completeUpload only quarantines and enqueues asset.uploaded; the worker produces poster/preview/thumb + video_publish', async () => {
    const { id, dto } = await uploadVideo(clipH264);
    expect(dto).toMatchObject({ status: 'quarantined', media_kind: 'video', preview_url: null });
    const ob = await testPool().query(`SELECT event_type, payload FROM outbox WHERE aggregate_type='asset' AND aggregate_id=$1`, [id]);
    expect(ob.rows).toEqual([{ event_type: 'asset.uploaded', payload: { assetId: id, kind: 'video' } }]);
    // Completing again does not enqueue a second job.
    expect((await completeUpload(t.ownerCtx, id)).status).toBe('quarantined');
    expect((await testPool().query(`SELECT 1 FROM outbox WHERE aggregate_id=$1`, [id])).rowCount).toBe(1);
    // While processing, validation sees it as not ready.
    expect((await publishFacts(testPool(), t.workspaceId, [id]))[0]).toMatchObject({ status: 'quarantined', kind: 'video' });

    const r = await runWorker(id);
    expect(r).toMatchObject({ status: 'ready', transcoded: false, facts: { width: 640, height: 360, videoCodec: 'h264', audioCodec: 'aac' } });
    const asset = await getAsset(t.ownerCtx, id);
    expect(asset).toMatchObject({ status: 'ready', media_kind: 'video', mime: 'video/mp4', width: 640, height: 360 });
    expect(asset.duration_ms).toBeGreaterThanOrEqual(1900);
    expect(asset.duration_ms).toBeLessThanOrEqual(2100);
    expect(asset.thumb_url).toContain('X-Amz-Expires=300');
    const thumb = Buffer.from(await (await fetch(asset.thumb_url!)).arrayBuffer());
    expect(thumb.subarray(8, 12).toString()).toBe('WEBP');

    const d = await testPool().query<{ variant: string; mime: string; width: number; height: number; duration_ms: number | null; video_codec: string | null; object_key: string }>(
      `SELECT variant, mime, width, height, duration_ms, video_codec, object_key FROM asset_derivatives WHERE asset_id=$1 ORDER BY variant`, [id]);
    expect(d.rows.map((x) => x.variant)).toEqual(['poster', 'preview', 'thumb', 'video_publish']);
    const vp = d.rows.find((x) => x.variant === 'video_publish')!;
    expect(vp).toMatchObject({ mime: 'video/mp4', width: 640, height: 360, video_codec: 'h264' });
    for (const row of d.rows) expect(await headObject(row.object_key)).not.toBeNull();

    // Facts for validation carry kind/duration/codecs; publish media has a signed URL, poster and loader.
    const [facts] = await assetFacts(testPool(), t.workspaceId, [id]);
    expect(facts).toMatchObject({ status: 'ready', kind: 'video', mime: 'video/mp4', width: 640, height: 360, videoCodec: 'h264', audioCodec: 'aac' });
    const [media] = await loadPublishMedia(testPool(), t.workspaceId, [id], 900);
    expect(media).toMatchObject({ kind: 'video', mime: 'video/mp4', width: 640, height: 360, videoCodec: 'h264' });
    expect(media!.url).toContain('X-Amz-Expires=900');
    expect(media!.posterUrl).toContain('poster.jpg');
    const loaded = Buffer.from(await media!.load());
    expect(loaded.length).toBe(media!.bytes);
    expect(loaded.subarray(4, 8).toString()).toBe('ftyp');

    // A second worker delivery (pg-boss redelivery) is a no-op.
    expect(await runWorker(id)).toMatchObject({ status: 'skipped' });
  });

  it('transcodes an incompatible MOV (MPEG-4/PCM 1080p) to H.264/AAC MP4 ≤ 1280×1024 and strips location metadata', async () => {
    expect(probe(join(dir, 'mpeg4.mov')).format.tags?.location).toBe('+51.5074-000.1278/');
    const { id } = await uploadVideo(clipMpeg4, 'video/quicktime', 'phone.mov');
    const r = await runWorker(id);
    expect(r).toMatchObject({ status: 'ready', transcoded: true, facts: { width: 1280, height: 720, videoCodec: 'h264', audioCodec: 'aac' } });
    const row = (await testPool().query<{ object_key: string }>(`SELECT object_key FROM asset_derivatives WHERE asset_id=$1 AND variant='video_publish'`, [id])).rows[0]!;
    const out = join(dir, `${id}.mp4`);
    writeFileSync(out, await getObjectBytes(row.object_key, 50 * 1024 * 1024));
    const p = probe(out);
    expect(p.streams.find((s) => s.codec_type === 'video')).toMatchObject({ codec_name: 'h264', width: 1280, height: 720, pix_fmt: 'yuv420p' });
    expect(p.streams.find((s) => s.codec_type === 'audio')).toMatchObject({ codec_name: 'aac' });
    expect(JSON.stringify(p.format.tags ?? {})).not.toContain('51.5074');
    const asset = await getAsset(t.ownerCtx, id);
    expect(asset).toMatchObject({ status: 'ready', mime: 'video/quicktime', width: 1920, height: 1080 }); // original facts
    expect((await assetFacts(testPool(), t.workspaceId, [id]))[0]).toMatchObject({ mime: 'video/mp4', width: 1280, height: 720 }); // publish facts
  });

  it('per-destination validation: a 2 s clip fails Instagram Reels (minimum 3 s) and passes Facebook, Telegram and X', async () => {
    const { id } = await uploadVideo(clipH264);
    await runWorker(id);
    const conns: Record<string, string> = {};
    for (const p of ['instagram', 'facebook', 'telegram', 'x']) {
      conns[p] = (await testPool().query<{ id: string }>(
        `INSERT INTO connections(workspace_id, brand_id, provider, provider_account_id, display_name, status, is_mock, capabilities)
         VALUES ($1,$2,$3,$4,$5,'ready',true,'{}') RETURNING id`, [t.workspaceId, t.brandId, p, `mock_${p}_${randomUUID().slice(0, 8)}`, `Sim ${p}`])).rows[0]!.id;
    }
    const draft = { baseText: 'Clip', baseLink: null, baseAssetIds: [id], variants: Object.values(conns).map((connectionId) => ({ connectionId, inheritText: true, inheritMedia: true })) };
    const { id: postId } = await createPost(t.ownerCtx, t.brandId, { title: 'Video', draft }, randomUUID());
    const v = await validatePost(t.ownerCtx, postId);
    expect(v.ok).toBe(false);
    expect(v.issues).toEqual([expect.objectContaining({ connectionId: conns.instagram, provider: 'instagram', code: 'video_too_short', message: 'Instagram: video is 2 s long; at least 3 s is required.' })]);
    expect(v.per_destination[conns.facebook!]!.ok).toBe(true);
    expect(v.per_destination[conns.telegram!]!.ok).toBe(true);
    expect(v.per_destination[conns.x!]!.ok).toBe(true);
  });
});

describe('malformed videos are rejected with a user-facing reason', () => {
  it('bytes that are not a video, and a truncated MP4, are rejected and the original deleted', async () => {
    const junk = await uploadVideo(Buffer.from('definitely not a video\n'.repeat(200)), 'video/mp4', 'junk.mp4');
    expect(await runWorker(junk.id)).toMatchObject({ status: 'rejected', code: 'unsupported_type' });
    const a1 = await getAsset(t.ownerCtx, junk.id);
    expect(a1).toMatchObject({ status: 'rejected' });
    expect(a1.rejection_reason).toMatch(/^Only MP4 and MOV videos are supported/);

    const truncated = await uploadVideo(clipH264.subarray(0, 4096), 'video/mp4', 'cut.mp4');
    const r = await runWorker(truncated.id);
    expect(r).toMatchObject({ status: 'rejected' });
    const a2 = await getAsset(t.ownerCtx, truncated.id);
    expect(a2.status).toBe('rejected');
    expect(a2.rejection_reason).toMatch(/could not be read|corrupted/);
    const key = (await testPool().query<{ object_key: string }>(`SELECT object_key FROM assets WHERE id=$1`, [truncated.id])).rows[0]!.object_key;
    expect(await headObject(key)).toBeNull();
    expect((await testPool().query(`SELECT 1 FROM asset_derivatives WHERE asset_id=$1`, [truncated.id])).rowCount).toBe(0);
  });

  it('refuses oversize or non-MP4/MOV video intents', async () => {
    await expect(createUploadIntent(t.ownerCtx, { brand_id: t.brandId, filename: 'big.mp4', content_type: 'video/mp4', bytes: 301 * 1024 * 1024 }))
      .rejects.toMatchObject({ code: 'payload_too_large' });
    await expect(createUploadIntent(t.ownerCtx, { brand_id: t.brandId, filename: 'a.webm', content_type: 'video/webm', bytes: 100 }))
      .rejects.toMatchObject({ code: 'unsupported_media' });
  });
});

describe('tenancy', () => {
  it('cross-tenant access is denied (not_found) and a forged worker event for another workspace changes nothing', async () => {
    const { id } = await uploadVideo(clipH264);
    const other = await tenant();
    await expect(getAsset(other.ownerCtx, id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(completeUpload(other.ownerCtx, id)).rejects.toMatchObject({ code: 'not_found' });
    expect(await runWorker(id, other.workspaceId)).toMatchObject({ status: 'skipped' });
    expect((await getAsset(t.ownerCtx, id)).status).toBe('quarantined');
    expect((await publishFacts(testPool(), other.workspaceId, [id]))[0]!.status).toBe('missing');
    await expect(loadPublishMedia(testPool(), other.workspaceId, [id])).rejects.toMatchObject({ code: 'invalid_state' });
    // Two workers racing: exactly one processes.
    const results = await Promise.all([processVideoAsset(t.workspaceId, id), processVideoAsset(t.workspaceId, id)]);
    expect(results.map((r) => r.status).sort()).toEqual(['ready', 'skipped']);
  });
});
