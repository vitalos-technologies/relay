// Provision least-privilege database roles for local development and apply infra/postgres/roles.sql.
// Runs as DATABASE_ADMIN_URL (the bootstrap/owner account). Login passwords come from the role URLs:
//   MIGRATOR_DATABASE_URL (socialite_migrator, DDL) · DATABASE_URL (socialite_app) · WORKER_DATABASE_URL (socialite_worker)
// Usage: tsx scripts/db-roles.ts [--db <name>]   (default: the database in DATABASE_URL)
// Production: roles are provisioned by the platform; run this only with an owner connection in a release job.
import pg from 'pg';
import { applyRoleGrants, ensureLoginRoles, passwordFor } from '../packages/db/src/roles.js';

async function main(): Promise<void> {
const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) {
  console.log(JSON.stringify({ msg: 'db-roles skipped: DATABASE_ADMIN_URL is not set (roles are provisioned by the platform)' }));
  return;
}
const argDb = process.argv.indexOf('--db');
const target = argDb > 0 ? process.argv[argDb + 1]! : new URL(process.env.DATABASE_URL ?? adminUrl).pathname.slice(1);
const url = new URL(adminUrl);
url.pathname = `/${target}`;
const client = new pg.Client({ connectionString: url.toString() });
await client.connect();
try {
  await ensureLoginRoles(client, {
    socialite_migrator: passwordFor(process.env.MIGRATOR_DATABASE_URL, 'socialite_migrator'),
    socialite_app: passwordFor(process.env.DATABASE_URL, 'socialite_app'),
    socialite_worker: passwordFor(process.env.WORKER_DATABASE_URL, 'socialite_worker'),
  });
  await applyRoleGrants(client);
  console.log(JSON.stringify({ msg: 'db roles applied', database: target }));
} finally {
  await client.end();
}
}

main().catch((err) => { console.error(JSON.stringify({ level: 'error', msg: (err as Error).message })); process.exit(1); });
