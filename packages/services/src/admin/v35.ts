// V3.5 admin wiring (stream F, brief §20). Workspace scope: integration health + sync lag (reusing each installation's
// `integrationHealth`), Slack delivery and translation usage, plus a one-call summary that reuses every stream's admin
// overview (inbox, listening, AI + automation). Platform scope: installation-wide COUNTS ONLY — no workspace names,
// conversation text, mention text, prompts or outputs — so platform operators never gain access to customer
// conversations. Counts are read from the same tables the product uses (no separate metrics store).
import { getPool, many, one } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { authorizeCtx, requireAction } from '../tenancy.js';
import { CONNECTORS } from '../connectors/registry.js';
import { integrationHealth } from '../connectors/store.js';
import { inboxAdminOverview, type InboxAdminOverview } from '../inbox/admin.js';
import { listeningAdminOverview, type ListeningAdminOverview } from '../listening/admin.js';
import { aiAutomationAdminOverview, type AiAutomationAdminOverview } from '../automation/admin.js';

export interface IntegrationsAdminOverview {
  generated_at: string;
  integrations: Array<{
    id: string; connector: string; name: string; display_name: string; status: string; is_simulated: boolean; brand_id: string | null;
    sync: { queued: number; running: number; failed_24h: number; unknown: number; lag_seconds: number | null };
    events: { pending: number; failed_24h: number; last_received_at: string | null };
    last_success_at: string | null;
    recent_errors: Array<{ at: string; code: string | null; message: string | null }>;
  }>;
  slack: { queued: number; deferred: number; failed_24h: number; unknown: number; sent_24h: number };
  translation: { characters_30d: number; cost_estimate_usd_30d: number; simulated_characters_30d: number };
}

/** Admin → Integrations and sync. diagnostics.read; per-installation numbers come from `integrationHealth`. */
export async function integrationsAdminOverview(ctx: Ctx): Promise<IntegrationsAdminOverview> {
  requireAction(ctx, 'diagnostics.read');
  const db = getPool();
  const ws = ctx.access.workspaceId;
  const rows = await many<{ id: string; brand_id: string | null }>(db,
    `SELECT id, brand_id FROM integration_connections WHERE workspace_id=$1 AND disconnected_at IS NULL ORDER BY created_at LIMIT 50`, [ws]);
  const canRead = (b: string | null) => authorizeCtx(ctx, 'integrations.read', b ? { brandId: b } : undefined).allowed;
  const health = await Promise.all(rows.filter((r) => canRead(r.brand_id)).map((r) => integrationHealth(ctx, r.id)));
  const [slack, tr] = await Promise.all([
    one<{ queued: number; deferred: number; failed: number; unknown: number; sent: number }>(db,
      `SELECT count(*) FILTER (WHERE state='queued')::int queued, count(*) FILTER (WHERE state='deferred')::int deferred,
              count(*) FILTER (WHERE state='failed' AND created_at > now() - interval '24 hours')::int failed, count(*) FILTER (WHERE state='unknown')::int unknown,
              count(*) FILTER (WHERE state='sent' AND sent_at > now() - interval '24 hours')::int sent
         FROM slack_deliveries WHERE workspace_id=$1`, [ws]),
    one<{ chars: number; micros: string; sim: number }>(db,
      `SELECT coalesce(sum(characters) FILTER (WHERE NOT is_simulated), 0)::int chars, coalesce(sum(cost_estimate_micros) FILTER (WHERE NOT is_simulated), 0)::text micros,
              coalesce(sum(characters) FILTER (WHERE is_simulated), 0)::int sim
         FROM translations WHERE workspace_id=$1 AND created_at > now() - interval '30 days'`, [ws]),
  ]);
  return {
    generated_at: new Date().toISOString(),
    integrations: health.map((h) => {
      const i = h.integration;
      return {
        id: i.id, connector: i.connector, name: CONNECTORS[i.connector as keyof typeof CONNECTORS]?.name ?? i.connector, display_name: i.display_name, status: i.status,
        is_simulated: i.is_simulated, brand_id: i.brand_id,
        sync: { queued: h.jobs.queued, running: h.jobs.running, failed_24h: h.jobs.failed_24h, unknown: h.jobs.unknown, lag_seconds: h.jobs.oldest_queued_age_seconds },
        events: h.events, last_success_at: i.last_success_at,
        recent_errors: h.activity.filter((a) => a.outcome === 'error').slice(0, 3).map((a) => ({ at: a.at, code: a.code, message: a.message })),
      };
    }),
    slack: { queued: slack.queued, deferred: slack.deferred, failed_24h: slack.failed, unknown: slack.unknown, sent_24h: slack.sent },
    translation: { characters_30d: tr.chars, cost_estimate_usd_30d: Math.round(Number(tr.micros) / 1e4) / 100, simulated_characters_30d: tr.sim },
  };
}

