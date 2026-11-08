// V3.1 §16 — release controls + support.
//  - Feature flags: code registry (safe default OFF) + installation rows (rollout %, kill switch; operators only, no
//    API) + workspace overrides (workspace.manage, audited). Unknown keys are always off.
//  - Support/problem reports: route (path only), app version, timestamps and safe correlation ids. Free text is
//    redacted; draft text only when the reporter explicitly selects a post (bounded, redacted excerpt). Never credentials.
//  - Release notes: data shipped with the code (core contract RELEASE_NOTES) + per-user "seen" marker.
//  - Dispatch version guard: during a rolling deploy only the worker version named in system_flags.dispatch_version
//    claims deliveries (docs/v3-1-progress/gov.md "Rollout: one dispatching scheduler version").
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError, notFound } from '@social-lite/core';
import { FEATURE_FLAGS, RELEASE_NOTES, SUPPORT_CATEGORIES, type EffectiveFlag, type FeatureFlagsResponse, type ReleaseNotesResponse, type SupportReportDto } from '@social-lite/core/contracts/v31-gov';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { enforceRateLimit } from '../ratelimit.js';
import { authorizeCtx, requireAction } from '../tenancy.js';
import { loadPost } from '../posts/service.js';
import { safeCorrelationId } from './diagnostics.js';
import { dispatchVersionAllowed } from '../engine/claim.js';

// ------------------------------------------------------------------ feature flags
interface FlagRow { key: string; description: string; default_enabled: boolean; rollout_percent: number; killed: boolean }

/** Stable 0..99 bucket per (flag, workspace): the same workspace stays in/out as a rollout widens. */
export function rolloutBucket(key: string, workspaceId: string): number {
  return createHash('sha256').update(`${key}:${workspaceId}`).digest().readUInt32BE(0) % 100;
}

export function evaluateFlag(key: string, workspaceId: string, row: FlagRow | null, override: boolean | null): Omit<EffectiveFlag, 'description' | 'workspace_override'> {
  const def = FEATURE_FLAGS.find((f) => f.key === key);
  if (!row && !def) return { key, enabled: false, source: 'unknown' };
  if (row?.killed) return { key, enabled: false, source: 'killed' };
  if (override !== null) return { key, enabled: override, source: 'workspace_override' };
  if (row && row.rollout_percent > 0 && rolloutBucket(key, workspaceId) < row.rollout_percent) return { key, enabled: true, source: 'rollout' };
  return { key, enabled: row ? row.default_enabled : !!def?.default_enabled, source: 'default' };
}

export async function isFeatureEnabled(workspaceId: string, key: string, db: Queryable = getPool()): Promise<boolean> {
  const row = await maybeOne<FlagRow>(db, `SELECT * FROM feature_flags WHERE key=$1`, [key]);
  const o = await maybeOne<{ enabled: boolean }>(db, `SELECT enabled FROM workspace_feature_flags WHERE workspace_id=$1 AND key=$2`, [workspaceId, key]);
  return evaluateFlag(key, workspaceId, row, o?.enabled ?? null).enabled;
}

export async function listFeatureFlags(ctx: Ctx, db: Queryable = getPool()): Promise<FeatureFlagsResponse> {
  const rows = await many<FlagRow>(db, `SELECT * FROM feature_flags ORDER BY key`);
  const overrides = await many<{ key: string; enabled: boolean }>(db, `SELECT key, enabled FROM workspace_feature_flags WHERE workspace_id=$1`, [ctx.access.workspaceId]);
  const keys = [...new Set([...FEATURE_FLAGS.map((f) => f.key), ...rows.map((r) => r.key)])].sort();
  const flags = keys.map((key) => {
    const row = rows.find((r) => r.key === key) ?? null;
    const o = overrides.find((x) => x.key === key)?.enabled ?? null;
    return { ...evaluateFlag(key, ctx.access.workspaceId, row, o), description: row?.description || FEATURE_FLAGS.find((f) => f.key === key)?.description || '', workspace_override: o };
  });
  return { workspace_id: ctx.access.workspaceId, flags, can_override: authorizeCtx(ctx, 'workspace.manage').allowed };
}

