// Integration tests run against a REAL PostgreSQL database, never SQLite or in-memory substitutes.
// Each run gets its OWN disposable database (socialite_test_<pid>) so concurrent runs cannot clobber
// each other; it is created from migrations and dropped afterwards. Set TEST_DATABASE_URL to pin one.
import pg from 'pg';
import { migrate, resetDatabase } from '../../packages/db/src/migrate.js';

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://socialite:socialite-local-only@localhost:54329/postgres';

function urlFor(db: string): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  return u.toString();
}

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? urlFor(`socialite_test_${process.env.SOCIALITE_TEST_RUN ?? 'default'}`);

export default async function setup(): Promise<() => Promise<void>> {
  process.env.APP_ENV = 'test';
  const pinned = !!process.env.TEST_DATABASE_URL;
  const dbName = `socialite_test_${process.pid}_${Date.now().toString(36)}`;
  const url = pinned ? process.env.TEST_DATABASE_URL! : urlFor(dbName);
  if (!pinned) {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    process.env.TEST_DATABASE_URL = url; // inherited by test workers forked after setup
  }
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    if (pinned) await resetDatabase(pool);
    await migrate(pool);
  } finally {
    await pool.end();
  }
  return async () => {
    if (pinned) return;
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.end();
  };
}
