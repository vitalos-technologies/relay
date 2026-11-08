// Slack (brief §8): alerts to explicitly selected channels, approval buttons bound to the exact revision, signed
// interactivity mapped to a CURRENT Relay identity, quiet hours, rate controls, deduplication and delivery history.
//  - Content is minimal: category, brand and a Relay link (sign-in required). Never message text, customer names or
//    post copy. Categories that concern customer conversations may only go to private channels.
//  - Slack users act in Relay only after an explicit link made by the signed-in Relay user for the Slack identity that
//    clicked (verified request). Display names and emails are never matched. Removed/suspended members are refused.
//  - Approve buttons carry an opaque id; the binding (approval + revision + fingerprint) stays server-side and the
//    normal approval service re-checks everything (changed content ⇒ fresh review in Relay). Reject needs a reason, so
//    it opens Relay.
//  - Deliveries are durable rows (one per route per event); a lost Slack response is "unknown" and never resent.
import { createHash, randomBytes } from 'node:crypto';
import { AppError, notFound } from '@social-lite/core';
import { SLACK_CATEGORIES, SLACK_PRIVATE_ONLY, type SlackCategory, type SlackDeliveryJson, type SlackRouteJson } from '@social-lite/core/contracts/v35-integrations';
import { getPool, many, maybeOne, one, withTx } from '@social-lite/db';
import { BizApiError, BizTransportError } from '@social-lite/providers/biz/transport';
import {
  SLACK_HOSTS, slackAuthTest, slackAuthorizeUrl, slackChannels, slackExchange, slackPost, slackRespond, slackRevoke, slackUpdate, type SlackBlock,
} from '@social-lite/providers/slack/client';
import { slackSim } from '@social-lite/providers/slack/sim';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { audit } from '../../audit.js';
import { log } from '../../log.js';
import { decideApproval } from '../../posts/scheduling.js';
import type { ApprovalRow } from '../../posts/serialize.js';
import { brandAllowed, loadAccess, requireAction } from '../../tenancy.js';
import { loadIntegration, recordActivity, registerInboundHandler } from '../../connectors/index.js';
import { onInboxEvent } from '../../inbox/hooks.js';
import { appErrorFrom, baseUrl, markRevoked, openConn } from '../core/runtime.js';
import type { Conn, HubAdapter } from '../core/types.js';

export const slackAdapter: HubAdapter = {
  connector: 'slack', hosts: SLACK_HOSTS, sim: slackSim, connect: 'oauth', webhook: 'global',
  required: ['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET', 'SLACK_SIGNING_SECRET'], optional: ['SLACK_SIGNING_SECRET_PREVIOUS'], simSettings: { team_id: 'mock_T1' },
  capabilities: ['Approval requests with Approve buttons', 'Assignment, connection, delivery and care alerts', 'Listening alerts', 'Daily summaries', 'Quiet hours and rate limits'],
  authorizeUrl: (cfg, p) => slackAuthorizeUrl({ clientId: cfg.values.SLACK_CLIENT_ID!, redirectUri: cfg.redirectUri, state: p.state }),
  async exchange(t, cfg, p) {
    const tok = await slackExchange(t, { clientId: cfg.values.SLACK_CLIENT_ID!, clientSecret: cfg.values.SLACK_CLIENT_SECRET!, redirectUri: cfg.redirectUri, code: p.code });
    return { externalAccountId: tok.teamId, displayName: `Slack · ${tok.teamName}`, grantedScopes: tok.scopes, creds: { accessToken: tok.accessToken, refreshToken: null, expiresAt: null },
      settings: { team_id: tok.teamId, bot_user_id: tok.botUserId }, health: { status: 'active', message: `Installed in ${tok.teamName}.` } };
  },
  async verify(c) { const a = await slackAuthTest(c); return { status: 'active', message: `Connected to ${a.team}.` }; },
  async discover(c) {
    return (await slackChannels(c)).map((ch) => ({ resource_type: 'channel', external_id: ch.id, name: `#${ch.name}`, url: null, detail: `${ch.is_private ? 'private' : 'public'}${ch.is_member ? '' : ' · invite the app first'}`, selected: false }));
  },
  async revoke(c) { await slackRevoke(c); },
};

// ------------------------------------------------------------------ routes (channel preferences)
export const routeSchema = z.object({
  integration_id: z.string().uuid(), resource_id: z.string().uuid(), categories: z.array(z.enum(SLACK_CATEGORIES)).min(1).max(SLACK_CATEGORIES.length),
  brand_ids: z.array(z.string().uuid()).max(50).nullable().default(null), quiet_start: z.string().regex(/^\d{2}:\d{2}$/).nullable().default(null), quiet_end: z.string().regex(/^\d{2}:\d{2}$/).nullable().default(null),
  timezone: z.string().min(1).max(60).default('UTC'), max_per_hour: z.number().int().min(1).max(200).default(20), summary_time: z.string().regex(/^\d{2}:\d{2}$/).nullable().default(null), enabled: z.boolean().default(true),
}).strict();

