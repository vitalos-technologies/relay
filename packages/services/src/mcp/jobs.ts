// Asynchronous MCP work (report exports). create_report_export returns a job reference immediately; the worker
// (apps/worker → runMcpJobs) claims queued jobs with a lease, RE-CHECKS current authority when it runs (client
// registration still active and granting reports.export, membership/grants, exports.create on the brand), charges the
// workspace exports budget, and stores a bounded CSV that is downloadable only inside Relay (session-authenticated
// /api/mcp/jobs/<id>/download). MCP clients receive the job status and an app link — never a bearer download URL.
// Retries with the same idempotency key return the same job (no duplicate exports).
// Interim target: relay_download. Google Drive / Notion targets plug in when the Content Hub exporters land.
import { AppError, PERMISSIONS, notFound } from '@social-lite/core';
import { MCP_SCOPE_PERMISSIONS, isMcpScope, type McpScope } from '@social-lite/core/contracts/mcp';
import { getPool, many, maybeOne, one, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { requestHash } from '../idempotency.js';
import { log } from '../log.js';
import { enforceRateLimit } from '../ratelimit.js';
import { csvCell, historyCsv } from '../readmodels.js';
import { assertBrand, loadAccess, requireAction } from '../tenancy.js';
import { listAnalytics } from '../analytics/index.js';
import { releaseUsage, reserveUsage, settleUsage } from '../product/budgets.js';
import { MCP_LIMITS } from './config.js';
import { appUrl, McpToolError, requireScope, type CallScope } from './principal.js';

export const REPORT_KINDS = ['delivery_history', 'post_metrics'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const LEASE_MS = 2 * 60_000;
const MAX_ATTEMPTS = 3;

export interface ExportInput { brand_id?: string | null; report: ReportKind; from: string; to: string; target: 'relay_download'; idempotency_key: string }

interface JobRow {
  id: string; workspace_id: string; client_row_id: string; actor_user_id: string | null; actor_service_account_id: string | null; brand_id: string | null;
  kind: 'report_export'; params: { report: ReportKind; from: string; to: string; target: string; token_scopes: string[] }; idempotency_key: string;
  request_hash: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'; attempts: number; result: Record<string, unknown> | null;
  error_code: string | null; error_message: string | null; created_at: Date; updated_at: Date; finished_at: Date | null; expires_at: Date;
}

function range(from: string, to: string): { from: Date; to: Date } {
  const f = new Date(from); const t = new Date(to);
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime()) || t <= f) throw new McpToolError('validation_failed', 'from/to must be ISO instants with from < to.');
  if (t.getTime() - f.getTime() > MCP_LIMITS.maxAnalyticsDays * 86_400_000) throw new McpToolError('validation_failed', `The range can be at most ${MCP_LIMITS.maxAnalyticsDays} days.`);
  return { from: f, to: t };
}

const jobView = (j: JobRow) => ({
  job_id: j.id,
  kind: j.kind,
  status: j.status,
  report: j.params.report,
  brand_id: j.brand_id,
  range: { from: j.params.from, to: j.params.to },
  target: j.params.target,
  created_at: j.created_at.toISOString(),
  finished_at: j.finished_at?.toISOString() ?? null,
  result: j.status === 'succeeded' && j.result ? { rows: Number(j.result.rows ?? 0), bytes: Number(j.result.bytes ?? 0), filename: String(j.result.filename ?? ''),
    download_in_app: appUrl(`/api/mcp/jobs/${j.id}/download`), expires_at: j.expires_at.toISOString() } : null,
  error: j.status === 'failed' ? { code: j.error_code ?? 'internal', message: j.error_message ?? 'The export failed.' } : null,
  next_step: j.status === 'queued' || j.status === 'running' ? 'Poll get_job_status in a few seconds.' : null,
});

