// Least-privilege database roles (see infra/postgres/roles.sql). ensureLoginRoles() creates/updates the three
// login roles from configured connection URLs (development: values in .env; production: platform-provisioned),
// applyRoleGrants() applies the idempotent per-database grants. Both must run as the database owner/superuser.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

export const DB_ROLES = ['socialite_migrator', 'socialite_app', 'socialite_worker'] as const;
export type DbRole = (typeof DB_ROLES)[number];

const ROLES_SQL = process.env.DB_ROLES_SQL ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'infra', 'postgres', 'roles.sql');

/** Create missing roles (NOLOGIN unless a password is given) — never superuser, createdb, createrole or bypassrls. */
export async function ensureLoginRoles(admin: pg.ClientBase, passwords: Partial<Record<DbRole, string>> = {}): Promise<void> {
  for (const role of DB_ROLES) {
    const exists = (await admin.query(`SELECT 1 FROM pg_roles WHERE rolname=$1`, [role])).rowCount === 1;
    const pw = passwords[role];
    const attrs = `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS ${pw ? `LOGIN PASSWORD ${admin.escapeLiteral(pw)}` : exists ? '' : 'NOLOGIN'}`;
    await admin.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${admin.escapeIdentifier(role)} WITH ${attrs}`);
  }
}

export async function applyRoleGrants(admin: pg.ClientBase): Promise<void> {
  await admin.query(await readFile(ROLES_SQL, 'utf8'));
}

/** Password for `role` if `url` connects as that role (used to provision local roles from .env URLs). */
export function passwordFor(url: string | undefined, role: DbRole): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return decodeURIComponent(u.username) === role && u.password ? decodeURIComponent(u.password) : undefined;
  } catch {
    return undefined;
  }
}
