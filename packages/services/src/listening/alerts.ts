// Volume-spike alerts (brief §15; acceptance test 10). Rules belong to a saved search. Evaluation (worker, after ingest
// and every 5 minutes) counts UNIQUE matched mentions in the current window (epoch-aligned) and compares them with the
// same-length windows of the previous baseline_days that were MONITORED (spike.ts). A fired alert stores:
//  - the exact observations counted (listening_alert_evidence) → the alert links to real mentions;
//  - a ListeningCoverage snapshot (sources, monitoring start, incomplete channels, query version, denominators);
//  - dedupe key rule:dataset:window (UNIQUE) and a cooldown check.
// Recipients are re-checked at delivery (deliverNotification → listening.read on the brand), so revoked members get
// nothing. 'listening.alert_fired' is emitted for other subscribers (Slack in stream C, automation in stream E).
import { AppError, notFound } from '@social-lite/core';
import { ALERT_METRICS, type AlertDto, type AlertRuleDto, type ListeningCoverage, type ObservationDto } from '@social-lite/core/contracts/v35-listening';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { log } from '../log.js';
import { writeOutbox } from '../outbox.js';
import { deliverNotification } from '../collab/notifications.js';
import { entitledNow } from '../collab/access.js';
import { assertUuid } from '../tenancy.js';
import { evaluateSpike, SPIKE_REASON_TEXT, windowStart, type SpikeReason } from './spike.js';
import { buildCoverage, monitoredSince } from './sources.js';
import { MENTION_JOINS, MENTION_SELECT, observationDto } from './query.js';
import { canListen, iso, listeningBrands, loadSearch, LISTENING_MANAGE, LISTENING_READ, type SearchRow } from './shared.js';

const EVIDENCE_CAP = 500;

export const ruleSchema = z.object({
  search_id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  metric: z.enum(ALERT_METRICS).default('volume'),
  window_minutes: z.number().int().refine((v) => [15, 30, 60, 120, 240, 360, 720, 1440].includes(v), 'Use 15, 30, 60, 120, 240, 360, 720 or 1440').default(60),
  baseline_days: z.number().int().min(1).max(28).default(7),
  min_sample: z.number().int().min(3).max(10_000).default(10),
  multiplier: z.number().min(1.2).max(20).default(2),
  min_baseline_windows: z.number().int().min(3).max(2000).default(24),
  cooldown_minutes: z.number().int().min(15).max(10_080).default(360),
  recipients: z.array(z.string().uuid()).max(20).default([]),
  enabled: z.boolean().default(true),
}).strict();
export const updateRuleSchema = ruleSchema.omit({ search_id: true }).partial().extend({ expected_version: z.number().int().min(1) }).strict();

interface RuleRow {
  id: string; workspace_id: string; brand_id: string; search_id: string; name: string; metric: 'volume' | 'negative'; window_minutes: number; baseline_days: number;
  min_sample: number; multiplier: number; min_baseline_windows: number; cooldown_minutes: number; recipients: string[]; enabled: boolean;
  last_evaluated_at: Date | null; last_state: SpikeReason | null; last_detail: string | null; version: number; created_by: string | null; archived_at: Date | null;
}

async function ruleDto(db: Queryable, rows: RuleRow[]): Promise<AlertRuleDto[]> {
  const ids = [...new Set(rows.flatMap((r) => r.recipients))];
  const users = ids.length ? await many<{ id: string; name: string | null }>(db, `SELECT id, name FROM users WHERE id = ANY($1::uuid[])`, [ids]) : [];
  return rows.map((r) => ({
    id: r.id, search_id: r.search_id, name: r.name, metric: r.metric, window_minutes: r.window_minutes, baseline_days: r.baseline_days, min_sample: r.min_sample,
    multiplier: r.multiplier, min_baseline_windows: r.min_baseline_windows, cooldown_minutes: r.cooldown_minutes,
    recipients: r.recipients.map((id) => ({ id, name: users.find((u) => u.id === id)?.name ?? null })), enabled: r.enabled,
    last_evaluated_at: iso(r.last_evaluated_at), last_result: r.last_state ? { state: r.last_state, detail: r.last_detail ?? SPIKE_REASON_TEXT[r.last_state] } : null, version: r.version,
  }));
}

