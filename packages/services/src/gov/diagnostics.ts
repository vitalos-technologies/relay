// V3.1 §15 — integration diagnostics ("test centre"), READ-ONLY. Every value comes from stored state (connection
// row, credential metadata, adapter capability record, analytics sync cursors/runs, delivery queue, budgets): no
// provider call, no token decryption, no publish, no queue write. "Check connection" never posts anything; a test
// publication is a separate, explicit action through the normal composer with a chosen destination and content.
// Never returns tokens, encrypted blobs or secret-bearing requests; correlation ids only when they match a safe pattern.
import { PROVIDER_LABEL, type ConnectionStatus, type Provider } from '@social-lite/core';
import type { ConnectionDiagnostics, DiagnosticCheck, DiagnosticStatus, IntegrationDiagnosticsResponse } from '@social-lite/core/contracts/v31-gov';
import { getPool, many, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { assertUuid, authorizeCtx, requireAction } from '../tenancy.js';
import { capabilitiesFor, type ConnectionRow } from '../posts/shared.js';
import { oauthConnectorFor } from '../connections/oauth.js';
import { classifyConnection, type ConnectionFacts } from '../product/health.js';
import { PROVIDER_LIMITS } from '../product/readiness.js';
import { readMeterUsage } from '../product/budgets.js';
import { brandsWith } from '../product/scope.js';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,64}$/;
export const safeCorrelationId = (v: string | null | undefined): string | null => (v && SAFE_ID.test(v) ? v : null);

type Row = ConnectionRow & ConnectionFacts & { last_attempt_cid: string | null };

const rank: Record<DiagnosticStatus, number> = { failing: 0, warning: 1, unknown: 2, ok: 3, not_applicable: 4 };
const worst = (s: DiagnosticStatus[]) => s.filter((x) => x !== 'not_applicable').sort((a, b) => rank[a] - rank[b])[0] ?? 'ok';