type RouteRow = { id: string; workspace_id: string; integration_id: string; resource_id: string; categories: SlackCategory[]; brand_ids: string[] | null; quiet_start: string | null; quiet_end: string | null;
  timezone: string; max_per_hour: number; summary_time: string | null; enabled: boolean; created_by: string | null; channel_id: string; channel_name: string; channel_private: boolean };

const ROUTE_SELECT = `SELECT r.*, res.external_id AS channel_id, res.name AS channel_name, coalesce((res.metadata->>'is_private')::boolean, false) AS channel_private
  FROM slack_alert_routes r JOIN integration_resources res ON res.id=r.resource_id`;
const hhmm = (t: string | null) => (t ? t.slice(0, 5) : null);
const routeJson = (r: RouteRow): SlackRouteJson => ({ id: r.id, integration_id: r.integration_id, resource_id: r.resource_id, channel_name: r.channel_name, channel_private: r.channel_private,
  categories: r.categories, brand_ids: r.brand_ids, quiet_start: hhmm(r.quiet_start), quiet_end: hhmm(r.quiet_end), timezone: r.timezone, max_per_hour: r.max_per_hour, summary_time: hhmm(r.summary_time), enabled: r.enabled });

function validTz(tz: string): boolean { try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch { return false; } }

export async function saveSlackRoute(ctx: Ctx, input: z.infer<typeof routeSchema>): Promise<SlackRouteJson> {
  const integ = await loadIntegration(ctx, input.integration_id, 'integrations.manage');
  if (integ.connector !== 'slack') throw new AppError('validation_failed', 'Choose a Slack integration.');
  if (!validTz(input.timezone)) throw new AppError('validation_failed', 'Unknown time zone.', { timezone: 'Unknown' });
  for (const b of input.brand_ids ?? []) if (!brandAllowed(ctx, b)) throw notFound('Brand');
  if (integ.brand_id && (!input.brand_ids || input.brand_ids.some((b) => b !== integ.brand_id))) input.brand_ids = [integ.brand_id];
  const res = await maybeOne<{ id: string; external_id: string; selected: boolean }>(getPool(), `SELECT id, external_id, selected FROM integration_resources WHERE id=$1 AND integration_id=$2 AND resource_type='channel'`, [input.resource_id, integ.id]);
  if (!res?.selected) throw new AppError('validation_failed', 'Select the channel first.');
  // Confirm the channel's privacy and the app's membership with Slack now (never trust a stale label).
  const c = await openConn(integ.id, { allowPaused: true });
  let ch;
  try { ch = (await slackChannels(c)).find((x) => x.id === res.external_id); } catch (err) { throw await appErrorFrom(err, c); }
  if (!ch) throw new AppError('invalid_state', 'Slack no longer lists this channel.');
  if (!ch.is_member) throw new AppError('invalid_state', `Invite the Relay app to #${ch.name} first.`);
  const priv = input.categories.filter((x) => SLACK_PRIVATE_ONLY.includes(x));
  if (priv.length && !ch.is_private) throw new AppError('validation_failed', `${priv.join(', ')} can only go to a private channel.`, { categories: 'Private channel required' });
  const id = await withTx(async (tx) => {
    await tx.query(`UPDATE integration_resources SET metadata = metadata || jsonb_build_object('is_private', $2::boolean), updated_at=now() WHERE id=$1`, [res.id, ch.is_private]);
    const r = await one<{ id: string }>(tx,
      `INSERT INTO slack_alert_routes(workspace_id, integration_id, resource_id, categories, brand_ids, quiet_start, quiet_end, timezone, max_per_hour, summary_time, enabled, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (integration_id, resource_id) DO UPDATE SET categories=EXCLUDED.categories, brand_ids=EXCLUDED.brand_ids, quiet_start=EXCLUDED.quiet_start, quiet_end=EXCLUDED.quiet_end,
         timezone=EXCLUDED.timezone, max_per_hour=EXCLUDED.max_per_hour, summary_time=EXCLUDED.summary_time, enabled=EXCLUDED.enabled, updated_at=now() RETURNING id`,
      [integ.workspace_id, integ.id, res.id, input.categories, input.brand_ids, input.quiet_start, input.quiet_end, input.timezone, input.max_per_hour, input.summary_time, input.enabled, ctx.actor.userId]);
    // Alerts start from now (no backfill of older notifications).
    await tx.query(`INSERT INTO integration_cursors(workspace_id, integration_id, scope, cursor, checkpoint_at) VALUES ($1,$2,'slack_feed',NULL,now())
                    ON CONFLICT (coalesce(integration_id, channel_id), scope) DO NOTHING`, [integ.workspace_id, integ.id]);
    await audit(tx, { workspaceId: integ.workspace_id, brandId: integ.brand_id, actorUserId: ctx.actor.userId, action: 'integration.slack_route_saved', resourceType: 'integration', resourceId: integ.id,
      diff: { channel: ch.name, categories: input.categories, enabled: input.enabled }, correlationId: ctx.correlationId });
    return r.id;
  });
  return routeJson((await one<RouteRow>(getPool(), `${ROUTE_SELECT} WHERE r.id=$1`, [id])));
}