export interface CareAdminSummary {
  generated_at: string;
  inbox: InboxAdminOverview | null;
  listening: ListeningAdminOverview | null;
  ai: AiAutomationAdminOverview | null;
  integrations: IntegrationsAdminOverview | null;
  security_events_24h: { total: number; denied_mcp: number; by_area: Record<string, number> } | null;
}

/** One call for the admin overview: each section is the stream's own service, or null when the viewer lacks it. */
export async function careAdminSummary(ctx: Ctx): Promise<CareAdminSummary> {
  requireAction(ctx, 'diagnostics.read');
  const safe = async <T>(fn: () => Promise<T>): Promise<T | null> => { try { return await fn(); } catch { return null; } };
  const ws = ctx.access.workspaceId;
  const [inbox, listening, ai, integrations, sec] = await Promise.all([
    safe(() => inboxAdminOverview(ctx)), safe(() => listeningAdminOverview(ctx)), safe(() => aiAutomationAdminOverview(ctx)), safe(() => integrationsAdminOverview(ctx)),
    authorizeCtx(ctx, 'audit.read').allowed ? safe(async () => {
      const db = getPool();
      const by = await many<{ area: string; n: number }>(db,
        `SELECT split_part(action, '.', 1) area, count(*)::int n FROM audit_events WHERE workspace_id=$1 AND created_at > now() - interval '24 hours'
            AND split_part(action, '.', 1) IN ('inbox','case','listening','ai','automation','integration','mcp') GROUP BY 1`, [ws]);
      const denied = await one<{ n: number }>(db, `SELECT count(*)::int n FROM mcp_audit WHERE workspace_id=$1 AND result='denied' AND created_at > now() - interval '24 hours'`, [ws]);
      return { total: by.reduce((s, r) => s + r.n, 0), denied_mcp: denied.n, by_area: Object.fromEntries(by.map((r) => [r.area, r.n])) };
    }) : Promise.resolve(null),
  ]);
  return { generated_at: new Date().toISOString(), inbox, listening, ai, integrations, security_events_24h: sec };
}

// ------------------------------------------------------------------ platform (counts only)
export interface PlatformCareHealth {
  window_hours: number;
  workspaces: { with_inbox: number; with_integrations: number; with_listening: number; with_automation: number };
  inbox: { channels_active: number; channels_attention: number; replies_sent: number; replies_failed: number; replies_unknown: number; replies_queued: number; oldest_queued_reply_seconds: number | null; sla_breached_open: number };
  ingestion: { integration_events_pending: number; integration_events_dead: number; meta_receipts_pending: number; inbound_events_unprocessed: number };
  sync: { jobs_queued: number; jobs_failed: number; jobs_unknown: number; oldest_queued_seconds: number | null; installations_reconnect: number };
  listening: { observations: number; ingest_failures: number; alerts_fired: number };
  ai: { runs: Record<string, number>; tokens_30d: number; workspaces_budget_blocked: number };
  automation: { runs: Record<string, number>; emergency_stops_active: number; policies_active: number };
}

