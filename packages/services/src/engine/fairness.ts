// Fair dispatch across workspaces (V2 §7 "Fair scheduling"). Used by claimDelivery():
//  - Per-workspace concurrency cap: a workspace never holds more than N live leases (default
//    DISPATCH_WORKSPACE_CONCURRENCY=4; operators may override per workspace with
//    workspaces.limits.dispatch_concurrency). Exact under concurrent workers: claims for one workspace
//    serialize on its workspace_dispatch_state row and re-count live leases after taking the lock.
//  - Fair ordering: among due work, the workspace with the fewest live leases goes first, then the one
//    served least recently (round-robin), then due time. One bulk campaign therefore cannot starve
//    other workspaces; within a workspace, due order is unchanged.
//  - Per-connection serialization, throttles and provider circuits are kept exactly as before.
// DISPATCH_FAIR_ORDERING=off restores plain due-time ordering (kill switch; the cap still applies).
//  - V3.1 per-provider cap: at most N live leases per provider across all workers (DISPATCH_PROVIDER_CONCURRENCY,
//    default 8; per provider DISPATCH_PROVIDER_CONCURRENCY_<PROVIDER>, e.g. _X=2). Exact under concurrency: claims for a
//    provider serialize on a transaction advisory lock (taken after the workspace row lock — one fixed order) and
//    re-count. Polls of 'processing' deliveries count too (they call the provider).
import type { DeliveryState } from '@social-lite/core';
import { maybeOne, one, type Queryable } from '@social-lite/db';

export function defaultWorkspaceConcurrency(): number {
  const n = Number(process.env.DISPATCH_WORKSPACE_CONCURRENCY ?? 4);
  return Number.isInteger(n) && n >= 1 ? n : 4;
}

/** Per-provider live-lease caps: { default, overrides } from the environment. */
export function providerConcurrency(env: NodeJS.ProcessEnv = process.env): { fallback: number; caps: Record<string, number> } {
  const int = (v: string | undefined) => { const n = Number(v); return v !== undefined && v !== '' && Number.isInteger(n) && n >= 1 ? n : null; };
  const caps: Record<string, number> = {};
  for (const [k, v] of Object.entries(env)) {
    const m = /^DISPATCH_PROVIDER_CONCURRENCY_([A-Z]+)$/.exec(k);
    const n = int(v);
    if (m && n) caps[m[1]!.toLowerCase()] = n;
  }
  return { fallback: int(env.DISPATCH_PROVIDER_CONCURRENCY) ?? 8, caps };
}

const fairOrdering = () => process.env.DISPATCH_FAIR_ORDERING !== 'off';

const CAP_SQL = (param: string) =>
  `CASE WHEN jsonb_typeof(w.limits->'dispatch_concurrency') = 'number' AND (w.limits->>'dispatch_concurrency')::numeric >= 1
        THEN floor((w.limits->>'dispatch_concurrency')::numeric)::int ELSE ${param}::int END`;

export interface FairCandidate { id: string; state: DeliveryState; workspace_id: string }

/**
 * Select (and row-lock) the next eligible delivery, honouring per-workspace caps and fair ordering.
 * MUST run inside the claim transaction; the caller transitions the returned row.
 */
