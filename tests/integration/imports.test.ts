import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { commitImport, previewImport } from '@social-lite/services/imports';
import { closeTestPool, tenant, testPool } from './helpers.js';
import { seedConnections, seedReadyImage } from './engine-helpers.js';

afterAll(closeTestPool);

describe('CSV import (drafts only)', () => {
  it('previews per-row, per-destination issues and commits only valid rows as drafts', async () => {
    const t = await tenant();
    await seedConnections(t.workspaceId, t.brandId);
    const img = await seedReadyImage(t.workspaceId, t.brandId);
    const csv = [
      'title,text,destinations,image_asset_id,scheduled_local_time,tags',
      `Good,"Hello, world",facebook|telegram,,2027-01-10T09:00,news|weekly`,
      `NeedsImage,Text only,instagram,,,`,
      `WithImage,Photo post,instagram|x,${img},,`,
      `BadTime,Spring gap,facebook,,2027-03-28T01:30,`,
      `Formula,=HYPERLINK("x"),bogus,,,`,
    ].join('\n');
    const p = await previewImport(t.ownerCtx, t.brandId, csv);
    expect(p.rows.map((r) => r.ok)).toEqual([true, false, true, false, false]);
    expect(p.rows[1]!.issues[0]!.message).toMatch(/Instagram: an image or video is required/);
    expect(p.rows[3]!.issues[0]!.code).toBe('gap');
    expect(p.rows[4]!.issues[0]!.code).toBe('unknown_provider');
    expect(p.rows[0]!.suggested_time!.utc).toBe('2027-01-10T09:00:00.000Z');
    const before = await testPool().query(`SELECT count(*)::int n FROM schedules s JOIN posts p ON p.id=s.post_id WHERE p.brand_id=$1`, [t.brandId]);
    const c = await commitImport(t.ownerCtx, t.brandId, csv, p.csv_hash, randomUUID());
    expect(c.created.map((x) => x.row)).toEqual([1, 3]);
    expect(c.skipped).toEqual([2, 4, 5]);
    const after = await testPool().query(`SELECT count(*)::int n FROM schedules s JOIN posts p ON p.id=s.post_id WHERE p.brand_id=$1`, [t.brandId]);
    expect(after.rows[0].n).toBe(before.rows[0].n); // nothing scheduled
    const post = await testPool().query(`SELECT tags, source FROM posts WHERE id=$1`, [c.created[0]!.post_id]);
    expect(post.rows[0].tags).toEqual(['news', 'weekly']);
    expect(post.rows[0].source.kind).toBe('csv_import');
    await expect(commitImport(t.ownerCtx, t.brandId, csv + '\nx,y,facebook,,,', p.csv_hash, randomUUID())).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects other tenants’ assets and viewers', async () => {
    const a = await tenant();
    const b = await tenant();
    await seedConnections(a.workspaceId, a.brandId);
    const foreign = await seedReadyImage(b.workspaceId, b.brandId);
    const p = await previewImport(a.ownerCtx, a.brandId, `text,destinations,image_asset_id\nhi,facebook,${foreign}`);
    expect(p.rows[0]!.issues.map((i) => i.code)).toContain('unknown_asset');
    await expect(previewImport({ ...a.ownerCtx, access: { ...a.ownerCtx.access, role: 'viewer' } }, a.brandId, 'text\nhi')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(previewImport(b.ownerCtx, a.brandId, 'text\nhi')).rejects.toMatchObject({ code: 'not_found' });
  });
});
