// Readiness (public, cheap) and diagnostics (owner/admin, contacts dependencies).
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, many, maybeOne, type Queryable } from '@social-lite/db';
import { config } from './config.js';
import type { Ctx } from './context.js';
import { verifySmtp } from './email.js';
import { headBucket } from './storage.js';
import { requireAction } from './tenancy.js';

export const HEARTBEAT_STALE_MS = 2 * 60 * 1000;

function migrationsDir(): string | null {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    resolve(process.cwd(), 'packages/db/migrations'),
    resolve(process.cwd(), '../../packages/db/migrations'),
  ];
  try {
    candidates.push(join(dirname(fileURLToPath(import.meta.url)), '../../db/migrations'));
  } catch { /* bundled: import.meta.url may not be a file URL */ }
  return candidates.find((d): d is string => !!d && existsSync(d)) ?? null;
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out`)), ms); })]);
  } finally {
    clearTimeout(t);
  }
}

export interface Readiness { status: 'ready' | 'not_ready'; checks: { database: { ok: boolean; detail: string }; migrations: { ok: boolean; detail: string } } }

/** /api/ready: database reachable and every migration file applied. */
export async function readiness(db: Queryable = getPool()): Promise<Readiness> {
  const checks: Readiness['checks'] = { database: { ok: false, detail: 'not checked' }, migrations: { ok: false, detail: 'not checked' } };
  try {
    await withTimeout(db.query('SELECT 1'), 3000, 'database');
    checks.database = { ok: true, detail: 'reachable' };
  } catch {
    checks.database = { ok: false, detail: 'unreachable' };
    return { status: 'not_ready', checks };
  }
  const dir = migrationsDir();
  if (!dir) {
    checks.migrations = { ok: false, detail: 'migration files not found (set MIGRATIONS_DIR)' };
  } else {
    try {
      const files = (await readdir(dir)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
      const applied = new Set((await many<{ name: string }>(db, `SELECT name FROM schema_migrations`)).map((r) => r.name));
      const pending = files.filter((f) => !applied.has(f));
      checks.migrations = pending.length
        ? { ok: false, detail: `${pending.length} migration(s) not applied` }
        : { ok: true, detail: `${files.length} applied` };
    } catch {
      checks.migrations = { ok: false, detail: 'schema_migrations table missing' };
    }
  }
  return { status: checks.database.ok && checks.migrations.ok ? 'ready' : 'not_ready', checks };
}

export interface DiagnosticCheck { name: string; ok: boolean; detail: string }

async function check(name: string, fn: () => Promise<string>, timeoutMs = 5000): Promise<DiagnosticCheck> {
  try {
    return { name, ok: true, detail: await withTimeout(fn(), timeoutMs, name) };
  } catch (err) {
    const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
    const detail = e.$metadata?.httpStatusCode ? `${e.name ?? 'error'} (HTTP ${e.$metadata.httpStatusCode})` : (e.message ?? 'failed').slice(0, 200);
    return { name, ok: false, detail };
  }
}

export async function diagnostics(ctx: Ctx, db: Queryable = getPool()): Promise<{ checks: DiagnosticCheck[] }> {
  requireAction(ctx, 'diagnostics.read');
  const c = config();
  const checks = await Promise.all([
    check('database', async () => {
      const r = await maybeOne<{ v: string }>(db, `SELECT current_setting('server_version') AS v`);
      const ready = await readiness(db);
      if (!ready.checks.migrations.ok) throw new Error(ready.checks.migrations.detail);
      return `PostgreSQL ${r?.v ?? '?'}; ${ready.checks.migrations.detail}`;
    }),
    check('storage', async () => {
      await headBucket();
      return `bucket ${c.S3_BUCKET} reachable`;
    }),
    check('oidc', async () => {
      if (!c.OIDC_ISSUER) throw new Error('OIDC_ISSUER is not configured');
      const url = `${c.OIDC_ISSUER.replace(/\/$/, '')}/.well-known/openid-configuration`;
      const res = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: 'error' });
      if (!res.ok) throw new Error(`discovery returned HTTP ${res.status}`);
      const meta = (await res.json()) as { issuer?: string };
      if (meta.issuer !== c.OIDC_ISSUER) throw new Error('issuer in discovery document does not match OIDC_ISSUER');
      return `discovery ok (${meta.issuer})`;
    }),
    check('smtp', async () => {
      const r = await verifySmtp(4000);
      if (!r.ok) throw new Error(r.detail);
      return r.detail;
    }),
    check('worker_heartbeat', async () => {
      const r = await maybeOne<{ n: number; last: Date | null }>(db, `SELECT count(*)::int AS n, max(last_seen_at) AS last FROM worker_heartbeats`);
      if (!r?.last) throw new Error('no worker has reported a heartbeat');
      const age = Date.now() - r.last.getTime();
      if (age > HEARTBEAT_STALE_MS) throw new Error(`last heartbeat ${Math.round(age / 1000)}s ago`);
      return `${r.n} worker(s); last heartbeat ${Math.round(age / 1000)}s ago`;
    }),
    check('dispatch_enabled', async () => {
      const r = await maybeOne<{ value: unknown }>(db, `SELECT value FROM system_flags WHERE key='dispatch_enabled'`);
      if (r?.value !== true) throw new Error('dispatch is disabled (post-restore reconciliation pending)');
      return 'dispatch enabled';
    }),
  ]);
  return { checks };
}