export async function selectFairCandidate(tx: Queryable, deliveryId: string | null): Promise<FairCandidate | null> {
  const excluded: string[] = [];
  const excludedProviders: string[] = [];
  const fallbackCap = defaultWorkspaceConcurrency();
  const pc = providerConcurrency();
  for (let attempt = 0; attempt < 4; attempt++) {
    const cand = await maybeOne<FairCandidate & { cap: number; provider: string; pcap: number }>(tx,
      `WITH live AS (
         SELECT workspace_id, count(*)::int n FROM deliveries
          WHERE lease_owner IS NOT NULL AND lease_expires_at > now() GROUP BY workspace_id),
       plive AS (
         SELECT provider, count(*)::int n FROM deliveries
          WHERE lease_owner IS NOT NULL AND lease_expires_at > now() GROUP BY provider)
       SELECT d.id, d.state, d.workspace_id, d.provider::text AS provider, ${CAP_SQL('$3')} AS cap,
              coalesce(($4::jsonb ->> d.provider::text)::int, $5::int) AS pcap FROM deliveries d
         JOIN connections c ON c.id = d.connection_id
         JOIN workspaces w ON w.id = d.workspace_id
         LEFT JOIN provider_circuits pc ON pc.provider = d.provider
         LEFT JOIN live ON live.workspace_id = d.workspace_id
         LEFT JOIN plive ON plive.provider = d.provider
         LEFT JOIN workspace_dispatch_state ds ON ds.workspace_id = d.workspace_id
        WHERE d.state IN ('scheduled','retry_wait','processing') AND d.next_attempt_at <= now()
          AND (d.lease_owner IS NULL OR d.lease_expires_at < now() AND d.phase = 'awaiting_provider')
          AND ($1::uuid IS NULL OR d.id = $1)
          AND (c.throttled_until IS NULL OR c.throttled_until <= now() OR d.state = 'processing')
          AND (pc.opened_until IS NULL OR pc.opened_until <= now())
          AND NOT EXISTS (SELECT 1 FROM deliveries x WHERE x.connection_id = d.connection_id AND x.id <> d.id
                            AND x.lease_owner IS NOT NULL AND x.lease_expires_at > now() AND x.phase IN ('preparing','sending'))
          AND coalesce(live.n, 0) < ${CAP_SQL('$3')}
          AND NOT (d.workspace_id = ANY($2::uuid[]))
          AND coalesce(plive.n, 0) < coalesce(($4::jsonb ->> d.provider::text)::int, $5::int)
          AND NOT (d.provider::text = ANY($6::text[]))
        ORDER BY ${fairOrdering() ? 'coalesce(live.n, 0), ds.last_claimed_at NULLS FIRST,' : ''} d.next_attempt_at, d.id
        LIMIT 1 FOR UPDATE OF d SKIP LOCKED`, [deliveryId, excluded, fallbackCap, JSON.stringify(pc.caps), pc.fallback, excludedProviders]);
    if (!cand) return null;
    // Serialize claims per workspace, then re-count with a fresh snapshot (READ COMMITTED): a
    // concurrent claimer that committed first is visible now, so the cap is never exceeded.
    await tx.query(`INSERT INTO workspace_dispatch_state(workspace_id) VALUES ($1) ON CONFLICT DO NOTHING`, [cand.workspace_id]);
    await tx.query(`SELECT 1 FROM workspace_dispatch_state WHERE workspace_id = $1 FOR UPDATE`, [cand.workspace_id]);
    const live = await one<{ n: number }>(tx,
      `SELECT count(*)::int n FROM deliveries WHERE workspace_id = $1 AND lease_owner IS NOT NULL AND lease_expires_at > now() AND id <> $2`,
      [cand.workspace_id, cand.id]);
    if (live.n >= cand.cap) {
      excluded.push(cand.workspace_id);
      if (deliveryId) return null;
      continue;
    }
    // V3.1 per-provider cap (exact): serialize claims per provider, then re-count with a fresh snapshot.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('dispatch-provider:' || $1, 0))`, [cand.provider]);
    const plive = await one<{ n: number }>(tx,
      `SELECT count(*)::int n FROM deliveries WHERE provider = $1::provider_kind AND lease_owner IS NOT NULL AND lease_expires_at > now() AND id <> $2`,
      [cand.provider, cand.id]);
    if (plive.n >= cand.pcap) {
      excludedProviders.push(cand.provider);
      if (deliveryId) return null;
      continue;
    }
    await tx.query(`UPDATE workspace_dispatch_state SET last_claimed_at = clock_timestamp(), claims = claims + 1 WHERE workspace_id = $1`, [cand.workspace_id]);
    return { id: cand.id, state: cand.state, workspace_id: cand.workspace_id };
  }
  return null;
}