export const flagOverrideSchema = z.object({ enabled: z.boolean().nullable() }).strict();

/** Workspace override (true/false) or null to follow the installation rollout. workspace.manage; audited. */
export async function setWorkspaceFlag(ctx: Ctx, key: string, raw: unknown): Promise<FeatureFlagsResponse> {
  const { enabled } = flagOverrideSchema.parse(raw);
  requireAction(ctx, 'workspace.manage');
  if (!/^[a-z0-9_.]{3,64}$/.test(key)) throw notFound('Flag');
  await withTx(async (tx) => {
    const row = await maybeOne<FlagRow>(tx, `SELECT * FROM feature_flags WHERE key=$1`, [key]);
    if (!row) throw notFound('Flag');
    const before = await maybeOne<{ enabled: boolean }>(tx, `SELECT enabled FROM workspace_feature_flags WHERE workspace_id=$1 AND key=$2`, [ctx.access.workspaceId, key]);
    if (enabled === null) await tx.query(`DELETE FROM workspace_feature_flags WHERE workspace_id=$1 AND key=$2`, [ctx.access.workspaceId, key]);
    else {
      await tx.query(`INSERT INTO workspace_feature_flags(workspace_id, key, enabled, updated_by) VALUES ($1,$2,$3,$4)
                      ON CONFLICT (workspace_id, key) DO UPDATE SET enabled=$3, updated_by=$4, updated_at=now()`, [ctx.access.workspaceId, key, enabled, ctx.actor.userId]);
    }
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'feature_flag.override_set', resourceType: 'feature_flag', resourceId: null,
      diff: { key, before: before?.enabled ?? null, after: enabled }, correlationId: ctx.correlationId });
  });
  return listFeatureFlags(ctx);
}

// ------------------------------------------------------------------ redaction
const REDACTIONS: Array<[RegExp, string]> = [
  [/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '<redacted-auth>'],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '<redacted-jwt>'],
  [/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, '<redacted-bot-token>'],
  [/\b(?:sk|pk|rk|xox[abpr]|ghp|gho|ghs|github_pat|glpat|AKIA|ya29)[-_.A-Za-z0-9]{10,}/g, '<redacted-key>'],
  [/\b((?:access|refresh|id)?_?token|secret|password|passwd|pwd|api[_-]?key|client_secret|code|signature|authorization|cookie|session)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s&,;]+)/gi, '$1=<redacted>'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>'],
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '<redacted-long-value>'],
  [/\b(?:\d[ -]?){13,19}\b/g, '<redacted-number>'],
];

/** Redact credentials/secrets/emails from free text. Returns the text and how many replacements were made. */
export function redactText(input: string): { text: string; count: number } {
  let count = 0;
  let text = input.normalize('NFKC');
  for (const [re, rep] of REDACTIONS) text = text.replace(re, (...m) => { count++; return rep.replace('$1', String(m[1] ?? '')); });
  return { text, count };
}

/** Keep only the path of a route (no query string, fragment, origin or credentials). */
export function safeRoute(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let path = raw.trim();
  try { path = new URL(path, 'http://x.invalid').pathname; } catch { return null; }
  path = path.replace(/[^A-Za-z0-9/_\-.[\]]/g, '').slice(0, 300);
  return path.startsWith('/') ? path : null;
}