export async function listSlackRoutes(ctx: Ctx, integrationId: string): Promise<{ items: SlackRouteJson[] }> {
  await loadIntegration(ctx, integrationId, 'integrations.read');
  return { items: (await many<RouteRow>(getPool(), `${ROUTE_SELECT} WHERE r.integration_id=$1 ORDER BY res.name`, [integrationId])).map(routeJson) };
}

export async function deleteSlackRoute(ctx: Ctx, routeId: string): Promise<void> {
  const r = await maybeOne<{ integration_id: string }>(getPool(), `SELECT integration_id FROM slack_alert_routes WHERE id=$1 AND workspace_id=$2`, [routeId, ctx.access.workspaceId]);
  if (!r) throw notFound('Route');
  await loadIntegration(ctx, r.integration_id, 'integrations.manage');
  await getPool().query(`DELETE FROM slack_alert_routes WHERE id=$1`, [routeId]);
}

export async function listSlackDeliveries(ctx: Ctx, integrationId: string): Promise<{ items: SlackDeliveryJson[] }> {
  await loadIntegration(ctx, integrationId, 'integrations.read');
  const rows = await many<SlackDeliveryJson & { created_at: Date; sent_at: Date | null; brand_id: string | null }>(getPool(),
    `SELECT d.id, d.route_id, res.name AS channel_name, d.category, d.text, d.state, d.state_detail, d.created_at, d.sent_at, d.attempts, d.brand_id
       FROM slack_deliveries d JOIN slack_alert_routes r ON r.id=d.route_id JOIN integration_resources res ON res.id=r.resource_id
      WHERE d.integration_id=$1 ORDER BY d.created_at DESC LIMIT 100`, [integrationId]);
  return { items: rows.filter((r) => !r.brand_id || brandAllowed(ctx, r.brand_id)).map(({ brand_id: _b, ...r }) => ({ ...r, created_at: r.created_at.toISOString(), sent_at: r.sent_at?.toISOString() ?? null })) };
}

// ------------------------------------------------------------------ alert production
const NOTIFICATION_CATEGORY: Array<[RegExp, SlackCategory]> = [
  [/^approval\./, 'approvals'], [/^(task|inbox)\.assigned$/, 'assignments'], [/^connection\./, 'connection_alerts'], [/^delivery\./, 'delivery_alerts'],
];
const TEXT: Record<string, string> = {
  'approval.requested': 'Approval requested', 'approval.approved': 'Post approved', 'approval.rejected': 'Changes requested on a post', 'task.assigned': 'Task assigned',
  'inbox.assigned': 'Conversation assigned', 'connection.health': 'A connection needs attention', 'delivery.failed': 'A post failed to publish', 'delivery.blocked': 'A post is blocked',
  'delivery.expired': 'A scheduled post was missed',
};

async function brandName(id: string | null): Promise<string | null> {
  return id ? (await maybeOne<{ name: string }>(getPool(), `SELECT name FROM brands WHERE id=$1`, [id]))?.name ?? null : null;
}

/** Whether a route may carry an event for this brand (route brand filter + the route creator's CURRENT access). */
async function routeAllows(r: Pick<RouteRow, 'brand_ids' | 'created_by' | 'workspace_id'>, brandId: string | null): Promise<boolean> {
  if (r.brand_ids && (!brandId || !r.brand_ids.includes(brandId))) return false;
  if (!r.created_by) return false;
  const access = await loadAccess(r.created_by, r.workspace_id);
  if (!access) return false;
  return !brandId || access.brandIds === null || access.brandIds.includes(brandId);
}

export async function enqueueSlackEvent(e: { workspaceId: string; integrationId?: string | null; category: SlackCategory; eventKey: string; brandId: string | null; text: string; linkPath: string | null; referenceType?: string | null; referenceId?: string | null; approvalId?: string | null; simulated?: boolean }): Promise<number> {
  // `simulated` (stream F): an event from simulated data reaches only simulated installs, and a live event only live ones.
  const routes = await many<RouteRow>(getPool(), `${ROUTE_SELECT} JOIN integration_connections i ON i.id=r.integration_id
      WHERE r.workspace_id=$1 AND r.enabled AND $2 = ANY(r.categories) AND i.disconnected_at IS NULL AND ($3::uuid IS NULL OR r.integration_id=$3)
        AND ($4::boolean IS NULL OR i.is_simulated = $4)`, [e.workspaceId, e.category, e.integrationId ?? null, e.simulated ?? null]);
  let n = 0;
  for (const r of routes) {
    if (SLACK_PRIVATE_ONLY.includes(e.category) && !r.channel_private) continue;
    if (!(await routeAllows(r, e.brandId))) continue;
    const brand = await brandName(e.brandId);
    const ins = await maybeOne<{ id: string }>(getPool(),
      `INSERT INTO slack_deliveries(workspace_id, integration_id, route_id, event_key, category, brand_id, reference_type, reference_id, text, link_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (route_id, event_key) DO NOTHING RETURNING id`,
      [e.workspaceId, r.integration_id, r.id, e.eventKey.slice(0, 300), e.category, e.brandId, e.referenceType ?? null, e.referenceId ?? null, `${e.text}${brand ? ` · ${brand}` : ''}`.slice(0, 500), e.linkPath]);
    if (!ins) continue;
    n++;
    if (e.approvalId) {
      const a = await maybeOne<{ revision_id: string; fingerprint: string; decision: string }>(getPool(), `SELECT revision_id, fingerprint, decision FROM approvals WHERE id=$1 AND workspace_id=$2`, [e.approvalId, e.workspaceId]);
      if (a?.decision === 'pending') {
        await getPool().query(`INSERT INTO slack_actions(workspace_id, integration_id, delivery_id, kind, approval_id, revision_id, fingerprint, expires_at) VALUES ($1,$2,$3,'approval',$4,$5,$6, now() + interval '72 hours')`,
          [e.workspaceId, r.integration_id, ins.id, e.approvalId, a.revision_id, a.fingerprint]);
      }
    }
  }
  return n;
}

