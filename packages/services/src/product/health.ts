// Account health centre (V2 §7): per connection, explain WHY it cannot publish (disconnected, expired,
// revoked, missing scope, expiring, throttled, paused, provider outage, budget) with the exact fix, and
// list the upcoming schedules it affects. Scope: only brands where the viewer holds connections.read;
// schedule titles only where they also hold content.read (otherwise counts only).
import { CONNECTION_STATUS_LABEL, PROVIDER_LABEL, type ConnectionStatus, type Provider } from '@social-lite/core';
import { getPool, many, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { authorizeCtx, requireAction } from '../tenancy.js';
import { excerpt } from '../posts/shared.js';
import { oauthConnectorFor } from '../connections/oauth.js';
import { brandsWith } from './scope.js';
import { readMeterUsage } from './budgets.js';

export type HealthIssueCode =
  | 'disconnected' | 'expired' | 'revoked' | 'missing_scope' | 'expiring' | 'throttled' | 'paused'
  | 'provider_outage' | 'pending_verification' | 'budget_exhausted' | 'stale_check';

export interface HealthFix {
  action: 'reconnect' | 'check' | 'resume' | 'wait' | 'budgets' | 'bot_admin';
  label: string;
  /** Exact steps. */
  how: string;
  /** Whether the viewer may perform it; otherwise who can. */
  allowed: boolean;
  who: string | null;
}

export interface HealthIssue {
  code: HealthIssueCode; severity: 'critical' | 'warning' | 'info'; title: string; detail: string; fix: HealthFix;
  /** Schedules due at/after this instant are at risk (expiring); null = all upcoming. */
  at_risk_from: string | null;
}

export interface ConnectionFacts {
  id: string; brand_id: string; provider: Provider; display_name: string; status: ConnectionStatus; is_mock: boolean; paused: boolean;
  disconnected_at: Date | null; throttled_until: Date | null; health_detail: { message?: string; missing_permissions?: string[]; expires_at?: string | null } | null;
  health_checked_at: Date | null; cred_expires_at: Date | null; refresh_expires_at: Date | null; granted_scopes: string[] | null;
  circuit_open_until: Date | null;
}

const DAY = 86_400_000;
const fmtDate = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

/** Pure classification (unit-tested). `canManage` = connections.manage on this connection. */
export function classifyConnection(c: ConnectionFacts, opts: { now?: Date; canManage: boolean; xBudgetExhausted?: boolean; canEditBudgets?: boolean }): HealthIssue[] {
  const now = opts.now ?? new Date();
  const p = PROVIDER_LABEL[c.provider];
  const who = opts.canManage ? null : 'An owner or admin';
  const reconnectHow = c.provider === 'telegram'
    ? 'Accounts → this channel → Reconnect, then paste a valid @BotFather token for the same bot.'
    : c.is_mock ? 'Accounts → this destination → Reconnect.' : `Accounts → this account → Reconnect, then sign in to ${p} and approve every requested permission.`;
  const reconnect = (label = 'Reconnect'): HealthFix => ({ action: 'reconnect', label, how: reconnectHow, allowed: opts.canManage, who });
  const issues: HealthIssue[] = [];
  const push = (i: Omit<HealthIssue, 'at_risk_from'> & { at_risk_from?: string | null }) => issues.push({ at_risk_from: null, ...i });

  if (c.disconnected_at || c.status === 'disconnected') {
    push({ code: 'disconnected', severity: 'critical', title: 'Disconnected',
      detail: `Disconnected${c.disconnected_at ? ` on ${fmtDate(c.disconnected_at)}` : ''}. Its stored credentials were deleted, so nothing can be sent to it.`,
      fix: reconnect('Connect again') });
    return issues;
  }
  const credExpired = !!c.cred_expires_at && c.cred_expires_at.getTime() <= now.getTime() && !(c.refresh_expires_at && c.refresh_expires_at.getTime() > now.getTime());
  if (c.status === 'reconnect_required') {
    if (credExpired) {
      push({ code: 'expired', severity: 'critical', title: 'Access expired',
        detail: `${p} access expired on ${fmtDate(c.cred_expires_at!)} and cannot be refreshed. Queued posts are held, not lost.`, fix: reconnect() });
    } else {
      push({ code: 'revoked', severity: 'critical', title: 'Access revoked',
        detail: `${p} no longer accepts this connection (access was revoked, the password changed, or the app was removed). ${c.health_detail?.message ?? ''}`.trim(), fix: reconnect() });
    }
  }
  if (c.status === 'missing_permission') {
    const required = !c.is_mock ? (oauthConnectorFor(c.provider)?.requiredScopes ?? []) : [];
    const granted = new Set(c.granted_scopes ?? []);
    const missing = c.health_detail?.missing_permissions?.length ? c.health_detail.missing_permissions : required.filter((s) => !granted.has(s));
    if (c.provider === 'telegram') {
      push({ code: 'missing_scope', severity: 'critical', title: 'Bot lacks admin rights',
        detail: 'The bot is not an administrator with “Post messages” in this channel.',
        fix: { action: 'bot_admin', label: 'Fix bot rights', how: 'In Telegram: channel → Administrators → add the bot → enable “Post messages”. Then Accounts → Check.', allowed: opts.canManage, who } });
    } else {
      push({ code: 'missing_scope', severity: 'critical', title: 'Missing permission',
        detail: missing.length ? `${p} did not grant: ${missing.join(', ')}.` : `${p} reports a missing permission. ${c.health_detail?.message ?? ''}`.trim(),
        fix: reconnect(missing.length ? `Reconnect and approve ${missing.join(', ')}` : 'Reconnect and approve all permissions') });
    }
  }
  const expiresAt = c.cred_expires_at ?? (c.health_detail?.expires_at ? new Date(c.health_detail.expires_at) : null);
  const refreshable = !!c.refresh_expires_at && c.refresh_expires_at.getTime() > (expiresAt?.getTime() ?? 0);
  // X access tokens rotate every 2 h via the refresh token: short expiry is normal, not "expiring".
  if (!issues.length && c.provider !== 'x' && (c.status === 'expiring' || (expiresAt && !refreshable && expiresAt.getTime() > now.getTime() && expiresAt.getTime() - now.getTime() < 7 * DAY))) {
    const days = expiresAt ? Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / DAY)) : null;
    push({ code: 'expiring', severity: 'warning', title: days !== null ? `Expires in ${days} day${days === 1 ? '' : 's'}` : 'Expiring soon',
      detail: `${p} access ${expiresAt ? `expires on ${fmtDate(expiresAt)}` : 'expires soon'}. Posts due after that will be held until it is reconnected.`,
      fix: reconnect(expiresAt ? `Reconnect before ${expiresAt.toISOString().slice(0, 10)}` : 'Reconnect soon'), at_risk_from: expiresAt?.toISOString() ?? null });
  }
  if (c.status === 'pending_verification') {
    push({ code: 'pending_verification', severity: 'info', title: 'Being verified', detail: 'The connection has not been verified yet.',
      fix: { action: 'check', label: 'Check now', how: 'Accounts → this account → Check.', allowed: opts.canManage, who } });
  }
  if (c.paused) {
    push({ code: 'paused', severity: 'warning', title: 'Paused', detail: 'Publishing to this destination is paused. Queued posts are held and resume when it is resumed, if still on time.',
      fix: { action: 'resume', label: 'Resume', how: 'Accounts → this account → Resume.', allowed: opts.canManage, who } });
  }
  if (c.throttled_until && c.throttled_until.getTime() > now.getTime()) {
    push({ code: 'throttled', severity: 'warning', title: 'Rate limited',
      detail: `${p} asked us to slow down until ${fmtDate(c.throttled_until)}. Queued posts wait and then continue automatically (unless their publish-before deadline passes).`,
      fix: { action: 'wait', label: 'No action needed', how: 'Wait, or spread posts to this destination further apart.', allowed: true, who: null } });
  }
  if (!c.is_mock && c.circuit_open_until && c.circuit_open_until.getTime() > now.getTime()) {
    push({ code: 'provider_outage', severity: 'warning', title: `${p} errors`,
      detail: `${p} returned repeated errors; sending is paused until ${fmtDate(c.circuit_open_until)} and then retried.`,
      fix: { action: 'wait', label: 'No action needed', how: 'Sending resumes automatically.', allowed: true, who: null } });
  }
  if (opts.xBudgetExhausted) {
    push({ code: 'budget_exhausted', severity: 'warning', title: 'X post budget used up',
      detail: 'This month’s X API post budget is used up. X posts are held until next month or until the cap is raised; other channels continue.',
      fix: { action: 'budgets', label: 'Raise the X budget', how: 'Settings → Budgets → X posts / month.', allowed: !!opts.canEditBudgets, who: opts.canEditBudgets ? null : 'The workspace owner' } });
  }
  if (!issues.length && !c.is_mock && (!c.health_checked_at || now.getTime() - c.health_checked_at.getTime() > DAY)) {
    push({ code: 'stale_check', severity: 'info', title: 'Not checked recently',
      detail: c.health_checked_at ? `Last checked ${fmtDate(c.health_checked_at)}.` : 'Never checked.',
      fix: { action: 'check', label: 'Check now', how: 'Accounts → this account → Check.', allowed: opts.canManage, who } });
  }
  return issues;
}

