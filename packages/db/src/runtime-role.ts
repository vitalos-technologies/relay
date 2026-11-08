// G14: the web app and worker must not run as a privileged database role. Least-privilege roles
// (socialite_app / socialite_worker) have no superuser/bypassrls/createrole/createdb attributes and own no tables;
// a runtime connected as the owner or a superuser would silently bypass the grants in infra/postgres/roles.sql.
import type { Queryable } from './pool.js';

export interface RuntimeRoleCheck { role: string; problems: string[] }

export async function checkRuntimeDbRole(db: Queryable): Promise<RuntimeRoleCheck> {
  const r = await db.query<{ role: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; owns: boolean }>(
    `SELECT current_user AS role, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
            EXISTS (SELECT 1 FROM pg_tables t WHERE t.schemaname='public' AND t.tableowner=current_user) AS owns
       FROM pg_roles r WHERE r.rolname=current_user`);
  const row = r.rows[0];
  if (!row) return { role: 'unknown', problems: ['the database role could not be inspected'] };
  const problems: string[] = [];
  if (row.rolsuper) problems.push('is a superuser');
  if (row.rolbypassrls) problems.push('bypasses row-level security');
  if (row.rolcreaterole) problems.push('can create roles');
  if (row.rolcreatedb) problems.push('can create databases');
  if (row.owns) problems.push('owns application tables (use the migrator role only for migrations)');
  return { role: row.role, problems };
}

/** Production: refuse to start as a privileged role. Elsewhere: return the problems so callers can warn. */
export async function assertRuntimeDbRole(db: Queryable, opts: { production: boolean; component: 'web' | 'worker' }): Promise<RuntimeRoleCheck> {
  const c = await checkRuntimeDbRole(db);
  if (opts.production && c.problems.length) {
    throw new Error(`Refusing to start ${opts.component}: database role "${c.role}" ${c.problems.join(', ')}. Connect as the least-privilege ${opts.component === 'web' ? 'socialite_app' : 'socialite_worker'} role (docs/DEPLOYMENT.md).`);
  }
  return c;
}
