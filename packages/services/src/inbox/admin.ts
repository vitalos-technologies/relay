// Admin visibility for the inbox + connector infrastructure (workspace scope; counts and states only — never message
// text, so the same shape is safe for operators who lack inbox.read). Permission: diagnostics.read (workspace admins).
import { getPool, many, one } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { requireAction } from '../tenancy.js';
import { CONNECTORS } from '../connectors/registry.js';
import { toChannelJson } from './channels.js';
import type { ChannelRow } from './shared.js';

export interface InboxAdminOverview {
  generated_at: string;
  backlog: { open: number; unassigned: number; unanswered: number; oldest_unanswered_minutes: number | null };
  replies: { queued: number; sending: number; unknown: number; failed_24h: number; sent_24h: number };
  sla: { breached_open: number; at_risk_1h: number };
  channels: Array<{ id: string; kind: string; display_name: string; status: string; is_simulated: boolean; missing_permissions: string[]; last_inbound_at: string | null }>;
  ingestion: { meta_receipts_pending: number; integration_events_pending: number; integration_events_failed_24h: number; integration_events_dead: number };
  integrations: Array<{ id: string; connector: string; name: string; status: string; is_simulated: boolean; jobs_failed_24h: number; jobs_unknown: number; last_success_at: string | null }>;
  workload_queues: string[];
}

export async function inboxAdminOverview(ctx: Ctx): Promise<InboxAdminOverview> {
  requireAction(ctx, 'diagnostics.read');
  const db = getPool();
  const ws = ctx.access.workspaceId;
  const [backlog, replies, sla, channels, ingestion, integ] = await Promise.all([
    one<{ open: number; unassigned: number; unanswered: number; oldest: number | null }>(db,
      `SELECT count(*) FILTER (WHERE status='open')::int open, count(*) FILTER (WHERE status='open' AND assignee_id IS NULL)::int unassigned,
              count(*) FILTER (WHERE unanswered_since IS NOT NULL AND status IN ('open','waiting'))::int unanswered,
              extract(epoch FROM now() - min(unanswered_since) FILTER (WHERE status IN ('open','waiting')))::float8 / 60 oldest
         FROM inbox_conversations WHERE workspace_id=$1`, [ws]),
    one<{ queued: number; sending: number; unknown: number; failed: number; sent: number }>(db,
      `SELECT count(*) FILTER (WHERE state='queued')::int queued, count(*) FILTER (WHERE state='sending')::int sending, count(*) FILTER (WHERE state='unknown')::int unknown,
              count(*) FILTER (WHERE state='failed' AND finished_at > now() - interval '24 hours')::int failed, count(*) FILTER (WHERE state='sent' AND sent_at > now() - interval '24 hours')::int sent
         FROM inbox_reply_attempts WHERE workspace_id=$1`, [ws]),
    one<{ breached: number; risk: number }>(db,
      `SELECT count(*) FILTER (WHERE state <> 'resolved' AND (first_response_breached_at IS NOT NULL OR resolution_breached_at IS NOT NULL))::int breached,
              count(*) FILTER (WHERE state <> 'resolved' AND paused_since IS NULL AND ((first_responded_at IS NULL AND first_response_due_at BETWEEN now() AND now() + interval '1 hour')
                                                                                   OR (resolution_due_at BETWEEN now() AND now() + interval '1 hour')))::int risk
         FROM care_cases WHERE workspace_id=$1`, [ws]),
    many<ChannelRow>(db, `SELECT * FROM inbox_channels WHERE workspace_id=$1 AND disconnected_at IS NULL ORDER BY created_at`, [ws]),
    one<{ meta: number; pending: number; failed: number; dead: number }>(db,
      `SELECT (SELECT count(*)::int FROM webhook_receipts WHERE provider='meta' AND processing_state='pending') meta,
              count(*) FILTER (WHERE state IN ('pending','processing'))::int pending, count(*) FILTER (WHERE state='failed' AND received_at > now() - interval '24 hours')::int failed,
              count(*) FILTER (WHERE state='dead')::int dead FROM integration_events WHERE workspace_id=$1`, [ws]),
    many<{ id: string; connector: keyof typeof CONNECTORS; status: string; paused: boolean; disconnected_at: Date | null; is_simulated: boolean; last_success_at: Date | null; failed: number; unknown: number }>(db,
      `SELECT i.id, i.connector, i.status, i.paused, i.disconnected_at, i.is_simulated, i.last_success_at,
              (SELECT count(*)::int FROM integration_sync_jobs j WHERE j.integration_id=i.id AND j.state='failed' AND j.finished_at > now() - interval '24 hours') failed,
              (SELECT count(*)::int FROM integration_sync_jobs j WHERE j.integration_id=i.id AND j.state='unknown') unknown
         FROM integration_connections i WHERE i.workspace_id=$1 AND i.disconnected_at IS NULL ORDER BY i.created_at`, [ws]),
  ]);
  return {
    generated_at: new Date().toISOString(),
    backlog: { open: backlog.open, unassigned: backlog.unassigned, unanswered: backlog.unanswered, oldest_unanswered_minutes: backlog.oldest === null ? null : Math.round(backlog.oldest) },
    replies: { queued: replies.queued, sending: replies.sending, unknown: replies.unknown, failed_24h: replies.failed, sent_24h: replies.sent },
    sla: { breached_open: sla.breached, at_risk_1h: sla.risk },
    channels: channels.map((c) => { const j = toChannelJson(c); return { id: j.id, kind: j.kind, display_name: j.display_name, status: j.status, is_simulated: j.is_simulated, missing_permissions: j.missing_permissions, last_inbound_at: j.last_inbound_at }; }),
    ingestion: { meta_receipts_pending: ingestion.meta, integration_events_pending: ingestion.pending, integration_events_failed_24h: ingestion.failed, integration_events_dead: ingestion.dead },
    integrations: integ.map((i) => ({ id: i.id, connector: i.connector, name: CONNECTORS[i.connector]?.name ?? i.connector, status: i.paused ? 'paused' : i.status, is_simulated: i.is_simulated, jobs_failed_24h: i.failed, jobs_unknown: i.unknown, last_success_at: i.last_success_at?.toISOString() ?? null })),
    workload_queues: ['inbox-reply', 'inbox-events', 'integration-sync'],
  };
}
