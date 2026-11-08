// Per-provider circuit breaker: repeated transient/ambiguous failures open the circuit for a
// short cool-down so a provider outage does not burn retries; deadlines still apply.
import type { Provider } from '@social-lite/core';
import type { Queryable } from '@social-lite/db';

const THRESHOLD = 5;
const OPEN_MS = 120_000;

export async function recordCircuit(db: Queryable, provider: Provider, success: boolean): Promise<void> {
  if (success) {
    await db.query(`UPDATE provider_circuits SET failure_count=0, state='closed', opened_until=NULL, updated_at=now() WHERE provider=$1 AND failure_count>0`, [provider]);
    return;
  }
  await db.query(
    `INSERT INTO provider_circuits(provider, failure_count, updated_at) VALUES ($1, 1, now())
     ON CONFLICT (provider) DO UPDATE SET
       failure_count = CASE WHEN provider_circuits.updated_at < now() - interval '10 minutes' THEN 1 ELSE provider_circuits.failure_count + 1 END,
       state = CASE WHEN provider_circuits.failure_count + 1 >= $2 THEN 'open' ELSE provider_circuits.state END,
       opened_until = CASE WHEN provider_circuits.failure_count + 1 >= $2 THEN now() + ($3 || ' milliseconds')::interval ELSE provider_circuits.opened_until END,
       updated_at = now()`, [provider, THRESHOLD, String(OPEN_MS)]);
}
