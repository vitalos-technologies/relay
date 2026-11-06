import pg from 'pg';

// Return timestamptz as JS Date (default), bigint/int8 as string to avoid precision loss.
pg.types.setTypeParser(20, (v) => v); // int8 -> string

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

let shared: pg.Pool | undefined;

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not configured');
  return url;
}

export function createPool(connectionString = databaseUrl(), max = Number(process.env.DATABASE_POOL_MAX ?? 10)): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    application_name: process.env.SERVICE_NAME ?? 'social-lite',
  });
  pool.on('error', (err) => {
    // Idle client errors must not crash the process; log a safe category only.
    console.error(JSON.stringify({ level: 'error', msg: 'pg_pool_idle_error', code: (err as { code?: string }).code }));
  });
  return pool;
}

/** Process-wide pool (web and worker each create one). */
export function getPool(): pg.Pool {
  if (!shared) shared = createPool();
  return shared;
}

export async function closePool(): Promise<void> {
  if (shared) {
    const p = shared;
    shared = undefined;
    await p.end();
  }
}

/** Override the shared pool (tests). */
export function setPool(pool: pg.Pool | undefined): void {
  shared = pool;
}

/**
 * Run fn in a transaction. Never perform external network calls inside fn:
 * transactions must stay short (see durable publishing algorithm, step 6).
 */
export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>, pool: pg.Pool = getPool()): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection may be broken */ }
    throw err;
  } finally {
    client.release();
  }
}

export async function one<T extends pg.QueryResultRow>(db: Queryable, sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<T>(sql, params);
  if (r.rows.length !== 1) throw new Error(`expected exactly one row, got ${r.rows.length}`);
  return r.rows[0]!;
}

export async function maybeOne<T extends pg.QueryResultRow>(db: Queryable, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await db.query<T>(sql, params);
  return r.rows[0] ?? null;
}

export async function many<T extends pg.QueryResultRow>(db: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.query<T>(sql, params);
  return r.rows;
}