/** Worker: turn new in-app notifications into channel alerts (deduplicated per event; minimal text). */
export async function collectSlackAlerts(limit = 200): Promise<number> {
  const curs = await many<{ id: string; workspace_id: string; integration_id: string; cursor: string | null; checkpoint_at: Date }>(getPool(),
    `SELECT c.id, c.workspace_id, c.integration_id, c.cursor, c.checkpoint_at FROM integration_cursors c JOIN integration_connections i ON i.id=c.integration_id
      WHERE c.scope='slack_feed' AND i.disconnected_at IS NULL AND EXISTS (SELECT 1 FROM slack_alert_routes r WHERE r.integration_id=c.integration_id AND r.enabled)`);
  let total = 0;
  for (const c of curs) {
    const since = c.cursor ? new Date(c.cursor) : c.checkpoint_at;
    const rows = await many<{ id: string; kind: string; brand_id: string | null; reference_type: string | null; reference_id: string | null; link_path: string | null; dedupe_key: string; created_at: Date }>(getPool(),
      `SELECT id, kind, brand_id, reference_type, reference_id, link_path, dedupe_key, created_at FROM notifications WHERE workspace_id=$1 AND created_at > $2 ORDER BY created_at LIMIT $3`, [c.workspace_id, since, limit]);
    for (const n of rows) {
      const cat = NOTIFICATION_CATEGORY.find(([re]) => re.test(n.kind))?.[1];
      if (!cat) continue;
      // Per-recipient suffixes (user ids) are stripped so one event = one channel message.
      const key = `n:${n.kind}:${n.dedupe_key.replace(/:[0-9a-f-]{36}(:\d+)?$/i, '')}`;
      total += await enqueueSlackEvent({ workspaceId: c.workspace_id, category: cat, eventKey: key, brandId: n.brand_id, text: TEXT[n.kind] ?? 'Relay alert',
        linkPath: n.link_path ?? (n.reference_type === 'connection' ? '/accounts/health' : n.reference_type === 'post' && n.reference_id ? `/posts/${n.reference_id}` : null),
        referenceType: n.reference_type, referenceId: n.reference_id, approvalId: n.kind === 'approval.requested' && n.reference_type === 'approval' ? n.reference_id : null });
    }
    if (rows.length) await getPool().query(`UPDATE integration_cursors SET cursor=$2, last_run_at=now(), last_success_at=now(), updated_at=now() WHERE id=$1`, [c.id, rows[rows.length - 1]!.created_at.toISOString()]);
  }
  return total;
}

/** Inbox hooks (stream B/D/E events): care escalations and listening alerts. Ids only; text is generic. */
export function registerSlackHooks(): void {
  onInboxEvent('case.changed', 'slack-care-escalations', async (e) => {
    const change = String(e.payload.change ?? '');
    if (change !== 'breach' && change !== 'escalated') return;
    const c = await maybeOne<{ brand_id: string; number: string }>(getPool(), `SELECT brand_id, number::text FROM care_cases WHERE id=$1 AND workspace_id=$2`, [e.aggregateId, e.workspaceId]);
    if (!c) return;
    await enqueueSlackEvent({ workspaceId: e.workspaceId, category: 'care_escalations', eventKey: `case:${e.aggregateId}:${change}:${String(e.payload.at ?? e.payload.kind ?? '')}`, brandId: c.brand_id,
      text: change === 'breach' ? `Case #${c.number} breached its service level` : `Case #${c.number} was escalated`, linkPath: `/inbox?case=${e.aggregateId}`, referenceType: 'case', referenceId: e.aggregateId });
  });
  onInboxEvent('listening.alert_fired', 'slack-listening-alerts', async (e) => {
    // Stream F: load the alert (ids in the event are hints only); simulated alerts go only to simulated Slack installs.
    const a = await maybeOne<{ brand_id: string; is_simulated: boolean; name: string }>(getPool(),
      `SELECT a.brand_id, a.is_simulated, s.name FROM listening_alerts a JOIN listening_searches s ON s.id=a.search_id WHERE a.id=$1 AND a.workspace_id=$2`, [e.aggregateId, e.workspaceId]);
    if (!a) return;
    await enqueueSlackEvent({ workspaceId: e.workspaceId, category: 'listening_alerts', eventKey: `listening:${e.aggregateId}`, brandId: a.brand_id, text: `Listening alert: ${a.name.replace(/[\r\n]+/g, ' ').slice(0, 80)}`,
      linkPath: `/listening/alerts/${e.aggregateId}`, referenceType: 'listening_alert', referenceId: e.aggregateId, simulated: a.is_simulated });
  });
}