/** Platform → Inbox and AI pipeline. Aggregates across the installation; nothing identifies a workspace or a person. */
export async function platformCareHealth(): Promise<PlatformCareHealth> {
  const db = getPool();
  const by = (rows: Array<{ k: string; n: number }>) => Object.fromEntries(rows.map((r) => [r.k, r.n]));
  const [w, ib, ing, sync, lis, aiRuns, aiTok, aiBudget, autoRuns, auto] = await Promise.all([
    one<{ inbox: number; integ: number; lis: number; auto: number }>(db,
      `SELECT (SELECT count(DISTINCT workspace_id)::int FROM inbox_channels WHERE disconnected_at IS NULL) inbox,
              (SELECT count(DISTINCT workspace_id)::int FROM integration_connections WHERE disconnected_at IS NULL) integ,
              (SELECT count(DISTINCT workspace_id)::int FROM listening_searches WHERE archived_at IS NULL) lis,
              (SELECT count(DISTINCT workspace_id)::int FROM automation_policies WHERE status='active') auto`),
    one<{ active: number; attn: number; sent: number; failed: number; unknown: number; queued: number; oldest: number | null; breached: number }>(db,
      `SELECT (SELECT count(*)::int FROM inbox_channels WHERE disconnected_at IS NULL AND status='active') active,
              (SELECT count(*)::int FROM inbox_channels WHERE disconnected_at IS NULL AND status NOT IN ('active','paused')) attn,
              count(*) FILTER (WHERE state='sent' AND sent_at > now() - interval '24 hours')::int sent,
              count(*) FILTER (WHERE state='failed' AND finished_at > now() - interval '24 hours')::int failed,
              count(*) FILTER (WHERE state='unknown')::int unknown, count(*) FILTER (WHERE state='queued')::int queued,
              extract(epoch FROM now() - min(created_at) FILTER (WHERE state='queued'))::float8 oldest,
              (SELECT count(*)::int FROM care_cases WHERE state <> 'resolved' AND (first_response_breached_at IS NOT NULL OR resolution_breached_at IS NOT NULL)) breached
         FROM inbox_reply_attempts`),
    one<{ pending: number; dead: number; meta: number; inbound: number }>(db,
      `SELECT count(*) FILTER (WHERE state IN ('pending','processing'))::int pending, count(*) FILTER (WHERE state='dead')::int dead,
              (SELECT count(*)::int FROM webhook_receipts WHERE provider='meta' AND processing_state='pending') meta,
              (SELECT count(*)::int FROM inbox_inbound_events WHERE state IN ('pending','failed')) inbound
         FROM integration_events`),
    one<{ queued: number; failed: number; unknown: number; oldest: number | null; reconnect: number }>(db,
      `SELECT count(*) FILTER (WHERE state IN ('queued','waiting_retry'))::int queued, count(*) FILTER (WHERE state='failed' AND finished_at > now() - interval '24 hours')::int failed,
              count(*) FILTER (WHERE state='unknown')::int unknown, extract(epoch FROM now() - min(created_at) FILTER (WHERE state IN ('queued','waiting_retry')))::float8 oldest,
              (SELECT count(*)::int FROM integration_connections WHERE disconnected_at IS NULL AND status='reconnect_required') reconnect
         FROM integration_sync_jobs`),
    one<{ obs: number; fail: number; alerts: number }>(db,
      `SELECT (SELECT count(*)::int FROM listening_observations WHERE observed_at > now() - interval '24 hours') obs,
              (SELECT count(*)::int FROM listening_ingest_failures WHERE at > now() - interval '24 hours') fail,
              (SELECT count(*)::int FROM listening_alerts WHERE created_at > now() - interval '24 hours') alerts`),
    many<{ k: string; n: number }>(db, `SELECT status k, count(*)::int n FROM ai_runs WHERE created_at > now() - interval '24 hours' GROUP BY 1`),
    one<{ n: number }>(db, `SELECT coalesce(sum(input_tokens + output_tokens), 0)::int n FROM ai_runs WHERE created_at > now() - interval '30 days'`),
    one<{ n: number }>(db, `SELECT count(DISTINCT workspace_id)::int n FROM ai_runs WHERE status IN ('blocked','failed') AND status_detail ILIKE '%budget%' AND created_at > now() - interval '24 hours'`),
    many<{ k: string; n: number }>(db, `SELECT outcome k, count(*)::int n FROM automation_runs WHERE NOT is_test AND created_at > now() - interval '24 hours' GROUP BY 1`),
    one<{ stops: number; active: number }>(db,
      `SELECT (SELECT count(*)::int FROM automation_settings WHERE emergency_stop) stops,
              (SELECT count(*)::int FROM automation_policies WHERE status='active' AND expires_at > now()) active`),
  ]);
  return {
    window_hours: 24,
    workspaces: { with_inbox: w.inbox, with_integrations: w.integ, with_listening: w.lis, with_automation: w.auto },
    inbox: { channels_active: ib.active, channels_attention: ib.attn, replies_sent: ib.sent, replies_failed: ib.failed, replies_unknown: ib.unknown, replies_queued: ib.queued,
      oldest_queued_reply_seconds: ib.oldest === null ? null : Math.round(ib.oldest), sla_breached_open: ib.breached },
    ingestion: { integration_events_pending: ing.pending, integration_events_dead: ing.dead, meta_receipts_pending: ing.meta, inbound_events_unprocessed: ing.inbound },
    sync: { jobs_queued: sync.queued, jobs_failed: sync.failed, jobs_unknown: sync.unknown, oldest_queued_seconds: sync.oldest === null ? null : Math.round(sync.oldest), installations_reconnect: sync.reconnect },
    listening: { observations: lis.obs, ingest_failures: lis.fail, alerts_fired: lis.alerts },
    ai: { runs: by(aiRuns), tokens_30d: aiTok.n, workspaces_budget_blocked: aiBudget.n },
    automation: { runs: by(autoRuns), emergency_stops_active: auto.stops, policies_active: auto.active },
  };
}