export async function createReportExport(s: CallScope, input: ExportInput) {
  requireScope(s, 'reports.export');
  const { ctx } = s;
  const r = range(input.from, input.to);
  if (input.brand_id) await assertBrand(ctx, input.brand_id);
  requireAction(ctx, 'exports.create', { brandId: input.brand_id ?? null });
  if (input.report === 'post_metrics') { requireScope(s, 'analytics.read'); requireAction(ctx, 'analytics.read', input.brand_id ? { brandId: input.brand_id } : undefined); }
  else requireAction(ctx, 'content.read', input.brand_id ? { brandId: input.brand_id } : undefined);
  const params = { report: input.report, from: r.from.toISOString(), to: r.to.toISOString(), target: input.target, token_scopes: s.scopes };
  const hash = requestHash({ brand: input.brand_id ?? null, report: input.report, from: params.from, to: params.to, target: input.target });
  const db = getPool();
  const existing = await maybeOne<JobRow>(db, `SELECT * FROM mcp_jobs WHERE workspace_id=$1 AND client_row_id=$2 AND idempotency_key=$3`, [ctx.access.workspaceId, s.client.id, input.idempotency_key]);
  if (existing) {
    if (existing.request_hash !== hash) throw new McpToolError('idempotency_conflict', 'This idempotency_key was already used for a different export.');
    return { ...jobView(existing), duplicate: true };
  }
  await enforceRateLimit('mcpExport', s.principal.key, MCP_LIMITS.exportRate);
  const ins = await maybeOne<JobRow>(db,
    `INSERT INTO mcp_jobs(workspace_id, client_row_id, actor_user_id, actor_service_account_id, brand_id, kind, params, idempotency_key, request_hash)
     VALUES ($1,$2,$3,$4,$5,'report_export',$6,$7,$8) ON CONFLICT (workspace_id, client_row_id, idempotency_key) DO NOTHING RETURNING *`,
    [ctx.access.workspaceId, s.client.id, s.principal.userId, s.principal.serviceAccountId, input.brand_id ?? null, JSON.stringify(params), input.idempotency_key, hash]);
  const job = ins ?? await one<JobRow>(db, `SELECT * FROM mcp_jobs WHERE workspace_id=$1 AND client_row_id=$2 AND idempotency_key=$3`, [ctx.access.workspaceId, s.client.id, input.idempotency_key]);
  if (!ins && job.request_hash !== hash) throw new McpToolError('idempotency_conflict', 'This idempotency_key was already used for a different export.');
  if (ins) {
    await audit(db, { workspaceId: ctx.access.workspaceId, brandId: input.brand_id ?? null, actorUserId: s.principal.userId, actorService: s.principal.serviceAccountId ? `service_account:${s.principal.serviceAccountId}` : null,
      action: 'mcp.export_requested', resourceType: 'mcp_job', resourceId: job.id, correlationId: ctx.correlationId, diff: { report: input.report, client_row_id: s.client.id } });
  }
  return { ...jobView(job), duplicate: !ins };
}

export async function getJobStatus(s: CallScope, jobId: string) {
  requireScope(s, 'reports.export', 'social.read');
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new McpToolError('not_found', 'Job not found');
  const j = await maybeOne<JobRow>(getPool(), `SELECT * FROM mcp_jobs WHERE id=$1 AND workspace_id=$2 AND client_row_id=$3`, [jobId, s.ctx.access.workspaceId, s.client.id]);
  if (!j) throw new McpToolError('not_found', 'Job not found');
  if (j.brand_id && s.ctx.access.brandIds !== null && !s.ctx.access.brandIds.includes(j.brand_id)) throw new McpToolError('not_found', 'Job not found');
  return jobView(j);
}

// ------------------------------------------------------------------ worker side