function localParts(tz: string, d = new Date()): { date: string; minutes: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Minutes until quiet hours end (0 when not quiet). Handles windows over midnight. */
export function quietMinutesLeft(r: Pick<RouteRow, 'quiet_start' | 'quiet_end' | 'timezone'>, now = new Date()): number {
  if (!r.quiet_start || !r.quiet_end) return 0;
  const m = localParts(r.timezone, now).minutes; const s = toMin(r.quiet_start); const e = toMin(r.quiet_end);
  if (s === e) return 0;
  const inQuiet = s < e ? m >= s && m < e : m >= s || m < e;
  if (!inQuiet) return 0;
  return (e - m + 1440) % 1440 || 1440;
}

/** Worker: daily summaries (counts only) at each route's local summary time. */
export async function queueSlackSummaries(): Promise<number> {
  const routes = await many<RouteRow>(getPool(), `${ROUTE_SELECT} WHERE r.enabled AND r.summary_time IS NOT NULL AND 'summaries' = ANY(r.categories)`);
  let n = 0;
  for (const r of routes) {
    const lp = localParts(r.timezone);
    if (lp.minutes < toMin(r.summary_time!) || lp.minutes > toMin(r.summary_time!) + 30) continue;
    const b = r.brand_ids;
    const counts = await one<{ approvals: number; failed: number; unassigned: number; breaches: number }>(getPool(),
      `SELECT (SELECT count(*)::int FROM approvals WHERE workspace_id=$1 AND decision='pending' AND ($2::uuid[] IS NULL OR brand_id = ANY($2))) approvals,
              (SELECT count(*)::int FROM deliveries d WHERE d.workspace_id=$1 AND d.state='failed' AND d.updated_at > now() - interval '24 hours') failed,
              (SELECT count(*)::int FROM inbox_conversations WHERE workspace_id=$1 AND state='open' AND assignee_id IS NULL AND ($2::uuid[] IS NULL OR brand_id = ANY($2))) unassigned,
              (SELECT count(*)::int FROM care_cases WHERE workspace_id=$1 AND (first_response_breached_at > now() - interval '24 hours' OR resolution_breached_at > now() - interval '24 hours') AND ($2::uuid[] IS NULL OR brand_id = ANY($2))) breaches`,
      [r.workspace_id, b]).catch(() => null);
    if (!counts) continue;
    const text = `Daily summary: ${counts.approvals} awaiting approval · ${counts.failed} failed posts (24 h) · ${counts.unassigned} unassigned conversations · ${counts.breaches} service-level breaches (24 h)`;
    const ins = await getPool().query(`INSERT INTO slack_deliveries(workspace_id, integration_id, route_id, event_key, category, text, link_path) VALUES ($1,$2,$3,$4,'summaries',$5,'/') ON CONFLICT (route_id, event_key) DO NOTHING`,
      [r.workspace_id, r.integration_id, r.id, `summary:${lp.date}`, text]);
    n += ins.rowCount ?? 0;
  }
  return n;
}

// ------------------------------------------------------------------ sender (worker)
function blocksFor(d: { text: string; link_path: string | null; category: string }, actionId: string | null): SlackBlock[] {
  const url = `${baseUrl()}${d.link_path ?? '/'}`;
  const els: SlackBlock[] = [{ type: 'button', text: { type: 'plain_text', text: 'Open in Relay' }, url, action_id: 'relay_open' }];
  if (actionId) els.unshift({ type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, action_id: 'relay_approve', value: actionId });
  return [{ type: 'section', text: { type: 'mrkdwn', text: d.text.replace(/[<>&]/g, '') } }, { type: 'actions', elements: els }];
}

export async function sendSlackDeliveries(limit = 20): Promise<{ sent: number; deferred: number; failed: number }> {
  const out = { sent: 0, deferred: 0, failed: 0 };
  const claimed = await many<{ id: string; workspace_id: string; integration_id: string; route_id: string; text: string; link_path: string | null; category: string; attempts: number; brand_id: string | null }>(getPool(),
    `UPDATE slack_deliveries d SET state='sending', attempts=d.attempts+1 WHERE d.id IN (
       SELECT d2.id FROM slack_deliveries d2 JOIN integration_connections i ON i.id=d2.integration_id
        WHERE d2.state IN ('queued','deferred') AND d2.not_before <= now() AND NOT i.paused AND i.disconnected_at IS NULL AND i.status <> 'reconnect_required'
        ORDER BY d2.not_before LIMIT $1 FOR UPDATE OF d2 SKIP LOCKED)
     RETURNING d.id, d.workspace_id, d.integration_id, d.route_id, d.text, d.link_path, d.category, d.attempts, d.brand_id`, [limit]);
  for (const d of claimed) {
    const r = await maybeOne<RouteRow>(getPool(), `${ROUTE_SELECT} WHERE r.id=$1`, [d.route_id]);
    const set = (state: string, detail: string | null, extra = '') => getPool().query(`UPDATE slack_deliveries SET state=$2, state_detail=$3 ${extra} WHERE id=$1`, [d.id, state, detail]);
    if (!r?.enabled) { await set('suppressed', 'Route disabled'); continue; }
    if (!(await routeAllows(r, d.brand_id))) { await set('suppressed', 'The route owner no longer has access to this brand.'); continue; }
    const quiet = quietMinutesLeft(r);
    if (quiet > 0) { await getPool().query(`UPDATE slack_deliveries SET state='deferred', state_detail='Quiet hours', attempts=attempts-1, not_before=now() + make_interval(mins => $2) WHERE id=$1`, [d.id, quiet]); out.deferred++; continue; }
    const recent = await one<{ n: number; oldest: Date | null }>(getPool(), `SELECT count(*)::int n, min(sent_at) oldest FROM slack_deliveries WHERE route_id=$1 AND state='sent' AND sent_at > now() - interval '1 hour'`, [r.id]);
    if (recent.n >= r.max_per_hour) {
      await getPool().query(`UPDATE slack_deliveries SET state='deferred', state_detail='Channel limit reached; delayed', attempts=attempts-1, not_before=$2 WHERE id=$1`, [d.id, new Date((recent.oldest?.getTime() ?? Date.now()) + 3_600_000)]);
      out.deferred++; continue;
    }
    const action = await maybeOne<{ id: string }>(getPool(), `SELECT id FROM slack_actions WHERE delivery_id=$1 AND used_at IS NULL AND expires_at > now()`, [d.id]);
    let c: Conn;
    try { c = await openConn(d.integration_id); } catch (err) { await set('failed', (err as Error).message.slice(0, 200)); out.failed++; continue; }
    try {
      const m = await slackPost(c, { channel: r.channel_id, text: d.text, blocks: blocksFor(d, action?.id ?? null) });
      await getPool().query(`UPDATE slack_deliveries SET state='sent', state_detail=NULL, message_ts=$2, sent_at=now() WHERE id=$1`, [d.id, m.ts]);
      out.sent++;
    } catch (err) {
      if (err instanceof BizTransportError && err.mayHaveReached) { await set('unknown', 'Slack did not confirm the message. It is not resent automatically.'); out.failed++; continue; }
      if (err instanceof BizApiError && err.kind === 'auth') { await markRevoked(d.integration_id, d.workspace_id, 'slack_token_revoked'); await set('failed', 'Slack access was revoked.'); out.failed++; continue; }
      const retryable = err instanceof BizTransportError || (err instanceof BizApiError && (err.kind === 'rate_limited' || err.kind === 'unavailable' || err.kind === 'server'));
      if (retryable && d.attempts < 5) {
        const wait = err instanceof BizApiError && err.retryAfterMs ? err.retryAfterMs : 30_000 * 2 ** (d.attempts - 1);
        await getPool().query(`UPDATE slack_deliveries SET state='queued', state_detail=$2, not_before=now() + make_interval(secs => $3) WHERE id=$1`, [d.id, err instanceof BizApiError && err.kind === 'rate_limited' ? 'Rate limited by Slack; retrying' : 'Slack unavailable; retrying', Math.ceil(wait / 1000)]);
        await recordActivity(getPool(), { workspaceId: d.workspace_id, integrationId: d.integration_id, kind: err instanceof BizApiError && err.kind === 'rate_limited' ? 'rate_limit' : 'sync', outcome: 'retry', code: (err as BizApiError).code ?? 'unavailable' });
      } else {
        await set('failed', err instanceof BizApiError && err.code === 'not_in_channel' ? 'The app is not in this channel.' : (err as Error).message.slice(0, 200));
        await recordActivity(getPool(), { workspaceId: d.workspace_id, integrationId: d.integration_id, kind: 'sync', outcome: 'error', code: (err as BizApiError).code ?? 'slack_failed' });
        out.failed++;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ identity links
const sha = (s: string) => createHash('sha256').update(s).digest();

async function issueLinkToken(integrationId: string, workspaceId: string, teamId: string, userId: string): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  await getPool().query(`INSERT INTO slack_link_tokens(token_hash, workspace_id, integration_id, slack_team_id, slack_user_id, expires_at) VALUES ($1,$2,$3,$4,$5, now() + interval '10 minutes')`, [sha(token), workspaceId, integrationId, teamId, userId]);
  return token;
}

/** The signed-in Relay user confirms "this Slack identity is me" (token came from a verified Slack request). */
export async function confirmSlackLink(ctx: Ctx, token: string): Promise<{ ok: true; team_id: string }> {
  if (!token || token.length > 100) throw new AppError('validation_failed', 'Invalid link.');
  return withTx(async (tx) => {
    const t = await maybeOne<{ workspace_id: string; integration_id: string; slack_team_id: string; slack_user_id: string }>(tx,
      `UPDATE slack_link_tokens SET consumed_at=now() WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at > now() RETURNING workspace_id, integration_id, slack_team_id, slack_user_id`, [sha(token)]);
    if (!t || t.workspace_id !== ctx.access.workspaceId) throw new AppError('invalid_state', 'This link expired or belongs to another workspace. Click the button in Slack again.');
    await tx.query(`UPDATE slack_user_links SET unlinked_at=now(), unlinked_by=$3 WHERE integration_id=$1 AND (slack_user_id=$2 OR user_id=$3) AND unlinked_at IS NULL`, [t.integration_id, t.slack_user_id, ctx.actor.userId]);
    await tx.query(`INSERT INTO slack_user_links(workspace_id, integration_id, slack_team_id, slack_user_id, user_id) VALUES ($1,$2,$3,$4,$5)`, [t.workspace_id, t.integration_id, t.slack_team_id, t.slack_user_id, ctx.actor.userId]);
    await audit(tx, { workspaceId: t.workspace_id, actorUserId: ctx.actor.userId, action: 'integration.slack_identity_linked', resourceType: 'integration', resourceId: t.integration_id, diff: { slack_user: t.slack_user_id }, correlationId: ctx.correlationId });
    return { ok: true as const, team_id: t.slack_team_id };
  });
}

export async function listSlackLinks(ctx: Ctx, integrationId: string) {
  await loadIntegration(ctx, integrationId, 'integrations.read');
  const rows = await many<{ id: string; slack_user_id: string; user_id: string; name: string | null; email: string; linked_at: Date }>(getPool(),
    `SELECT l.id, l.slack_user_id, l.user_id, u.name, u.email, l.linked_at FROM slack_user_links l JOIN users u ON u.id=l.user_id WHERE l.integration_id=$1 AND l.unlinked_at IS NULL ORDER BY l.linked_at DESC`, [integrationId]);
  return { items: rows.map((r) => ({ ...r, linked_at: r.linked_at.toISOString(), is_me: r.user_id === ctx.actor.userId })) };
}

export async function unlinkSlackIdentity(ctx: Ctx, linkId: string): Promise<void> {
  const l = await maybeOne<{ integration_id: string; user_id: string }>(getPool(), `SELECT integration_id, user_id FROM slack_user_links WHERE id=$1 AND workspace_id=$2 AND unlinked_at IS NULL`, [linkId, ctx.access.workspaceId]);
  if (!l) throw notFound('Link');
  await loadIntegration(ctx, l.integration_id, l.user_id === ctx.actor.userId ? 'integrations.read' : 'integrations.manage');
  await getPool().query(`UPDATE slack_user_links SET unlinked_at=now(), unlinked_by=$2 WHERE id=$1`, [linkId, ctx.actor.userId]);
  await audit(getPool(), { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'integration.slack_identity_unlinked', resourceType: 'integration', resourceId: l.integration_id, diff: { link_id: linkId }, correlationId: ctx.correlationId });
}

// ------------------------------------------------------------------ interactivity (verified by the ingress; processed here)
type BlockActions = { type?: string; team?: { id?: string }; user?: { id?: string }; actions?: Array<{ action_id?: string; value?: string }>; response_url?: string; container?: { channel_id?: string; message_ts?: string } };
export type SlackActionOutcome = 'approved' | 'link_required' | 'actor_refused' | 'stale' | 'refused' | 'ignored';

async function respond(c: Conn, url: string | undefined, text: string, replace = false): Promise<void> {
  if (!url) return;
  await slackRespond(c.t, url, { text, response_type: 'ephemeral', replace_original: replace }).catch((err) => log.warn('slack_respond_failed', { err: (err as Error).name }));
}

export async function handleSlackInteraction(raw: unknown): Promise<{ outcome: SlackActionOutcome; detail?: string }> {
  const p = ((raw as { raw_form?: boolean }).raw_form ? null : raw) as BlockActions | null;
  if (!p || p.type !== 'block_actions' || !p.team?.id || !p.user?.id) return { outcome: 'ignored' };
  const act = p.actions?.[0];
  if (!act || act.action_id !== 'relay_approve' || !act.value || !/^[0-9a-f-]{36}$/i.test(act.value)) return { outcome: 'ignored' };
  const a = await maybeOne<{ id: string; workspace_id: string; integration_id: string; delivery_id: string | null; approval_id: string; revision_id: string; fingerprint: string; expires_at: Date; used_at: Date | null }>(getPool(),
    `SELECT a.* FROM slack_actions a JOIN integration_connections i ON i.id=a.integration_id WHERE a.id=$1 AND i.connector='slack' AND coalesce(i.settings->>'team_id', i.external_account_id)=$2 AND i.disconnected_at IS NULL`, [act.value, p.team.id]);
  if (!a) return { outcome: 'refused', detail: 'unknown action for this Slack workspace' };
  const c = await openConn(a.integration_id, { allowPaused: true });
  const link = await maybeOne<{ user_id: string }>(getPool(), `SELECT user_id FROM slack_user_links WHERE integration_id=$1 AND slack_user_id=$2 AND unlinked_at IS NULL`, [a.integration_id, p.user.id]);
  if (!link) {
    const token = await issueLinkToken(a.integration_id, a.workspace_id, p.team.id, p.user.id);
    await respond(c, p.response_url, `Link your Slack account to Relay first, then try again: ${baseUrl()}/integrations/link/slack?t=${token}`);
    await recordActivity(getPool(), { workspaceId: a.workspace_id, integrationId: a.integration_id, kind: 'webhook', outcome: 'error', code: 'slack_actor_unlinked' });
    return { outcome: 'link_required' };
  }
  // Current membership + permission, evaluated now (removed or suspended members are refused).
  const access = await loadAccess(link.user_id, a.workspace_id, getPool(), { mfaVerified: false, authTime: null });
  const user = await maybeOne<{ email: string; name: string | null }>(getPool(), `SELECT email, name FROM users WHERE id=$1`, [link.user_id]);
  if (!access || !user) {
    await respond(c, p.response_url, 'Your Relay access was removed. Nothing was changed.');
    await audit(getPool(), { workspaceId: a.workspace_id, actorService: 'slack', action: 'integration.slack_action_refused', resourceType: 'approval', resourceId: a.approval_id, diff: { reason: 'no_access', slack_user: p.user.id }, correlationId: null });
    return { outcome: 'actor_refused', detail: 'no current access' };
  }
  const ctx: Ctx = { actor: { userId: link.user_id, email: user.email, name: user.name, sessionId: '' }, access, correlationId: `slack:${act.value}` };
  if (a.used_at || a.expires_at.getTime() < Date.now()) {
    await respond(c, p.response_url, 'This button expired. Review it in Relay.');
    return { outcome: 'stale' };
  }
  try {
    await decideApproval(ctx, async (tx) => {
      const row = await maybeOne<ApprovalRow & { revision_id: string }>(tx,
        `SELECT a.*, ru.email AS requested_by_email, rv.email AS reviewer_email FROM approvals a LEFT JOIN users ru ON ru.id=a.requested_by LEFT JOIN users rv ON rv.id=a.reviewer_id
          WHERE a.id=$1 AND a.workspace_id=$2 FOR UPDATE OF a`, [a.approval_id, a.workspace_id]);
      if (!row || !brandAllowed(ctx, row.brand_id)) throw notFound('Approval');
      requireAction(ctx, 'approvals.decide', { brandId: row.brand_id });
      if (row.revision_id !== a.revision_id) throw new AppError('conflict', 'The post changed after this message was sent. Review the new version in Relay.');
      return row;
    }, a.fingerprint);
  } catch (err) {
    const msg = err instanceof AppError ? err.message : 'Relay could not record the approval.';
    await respond(c, p.response_url, `${msg} Nothing was approved from Slack.`);
    await audit(getPool(), { workspaceId: a.workspace_id, actorUserId: link.user_id, actorService: 'slack', action: 'integration.slack_action_refused', resourceType: 'approval', resourceId: a.approval_id,
      diff: { reason: err instanceof AppError ? err.code : 'error' }, correlationId: ctx.correlationId });
    return { outcome: err instanceof AppError && (err.code === 'forbidden' || err.code === 'not_found') ? 'actor_refused' : 'stale', detail: msg };
  }
  await getPool().query(`UPDATE slack_actions SET used_at=now(), used_by=$2, outcome='approved' WHERE id=$1`, [a.id, link.user_id]);
  await audit(getPool(), { workspaceId: a.workspace_id, actorUserId: link.user_id, actorService: 'slack', action: 'integration.slack_approved', resourceType: 'approval', resourceId: a.approval_id, diff: { slack_user: p.user.id }, correlationId: ctx.correlationId });
  const ch = p.container?.channel_id; const ts = p.container?.message_ts;
  if (ch && ts) await slackUpdate(c, { channel: ch, ts, text: `Approved in Slack by ${user.name ?? 'a reviewer'}`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `Approved in Slack by ${(user.name ?? 'a reviewer').replace(/[<>&]/g, '')}` } }] }).catch(() => undefined);
  else await respond(c, p.response_url, 'Approved.');
  return { outcome: 'approved' };
}

export function registerSlack(): void {
  registerInboundHandler({
    connector: 'slack',
    async handle(e) {
      const r = await handleSlackInteraction(e.body);
      return { outcome: r.outcome === 'ignored' ? 'ignored' : 'processed', detail: r.outcome };
    },
  });
  registerSlackHooks();
}

export { appErrorFrom as slackAppError };
