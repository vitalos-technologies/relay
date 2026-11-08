// Listening coverage + ingestion health for the admin app (stream F wires the screen; brief §20 "Listening coverage and
// ingestion failures"). Counts and states only — no mention text — so it is safe for workspace admins.
import { getPool, many, one } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { requireAction } from '../tenancy.js';
import { sourceStates } from './sources.js';

export interface ListeningAdminOverview {
  sources: Array<{ key: string; label: string; layer: string; status: string; channels: number }>;
  observations: { total: number; last_24h: number; removed_at_source: number; simulated: number };
  backlog: { cursor_at: string | null; pending_rematch: number; pending_reprocess: number; pending_backfill: number };
  failures: Array<{ at: string; source: string; code: string; message: string }>;
  alerts: { open: number; last_7d: number; rules: number };
}

export async function listeningAdminOverview(ctx: Ctx): Promise<ListeningAdminOverview> {
  requireAction(ctx, 'workspace.read');
  const db = getPool();
  const ws = ctx.access.workspaceId;
  const brands = (await many<{ id: string }>(db, `SELECT id FROM brands WHERE workspace_id=$1`, [ws])).map((b) => b.id);
  const states = await sourceStates(ws, brands, db);
  const o = await one<{ total: number; d1: number; removed: number; sim: number }>(db,
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE observed_at >= now() - interval '24 hours')::int AS d1, count(*) FILTER (WHERE removed_at IS NOT NULL)::int AS removed,
            count(*) FILTER (WHERE is_simulated)::int AS sim FROM listening_observations WHERE workspace_id=$1`, [ws]);
  const cur = await many<{ received_at: Date }>(db, `SELECT received_at FROM listening_cursors WHERE key='inbox'`);
  const b = await one<{ rm: number; rp: number; bf: number }>(db,
    `SELECT (SELECT count(*)::int FROM listening_searches WHERE workspace_id=$1 AND archived_at IS NULL AND rematch_state <> 'idle') AS rm,
            (SELECT count(*)::int FROM listening_observations WHERE workspace_id=$1 AND needs_reprocess) AS rp,
            (SELECT count(*)::int FROM listening_channel_settings WHERE workspace_id=$1 AND backfill_requested_at IS NOT NULL) AS bf`, [ws]);
  const f = await many<{ at: Date; source_key: string; code: string; message: string }>(db, `SELECT at, source_key, code, message FROM listening_ingest_failures WHERE workspace_id=$1 ORDER BY at DESC LIMIT 20`, [ws]);
  const a = await one<{ open: number; d7: number; rules: number }>(db,
    `SELECT (SELECT count(*)::int FROM listening_alerts WHERE workspace_id=$1 AND state='open') AS open,
            (SELECT count(*)::int FROM listening_alerts WHERE workspace_id=$1 AND created_at >= now() - interval '7 days') AS d7,
            (SELECT count(*)::int FROM listening_alert_rules WHERE workspace_id=$1 AND archived_at IS NULL AND enabled) AS rules`, [ws]);
  return {
    sources: states.map((s) => ({ key: s.key, label: s.label, layer: s.layer, status: s.status, channels: s.channels.length })),
    observations: { total: o.total, last_24h: o.d1, removed_at_source: o.removed, simulated: o.sim },
    backlog: { cursor_at: cur[0]?.received_at && cur[0].received_at.getTime() > 0 ? cur[0].received_at.toISOString() : null, pending_rematch: b.rm, pending_reprocess: b.rp, pending_backfill: b.bf },
    failures: f.map((x) => ({ at: x.at.toISOString(), source: x.source_key, code: x.code, message: x.message })),
    alerts: { open: a.open, last_7d: a.d7, rules: a.rules },
  };
}