/** Rebuild the job's authority NOW (not at creation): registration, membership, grants, consented scopes/brands. */
async function jobCtx(db: Queryable, j: JobRow): Promise<Ctx> {
  const client = await maybeOne<{ status: string; granted_scopes: string[]; brand_ids: string[] | null; kind: string }>(db,
    `SELECT status, granted_scopes, brand_ids, kind FROM mcp_clients WHERE id=$1 AND workspace_id=$2`, [j.client_row_id, j.workspace_id]);
  if (!client || client.status !== 'active') throw new AppError('forbidden', 'The client’s access was revoked.');
  const scopes = (j.params.token_scopes ?? []).filter(isMcpScope).filter((x) => client.granted_scopes.includes(x)) as McpScope[];
  if (!scopes.includes('reports.export')) throw new AppError('forbidden', 'The client no longer has the reports.export scope.');
  let ctx: Ctx;
  const correlationId = `mcp-job:${j.id}`;
  if (j.actor_service_account_id) {
    const { serviceAccountCtx } = await import('../service-accounts.js');
    ctx = await serviceAccountCtx({ serviceAccountId: j.actor_service_account_id, workspaceId: j.workspace_id }, correlationId, db);
  } else {
    // MFA was verified for the call that created the job (exports.create is MFA-gated); membership/grants are fresh.
    const access = await loadAccess(j.actor_user_id!, j.workspace_id, db, { mfaVerified: true, authTime: null });
    if (!access) throw new AppError('forbidden', 'The person who requested the export no longer has access.');
    const u = await one<{ email: string; name: string | null }>(db, `SELECT email, name FROM users WHERE id=$1`, [j.actor_user_id]);
    ctx = { actor: { userId: j.actor_user_id!, email: u.email, name: u.name, sessionId: `mcp-job:${j.id}` }, access, correlationId };
  }
  const allowed = new Set(scopes.flatMap((x) => [...MCP_SCOPE_PERMISSIONS[x]]));
  ctx.access.authz!.subject.restrictions.push({ brandId: null, actions: PERMISSIONS.filter((p) => !allowed.has(p)), expiresAt: null });
  if (client.brand_ids) ctx.access.brandIds = ctx.access.brandIds === null ? client.brand_ids : ctx.access.brandIds.filter((b) => client.brand_ids!.includes(b));
  return ctx;
}

async function postMetricsCsv(ctx: Ctx, brandId: string | null, from: Date, to: Date): Promise<{ csv: string; rows: number }> {
  requireAction(ctx, 'analytics.read', brandId ? { brandId } : undefined);
  const header = ['published_at_utc', 'brand', 'post_title', 'provider', 'destination', 'simulated', 'metric', 'dimension', 'value', 'period', 'observed_at_utc', 'source', 'delivery_id'];
  const lines = [header.join(',')];
  let cursor: string | null = null;
  let rows = 0;
  for (let page = 0; page < 40; page++) {
    const r = await listAnalytics(ctx, { brand_id: brandId, cursor, limit: 100 });
    for (const it of r.items) {
      const at = new Date(it.published_at);
      if (at < from) { cursor = null; break; }
      if (at >= to) continue;
      for (const m of it.metrics) {
        lines.push([it.published_at, it.brand_name, it.title, it.provider, it.display_name, it.is_mock ? 'yes' : 'no', m.name, m.dimension, m.value, m.period, m.observed_at, m.source, it.delivery_id].map(csvCell).join(','));
        rows++;
      }
    }
    if (!r.next_cursor || (r.items.length && new Date(r.items[r.items.length - 1]!.published_at) < from)) break;
    cursor = r.next_cursor;
  }
  return { csv: lines.join('\r\n') + '\r\n', rows };
}

