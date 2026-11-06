// Integration tests run against a REAL PostgreSQL database (socialite_test), never SQLite
// or in-memory substitutes. The schema is rebuilt from migrations once per run.
import pg from 'pg';
import { migrate, resetDatabase } from '../../packages/db/src/migrate.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://socialite:socialite-local-only@localhost:54329/socialite_test';

export default async function setup(): Promise<void> {
  process.env.APP_ENV = 'test';
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  try {
    await resetDatabase(pool);
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