// ------------------------------------------------------------------ support reports
export const supportReportSchema = z.object({
  category: z.enum(SUPPORT_CATEGORIES),
  summary: z.string().trim().min(1).max(4000),
  route: z.string().max(2000).nullish(),
  app_version: z.string().trim().max(64).regex(/^[A-Za-z0-9._+-]*$/).nullish(),
  occurred_at: z.string().datetime({ offset: true }).nullish(),
  correlation_ids: z.array(z.string().max(200)).max(50).default([]),
  /** Explicit selection only: include a bounded, redacted excerpt of this draft. */
  include_draft_post_id: z.string().uuid().nullish(),
  // V4 (support): browser family only (never the user agent) and a stable error code.
  browser_family: z.enum(['chrome', 'edge', 'firefox', 'safari', 'opera', 'samsung', 'other']).nullish(),
  error_code: z.string().trim().regex(/^[a-z0-9_.-]{1,64}$/).nullish(),
}).passthrough();

const EXCERPT_MAX = 500;

interface ReportRow { id: string; category: SupportReportDto['category']; summary: string; route: string | null; app_version: string | null; occurred_at: Date | null;
  correlation_ids: string[]; attachments: SupportReportDto['attachments']; redactions: number; status: 'open' | 'closed'; created_at: Date;
  user_id?: string | null; browser_family?: string | null; error_code?: string | null; support_ticket_id?: string | null; shared_at?: Date | null; reporter_email?: string | null; ticket_reference?: string | null }
// V4: also the sharing state ("Send to Relay support") and who filed it (admin list).
const reportDto = (r: ReportRow): SupportReportDto & { browser_family: string | null; error_code: string | null; shared: { ticket_id: string; reference: string | null; at: string | null } | null; reporter_email?: string | null; mine?: boolean } => ({
  id: r.id, category: r.category, summary: r.summary, route: r.route, app_version: r.app_version,
  occurred_at: r.occurred_at?.toISOString() ?? null, correlation_ids: r.correlation_ids, attachments: r.attachments, redactions: r.redactions, status: r.status, created_at: r.created_at.toISOString(),
  browser_family: r.browser_family ?? null, error_code: r.error_code ?? null,
  shared: r.support_ticket_id ? { ticket_id: r.support_ticket_id, reference: r.ticket_reference ?? null, at: r.shared_at?.toISOString() ?? null } : null,
  ...(r.reporter_email !== undefined ? { reporter_email: r.reporter_email } : {}) });

