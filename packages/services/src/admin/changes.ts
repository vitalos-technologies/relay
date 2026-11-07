// V3.1 Admin §5 — change feed. Instead of streaming records, the server returns one opaque marker per topic, read from
// the authoritative tables in a single statement (each sub-select is an index probe). The admin UI polls it while
// visible (ADMIN_SYNC.poll_ms) and refetches only the views whose topic marker changed. Because a marker IS current
// state, missed, duplicated or out-of-order notifications can't leave the UI wrong: the next poll reconciles.
// The feed carries no record data, only timestamps/counters, and is limited to people who administer the workspace
// (workspace.read) so brand-scoped members can't observe other brands' activity timing.
import { ADMIN_SYNC, ADMIN_TOPICS, type AdminChanges, type AdminTopic } from '@social-lite/core/contracts/v31-admin';
import { getPool, one, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { requireAction } from '../tenancy.js';

type Row = Record<AdminTopic | 'policy_version', string | null> & { now: Date };

export async function adminChanges(ctx: Ctx, db: Queryable = getPool()): Promise<AdminChanges> {
  requireAction(ctx, 'workspace.read');
  const r = await one<Row>(db,
    `SELECT now() AS now,
       (SELECT policy_version::text FROM workspaces WHERE id=$1) policy_version,
       (SELECT policy_version::text || ':' || state || ':' || publishing_paused::text FROM workspaces WHERE id=$1) access,
       (SELECT updated_at::text FROM deliveries WHERE workspace_id=$1 ORDER BY updated_at DESC LIMIT 1) publishing,
       (SELECT updated_at::text FROM posts WHERE workspace_id=$1 ORDER BY updated_at DESC LIMIT 1) content,
       (SELECT count(*)::text || ':' || coalesce(max(requested_at)::text, '') FROM approvals WHERE workspace_id=$1 AND decision='pending')
         || ':' || coalesce((SELECT decided_at::text FROM approvals WHERE workspace_id=$1 AND decision <> 'pending' ORDER BY decided_at DESC NULLS LAST LIMIT 1), '') approvals,
       (SELECT coalesce(max(updated_at)::text, '') || ':' || coalesce(max(health_checked_at)::text, '') || ':' || count(*)::text FROM connections WHERE workspace_id=$1) connections,
       (SELECT id::text FROM audit_events WHERE workspace_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1) audit,
       (SELECT coalesce(max(coalesce(finished_at, started_at))::text, '') FROM (SELECT finished_at, started_at FROM sync_runs WHERE workspace_id=$1 ORDER BY started_at DESC LIMIT 20) x)
         || ':' || coalesce((SELECT max(coalesce(completed_at, started_at, created_at))::text FROM (SELECT completed_at, started_at, created_at FROM imports WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 20) y), '')
         || ':' || coalesce((SELECT max(coalesce(finished_at, started_at, created_at))::text FROM (SELECT finished_at, started_at, created_at FROM report_exports WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 20) z), '') jobs,
       (SELECT count(*)::text || ':' || coalesce(max(greatest(requested_at, decided_at, ended_at))::text, '') FROM support_access_grants WHERE workspace_id=$1) support`,
    [ctx.access.workspaceId]);
  const topics = Object.fromEntries(ADMIN_TOPICS.map((t) => [t, r[t] ?? ''])) as Record<AdminTopic, string>;
  return { workspace_id: ctx.access.workspaceId, policy_version: Number(r.policy_version ?? 0), at: r.now.toISOString(), topics, poll_ms: ADMIN_SYNC.poll_ms };
}
