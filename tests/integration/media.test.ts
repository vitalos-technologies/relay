// Media pipeline against REAL PostgreSQL + REAL S3-compatible storage (SeaweedFS, bucket social-lite-test).
// Uploads go through actual presigned POST policies; validation/derivatives run through completeUpload().
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppError } from '@social-lite/core';
import {
  archiveAsset, assetFacts, completeUpload, createUploadIntent, getAsset, listAssets, loadPublishMedia, updateAsset,
} from '../../packages/services/src/media/assets.js';
import { processImage } from '../../packages/services/src/media/process.js';
import { ensureBucket, getObjectBytes, headObject, presignUpload } from '../../packages/services/src/storage.js';
import { addMember, closeTestPool, createUser, ctxFor, tenant, testPool } from './helpers.js';

type SharpFn = typeof import('../../packages/services/node_modules/sharp').default;
const sharp = createRequire(new URL('../../packages/services/package.json', import.meta.url))('sharp') as SharpFn;

async function png(width = 640, height = 480): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 20, g: 120, b: 200 } } }).png().toBuffer();
}

async function upload(intent: { upload: { url: string; fields: Record<string, string> } }, body: Buffer): Promise<number> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(intent.upload.fields)) fd.append(k, v);
  fd.append('file', new Blob([new Uint8Array(body)]));
  const res = await fetch(intent.upload.url, { method: 'POST', body: fd });
  await res.arrayBuffer();
  return res.status;
}

let t: Awaited<ReturnType<typeof tenant>>;

beforeAll(async () => {
  testPool();
  await ensureBucket();
  t = await tenant();
});
afterAll(closeTestPool);

async function uploadAndComplete(body: Buffer, contentType = 'image/png', filename = 'image.png') {
  const intent = await createUploadIntent(t.ownerCtx, { brand_id: t.brandId, filename, content_type: contentType, bytes: body.length });
  expect(intent.upload.method).toBe('POST');
  expect(intent.upload.fields.key).toBe(`originals/${t.workspaceId}/${t.brandId}/${intent.asset_id}`);
  expect(await upload(intent, body)).toBeLessThan(300);
  return completeUpload(t.ownerCtx, intent.asset_id);
}