export async function createSupportReport(ctx: Ctx, raw: unknown): Promise<SupportReportDto> {
  // Unknown fields (e.g. a client trying to attach logs, cookies or a whole draft) are accepted but DROPPED.
  const input = supportReportSchema.parse(raw);
  // V4: bounded per person (problem reports can now be forwarded to Relay staff).
  await enforceRateLimit('supportReport', ctx.actor.userId, { capacity: 10, refillPerSecond: 10 / 3600 });
  let redactions = 0;
  const s = redactText(input.summary);
  redactions += s.count;
  const ids = input.correlation_ids.map(safeCorrelationId);
  redactions += ids.filter((x) => x === null).length;
  const attachments: SupportReportDto['attachments'] = {};
  if (input.include_draft_post_id) {
    const post = await loadPost(ctx, input.include_draft_post_id);
    requireAction(ctx, 'content.read', { brandId: post.brand_id });
    const ex = redactText((post.draft.baseText ?? '').slice(0, EXCERPT_MAX));
    redactions += ex.count;
    attachments.draft_excerpt = { post_id: post.id, text: ex.text };
  }
  const row = await withTx(async (tx) => {
    const r = await one<ReportRow>(tx,
      `INSERT INTO support_reports(workspace_id, user_id, category, summary, route, app_version, occurred_at, correlation_ids, attachments, redactions, browser_family, error_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [ctx.access.workspaceId, ctx.actor.userId, input.category, s.text.slice(0, 2000), safeRoute(input.route), input.app_version || null,
        input.occurred_at ? new Date(input.occurred_at) : null, [...new Set(ids.filter((x): x is string => !!x))].slice(0, 20), JSON.stringify(attachments), redactions,
        input.browser_family ?? null, input.error_code ?? null]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'support_report.created', resourceType: 'support_report', resourceId: r.id,
      diff: { category: input.category, draft_excerpt: !!attachments.draft_excerpt, redactions }, correlationId: ctx.correlationId });
    return r;
  });
  return reportDto(row);
}

export async function listSupportReports(ctx: Ctx, q: { limit?: number } = {}): Promise<{ items: SupportReportDto[] }> {
  requireAction(ctx, 'audit.read');
  const rows = await many<ReportRow>(getPool(),
    `SELECT r.*, u.email::text AS reporter_email, t.reference AS ticket_reference FROM support_reports r LEFT JOIN users u ON u.id=r.user_id
       LEFT JOIN support_tickets t ON t.id=r.support_ticket_id WHERE r.workspace_id=$1 ORDER BY r.created_at DESC LIMIT $2`,
    [ctx.access.workspaceId, Math.min(Math.max(q.limit ?? 50, 1), 200)]);
  return { items: rows.map(reportDto) };
}

// ------------------------------------------------------------------ release notes
export const currentVersion = () => process.env.APP_VERSION && /^\d+\.\d+\.\d+/.test(process.env.APP_VERSION) ? process.env.APP_VERSION : RELEASE_NOTES[0]!.version;

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).slice(0, 3).map((x) => Number(x) || 0);
  const pb = b.split(/[.+-]/).slice(0, 3).map((x) => Number(x) || 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

export async function getReleaseNotes(ctx: Ctx, db: Queryable = getPool()): Promise<ReleaseNotesResponse> {
  const seen = await maybeOne<{ last_seen_version: string }>(db, `SELECT last_seen_version FROM release_note_reads WHERE user_id=$1`, [ctx.actor.userId]);
  const notes = [];
  for (const n of RELEASE_NOTES) if (!n.flag || await isFeatureEnabled(ctx.access.workspaceId, n.flag, db)) notes.push(n);
  const last = seen?.last_seen_version ?? null;
  return { current_version: currentVersion(), notes, last_seen_version: last, unseen: notes.filter((n) => !last || compareVersions(n.version, last) > 0).length };
}

export async function markReleaseNotesSeen(ctx: Ctx, raw: unknown): Promise<ReleaseNotesResponse> {
  const { version } = z.object({ version: z.string().max(32) }).strict().parse(raw);
  if (!RELEASE_NOTES.some((n) => n.version === version)) throw new AppError('validation_failed', 'Unknown version', { version: 'Unknown version' });
  await getPool().query(`INSERT INTO release_note_reads(user_id, last_seen_version) VALUES ($1,$2)
                         ON CONFLICT (user_id) DO UPDATE SET last_seen_version=$2, seen_at=now()`, [ctx.actor.userId, version]);
  return getReleaseNotes(ctx);
}

// ------------------------------------------------------------------ dispatch version guard
/**
 * During a rolling deploy two worker builds can run at once. Delivery claims are already atomic and fenced (no
 * delivery is sent twice), but two scheduler versions must not BOTH dispatch (different code paths/semantics).
 * Operators set system_flags.dispatch_version to the version allowed to dispatch (string or array of strings);
 * absent/null = any version (default, unchanged behaviour). Workers of other versions keep running sweepers that
 * don't dispatch and idle on claims.
 */
export { dispatchVersionAllowed };

/** Operator helper (scripts/tests; no API): pin dispatch to `version`, or null to allow any. */
export async function setDispatchVersion(version: string | string[] | null, by: string, db: Queryable = getPool()): Promise<void> {
  if (version === null) await db.query(`DELETE FROM system_flags WHERE key='dispatch_version'`);
  else await db.query(`INSERT INTO system_flags(key, value, updated_by) VALUES ('dispatch_version', $1::jsonb, $2)
                       ON CONFLICT (key) DO UPDATE SET value=$1::jsonb, updated_at=now(), updated_by=$2`, [JSON.stringify(version), by.slice(0, 64)]);
}
