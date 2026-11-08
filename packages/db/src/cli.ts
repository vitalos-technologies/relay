import { createPool } from './pool.js';
import { migrate, resetDatabase } from './migrate.js';

const cmd = process.argv[2];
// Migrations run as the migrator role (DDL); reset needs the schema owner. Both fall back to DATABASE_URL.
const url = cmd === 'reset'
  ? process.env.DATABASE_ADMIN_URL ?? process.env.MIGRATOR_DATABASE_URL ?? process.env.DATABASE_URL
  : process.env.MIGRATOR_DATABASE_URL ?? process.env.DATABASE_URL;
const pool = createPool(url, 2);
try {
  if (cmd === 'migrate') {
    const r = await migrate(pool);
    console.log(JSON.stringify({ msg: 'migrations', applied: r.applied, alreadyApplied: r.skipped.length }));
  } else if (cmd === 'reset') {
    await resetDatabase(pool);
    console.log(JSON.stringify({ msg: 'database reset' }));
  } else {
    console.error('usage: cli.ts migrate|reset');
    process.exitCode = 2;
  }
} catch (err) {
  console.error(JSON.stringify({ level: 'error', msg: (err as Error).message }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
