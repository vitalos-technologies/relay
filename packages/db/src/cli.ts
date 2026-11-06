import { createPool } from './pool.js';
import { migrate, resetDatabase } from './migrate.js';

const cmd = process.argv[2];
const pool = createPool(undefined, 2);
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
