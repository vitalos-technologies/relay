import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const LOCK_ID = 727_001; // advisory lock: one migration job at a time

export interface MigrationResult { applied: string[]; skipped: string[] }

export async function migrate(pool: pg.Pool, dir = MIGRATIONS_DIR): Promise<MigrationResult> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const files = (await readdir(dir)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    const done = new Map<string, string>(
      (await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]),
    );
    const applied: string[] = [];
    const skipped: string[] = [];
    for (const f of files) {
      const sql = await readFile(join(dir, f), 'utf8');
      const sum = createHash('sha256').update(sql).digest('hex');
      const prior = done.get(f);
      if (prior) {
        if (prior !== sum) throw new Error(`migration ${f} was modified after being applied (checksum mismatch)`);
        skipped.push(f);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)', [f, sum]);
        await client.query('COMMIT');
        applied.push(f);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${(err as Error).message}`);
      }
    }
    return { applied, skipped };
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]); } catch { /* ignore */ }
    client.release();
  }
}

/** Drop and recreate the public schema. Refuses to run outside development/test. */
export async function resetDatabase(pool: pg.Pool): Promise<void> {
  const env = process.env.APP_ENV ?? 'development';
  if (env === 'production') throw new Error('refusing to reset a production database');
  await pool.query('DROP SCHEMA IF EXISTS pgboss CASCADE');
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
}
