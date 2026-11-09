// V3.1 Admin §6 — workspace admin overview: one bounded read (≈12 index-backed statements) answering "what needs me".
// Each card carries its drill-down URL (filters in the query string) and a state from the shared vocabulary.
// Cards the viewer can't act on are omitted (the API behind each drill-down re-checks anyway). Missing ≠ zero:
// `value: null` means "not measurable here". Simulated (mock) activity never counts as live.
import type { AdminOverview, HealthState, OverviewCard } from '@social-lite/core/contracts/v31-admin';
import { getPool, many, maybeOne, one, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { canAnywhere } from '../access.js';
import { requireAction } from '../tenancy.js';
import { limitsView } from '../product/usage-admin.js';
import { listSupportAccessFor } from './support-access.js';

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const span = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};
const ago = (d: Date | null) => (d ? span(Date.now() - d.getTime()) : null);

export async function adminOverview(ctx: Ctx, db: Queryable = getPool()): Promise<AdminOverview> {
  requireAction(ctx, 'workspace.read');
  const ws = ctx.access.workspaceId;
  const brands = ctx.access.brandIds; // null = all
  const w = await one<{ id: string; name: string; is_demo: boolean; publishing_paused: boolean; paused_reason: string | null }>(db,
    `SELECT id, name, is_demo, publishing_paused, paused_reason FROM workspaces WHERE id=$1`, [ws]);
  const cards: OverviewCard[] = [];
  const can = (p: Parameters<typeof canAnywhere>[1]) => canAnywhere(ctx, p);

  if (can('content.read')) {
    const day = await many<{ state: string; is_mock: boolean; n: number }>(db,
      `SELECT state::text, is_mock, count(*)::int n FROM deliveries WHERE workspace_id=$1 AND updated_at > now() - interval '24 hours'
          AND ($2::uuid[] IS NULL OR brand_id = ANY($2)) GROUP BY state, is_mock`, [ws, brands]);
    const live = (s: string[]) => day.filter((r) => !r.is_mock && s.includes(r.state)).reduce((a, r) => a + r.n, 0);
    const sim = day.filter((r) => r.is_mock).reduce((a, r) => a + r.n, 0);
    const pub = live(['published']);
    const bad = live(['failed', 'unknown', 'expired']);
    let state: HealthState = bad === 0 ? 'healthy' : pub === 0 && bad > 0 ? 'failed' : 'degraded';
    if (w.publishing_paused) state = 'paused';
    else if (pub + bad === 0 && sim > 0) state = 'demo';
    cards.push({ key: 'publishing', label: 'Publishing · 24 h', state, value: pub,
      detail: w.publishing_paused ? 'Workspace paused' : `${pub} published${bad ? ` · ${bad} failed or unknown` : ''}${sim ? ` · ${sim} simulated` : ''}`,
      href: '/admin/publishing?window=24h' });

    const att = await one<{ n: number; unknown: number }>(db,
      `SELECT count(*)::int n, count(*) FILTER (WHERE state='unknown')::int unknown FROM deliveries
        WHERE workspace_id=$1 AND state IN ('failed','unknown','blocked','handoff','expired') AND updated_at > now() - interval '7 days'
          AND ($2::uuid[] IS NULL OR brand_id = ANY($2))`, [ws, brands]);
    cards.push({ key: 'attention', label: 'Needs attention', state: att.n === 0 ? 'healthy' : att.unknown > 0 ? 'failed' : 'degraded', value: att.n,
      detail: att.n ? `${att.unknown ? `${att.unknown} unknown · ` : ''}last 7 days` : 'Nothing waiting', href: '/admin/publishing?state=attention' });

    const sch = await one<{ n: number; next: Date | null }>(db,
      `SELECT count(*)::int n, min(due_at) next FROM deliveries WHERE workspace_id=$1 AND state IN ('scheduled','retry_wait','paused')
          AND due_at >= now() AND due_at < now() + interval '7 days' AND ($2::uuid[] IS NULL OR brand_id = ANY($2))`, [ws, brands]);
    cards.push({ key: 'scheduled', label: 'Scheduled · 7 days', state: w.publishing_paused && sch.n ? 'paused' : 'healthy', value: sch.n,
      detail: sch.next ? `Next in ${span(sch.next.getTime() - Date.now())}` : 'Nothing scheduled', href: '/admin/publishing?state=scheduled' });

    const ap = await one<{ n: number; oldest: Date | null }>(db,
      `SELECT count(*)::int n, min(requested_at) oldest FROM approvals WHERE workspace_id=$1 AND decision='pending' AND ($2::uuid[] IS NULL OR brand_id = ANY($2))`, [ws, brands]);
    const oldH = ap.oldest ? (Date.now() - ap.oldest.getTime()) / 3600_000 : 0;
    cards.push({ key: 'approvals', label: 'Approval backlog', state: ap.n === 0 ? 'healthy' : oldH > 24 ? 'degraded' : 'healthy', value: ap.n,
      detail: ap.oldest ? `Oldest ${ago(ap.oldest)}` : 'Nothing waiting', href: '/admin/approvals' });
  }

  if (can('connections.read')) {
    const c = await one<{ total: number; problems: number; mock: number; paused: number }>(db,
      `SELECT count(*)::int total, count(*) FILTER (WHERE status NOT IN ('ready','expiring'))::int problems,
              count(*) FILTER (WHERE is_mock OR is_synthetic)::int mock, count(*) FILTER (WHERE paused)::int paused
         FROM connections WHERE workspace_id=$1 AND disconnected_at IS NULL AND ($2::uuid[] IS NULL OR brand_id = ANY($2))`, [ws, brands]);
    const state: HealthState = c.total === 0 ? 'awaiting_setup' : c.mock === c.total ? 'demo' : c.problems ? 'degraded' : c.paused ? 'paused' : 'healthy';
    cards.push({ key: 'connections', label: 'Connections', state, value: c.problems,
      detail: c.total === 0 ? 'None connected' : `${c.problems} of ${c.total} need attention${c.mock ? ` · ${c.mock} simulated` : ''}`,
      href: c.problems ? '/admin/connections?problem=1' : '/admin/connections' });
  }

  if (can('workspace.manage')) {
    const q = await one<{ n: number; oldest: Date | null }>(db,
      `SELECT count(*)::int n, min(next_attempt_at) oldest FROM deliveries WHERE workspace_id=$1 AND state IN ('scheduled','retry_wait')
          AND next_attempt_at <= now() AND lease_owner IS NULL`, [ws]);
    const hb = await maybeOne<{ last: Date | null }>(db, `SELECT max(last_seen_at) last FROM worker_heartbeats`);
    const hbAge = hb?.last ? (Date.now() - hb.last.getTime()) / 1000 : Infinity;
    const qAge = q.oldest ? (Date.now() - q.oldest.getTime()) / 1000 : 0;
    const state: HealthState = hbAge > 60 ? 'failed' : qAge > 120 ? 'degraded' : 'healthy';
    cards.push({ key: 'queue', label: 'Queue and workers', state, value: q.n,
      detail: hbAge === Infinity ? 'No worker seen' : `${qAge ? `Oldest due ${ago(q.oldest)} · worker` : 'Worker'} seen ${ago(hb!.last)} ago`, href: '/admin/operations' });
  }

  if (can('analytics.read')) {
    const a = await one<{ last_ok: Date | null; failed: number; conns: number; stale: number }>(db,
      `SELECT (SELECT max(finished_at) FROM sync_runs WHERE workspace_id=$1 AND status='succeeded') last_ok,
              (SELECT count(*)::int FROM sync_runs WHERE workspace_id=$1 AND status='failed' AND started_at > now() - interval '24 hours') failed,
              (SELECT count(*)::int FROM connections c WHERE c.workspace_id=$1 AND c.disconnected_at IS NULL AND NOT c.is_mock AND NOT c.is_synthetic) conns,
              (SELECT count(*)::int FROM connections c WHERE c.workspace_id=$1 AND c.disconnected_at IS NULL AND NOT c.is_mock AND NOT c.is_synthetic
                  AND NOT EXISTS (SELECT 1 FROM sync_runs r WHERE r.connection_id=c.id AND r.status='succeeded' AND r.started_at > now() - interval '48 hours')) stale`, [ws]);
    const state: HealthState = a.conns === 0 ? (a.last_ok ? 'demo' : 'awaiting_setup') : a.failed ? 'degraded' : a.stale ? 'degraded' : a.last_ok ? 'healthy' : 'unknown';
    cards.push({ key: 'analytics', label: 'Analytics freshness', state, value: a.conns ? a.stale : null,
      detail: a.conns === 0 ? 'No live accounts' : `${a.stale} stale of ${a.conns}${a.last_ok ? ` · last sync ${ago(a.last_ok)} ago` : ''}`, href: '/admin/analytics' });

    const f = await one<{ imports: number; exports: number; writebacks: number; reports: number }>(db,
      `SELECT (SELECT count(*)::int FROM imports WHERE workspace_id=$1 AND status='failed' AND created_at > now() - interval '7 days') imports,
              (SELECT count(*)::int FROM export_jobs WHERE workspace_id=$1 AND status='failed' AND created_at > now() - interval '7 days') exports,
              (SELECT count(*)::int FROM writeback_jobs WHERE workspace_id=$1 AND status IN ('failed','conflict') AND created_at > now() - interval '7 days') writebacks,
              (SELECT count(*)::int FROM report_exports WHERE workspace_id=$1 AND status='failed' AND created_at > now() - interval '7 days') reports`, [ws]);
    const n = f.imports + f.exports + f.writebacks + f.reports;
    cards.push({ key: 'imports', label: 'Imports and exports', state: n ? 'degraded' : 'healthy', value: n,
      detail: n ? [f.imports && `${f.imports} import`, f.exports && `${f.exports} export`, f.writebacks && `${f.writebacks} writeback`, f.reports && `${f.reports} report`].filter(Boolean).join(' · ') + ' · 7 days' : 'No failures · 7 days',
      href: '/admin/content?status=failed' });
  }

  if (can('workspace.manage')) {
    const l = await limitsView(ctx, db);
    const top = l.items.filter((i) => i.percent !== null).sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))[0];
    cards.push({ key: 'usage', label: 'Usage and limits', state: !top ? 'healthy' : (top.percent ?? 0) >= 100 ? 'failed' : (top.percent ?? 0) >= 80 ? 'degraded' : 'healthy',
      value: top?.percent ?? null, detail: top ? `${top.label}: ${top.percent}%` : 'No caps set', href: '/admin/usage' });
  }

  let activity: AdminOverview['activity'] = [];
  if (can('audit.read')) {
    const s = await one<{ n: number }>(db,
      `SELECT count(*)::int n FROM audit_events WHERE workspace_id=$1 AND created_at > now() - interval '7 days'
          AND split_part(action, '.', 1) = ANY($2::text[])`, [ws, ['auth', 'session', 'mfa', 'security', 'api_key', 'service_account', 'support_access', 'platform', 'member', 'grant', 'ownership', 'restriction']]);
    const support = await one<{ active: number; pending: number }>(db,
      `SELECT count(*) FILTER (WHERE status='active' AND expires_at > now())::int active, count(*) FILTER (WHERE status='requested' AND request_expires_at > now())::int pending
         FROM support_access_grants WHERE workspace_id=$1 AND status IN ('requested','active')`, [ws]);
    cards.push({ key: 'security', label: 'Security events · 7 days', state: support.pending ? 'degraded' : 'healthy', value: s.n,
      detail: support.active ? `Support access active` : support.pending ? `${plural(support.pending, 'support request')} waiting` : 'Access and sign-in changes',
      href: support.pending || support.active ? '/admin/security/support' : '/admin/security/audit?category=security' });
    const rows = await many<{ id: string; action: string; created_at: Date; actor: string | null; resource_type: string }>(db,
      `SELECT e.id::text, e.action, e.created_at, coalesce(u.email::text, e.actor_service) actor, e.resource_type FROM audit_events e LEFT JOIN users u ON u.id=e.actor_user_id
        WHERE e.workspace_id=$1 ORDER BY e.created_at DESC, e.id DESC LIMIT 6`, [ws]);
    activity = rows.map((r) => ({ id: r.id, action: r.action, at: r.created_at.toISOString(), actor: r.actor, resource_type: r.resource_type }));
  }

  return {
    generated_at: new Date().toISOString(),
    workspace: { id: w.id, name: w.name, is_demo: w.is_demo, paused: w.publishing_paused, paused_reason: w.paused_reason },
    cards, activity,
    support_access: can('members.read') ? await listSupportAccessFor(db, { workspaceId: ws, open: true, limit: 5 }) : [],
  };
}
