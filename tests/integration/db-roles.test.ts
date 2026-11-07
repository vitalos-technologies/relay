// Least-privilege database roles (infra/postgres/roles.sql) verified against real PostgreSQL:
// the app and worker roles have DML only (no DDL, no superuser) and the audit log is append-only for them;
// only the migrator can change the schema.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { applyRoleGrants, ensureLoginRoles } from '../../packages/db/src/roles.js';
import { closeTestPool, testPool } from './helpers.js';

let client: pg.PoolClient;

beforeAll(async () => {
  client = await testPool().connect();
  await ensureLoginRoles(client);   // creates missing roles (NOLOGIN); never changes existing passwords
  await applyRoleGrants(client);
  await applyRoleGrants(client);    // idempotent
});
afterAll(async () => {
  client.release();
  await closeTestPool();
});

/** Run `sql` as `role` inside a rolled-back transaction; returns the error code (or null on success). */
async function as(role: string, sql: string): Promise<string | null> {
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(sql);
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'error';
  } finally {
    await client.query('ROLLBACK');
  }
}

describe('database roles', () => {
  it('no application role is a superuser or can create roles/databases', async () => {
    const r = await client.query(`SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname LIKE 'socialite\\_%' AND rolname <> 'socialite' ORDER BY 1`);
    expect(r.rows.map((x) => x.rolname)).toEqual(['socialite_app', 'socialite_migrator', 'socialite_worker']);
    for (const row of r.rows) expect([row.rolsuper, row.rolcreaterole, row.rolcreatedb, row.rolbypassrls]).toEqual([false, false, false, false]);
    const owners = await client.query(`SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname='public'`);
    expect(owners.rows).toEqual([{ tableowner: 'socialite_migrator' }]);
  });

  it('app and worker: DML on application tables, audit log INSERT/SELECT only, no DDL', async () => {
    for (const role of ['socialite_app', 'socialite_worker']) {
      expect(await as(role, `SELECT count(*) FROM posts`), role).toBeNull();
      expect(await as(role, `INSERT INTO audit_events(workspace_id, action, resource_type) VALUES (NULL, 'test.append', 'test')`), role).toBeNull();
      expect(await as(role, `SELECT count(*) FROM audit_events`), role).toBeNull();
      expect(await as(role, `UPDATE audit_events SET action = action`), role).toBe('42501');       // insufficient_privilege
      expect(await as(role, `DELETE FROM audit_events`), role).toBe('42501');
      expect(await as(role, `TRUNCATE audit_events`), role).toBe('42501');
      expect(await as(role, `ALTER TABLE posts ADD COLUMN x int`), role).toBe('42501');           // must be owner
      expect(await as(role, `ALTER TABLE audit_events DISABLE TRIGGER ALL`), role).toBe('42501');
      expect(await as(role, `DROP TABLE posts`), role).toBe('42501');
      expect(await as(role, `CREATE TABLE public.sneaky(a int)`), role).toBe('42501');
      expect(await as(role, `CREATE INDEX ON posts(title)`), role).toBe('42501');
      expect(await as(role, `INSERT INTO schema_migrations(name, checksum) VALUES ('999_x.sql','x')`), role).toBe('42501');
      expect(await as(role, `UPDATE sessions SET last_seen_at = now() WHERE false`), role).toBeNull();
      expect(await as(role, `CREATE ROLE evil`), role).toBe('42501');
    }
  });

  it('only the migrator changes the schema', async () => {
    expect(await as('socialite_migrator', `ALTER TABLE posts ADD COLUMN x int`)).toBeNull();
    expect(await as('socialite_migrator', `CREATE TABLE public.migration_probe(a int)`)).toBeNull();
    expect(await as('socialite_migrator', `CREATE ROLE evil`)).toBe('42501');
  });

  it('tables created later by the migrator get app/worker DML via default privileges', async () => {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL ROLE socialite_migrator`);
      await client.query(`CREATE TABLE public.later_table(id int)`);
      await client.query(`SET LOCAL ROLE socialite_app`);
      await client.query(`INSERT INTO public.later_table VALUES (1)`);
      const r = await client.query(`SELECT count(*)::int n FROM public.later_table`);
      expect(r.rows[0].n).toBe(1);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
