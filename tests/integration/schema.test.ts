import { afterAll, describe, expect, it } from 'vitest';
import { closeTestPool, createBrand, createWorkspace, testPool } from './helpers.js';

afterAll(closeTestPool);

describe('schema invariants (real PostgreSQL)', () => {
  it('prevents cross-tenant relationships with composite foreign keys', async () => {
    const db = testPool();
    const wsA = await createWorkspace('A');
    const wsB = await createWorkspace('B');
    const brandB = await createBrand(wsB);
    // A connection in workspace A that points at a brand in workspace B must be rejected.
    await expect(db.query(
      `INSERT INTO connections(workspace_id, brand_id, provider, provider_account_id, display_name, is_mock)
       VALUES ($1,$2,'telegram','mock_1','x',true)`, [wsA, brandB])).rejects.toThrow(/foreign key/);
  });

  it('makes revisions immutable', async () => {
    const db = testPool();
    const ws = await createWorkspace();
    const brand = await createBrand(ws);
    const post = await db.query<{ id: string }>(`INSERT INTO posts(workspace_id, brand_id) VALUES ($1,$2) RETURNING id`, [ws, brand]);
    const rev = await db.query<{ id: string }>(
      `INSERT INTO post_revisions(workspace_id, post_id, revision_number, base_text, content_hash) VALUES ($1,$2,1,'hi','h') RETURNING id`,
      [ws, post.rows[0]!.id]);
    await expect(db.query(`UPDATE post_revisions SET base_text='changed' WHERE id=$1`, [rev.rows[0]!.id])).rejects.toThrow(/immutable/);
  });

  it('refuses mock flag on non-mock identities', async () => {
    const db = testPool();
    const ws = await createWorkspace();
    const brand = await createBrand(ws);
    await expect(db.query(
      `INSERT INTO connections(workspace_id, brand_id, provider, provider_account_id, display_name, is_mock)
       VALUES ($1,$2,'telegram','-100123','real',true)`, [ws, brand])).rejects.toThrow(/check constraint/);
  });
});