export interface AffectedSchedule { schedule_id: string; post_id: string; title: string | null; excerpt: string; due_at: string; publish_before: string | null; state: string }

export async function accountHealth(ctx: Ctx, q: { brand_id?: string | null } = {}, db: Queryable = getPool()) {
  requireAction(ctx, 'connections.read');
  const brands = await brandsWith(ctx, 'connections.read', db);
  const scoped = q.brand_id ? brands.filter((b) => b.id === q.brand_id) : brands;
  const brandIds = scoped.map((b) => b.id);
  if (!brandIds.length) return { generated_at: new Date().toISOString(), summary: { total: 0, ok: 0, warning: 0, critical: 0, affected_schedules: 0 }, items: [] };
  const conns = await many<ConnectionFacts & { username: string | null }>(db,
    `SELECT c.id, c.brand_id, c.provider, c.display_name, c.username, c.status, c.is_mock, c.paused, c.disconnected_at, c.throttled_until, c.health_detail,
            c.health_checked_at, cr.expires_at AS cred_expires_at, cr.refresh_expires_at, cr.granted_scopes,
            CASE WHEN pc.state = 'open' THEN pc.opened_until END AS circuit_open_until
       FROM connections c
       LEFT JOIN credentials cr ON cr.id = c.credential_id AND cr.workspace_id = c.workspace_id
       LEFT JOIN provider_circuits pc ON pc.provider = c.provider
      WHERE c.workspace_id = $1 AND c.brand_id = ANY($2::uuid[])
        AND (c.disconnected_at IS NULL OR c.disconnected_at > now() - interval '30 days'
             OR EXISTS (SELECT 1 FROM deliveries d WHERE d.connection_id = c.id AND d.state IN ('scheduled','retry_wait','blocked','paused') AND d.publish_before > now()))
      ORDER BY c.provider, c.display_name`, [ctx.access.workspaceId, brandIds]);
  const ids = conns.map((c) => c.id);
  const upcoming = ids.length ? await many<{ connection_id: string; brand_id: string; schedule_id: string; post_id: string; title: string | null; base_text: string; due_at: Date; publish_before: Date | null; state: string }>(db,
    `SELECT * FROM (
       SELECT d.connection_id, d.brand_id, d.schedule_id, d.post_id, p.title, r.base_text, d.due_at, d.publish_before, d.state::text AS state
         FROM deliveries d JOIN schedules s ON s.id = d.schedule_id JOIN posts p ON p.id = d.post_id JOIN post_revisions r ON r.id = d.revision_id
        WHERE d.workspace_id = $1 AND d.connection_id = ANY($2::uuid[]) AND d.state IN ('scheduled','retry_wait','blocked','paused')
          AND d.publish_before > now() AND s.generation = p.schedule_generation
       UNION ALL
       SELECT v.connection_id, s.brand_id, s.id, s.post_id, p.title, r.base_text, s.due_at, s.publish_before, 'pending_approval'
         FROM schedules s JOIN variants v ON v.revision_id = s.revision_id JOIN posts p ON p.id = s.post_id JOIN post_revisions r ON r.id = s.revision_id
        WHERE s.workspace_id = $1 AND v.connection_id = ANY($2::uuid[]) AND s.status = 'pending_approval'
     ) x ORDER BY due_at LIMIT 2000`, [ctx.access.workspaceId, ids]) : [];
  const liveX = conns.some((c) => c.provider === 'x' && !c.is_mock && !c.disconnected_at);
  let xExhausted = false;
  if (liveX) {
    const u = await readMeterUsage(ctx.access.workspaceId, 'x.write', {}, db);
    xExhausted = u.cap !== null && u.used + u.reserved >= u.cap;
  }
  const canEditBudgets = authorizeCtx(ctx, 'security.manage').allowed;
  const now = new Date();
  const affectedIds = new Set<string>();
  const items = conns.map((c) => {
    const canManage = authorizeCtx(ctx, 'connections.manage', { brandId: c.brand_id, connectionId: c.id }).allowed;
    const issues = classifyConnection(c, { now, canManage, xBudgetExhausted: xExhausted && c.provider === 'x' && !c.is_mock, canEditBudgets });
    const mine = upcoming.filter((u) => u.connection_id === c.id);
    const riskFrom = issues.filter((i) => i.severity !== 'info').map((i) => i.at_risk_from);
    const affectedRows = !issues.some((i) => i.severity !== 'info') ? [] : riskFrom.some((r) => r === null) ? mine
      : mine.filter((u) => riskFrom.some((r) => r && u.due_at.getTime() >= new Date(r).getTime()));
    for (const u of affectedRows) affectedIds.add(u.schedule_id);
    const canReadContent = authorizeCtx(ctx, 'content.read', { brandId: c.brand_id }).allowed;
    const state = issues.some((i) => i.severity === 'critical') ? 'critical' : issues.some((i) => i.severity === 'warning') ? 'warning' : 'ok';
    return {
      connection: { id: c.id, brand_id: c.brand_id, brand_name: scoped.find((b) => b.id === c.brand_id)?.name ?? null, provider: c.provider,
        display_name: c.display_name, username: c.username, is_mock: c.is_mock, status: c.disconnected_at ? 'disconnected' : c.paused ? 'paused' : c.status,
        status_label: CONNECTION_STATUS_LABEL[c.disconnected_at ? 'disconnected' : c.paused ? 'paused' : c.status], checked_at: c.health_checked_at?.toISOString() ?? null },
      state, issues,
      affected: {
        count: affectedRows.length,
        schedules: canReadContent ? affectedRows.slice(0, 50).map((u): AffectedSchedule => ({ schedule_id: u.schedule_id, post_id: u.post_id, title: u.title,
          excerpt: excerpt(u.base_text, 100), due_at: u.due_at.toISOString(), publish_before: u.publish_before?.toISOString() ?? null, state: u.state })) : null,
      },
    };
  });
  const rank = { critical: 0, warning: 1, ok: 2 } as const;
  items.sort((a, b) => rank[a.state as keyof typeof rank] - rank[b.state as keyof typeof rank] || b.affected.count - a.affected.count);
  return {
    generated_at: now.toISOString(),
    summary: {
      total: items.length, ok: items.filter((i) => i.state === 'ok').length, warning: items.filter((i) => i.state === 'warning').length,
      critical: items.filter((i) => i.state === 'critical').length, affected_schedules: affectedIds.size,
    },
    items,
  };
}