async function assertRecipients(db: Queryable, workspaceId: string, brandId: string, ids: string[]): Promise<void> {
  for (const id of ids) {
    if (!(await entitledNow(db, workspaceId, id, { brandId, permission: LISTENING_READ }))) {
      throw new AppError('validation_failed', 'A recipient cannot see listening for this brand.', { recipients: 'Choose people with listening access' });
    }
  }
}

export async function listRules(ctx: Ctx, searchId: string): Promise<{ items: AlertRuleDto[] }> {
  await loadSearch(ctx, searchId);
  const rows = await many<RuleRow>(getPool(), `SELECT * FROM listening_alert_rules WHERE search_id=$1 AND archived_at IS NULL ORDER BY created_at`, [searchId]);
  return { items: await ruleDto(getPool(), rows) };
}

export async function createRule(ctx: Ctx, input: z.infer<typeof ruleSchema>): Promise<AlertRuleDto> {
  const row = await withTx(async (tx) => {
    const s = await loadSearch(ctx, input.search_id, LISTENING_MANAGE, tx);
    const recipients = input.recipients.length ? [...new Set(input.recipients)] : [ctx.actor.userId];
    await assertRecipients(tx, ctx.access.workspaceId, s.brand_id, recipients);
    const r = await one<RuleRow>(tx,
      `INSERT INTO listening_alert_rules(workspace_id, brand_id, search_id, name, metric, window_minutes, baseline_days, min_sample, multiplier, min_baseline_windows, cooldown_minutes, recipients, enabled, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [ctx.access.workspaceId, s.brand_id, s.id, input.name, input.metric, input.window_minutes, input.baseline_days, input.min_sample, input.multiplier, input.min_baseline_windows,
        input.cooldown_minutes, recipients, input.enabled, ctx.actor.userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: s.brand_id, actorUserId: ctx.actor.userId, action: 'listening.alert_rule_created', resourceType: 'listening_alert_rule', resourceId: r.id, diff: { metric: r.metric, window_minutes: r.window_minutes, min_sample: r.min_sample }, correlationId: ctx.correlationId });
    return r;
  });
  return (await ruleDto(getPool(), [row]))[0]!;
}

async function loadRule(ctx: Ctx, id: string, db: Queryable, forUpdate = false): Promise<RuleRow> {
  assertUuid(id, 'Alert rule');
  const r = await maybeOne<RuleRow>(db, `SELECT * FROM listening_alert_rules WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL${forUpdate ? ' FOR UPDATE' : ''}`, [id, ctx.access.workspaceId]);
  if (!r || !canListen(ctx, r.brand_id)) throw notFound('Alert rule');
  return r;
}

export async function updateRule(ctx: Ctx, id: string, input: z.infer<typeof updateRuleSchema>): Promise<AlertRuleDto> {
  const row = await withTx(async (tx) => {
    const cur = await loadRule(ctx, id, tx, true);
    await loadSearch(ctx, cur.search_id, LISTENING_MANAGE, tx);
    if (cur.version !== input.expected_version) throw new AppError('version_conflict', 'Someone changed this rule. Reload to see their version.', undefined, { current_version: cur.version });
    if (input.recipients) await assertRecipients(tx, ctx.access.workspaceId, cur.brand_id, input.recipients);
    const n = { ...cur, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as RuleRow;
    const r = await one<RuleRow>(tx,
      `UPDATE listening_alert_rules SET name=$2, metric=$3, window_minutes=$4, baseline_days=$5, min_sample=$6, multiplier=$7, min_baseline_windows=$8, cooldown_minutes=$9,
              recipients=$10, enabled=$11, version=version+1, updated_at=now() WHERE id=$1 RETURNING *`,
      [id, n.name, n.metric, n.window_minutes, n.baseline_days, n.min_sample, n.multiplier, n.min_baseline_windows, n.cooldown_minutes, n.recipients, n.enabled]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: cur.brand_id, actorUserId: ctx.actor.userId, action: 'listening.alert_rule_updated', resourceType: 'listening_alert_rule', resourceId: id, diff: { enabled: r.enabled, version: r.version }, correlationId: ctx.correlationId });
    return r;
  });
  return (await ruleDto(getPool(), [row]))[0]!;
}

export async function archiveRule(ctx: Ctx, id: string): Promise<{ ok: true }> {
  await withTx(async (tx) => {
    const cur = await loadRule(ctx, id, tx, true);
    await loadSearch(ctx, cur.search_id, LISTENING_MANAGE, tx);
    await tx.query(`UPDATE listening_alert_rules SET archived_at=now(), enabled=false WHERE id=$1`, [id]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: cur.brand_id, actorUserId: ctx.actor.userId, action: 'listening.alert_rule_archived', resourceType: 'listening_alert_rule', resourceId: id, correlationId: ctx.correlationId });
  });
  return { ok: true };
}

// ------------------------------------------------------------------ evaluation (worker)
const COUNTED = `FROM listening_matches lm JOIN listening_observations o ON o.id = lm.observation_id
  WHERE lm.search_id=$1 AND o.is_simulated=$2 AND o.removed_at IS NULL AND o.excluded_at IS NULL
    AND (o.duplicate_of IS NULL OR NOT EXISTS (SELECT 1 FROM listening_matches lm2 WHERE lm2.search_id = lm.search_id AND lm2.observation_id = o.duplicate_of))
    AND ($3::text = 'volume' OR coalesce(o.corrected_label, o.sentiment_label) = 'negative')`;

export interface EvaluationResult { ruleId: string; dataset: 'live' | 'simulated'; reason: SpikeReason; observed: number; threshold: number; alertId: string | null }

async function datasetsFor(db: Queryable, rule: RuleRow): Promise<Array<'live' | 'simulated'>> {
  const r = await many<{ sim: boolean }>(db, `SELECT DISTINCT is_simulated AS sim FROM inbox_channels WHERE workspace_id=$1 AND brand_id=$2`, [rule.workspace_id, rule.brand_id]);
  return r.map((x) => (x.sim ? 'simulated' : 'live'));
}

/** Evaluate one rule now (every dataset the brand has). Safe to call concurrently (advisory lock + unique dedupe key). */
export async function evaluateRule(ruleId: string, now = new Date()): Promise<EvaluationResult[]> {
  const db = getPool();
  const rule = await maybeOne<RuleRow>(db, `SELECT * FROM listening_alert_rules WHERE id=$1 AND enabled AND archived_at IS NULL`, [ruleId]);
  if (!rule) return [];
  const search = await maybeOne<SearchRow>(db, `SELECT * FROM listening_searches WHERE id=$1 AND archived_at IS NULL`, [rule.search_id]);
  if (!search) return [];
  const out: EvaluationResult[] = [];
  for (const dataset of await datasetsFor(db, rule)) out.push(await evaluateDataset(rule, search, dataset, now));
  const shown = out.find((r) => r.reason === 'fired') ?? out.find((r) => r.dataset === 'live') ?? out[0];
  await db.query(`UPDATE listening_alert_rules SET last_evaluated_at=$2, last_state=$3, last_detail=$4 WHERE id=$1`,
    [rule.id, now, shown?.reason ?? 'not_collected', shown ? `${SPIKE_REASON_TEXT[shown.reason]} · ${shown.observed} in window, threshold ${shown.threshold}${shown.dataset === 'simulated' ? ' (simulated)' : ''}` : SPIKE_REASON_TEXT.not_collected]);
  return out;
}

async function evaluateDataset(rule: RuleRow, search: SearchRow, dataset: 'live' | 'simulated', now: Date): Promise<EvaluationResult> {
  const db = getPool();
  const w = rule.window_minutes * 60_000;
  const start = windowStart(now, rule.window_minutes);
  const sim = dataset === 'simulated';
  const base = { ruleId: rule.id, dataset, alertId: null };
  const since = await monitoredSince(rule.workspace_id, rule.brand_id, dataset, search.sources, db);
  if (!since) return { ...base, reason: 'not_collected', observed: 0, threshold: rule.min_sample };
  const observed = (await one<{ n: number }>(db, `SELECT count(*)::int AS n ${COUNTED} AND lm.occurred_at >= $4 AND lm.occurred_at < $5`,
    [search.id, sim, rule.metric, start, new Date(start.getTime() + w)])).n;
  // Baseline: complete windows inside [now - baseline_days, start) that began after monitoring started.
  const earliest = Math.max(start.getTime() - rule.baseline_days * 86_400_000, Math.ceil(since.getTime() / w) * w);
  const counts = await many<{ k: number; n: number }>(db,
    `SELECT floor(extract(epoch FROM lm.occurred_at) * 1000 / $6)::bigint AS k, count(*)::int AS n ${COUNTED} AND lm.occurred_at >= $4 AND lm.occurred_at < $5 GROUP BY 1`,
    [search.id, sim, rule.metric, new Date(earliest), start, w]);
  const baseline: number[] = [];
  for (let t = earliest; t + w <= start.getTime(); t += w) baseline.push(counts.find((c) => Number(c.k) === Math.floor(t / w))?.n ?? 0);
  const res = evaluateSpike({ observed, baseline, minSample: rule.min_sample, multiplier: rule.multiplier, minBaselineWindows: rule.min_baseline_windows });
  if (!res.fire) return { ...base, reason: res.reason, observed, threshold: res.threshold };

  const dedupeKey = `${rule.id}:${dataset}:${start.toISOString()}`;
  const fired = await withTx(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`listening-rule:${rule.id}`]);
    if (await maybeOne(tx, `SELECT 1 FROM listening_alerts WHERE workspace_id=$1 AND dedupe_key=$2`, [rule.workspace_id, dedupeKey])) return { reason: 'already_alerted' as const, id: null };
    const last = await maybeOne<{ created_at: Date }>(tx, `SELECT created_at FROM listening_alerts WHERE rule_id=$1 AND is_simulated=$2 ORDER BY created_at DESC LIMIT 1`, [rule.id, sim]);
    if (last && last.created_at.getTime() > now.getTime() - rule.cooldown_minutes * 60_000) return { reason: 'cooldown' as const, id: null };
    const ids = await many<{ id: string }>(tx, `SELECT o.id ${COUNTED} AND lm.occurred_at >= $4 AND lm.occurred_at < $5 ORDER BY lm.occurred_at DESC LIMIT ${EVIDENCE_CAP}`,
      [search.id, sim, rule.metric, start, new Date(start.getTime() + w)]);
    const coverage = await buildCoverage({ workspaceId: rule.workspace_id, brandIds: [rule.brand_id], dataset, sources: search.sources, kinds: search.kinds, from: start, to: now,
      queryVersion: search.version, sample: { observations: observed, unique: observed, duplicates_collapsed: 0, removed_at_source: 0 } }, tx);
    const a = await one<{ id: string }>(tx,
      `INSERT INTO listening_alerts(workspace_id, brand_id, rule_id, search_id, query_version, metric, window_start, window_end, observed, baseline_mean, baseline_stddev, baseline_windows,
                                    threshold, min_sample, coverage, is_simulated, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
      [rule.workspace_id, rule.brand_id, rule.id, search.id, search.version, rule.metric, start, new Date(start.getTime() + w), observed, res.mean, res.stddev, res.windows,
        res.threshold, rule.min_sample, JSON.stringify(coverage), sim, dedupeKey]);
    if (ids.length) await tx.query(`INSERT INTO listening_alert_evidence(alert_id, observation_id, workspace_id) SELECT $1, unnest($2::uuid[]), $3`, [a.id, ids.map((x) => x.id), rule.workspace_id]);
    for (const userId of rule.recipients) {
      await deliverNotification(tx, {
        workspaceId: rule.workspace_id, userId, event: 'account_health', severity: 'warning', kind: 'listening.alert',
        title: `${rule.metric === 'negative' ? 'Negative mention' : 'Mention'} spike: ${search.name}${sim ? ' (simulated)' : ''}`,
        body: `${observed} in ${rule.window_minutes} min (usual ${res.mean}).`, referenceType: 'listening_alert', referenceId: a.id, dedupeKey: `listening-alert:${a.id}`,
        requirement: { brandId: rule.brand_id, permission: LISTENING_READ }, linkPath: `/listening/alerts/${a.id}`,
      });
    }
    await writeOutbox(tx, { workspaceId: rule.workspace_id, aggregateType: 'listening_alert', aggregateId: a.id, eventType: 'listening.alert_fired', payload: { ruleId: rule.id, searchId: search.id, brandId: rule.brand_id, simulated: sim, origin: { kind: 'system', id: null } } });
    await audit(tx, { workspaceId: rule.workspace_id, brandId: rule.brand_id, actorService: 'listening', action: 'listening.alert_fired', resourceType: 'listening_alert', resourceId: a.id, diff: { observed, threshold: res.threshold, baseline_mean: res.mean, simulated: sim } });
    return { reason: 'fired' as const, id: a.id };
  });
  if (fired.id) log.info('listening_alert_fired', { ruleId: rule.id, alertId: fired.id, observed });
  return { ...base, reason: fired.reason, observed, threshold: res.threshold, alertId: fired.id };
}

/** After ingest: rules on the matched searches (throttled per rule; the sweep catches up). */
export async function evaluateRulesForSearches(workspaceId: string, searchIds: string[]): Promise<void> {
  const rules = await many<{ id: string }>(getPool(),
    `SELECT id FROM listening_alert_rules WHERE workspace_id=$1 AND search_id = ANY($2::uuid[]) AND enabled AND archived_at IS NULL
        AND (last_evaluated_at IS NULL OR last_evaluated_at < now() - interval '3 seconds')`, [workspaceId, searchIds]);
  for (const r of rules) await evaluateRule(r.id);
}

/** Every 5 minutes per rule, and sooner when its search matched something since the last evaluation (throttled bursts). */
export async function sweepAlertRules(limit = 100): Promise<number> {
  const rules = await many<{ id: string }>(getPool(),
    `SELECT r.id FROM listening_alert_rules r WHERE r.enabled AND r.archived_at IS NULL
        AND (r.last_evaluated_at IS NULL OR r.last_evaluated_at < now() - interval '5 minutes'
             OR EXISTS (SELECT 1 FROM listening_matches lm WHERE lm.search_id = r.search_id AND lm.matched_at > r.last_evaluated_at))
      ORDER BY r.last_evaluated_at NULLS FIRST LIMIT $1`, [limit]);
  for (const r of rules) {
    try { await evaluateRule(r.id); } catch (err) { log.error('listening_rule_eval_failed', { ruleId: r.id, err: err as Error }); }
  }
  return rules.length;
}

// ------------------------------------------------------------------ alert reads
interface AlertRow {
  id: string; workspace_id: string; brand_id: string; rule_id: string; search_id: string; query_version: number; metric: 'volume' | 'negative'; window_start: Date; window_end: Date;
  observed: number; baseline_mean: number; baseline_stddev: number; baseline_windows: number; threshold: number; min_sample: number; coverage: ListeningCoverage; is_simulated: boolean;
  state: AlertDto['state']; acknowledged_by: string | null; acknowledged_at: Date | null; created_at: Date;
  rule_name: string; search_name: string; baseline_days: number; ev_total: number; ev_removed: number; ack_name: string | null;
}
const ALERT_SELECT = `a.*, r.name AS rule_name, r.baseline_days, s.name AS search_name, u.name AS ack_name,
  (SELECT count(*)::int FROM listening_alert_evidence e WHERE e.alert_id = a.id) AS ev_total,
  (SELECT count(*)::int FROM listening_alert_evidence e JOIN listening_observations o ON o.id = e.observation_id WHERE e.alert_id = a.id AND (o.removed_at IS NOT NULL OR o.excluded_at IS NOT NULL)) AS ev_removed
  FROM listening_alerts a JOIN listening_alert_rules r ON r.id = a.rule_id JOIN listening_searches s ON s.id = a.search_id LEFT JOIN users u ON u.id = a.acknowledged_by`;

function alertDto(a: AlertRow): AlertDto {
  return {
    id: a.id, rule: { id: a.rule_id, name: a.rule_name, metric: a.metric }, search: { id: a.search_id, name: a.search_name, version_at_fire: a.query_version }, brand_id: a.brand_id,
    window: { from: a.window_start.toISOString(), to: a.window_end.toISOString(), minutes: Math.round((a.window_end.getTime() - a.window_start.getTime()) / 60_000) },
    observed: a.observed, baseline: { mean: a.baseline_mean, stddev: a.baseline_stddev, windows: a.baseline_windows, days: a.baseline_days }, threshold: a.threshold, min_sample: a.min_sample,
    state: a.state, coverage: a.coverage, evidence: { total: a.ev_total, available: a.ev_total - a.ev_removed, removed_at_source: a.ev_removed },
    created_at: a.created_at.toISOString(), acknowledged: a.acknowledged_at ? { by: a.ack_name, at: a.acknowledged_at.toISOString() } : null,
  };
}

export async function listAlerts(ctx: Ctx, q: { brand_id?: string | null; state?: string | null; search_id?: string | null; limit?: unknown } = {}): Promise<{ items: Array<AlertDto & { is_simulated: boolean }> }> {
  const brands = await listeningBrands(ctx, q.brand_id);
  const params: unknown[] = [ctx.access.workspaceId, brands];
  let where = '';
  if (q.state && ['open', 'acknowledged', 'dismissed'].includes(q.state)) { params.push(q.state); where += ` AND a.state=$${params.length}`; }
  if (q.search_id) { assertUuid(q.search_id, 'Saved search'); params.push(q.search_id); where += ` AND a.search_id=$${params.length}`; }
  const limit = Math.min(100, Math.max(1, Number(q.limit ?? 50) || 50));
  const rows = await many<AlertRow>(getPool(), `SELECT ${ALERT_SELECT} WHERE a.workspace_id=$1 AND a.brand_id = ANY($2::uuid[]) ${where} ORDER BY a.created_at DESC LIMIT ${limit}`, params);
  return { items: rows.map((r) => ({ ...alertDto(r), is_simulated: r.is_simulated })) };
}

async function loadAlert(ctx: Ctx, id: string, db: Queryable = getPool()): Promise<AlertRow> {
  assertUuid(id, 'Alert');
  const a = await maybeOne<AlertRow>(db, `SELECT ${ALERT_SELECT} WHERE a.id=$1 AND a.workspace_id=$2`, [id, ctx.access.workspaceId]);
  if (!a || !canListen(ctx, a.brand_id)) throw notFound('Alert');
  return a;
}

/** Alert with its evidence: the real observations counted (removed ones appear as "removed at source"). */
export async function getAlert(ctx: Ctx, id: string): Promise<AlertDto & { is_simulated: boolean; mentions: ObservationDto[]; actions: Array<{ action: string; target_id: string; at: string }> }> {
  const a = await loadAlert(ctx, id);
  const rows = await many<Parameters<typeof observationDto>[0]>(getPool(),
    `SELECT ${MENTION_SELECT} FROM listening_alert_evidence e JOIN listening_observations o ON o.id = e.observation_id ${MENTION_JOINS} WHERE e.alert_id=$1 ORDER BY o.occurred_at DESC LIMIT 200`, [id]);
  const actions = await many<{ action: string; target_id: string; created_at: Date }>(getPool(), `SELECT action, target_id, created_at FROM listening_insight_actions WHERE alert_id=$1 ORDER BY created_at`, [id]);
  return { ...alertDto(a), is_simulated: a.is_simulated, mentions: rows.map(observationDto), actions: actions.map((x) => ({ action: x.action, target_id: x.target_id, at: x.created_at.toISOString() })) };
}

export async function setAlertState(ctx: Ctx, id: string, state: 'acknowledged' | 'dismissed' | 'open'): Promise<AlertDto> {
  await withTx(async (tx) => {
    const a = await loadAlert(ctx, id, tx);
    await tx.query(`UPDATE listening_alerts SET state=$2, acknowledged_by=CASE WHEN $2='open' THEN NULL ELSE $3::uuid END, acknowledged_at=CASE WHEN $2='open' THEN NULL ELSE now() END WHERE id=$1`, [id, state, ctx.actor.userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: a.brand_id, actorUserId: ctx.actor.userId, action: `listening.alert_${state}`, resourceType: 'listening_alert', resourceId: id, correlationId: ctx.correlationId });
  });
  return alertDto(await loadAlert(ctx, id));
}