export async function integrationDiagnostics(ctx: Ctx, q: { brand_id?: string | null; connection_id?: string | null } = {}, db: Queryable = getPool()): Promise<IntegrationDiagnosticsResponse> {
  requireAction(ctx, 'connections.read');
  if (q.brand_id) assertUuid(q.brand_id, 'Brand');
  if (q.connection_id) assertUuid(q.connection_id, 'Connection');
  const brands = (await brandsWith(ctx, 'connections.read', db)).filter((b) => !q.brand_id || b.id === q.brand_id);
  const now = new Date();
  if (!brands.length) return { generated_at: now.toISOString(), read_only: true, items: [] };
  const rows = await many<Row>(db,
    `SELECT c.id, c.workspace_id, c.brand_id, c.provider, c.provider_account_id, c.display_name, c.username, c.status, c.is_mock, c.paused,
            c.capabilities, c.metadata, c.throttled_until, c.disconnected_at, c.health_detail, c.health_checked_at, c.created_at,
            cr.expires_at AS cred_expires_at, cr.refresh_expires_at, cr.granted_scopes,
            CASE WHEN pc.state='open' THEN pc.opened_until END AS circuit_open_until,
            (SELECT a.correlation_id FROM delivery_attempts a JOIN deliveries d ON d.id=a.delivery_id
              WHERE d.connection_id=c.id AND a.correlation_id IS NOT NULL ORDER BY a.started_at DESC LIMIT 1) AS last_attempt_cid
       FROM connections c
       LEFT JOIN credentials cr ON cr.id=c.credential_id AND cr.workspace_id=c.workspace_id
       LEFT JOIN provider_circuits pc ON pc.provider=c.provider
      WHERE c.workspace_id=$1 AND c.brand_id = ANY($2::uuid[]) ${q.connection_id ? 'AND c.id=$3' : ''}
        AND (c.disconnected_at IS NULL OR c.disconnected_at > now() - interval '30 days')
      ORDER BY c.provider, c.display_name LIMIT 500`,
    q.connection_id ? [ctx.access.workspaceId, brands.map((b) => b.id), q.connection_id] : [ctx.access.workspaceId, brands.map((b) => b.id)]);
  if (q.connection_id && !rows.length) {
    const { notFound } = await import('@social-lite/core');
    throw notFound('Connection');
  }
  const ids = rows.map((r) => r.id);
  const sync = ids.length ? await many<{ connection_id: string; status: string; stop_reason: string | null; last_success_at: Date | null; last_status: string | null }>(db,
    `SELECT sc.connection_id, sc.status, sc.stop_reason, sc.last_success_at, sr.status AS last_status FROM sync_cursors sc LEFT JOIN sync_runs sr ON sr.id=sc.last_run_id
      WHERE sc.workspace_id=$1 AND sc.connection_id = ANY($2::uuid[]) AND sc.stream='post_metrics'`, [ctx.access.workspaceId, ids]) : [];
  const work = ids.length ? await many<{ connection_id: string; n: number; next_due: Date | null }>(db,
    `SELECT connection_id, count(*)::int n, min(due_at) next_due FROM (
        SELECT d.connection_id, d.due_at FROM deliveries d WHERE d.workspace_id=$1 AND d.connection_id = ANY($2::uuid[])
           AND d.state IN ('scheduled','retry_wait','blocked','paused') AND d.publish_before > now()
        UNION ALL
        SELECT v.connection_id, s.due_at FROM schedules s JOIN variants v ON v.revision_id=s.revision_id
         WHERE s.workspace_id=$1 AND v.connection_id = ANY($2::uuid[]) AND s.status='pending_approval') x
      GROUP BY connection_id`, [ctx.access.workspaceId, ids]) : [];
  const windowUse = new Map<string, number>();
  for (const r of rows) {
    const lim = PROVIDER_LIMITS[r.provider];
    if (!lim || r.disconnected_at) continue;
    const n = await many<{ n: number }>(db, `SELECT count(*)::int n FROM deliveries WHERE connection_id=$1 AND state IN ('published','publishing','processing','preparing')
                                              AND coalesce(published_at, due_at) > $2`, [r.id, new Date(now.getTime() - lim.windowMs)]);
    windowUse.set(r.id, n[0]?.n ?? 0);
  }
  const liveX = rows.some((r) => r.provider === 'x' && !r.is_mock && !r.disconnected_at);
  const xUsage = liveX ? await readMeterUsage(ctx.access.workspaceId, 'x.write', {}, db) : null;
  const xExhausted = !!xUsage && xUsage.cap !== null && xUsage.used + xUsage.reserved >= xUsage.cap;

  const items: ConnectionDiagnostics[] = rows.map((r) => {
    const label = PROVIDER_LABEL[r.provider] ?? r.provider;
    const canManage = authorizeCtx(ctx, 'connections.manage', { brandId: r.brand_id, connectionId: r.id }).allowed;
    const issues = classifyConnection(r, { now, canManage, xBudgetExhausted: xExhausted && r.provider === 'x' && !r.is_mock });
    const remedyFor = (codes: string[]) => { const i = issues.find((x) => codes.includes(x.code)); return i ? (i.fix.allowed ? i.fix.how : `${i.fix.who ?? 'An owner or admin'}: ${i.fix.how}`) : null; };
    const caps = r.disconnected_at ? null : capabilitiesFor(r);
    const required = r.is_mock ? [] : [...(oauthConnectorFor(r.provider)?.requiredScopes ?? [])];
    const granted = r.granted_scopes ?? [];
    const missing = r.health_detail?.missing_permissions?.length ? r.health_detail.missing_permissions : required.filter((s) => !granted.includes(s));
    const checks: DiagnosticCheck[] = [];
    const add = (c: DiagnosticCheck) => checks.push(c);

    // authorization
    const authFail = issues.find((i) => ['disconnected', 'expired', 'revoked'].includes(i.code));
    add({ key: 'authorization', status: authFail ? 'failing' : r.status === 'pending_verification' ? 'unknown' : 'ok', title: 'Authorization',
      detail: authFail ? authFail.detail : r.status === 'pending_verification' ? 'Not verified yet.' : `${label} accepts this connection${r.is_mock ? ' (simulated destination)' : ''}.`,
      remedy: authFail ? remedyFor([authFail.code]) : r.status === 'pending_verification' ? remedyFor(['pending_verification']) : null });
    // selected account
    const resourceKind = typeof r.metadata?.kind === 'string' ? String(r.metadata.kind) : typeof r.metadata?.account_type === 'string' ? String(r.metadata.account_type) : null;
    add({ key: 'selected_account', status: r.provider_account_id ? 'ok' : 'failing', title: 'Selected account',
      detail: `${r.display_name}${r.username ? ` (@${r.username})` : ''}${resourceKind ? ` · ${resourceKind}` : ''}`, remedy: r.provider_account_id ? null : 'Reconnect and pick the account, page or channel to publish to.' });
    // capabilities / scopes
    add({ key: 'capabilities', status: r.disconnected_at ? 'not_applicable' : missing.length ? 'failing' : 'ok', title: 'Granted permissions',
      detail: missing.length ? `${label} did not grant: ${missing.join(', ')}.` : required.length ? 'Every required permission is granted.' : r.is_mock ? 'Simulated destination: no provider permissions.' : 'No extra permissions required.',
      remedy: missing.length ? remedyFor(['missing_scope']) ?? 'Reconnect and approve every requested permission.' : null });
    // token
    const exp = r.cred_expires_at;
    const refreshable = !!r.refresh_expires_at && r.refresh_expires_at.getTime() > now.getTime();
    const expiring = issues.find((i) => i.code === 'expiring');
    add({ key: 'token', status: r.disconnected_at ? 'not_applicable' : authFail ? 'failing' : expiring ? 'warning' : 'ok', title: 'Access token',
      detail: exp ? `Expires ${exp.toISOString().slice(0, 16).replace('T', ' ')} UTC${refreshable ? '; refreshed automatically' : ''}.` : r.is_mock ? 'No token (simulated).' : 'No expiry reported.',
      remedy: expiring ? remedyFor(['expiring']) : null });
    // publishing + media
    const pmode = caps?.publishMode ?? 'direct';
    const elig = caps?.eligibility;
    const pubStatus: DiagnosticStatus = !caps ? (r.disconnected_at ? 'not_applicable' : 'unknown') : !caps.canPublish ? 'failing'
      : elig && elig.status !== 'eligible' ? 'warning' : r.paused ? 'warning' : 'ok';
    add({ key: 'publishing', status: pubStatus, title: 'Publishing',
      detail: !caps ? 'Publishing rules unavailable.' : `${pmode === 'direct' ? 'Posts directly' : pmode === 'draft_handoff' ? 'Sends to the creator’s drafts' : 'Manual handoff only'}${elig && elig.status !== 'eligible' ? ` · ${elig.message}` : ''}${r.paused ? ' · paused' : ''}.`,
      remedy: r.paused ? remedyFor(['paused']) : null });
    add({ key: 'media', status: caps ? 'ok' : 'not_applicable', title: 'Formats', detail: caps ? `Supports: ${caps.formats.join(', ') || 'text'}.` : '—', remedy: null });
    // analytics
    const s = sync.find((x) => x.connection_id === r.id);
    const supported = !!caps?.canReadMetrics;
    const syncStatus: ConnectionDiagnostics['analytics']['sync_status'] = !supported ? 'unsupported' : !s ? 'never' : (s.status as 'active' | 'stopped');
    add({ key: 'analytics', status: !supported ? 'not_applicable' : !s ? 'unknown' : s.status === 'stopped' && s.stop_reason !== 'unsupported' ? 'warning' : s.last_status === 'failed' ? 'warning' : 'ok',
      title: 'Analytics access', detail: !supported ? `${label} metrics are not available for this destination.` : s ? `Last successful sync: ${s.last_success_at ? s.last_success_at.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'never'}${s.stop_reason ? ` · stopped (${s.stop_reason.replace(/_/g, ' ')})` : ''}.` : 'No sync has run yet.',
      remedy: s?.stop_reason === 'access_revoked' || s?.stop_reason === 'reconnect_required' ? 'Reconnect the account to resume analytics.' : null });
    // quota
    const lim = PROVIDER_LIMITS[r.provider];
    const used = windowUse.get(r.id) ?? 0;
    const throttled = r.throttled_until && r.throttled_until.getTime() > now.getTime() ? r.throttled_until : null;
    const circuit = !r.is_mock && r.circuit_open_until && r.circuit_open_until.getTime() > now.getTime() ? r.circuit_open_until : null;
    const xb = r.provider === 'x' && !r.is_mock ? xUsage : null;
    add({ key: 'quota', status: throttled || circuit || (xb && xExhausted) ? 'warning' : lim && used >= lim.max ? 'warning' : 'ok', title: 'Limits',
      detail: [throttled ? `Rate limited until ${throttled.toISOString().slice(11, 16)} UTC.` : null, circuit ? 'Provider errors: sending paused briefly.' : null,
        lim ? `${used} of ${lim.max} (${lim.label}).` : 'No documented per-account limit.', xb ? `X posts this month: ${xb.used}${xb.cap !== null ? ` of ${xb.cap}` : ''}.` : null].filter(Boolean).join(' '),
      remedy: xb && xExhausted ? remedyFor(['budget_exhausted']) : null });
    // scheduled work
    const w = work.find((x) => x.connection_id === r.id);
    const atRisk = issues.some((i) => i.severity === 'critical') ? (w?.n ?? 0) : 0;
    add({ key: 'scheduled_work', status: atRisk ? 'failing' : 'ok', title: 'Scheduled work',
      detail: w?.n ? `${w.n} upcoming post${w.n === 1 ? '' : 's'}${atRisk ? ', held until this is fixed' : ''}.` : 'Nothing scheduled.', remedy: atRisk ? 'Fix the connection; held posts continue if still on time.' : null });

    return {
      connection: { id: r.id, brand_id: r.brand_id, provider: r.provider as Provider, display_name: r.display_name, username: r.username, simulated: r.is_mock,
        status: r.disconnected_at ? 'disconnected' : r.paused ? 'paused' : (r.status as ConnectionStatus) },
      overall: worst(checks.map((c) => c.status)), checks,
      selected_account: { display_name: r.display_name, username: r.username, resource_kind: resourceKind },
      capabilities: { granted_scopes: granted, missing_scopes: missing, formats: caps?.formats ?? [], publish_mode: pmode, can_read_metrics: supported },
      token: { expires_at: exp?.toISOString() ?? null, refresh_expires_at: r.refresh_expires_at?.toISOString() ?? null, refreshable, reconnect_required: r.status === 'reconnect_required' || !!authFail },
      analytics: { supported, sync_status: syncStatus, stop_reason: s?.stop_reason ?? null, last_success_at: s?.last_success_at?.toISOString() ?? null, last_run_status: s?.last_status ?? null },
      quota: { throttled_until: throttled?.toISOString() ?? null, circuit_open_until: circuit?.toISOString() ?? null, window: lim ? { label: lim.label, used, max: lim.max } : null,
        budget: xb ? { meter: 'x.write', used: xb.used, cap: xb.cap } : null },
      scheduled_work: { count: w?.n ?? 0, next_due_at: w?.next_due?.toISOString() ?? null, at_risk: atRisk },
      correlation: { request_id: ctx.correlationId, last_attempt_id: safeCorrelationId(r.last_attempt_cid) },
      checked_at: r.health_checked_at?.toISOString() ?? null,
    };
  });
  return { generated_at: now.toISOString(), read_only: true, items };
}
