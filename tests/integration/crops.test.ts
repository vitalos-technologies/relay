// Image crops (V1.1): deterministic cached derivatives, cropped-facts validation, approval invalidation,
// and the engine publishing the cropped derivative. REAL PostgreSQL + object storage.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveVariants, type DraftContent, type PublishMedia } from '@social-lite/core';
import {
  claimDelivery, contentHash, createPost, processDelivery, publishNow, submitForReview, updateDraft, validatePost,
} from '@social-lite/services';
import { completeUpload, createUploadIntent, loadPublishMedia } from '@social-lite/services/media/index';
import { cropOutputSize, cropVariantName, ensureCropDerivative, renderCrop, type CropSpec } from '@social-lite/services/crops/index';
import { ensureBucket, getObjectBytes } from '../../packages/services/src/storage.js';
import { closeTestPool, tenant, testPool } from './helpers.js';
import { scriptedWorld, seedConnections } from './engine-helpers.js';
import { toLocalInput } from '@social-lite/core';

type SharpFn = typeof import('../../packages/services/node_modules/sharp').default;
const sharp = createRequire(new URL('../../packages/services/package.json', import.meta.url))('sharp') as SharpFn;

/** 1600×600: left 800px red, right 800px blue (aspect 2.67 — too wide for Instagram). */
async function twoTone(): Promise<Buffer> {
  const red = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 220, g: 20, b: 20 } } }).png().toBuffer();
  return sharp({ create: { width: 1600, height: 600, channels: 3, background: { r: 20, g: 20, b: 220 } } })
    .composite([{ input: red, left: 0, top: 0 }]).png().toBuffer();
}

async function upload(intent: { upload: { url: string; fields: Record<string, string> } }, body: Buffer) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(intent.upload.fields)) fd.append(k, v);
  fd.append('file', new Blob([new Uint8Array(body)]));
  const res = await fetch(intent.upload.url, { method: 'POST', body: fd });
  await res.arrayBuffer();
  expect(res.status).toBeLessThan(300);
}

type T = Awaited<ReturnType<typeof tenant>>;
async function realImage(t: T): Promise<string> {
  const body = await twoTone();
  const intent = await createUploadIntent(t.ownerCtx, { brand_id: t.brandId, filename: 'wide.png', content_type: 'image/png', bytes: body.length });
  await upload(intent, body);
  const a = await completeUpload(t.ownerCtx, intent.asset_id);
  expect(a.status).toBe('ready');
  return a.id;
}

const RED_4x5: CropSpec = { preset: '4:5', x: 0, y: 0, width: 480, height: 600 };
const BLUE_4x5: CropSpec = { preset: '4:5', x: 1100, y: 0, width: 480, height: 600 };

function draftWith(asset: string, connectionId: string, crop: CropSpec | null): DraftContent {
  return { baseText: 'Cropped', baseLink: null, baseAssetIds: [asset],
    variants: [{ connectionId, inheritText: true, inheritMedia: true, ...(crop ? { options: { crop: { [asset]: crop } } } : {}) }] };
}

beforeAll(async () => { testPool(); await ensureBucket(); });
beforeEach(async () => {
  await testPool().query(`UPDATE deliveries SET state='cancelled' WHERE state IN ('scheduled','retry_wait','processing','preparing','publishing')`);
});
afterAll(closeTestPool);

describe('crop derivatives', () => {
  it('are deterministic, cached by (asset, rect, transform_version) and contain exactly the cropped pixels', async () => {
    const t = await tenant();
    const asset = await realImage(t);
    const a = await ensureCropDerivative(testPool(), t.workspaceId, asset, RED_4x5);
    const b = await ensureCropDerivative(testPool(), t.workspaceId, asset, RED_4x5);
    expect(b).toEqual(a);
    expect(a).toMatchObject({ mime: 'image/jpeg', width: 480, height: 600 });
    const rows = await testPool().query(`SELECT variant, transform_version FROM asset_derivatives WHERE asset_id=$1 AND variant LIKE 'crop:%'`, [asset]);
    expect(rows.rows).toEqual([{ variant: cropVariantName(RED_4x5), transform_version: 1 }]);
    const bytes = await getObjectBytes(a.object_key, 10 << 20);
    const { data, info } = await sharp(bytes).resize(1, 1).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(3);
    expect(data[0]).toBeGreaterThan(180); // red
    expect(data[2]).toBeLessThan(80);
    // Re-rendering the same rect from the same original yields identical bytes.
    const orig = await getObjectBytes(`originals/${t.workspaceId}/${t.brandId}/${asset}`, 20 << 20);
    const r1 = await renderCrop(orig, RED_4x5);
    const r2 = await renderCrop(orig, RED_4x5);
    expect(r1.sha256).toBe(r2.sha256);
    expect(cropOutputSize({ width: 6000, height: 3000 })).toEqual({ width: 4096, height: 2048 });
  });
});

