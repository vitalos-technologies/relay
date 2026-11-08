// PostgreSQL-backed store for simulated business-connector APIs (migration 030, mock_ accounts only) so simulated
// objects survive restarts and are shared by the web app and the worker (truthful reconciliation).
import { getPool, type Queryable } from '@social-lite/db';
import type { SimStore } from '@social-lite/providers/biz/sim';

export class DbSimStore implements SimStore {
  constructor(private readonly q: Queryable | null = null) {}
  private get db(): Queryable { return this.q ?? getPool(); }
  async get(c: string, a: string, t: string, i: string) {
    const r = await this.db.query<{ data: Record<string, unknown> }>(`SELECT data FROM integration_sim_objects WHERE connector=$1 AND account_id=$2 AND object_type=$3 AND object_id=$4`, [c, a, t, i]);
    return r.rows[0]?.data ?? null;
  }
  async put(c: string, a: string, t: string, i: string, data: Record<string, unknown>) {
    await this.db.query(`INSERT INTO integration_sim_objects(connector, account_id, object_type, object_id, data) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (connector, account_id, object_type, object_id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [c, a, t, i, JSON.stringify(data)]);
  }
  async list(c: string, a: string, t: string) {
    const r = await this.db.query<{ object_id: string; data: Record<string, unknown>; created_at: Date }>(
      `SELECT object_id, data, created_at FROM integration_sim_objects WHERE connector=$1 AND account_id=$2 AND object_type=$3 ORDER BY created_at, object_id LIMIT 500`, [c, a, t]);
    return r.rows.map((x) => ({ id: x.object_id, data: x.data, createdAt: x.created_at.toISOString() }));
  }
  async incr(key: string) {
    const r = await this.db.query<{ value: number }>(`INSERT INTO integration_sim_counters(key, value) VALUES ($1, 1) ON CONFLICT (key) DO UPDATE SET value = integration_sim_counters.value + 1 RETURNING value`, [key]);
    return r.rows[0]!.value;
  }
}