async function runOne(db: Queryable, j: JobRow): Promise<void> {
  let reservation: { id: string } | null = null;
  try {
    const ctx = await jobCtx(db, j);
    if (j.brand_id) await assertBrand(ctx, j.brand_id, db);
    requireAction(ctx, 'exports.create', { brandId: j.brand_id ?? null });
    reservation = await reserveUsage({ workspaceId: j.workspace_id, meter: 'exports.count', amount: 1, userId: j.actor_user_id, ref: `mcp-job:${j.id}`, ttlSeconds: 600 });
    const from = new Date(j.params.from); const to = new Date(j.params.to);
    const out = j.params.report === 'post_metrics'
      ? await postMetricsCsv(ctx, j.brand_id, from, to)
      : await (async () => { const csv = await historyCsv(ctx, { brand_id: j.brand_id ?? undefined, from: j.params.from, to: j.params.to }); return { csv, rows: Math.max(0, csv.split('\r\n').length - 2) }; })();
    const bytes = Buffer.byteLength(out.csv, 'utf8');
    if (bytes > MAX_OUTPUT_BYTES) throw new AppError('payload_too_large', 'The export is larger than 5 MB. Narrow the range or brand.');
    const filename = `relay-${j.params.report}-${j.params.from.slice(0, 10)}-${j.params.to.slice(0, 10)}.csv`;
    await db.query(`UPDATE mcp_jobs SET status='succeeded', output=$2, result=$3, finished_at=now(), updated_at=now(), lease_until=NULL WHERE id=$1`,
      [j.id, out.csv, JSON.stringify({ rows: out.rows, bytes, filename })]);
    await settleUsage(reservation.id, 1);
    await audit(db, { workspaceId: j.workspace_id, brandId: j.brand_id, actorUserId: j.actor_user_id, actorService: j.actor_service_account_id ? `service_account:${j.actor_service_account_id}` : null,
      action: 'mcp.export_completed', resourceType: 'mcp_job', resourceId: j.id, correlationId: `mcp-job:${j.id}`, diff: { rows: out.rows, bytes, report: j.params.report } });
  } catch (err) {
    if (reservation) await releaseUsage(reservation.id).catch(() => undefined);
    const e = err instanceof AppError ? err : null;
    const transient = !e && j.attempts < MAX_ATTEMPTS;
    if (!e) log.warn('mcp_job_failed', { jobId: j.id, err: err as Error });
    await db.query(`UPDATE mcp_jobs SET status=$2, error_code=$3, error_message=$4, finished_at=CASE WHEN $2='failed' THEN now() ELSE NULL END, updated_at=now(), lease_until=NULL WHERE id=$1`,
      [j.id, transient ? 'queued' : 'failed', e?.code ?? 'internal', (e?.message ?? 'The export failed.').slice(0, 300)]);
  }
}

/** Worker loop: claim queued (or lease-expired) jobs and run them. Returns the number processed. */
export async function runMcpJobs(opts: { limit?: number; jobId?: string } = {}, db: Queryable = getPool()): Promise<number> {
  const claimed = await many<JobRow>(db,
    `UPDATE mcp_jobs SET status='running', attempts=attempts+1, lease_until=now() + make_interval(secs => $2), updated_at=now()
      WHERE id IN (SELECT id FROM mcp_jobs WHERE (status='queued' OR (status='running' AND lease_until < now())) ${opts.jobId ? 'AND id=$3' : ''}
                    ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING *`, opts.jobId ? [opts.limit ?? 5, LEASE_MS / 1000, opts.jobId] : [opts.limit ?? 5, LEASE_MS / 1000]);
  for (const j of claimed) await runOne(db, j);
  // Retention: drop outputs past expiry.
  await db.query(`UPDATE mcp_jobs SET output=NULL WHERE output IS NOT NULL AND expires_at < now()`).catch(() => undefined);
  return claimed.length;
}

/** Download inside Relay (session-authenticated): the requester, or anyone holding exports.create on the brand. */
export async function downloadJob(ctx: Ctx, jobId: string): Promise<{ filename: string; csv: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw notFound('Export');
  const j = await maybeOne<JobRow & { output: string | null }>(getPool(), `SELECT * FROM mcp_jobs WHERE id=$1 AND workspace_id=$2`, [jobId, ctx.access.workspaceId]);
  if (!j || j.status !== 'succeeded' || !j.output || j.expires_at.getTime() < Date.now()) throw notFound('Export');
  if (j.brand_id) await assertBrand(ctx, j.brand_id);
  requireAction(ctx, 'exports.create', { brandId: j.brand_id ?? null });
  await audit(getPool(), { workspaceId: j.workspace_id, brandId: j.brand_id, actorUserId: ctx.actor.userId, action: 'mcp.export_downloaded', resourceType: 'mcp_job', resourceId: j.id, correlationId: ctx.correlationId });
  return { filename: String(j.result?.filename ?? 'relay-export.csv'), csv: j.output };
}