describe('validation uses the cropped facts', () => {
  it('a too-wide image fails Instagram; a 4:5 crop of it passes; an out-of-bounds crop is an exact issue', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const asset = await realImage(t);
    const { id } = await createPost(t.ownerCtx, t.brandId, { title: 'c', draft: draftWith(asset, conns.instagram, null) }, randomUUID());
    const v1 = await validatePost(t.ownerCtx, id, [conns.instagram]);
    expect(v1.issues.map((i) => i.code)).toContain('aspect');
    await updateDraft(t.ownerCtx, id, { expected_version: 1, draft: draftWith(asset, conns.instagram, RED_4x5) });
    const v2 = await validatePost(t.ownerCtx, id, [conns.instagram]);
    expect(v2.ok).toBe(true);
    await updateDraft(t.ownerCtx, id, { expected_version: 2, draft: draftWith(asset, conns.instagram, { preset: 'free', x: 1500, y: 0, width: 400, height: 600 }) });
    const v3 = await validatePost(t.ownerCtx, id, [conns.instagram]);
    expect(v3.issues.find((i) => i.code === 'invalid_crop')?.message).toMatch(/beyond the image/);
    await updateDraft(t.ownerCtx, id, { expected_version: 3, draft: draftWith(asset, conns.instagram, { preset: '1:1', x: 0, y: 0, width: 480, height: 600 }) });
    expect((await validatePost(t.ownerCtx, id, [conns.instagram])).issues.find((i) => i.code === 'invalid_crop')?.message).toMatch(/not 1:1/);
  });
});

describe('approval', () => {
  it('the crop is part of the revision content hash; changing it invalidates a pending approval', async () => {
    const t = await tenant({ approvalRequired: true });
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const asset = await realImage(t);
    const conn = [{ id: conns.instagram, provider: 'instagram' as const }];
    const hRed = contentHash('Cropped', null, [asset], resolveVariants(draftWith(asset, conns.instagram, RED_4x5), conn));
    const hBlue = contentHash('Cropped', null, [asset], resolveVariants(draftWith(asset, conns.instagram, BLUE_4x5), conn));
    expect(hRed).not.toBe(hBlue);
    const { id } = await createPost(t.ownerCtx, t.brandId, { title: 'c', draft: draftWith(asset, conns.instagram, RED_4x5) }, randomUUID());
    const when = toLocalInput(new Date(Date.now() + 3 * 3600_000), 'Europe/London');
    const r = await submitForReview(t.ownerCtx, id, { expected_version: 1, connection_ids: [conns.instagram], input_local_time: when, timezone: 'Europe/London' }, randomUUID());
    const approvalId = (r.body as { approval: { id: string } }).approval.id;
    const rev = await testPool().query(`SELECT r.content_hash, v.options FROM schedules s JOIN post_revisions r ON r.id=s.revision_id JOIN variants v ON v.revision_id=r.id WHERE s.post_id=$1`, [id]);
    expect(rev.rows[0].content_hash).toBe(hRed);
    expect(rev.rows[0].options.crop[asset]).toEqual(RED_4x5);
    // Same crop re-saved: approval stays pending.
    await updateDraft(t.ownerCtx, id, { expected_version: 1, draft: draftWith(asset, conns.instagram, RED_4x5) });
    expect((await testPool().query(`SELECT decision FROM approvals WHERE id=$1`, [approvalId])).rows[0].decision).toBe('pending');
    // Crop changed: invalidated.
    await updateDraft(t.ownerCtx, id, { expected_version: 2, draft: draftWith(asset, conns.instagram, BLUE_4x5) });
    expect((await testPool().query(`SELECT decision, reason FROM approvals WHERE id=$1`, [approvalId])).rows[0]).toMatchObject({ decision: 'invalidated' });
  });
});

describe('engine', () => {
  it('publishes the cropped derivative (dims, bytes and pixels of the crop)', async () => {
    const t = await tenant();
    const conns = await seedConnections(t.workspaceId, t.brandId);
    const asset = await realImage(t);
    const world = scriptedWorld();
    // Real media loading (signed URL + storage) instead of the fake, so the crop path is exercised end to end.
    const seen: PublishMedia[] = [];
    let cropsPassed: unknown = null;
    world.deps.loadMedia = async (ws, ids, opts) => { cropsPassed = opts?.crops ?? null; const m = await loadPublishMedia(testPool(), ws, ids, 600, opts); seen.push(...m); return m; };
    const { id } = await createPost(t.ownerCtx, t.brandId, { title: 'c', draft: draftWith(asset, conns.instagram, BLUE_4x5) }, randomUUID());
    await publishNow(t.ownerCtx, id, { expected_version: 1, connection_ids: [conns.instagram] }, randomUUID());
    let state = '';
    for (let i = 0; i < 5 && state !== 'published'; i++) {
      const c = await claimDelivery('crop-worker');
      if (!c) break;
      state = await processDelivery(world.deps, c);
    }
    expect(state).toBe('published');
    expect(cropsPassed).toEqual({ [asset]: BLUE_4x5 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ assetId: asset, mime: 'image/jpeg', width: 480, height: 600 });
    const bytes = await seen[0]!.load();
    const meta = await sharp(Buffer.from(bytes)).metadata();
    expect([meta.width, meta.height]).toEqual([480, 600]);
    const px = await sharp(Buffer.from(bytes)).resize(1, 1).raw().toBuffer();
    expect(px[2]).toBeGreaterThan(180); // blue half
    expect(px[0]).toBeLessThan(80);
  });
});