describe('media upload + validation (ME-01..ME-03)', () => {
  it('valid PNG becomes ready with 3 derivatives (checksums, transform_version 1, signed previews)', async () => {
    const asset = await uploadAndComplete(await png(2000, 1000));
    expect(asset.status).toBe('ready');
    expect(asset).toMatchObject({ mime: 'image/png', width: 2000, height: 1000, rejection_reason: null });
    const d = await testPool().query<{ variant: string; mime: string; width: number; height: number; checksum_sha256: string; transform_version: number; object_key: string }>(
      `SELECT variant, mime, width, height, checksum_sha256, transform_version, object_key FROM asset_derivatives WHERE asset_id=$1 ORDER BY variant`, [asset.id]);
    expect(d.rows.map((r) => r.variant)).toEqual(['jpeg_publish', 'preview', 'thumb']);
    const by = Object.fromEntries(d.rows.map((r) => [r.variant, r]));
    expect(by.thumb).toMatchObject({ mime: 'image/webp', width: 400, height: 200, transform_version: 1 });
    expect(by.preview).toMatchObject({ mime: 'image/webp', width: 1600, height: 800 });
    expect(by.jpeg_publish).toMatchObject({ mime: 'image/jpeg', width: 2000, height: 1000 });
    for (const r of d.rows) {
      expect(r.checksum_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(r.object_key.startsWith(`derivatives/${t.workspaceId}/${t.brandId}/${asset.id}/v1/`)).toBe(true);
      expect(await headObject(r.object_key)).not.toBeNull();
    }
    // Short-lived signed preview URL works; the bucket itself is private.
    expect(asset.preview_url).toContain('X-Amz-Expires=300');
    const res = await fetch(asset.preview_url!);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).subarray(8, 12).toString()).toBe('WEBP');
    const anon = await fetch(asset.preview_url!.split('?')[0]!);
    expect(anon.status).toBeGreaterThanOrEqual(400);

    // Completing again is idempotent.
    expect((await completeUpload(t.ownerCtx, asset.id)).status).toBe('ready');
  });

  it('rejects a text file renamed to .png and removes the original', async () => {
    const asset = await uploadAndComplete(Buffer.from('hello, I am definitely not an image\n'.repeat(10)), 'image/png', 'evil.png');
    expect(asset.status).toBe('rejected');
    expect(asset.rejection_reason).toMatch(/Only JPEG and PNG/);
    const row = await testPool().query<{ object_key: string }>(`SELECT object_key FROM assets WHERE id=$1`, [asset.id]);
    expect(await headObject(row.rows[0]!.object_key)).toBeNull();
    const d = await testPool().query(`SELECT 1 FROM asset_derivatives WHERE asset_id=$1`, [asset.id]);
    expect(d.rowCount).toBe(0);
  });

  it('rejects declared/actual type mismatch, SVG, and polyglot trailers', async () => {
    const jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#888' } }).jpeg().toBuffer();
    expect((await uploadAndComplete(jpeg, 'image/png')).rejection_reason).toMatch(/does not match/);

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
    expect((await uploadAndComplete(svg, 'image/png', 'x.svg')).status).toBe('rejected');

    const polyglot = Buffer.concat([await png(64, 64), Buffer.from('PK\x03\x04 hidden zip payload <script>alert(1)</script>')]);
    const r = await uploadAndComplete(polyglot);
    expect(r.status).toBe('rejected');
    expect(r.rejection_reason).toMatch(/hidden extra content/);

    const truncated = (await png(300, 300)).subarray(0, 200);
    expect((await processImage(truncated, 'image/png')).ok).toBe(false);
  });

  it('rejects images whose dimensions exceed the pixel limit (decompression-bomb guard)', async () => {
    const big = await sharp({ create: { width: 8000, height: 6000, channels: 3, background: '#000' } }).png({ compressionLevel: 9 }).toBuffer();
    expect(big.length).toBeLessThan(20 * 1024 * 1024);
    const asset = await uploadAndComplete(big);
    expect(asset.status).toBe('rejected');
    expect(asset.rejection_reason).toMatch(/too large \(8000×6000\)/);
  });

  it('strips EXIF (including GPS) from every derivative and auto-orients', async () => {
    const withGps = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#c33' } })
      .jpeg()
      .withExif({ IFD0: { Make: 'TestCam', Model: 'Secret Phone' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '0/1 7/1 0/1' } })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const meta = await sharp(withGps).metadata();
    expect(meta.orientation).toBe(6);
    expect(meta.exif!.toString('latin1')).toContain('Secret Phone');
    const hasGpsIfd = (b: Buffer) => b.includes(Buffer.from([0x88, 0x25])) || b.includes(Buffer.from([0x25, 0x88]));
    expect(hasGpsIfd(meta.exif!)).toBe(true);

    const asset = await uploadAndComplete(withGps, 'image/jpeg', 'gps.jpg');
    expect(asset.status).toBe('ready');
    // Orientation 6 (rotate 90°): oriented dimensions are 200×300.
    expect({ w: asset.width, h: asset.height }).toEqual({ w: 200, h: 300 });
    const d = await testPool().query<{ object_key: string; variant: string; width: number; height: number }>(
      `SELECT object_key, variant, width, height FROM asset_derivatives WHERE asset_id=$1`, [asset.id]);
    expect(d.rowCount).toBe(3);
    for (const r of d.rows) {
      const bytes = await getObjectBytes(r.object_key, 10 * 1024 * 1024);
      const m = await sharp(bytes).metadata();
      expect(m.exif, r.variant).toBeUndefined();
      expect(bytes.includes(Buffer.from('Exif\0\0')), r.variant).toBe(false);
      expect(m.xmp, r.variant).toBeUndefined();
      expect(m.iptc, r.variant).toBeUndefined();
      expect(m.orientation ?? 1, r.variant).toBe(1);
      expect(bytes.toString('latin1')).not.toContain('Secret Phone');
      expect(r.height).toBeGreaterThan(r.width);
    }
  });

  it('presigned POST policy enforces size range and exact key (SeaweedFS honours policies)', async () => {
    const key = `originals/policy-test/${randomUUID()}`;
    const post = await presignUpload({ key, contentType: 'image/png', maxBytes: 100 });
    const send = async (body: Buffer, k = key, ct = 'image/png') => {
      const fd = new FormData();
      for (const [a, b] of Object.entries(post.fields)) fd.append(a, a === 'key' ? k : a === 'Content-Type' ? ct : b);
      fd.append('file', new Blob([new Uint8Array(body)]));
      const r = await fetch(post.url, { method: 'POST', body: fd });
      await r.arrayBuffer();
      return r.status;
    };
    expect(await send(Buffer.alloc(500, 1))).toBeGreaterThanOrEqual(400);           // too large
    expect(await send(Buffer.alloc(50, 1), `${key}-other`)).toBeGreaterThanOrEqual(400); // different key
    expect(await send(Buffer.alloc(50, 1), key, 'text/html')).toBeGreaterThanOrEqual(400); // different type
    expect(await headObject(key)).toBeNull();
    expect(await send(Buffer.alloc(50, 1))).toBeLessThan(300);
    expect((await headObject(key))?.ContentLength).toBe(50);
  });

  it('refuses intents for unsupported types or oversize declarations; viewers cannot upload', async () => {
    await expect(createUploadIntent(t.ownerCtx, { brand_id: t.brandId, filename: 'a.svg', content_type: 'image/svg+xml', bytes: 10 }))
      .rejects.toMatchObject({ code: 'unsupported_media' });
    await expect(createUploadIntent(t.ownerCtx, { brand_id: t.brandId, filename: 'a.png', content_type: 'image/png', bytes: 21 * 1024 * 1024 }))
      .rejects.toMatchObject({ code: 'payload_too_large' });
    const viewer = await createUser();
    await addMember(t.workspaceId, viewer.id, 'viewer');
    await expect(createUploadIntent(ctxFor(viewer.id, t.workspaceId, 'viewer'), { brand_id: t.brandId, filename: 'a.png', content_type: 'image/png', bytes: 10 }))
      .rejects.toMatchObject({ code: 'forbidden' });
  });

  it('completing before the upload exists is refused and leaves the asset pending', async () => {
    const intent = await createUploadIntent(t.ownerCtx, { brand_id: t.brandId, filename: 'later.png', content_type: 'image/png', bytes: 100 });
    await expect(completeUpload(t.ownerCtx, intent.asset_id)).rejects.toMatchObject({ code: 'invalid_state' });
    expect((await getAsset(t.ownerCtx, intent.asset_id)).status).toBe('pending_upload');
  });
});

