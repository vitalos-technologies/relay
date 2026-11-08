// PostgreSQL-backed MockStore for simulated destinations (survives worker restarts so that
// reconciliation of simulated Unknown outcomes is truthful).
import type { Provider } from '@social-lite/core';
import { getPool, type Queryable } from '@social-lite/db';
import type { MockObject, MockStore } from '@social-lite/providers';

export class DbMockStore implements MockStore {
  constructor(private readonly db: Queryable = getPool()) {}

  async put(o: MockObject): Promise<void> {
    await this.db.query(
      `INSERT INTO mock_provider_objects(provider, object_id, account_id, kind, data, created_at) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (provider, object_id) DO UPDATE SET data = EXCLUDED.data, kind = EXCLUDED.kind`,
      [o.provider, o.objectId, o.accountId, o.kind, JSON.stringify(o.data), o.createdAt]);
  }

  async get(provider: Provider, objectId: string): Promise<MockObject | null> {
    const r = await this.db.query<{ provider: Provider; object_id: string; account_id: string; kind: string; data: Record<string, unknown>; created_at: Date }>(
      `SELECT * FROM mock_provider_objects WHERE provider=$1 AND object_id=$2`, [provider, objectId]);
    const row = r.rows[0];
    return row ? { provider: row.provider, objectId: row.object_id, accountId: row.account_id, kind: row.kind, data: row.data, createdAt: row.created_at.toISOString() } : null;
  }

  async list(provider: Provider, accountId: string, kind?: string): Promise<MockObject[]> {
    const r = await this.db.query<{ provider: Provider; object_id: string; account_id: string; kind: string; data: Record<string, unknown>; created_at: Date }>(
      `SELECT * FROM mock_provider_objects WHERE provider=$1 AND account_id=$2 AND ($3::text IS NULL OR kind=$3)
        ORDER BY created_at DESC LIMIT 200`, [provider, accountId, kind ?? null]);
    return r.rows.map((row) => ({ provider: row.provider, objectId: row.object_id, accountId: row.account_id, kind: row.kind, data: row.data, createdAt: row.created_at.toISOString() }));
  }

  async incr(key: string): Promise<number> {
    const r = await this.db.query<{ value: number }>(
      `INSERT INTO mock_provider_counters(key, value) VALUES ($1, 1)
       ON CONFLICT (key) DO UPDATE SET value = mock_provider_counters.value + 1 RETURNING value`, [key]);
    return r.rows[0]!.value;
  }
}