describe('media access, publishing facts and archive (ME-04, ME-05)', () => {
  it('denies cross-tenant access with not_found', async () => {
    const asset = await uploadAndComplete(await png(100, 100));
    const other = await tenant();
    const notFound = { code: 'not_found' } satisfies Partial<AppError>;
    await expect(getAsset(other.ownerCtx, asset.id)).rejects.toMatchObject(notFound);
    await expect(completeUpload(other.ownerCtx, asset.id)).rejects.toMatchObject(notFound);
    await expect(updateAsset(other.ownerCtx, asset.id, { alt_text: 'pwned' })).rejects.toMatchObject(notFound);
    await expect(archiveAsset(other.ownerCtx, asset.id)).rejects.toMatchObject(notFound);
    await expect(listAssets(other.ownerCtx, t.brandId)).rejects.toMatchObject(notFound);
    await expect(createUploadIntent(other.ownerCtx, { brand_id: t.brandId, filename: 'x.png', content_type: 'image/png', bytes: 10 })).rejects.toMatchObject(notFound);
    // Engine-facing helpers are workspace-scoped too.
    expect((await assetFacts(testPool(), other.workspaceId, [asset.id]))[0]!.status).toBe('missing');
    await expect(loadPublishMedia(testPool(), other.workspaceId, [asset.id])).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('lists with filters and cursor pagination; updates alt text and tags', async () => {
    const brand = (await testPool().query<{ id: string }>(`INSERT INTO brands(workspace_id, name) VALUES ($1,'Paging') RETURNING id`, [t.workspaceId])).rows[0]!.id;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const intent = await createUploadIntent(t.ownerCtx, { brand_id: brand, filename: `p${i}.png`, content_type: 'image/png', bytes: 1000 });
      ids.push(intent.asset_id);
    }
    const p1 = await listAssets(t.ownerCtx, brand, { limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.next_cursor).toBeTruthy();
    const p2 = await listAssets(t.ownerCtx, brand, { limit: 2, cursor: p1.next_cursor });
    expect(p2.items).toHaveLength(1);
    expect(p2.next_cursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((a) => a.id))).toEqual(new Set(ids));
    const updated = await updateAsset(t.ownerCtx, ids[0]!, { alt_text: 'A blue square', tags: ['launch', 'launch', 'blue'] });
    expect(updated).toMatchObject({ alt_text: 'A blue square', tags: ['launch', 'blue'] });
    expect((await listAssets(t.ownerCtx, brand, { tag: 'launch' })).items.map((a) => a.id)).toEqual([ids[0]]);
    expect((await listAssets(t.ownerCtx, brand, { q: 'p1' })).items.map((a) => a.id)).toEqual([ids[1]]);
  });

  it('provides publish media (signed jpeg_publish URL + loader) and validation facts', async () => {
    const asset = await uploadAndComplete(await png(1200, 800));
    const [facts] = await assetFacts(testPool(), t.workspaceId, [asset.id]);
    expect(facts).toMatchObject({ assetId: asset.id, status: 'ready', mime: 'image/jpeg', width: 1200, height: 800 });
    expect(facts!.bytes).toBeGreaterThan(0);
    const [media] = await loadPublishMedia(testPool(), t.workspaceId, [asset.id], 900);
    expect(media).toMatchObject({ assetId: asset.id, mime: 'image/jpeg', width: 1200, height: 800, bytes: facts!.bytes });
    expect(media!.url).toContain('X-Amz-Expires=900');
    const fetched = Buffer.from(await (await fetch(media!.url)).arrayBuffer());
    const loaded = Buffer.from(await media!.load());
    expect(loaded.equals(fetched)).toBe(true);
    expect(loaded.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
    expect(loaded.length).toBe(facts!.bytes);
  });

  it('refuses to archive an asset referenced by a non-terminal delivery, allows it afterwards', async () => {
    const db = testPool();
    const asset = await uploadAndComplete(await png(200, 200));
    const conn = (await db.query<{ id: string }>(
      `INSERT INTO connections(workspace_id, brand_id, provider, provider_account_id, display_name, is_mock, status)
       VALUES ($1,$2,'telegram',$3,'Mock channel',true,'ready') RETURNING id`, [t.workspaceId, t.brandId, `mock_${randomUUID()}`])).rows[0]!.id;
    const post = (await db.query<{ id: string }>(`INSERT INTO posts(workspace_id, brand_id) VALUES ($1,$2) RETURNING id`, [t.workspaceId, t.brandId])).rows[0]!.id;
    const rev = (await db.query<{ id: string }>(
      `INSERT INTO post_revisions(workspace_id, post_id, revision_number, base_text, base_asset_ids, content_hash) VALUES ($1,$2,1,'hi',$3,'h') RETURNING id`,
      [t.workspaceId, post, [asset.id]])).rows[0]!.id;
    const variant = (await db.query<{ id: string }>(
      `INSERT INTO variants(workspace_id, revision_id, connection_id, format, asset_ids) VALUES ($1,$2,$3,'image',$4) RETURNING id`,
      [t.workspaceId, rev, conn, [asset.id]])).rows[0]!.id;
    const due = new Date(Date.now() + 3600_000);
    const schedule = (await db.query<{ id: string }>(
      `INSERT INTO schedules(workspace_id, brand_id, post_id, revision_id, generation, due_at, input_timezone, input_local_time, publish_before, fingerprint, status)
       VALUES ($1,$2,$3,$4,1,$5,'UTC','2026-01-01T00:00',$6,'fp','completed') RETURNING id`,
      [t.workspaceId, t.brandId, post, rev, due, new Date(due.getTime() + 900_000)])).rows[0]!.id;
    const delivery = (await db.query<{ id: string }>(
      `INSERT INTO deliveries(workspace_id, brand_id, post_id, schedule_id, generation, revision_id, variant_id, connection_id, provider, is_mock, due_at, publish_before, next_attempt_at)
       VALUES ($1,$2,$3,$4,1,$5,$6,$7,'telegram',true,$8,$9,$8) RETURNING id`,
      [t.workspaceId, t.brandId, post, schedule, rev, variant, conn, due, new Date(due.getTime() + 900_000)])).rows[0]!.id;

    await expect(archiveAsset(t.ownerCtx, asset.id)).rejects.toMatchObject({ code: 'conflict', details: { active_deliveries: 1 } });
    expect((await getAsset(t.ownerCtx, asset.id)).status).toBe('ready');

    await db.query(`UPDATE deliveries SET state='published' WHERE id=$1`, [delivery]);
    const archived = await archiveAsset(t.ownerCtx, asset.id);
    expect(archived.status).toBe('archived');
    const r = await db.query<{ retention_at: Date }>(`SELECT retention_at FROM assets WHERE id=$1`, [asset.id]);
    expect(r.rows[0]!.retention_at.getTime()).toBeGreaterThan(Date.now() + 29 * 86400_000);
    // Archived assets are hidden from the default list and reported as archived to validation.
    expect((await listAssets(t.ownerCtx, t.brandId)).items.map((a) => a.id)).not.toContain(asset.id);
    expect((await assetFacts(db, t.workspaceId, [asset.id]))[0]!.status).toBe('archived');
  });
});
