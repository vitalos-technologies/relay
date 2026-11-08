// Rule builder (brief §18): trigger → conditions → actions, scope, schedule/business hours, limits, test preview,
// enable/disable and execution history. Every rule runs under one automation policy and can never exceed it.
// automation.manage for everything here (sensitive permission ⇒ MFA where the workspace requires it).
import { z } from 'zod';
import { AppError, notFound } from '@social-lite/core';
import { MESSAGE_CATEGORIES } from '@social-lite/core/contracts/v35-ai';
import {
  AUTOMATION_ACTIONS, AUTOMATION_TRIGGERS, CONDITION_FIELDS, CONDITION_OPS, CUSTOMER_FACING_ACTIONS, TRIGGER_ACTIONS, TRIGGER_INTEGRATION_KINDS, type AutomationCatalogDto, type AutomationRuleDto, type AutomationRunDto,
  type RuleAction, type RuleTestResult, type RunActionResult,
} from '@social-lite/core/contracts/v35-automation';
import { CONVERSATION_KINDS, PRIORITIES } from '@social-lite/core/contracts/v35-inbox';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { loadUserAuthz } from '../authz.js';
import { staffAllowed } from '../collab/access.js';
import { syncExecutor } from '../connectors/registry.js';
// Stream C: registers the integration executors (asana/monday/hubspot/slack kinds) in this process (web + worker).
import '../integrations-v35/index.js';
import { assertUuid, requireAction } from '../tenancy.js';
import { classifyText } from '../assistant/classify.js';
import { listeningSourcesAvailable } from '../assistant/retrieval.js';
import { conditionError, evaluateConditions } from './conditions.js';
import { replyBlocker, type RuleRow } from './engine.js';
import { emergencyStopState, loadPolicy, type PolicyRow } from './policies.js';

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('assign'), assignee_id: z.string().uuid().nullable().optional(), team_id: z.string().uuid().nullable().optional() }).strict(),
  z.object({ type: z.literal('set_priority'), priority: z.enum(PRIORITIES) }).strict(),
  z.object({ type: z.literal('add_labels'), labels: z.array(z.string().trim().min(1).max(40)).min(1).max(10) }).strict(),
  z.object({ type: z.literal('add_note'), body: z.string().trim().min(1).max(1000) }).strict(),
  z.object({ type: z.literal('create_case'), title: z.string().trim().max(200).nullable().optional() }).strict(),
  z.object({ type: z.literal('notify'), to: z.enum(['assignee', 'case_owner', 'users']), user_ids: z.array(z.string().uuid()).max(20).optional() }).strict(),
  z.object({ type: z.literal('escalate'), team_id: z.string().uuid().nullable().optional(), assignee_id: z.string().uuid().nullable().optional(), reason: z.string().trim().max(200).nullable().optional() }).strict(),
  z.object({ type: z.literal('reply_saved'), saved_reply_id: z.string().uuid(), mode: z.enum(['public_reply', 'private_message']) }).strict(),
  z.object({ type: z.literal('reply_ai'), mode: z.enum(['public_reply', 'private_message']) }).strict(),
  z.object({ type: z.literal('integration_job'), integration_id: z.string().uuid(), kind: z.string().regex(/^[a-z_]+\.[a-z_]+$/).max(80) }).strict(),
]);

export const ruleSchema = z.object({
  policy_id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  trigger: z.enum(AUTOMATION_TRIGGERS),
  trigger_params: z.object({ minutes_before: z.number().int().min(5).max(1440).optional() }).strict().optional(),
  conditions: z.array(z.object({ field: z.enum(CONDITION_FIELDS), op: z.enum(CONDITION_OPS), value: z.union([z.array(z.string()), z.boolean(), z.number()]) }).strict()).max(20),
  actions: z.array(actionSchema).min(1).max(10),
  scope: z.object({ brand_ids: z.array(z.string().uuid()).min(1).max(50), channel_ids: z.array(z.string().uuid()).max(200) }).strict(),
  schedule: z.object({ mode: z.enum(['always', 'business_hours', 'outside_business_hours']), sla_policy_id: z.string().uuid().nullable().optional() }).strict().optional(),
  limits: z.object({ max_per_hour: z.number().int().min(1).max(1000), per_conversation_cooldown_minutes: z.number().int().min(0).max(10_080) }).strict().optional(),
  enabled: z.boolean().optional(),
  position: z.number().int().min(0).max(1000).optional(),
}).strict();
export type RuleInput = z.infer<typeof ruleSchema>;

/** Integration actions Relay knows how to request (stream C registers the executors). */
export const INTEGRATION_ACTIONS: Record<string, { kind: string; label: string }> = {
  slack: { kind: 'slack.post_message', label: 'Post to Slack channel' },
  asana: { kind: 'asana.create_task', label: 'Create Asana task' },
  monday: { kind: 'monday.create_item', label: 'Create monday.com item' },
  // mailchimp.create_campaign_draft: deliberately not offered (drafts are made from approved posts in Relay; no executor).
  hubspot: { kind: 'hubspot.create_ticket', label: 'Create HubSpot ticket' },
};

function triggerAvailability(t: string): string | null {
  if (t === 'listening.alert') return listeningSourcesAvailable() ? null : 'Needs Listening alerts.';
  return null;
}

async function validateRule(ctx: Ctx, input: RuleInput, p: PolicyRow, db: Queryable): Promise<void> {
  const err = (field: string, msg: string): never => { throw new AppError('validation_failed', msg, { [field]: msg }); };
  const t = triggerAvailability(input.trigger);
  if (t && input.enabled) err('trigger', t);
  if (input.scope.brand_ids.some((b) => !p.brand_ids.includes(b))) err('scope.brand_ids', 'Brands must be covered by the policy.');
  if (input.scope.channel_ids.some((c) => !p.channel_ids.includes(c))) err('scope.channel_ids', 'Channels must be covered by the policy.');
  for (const c of input.conditions) { const e = conditionError(input.trigger, c); if (e) err('conditions', e); }
  for (const a of input.actions) {
    if (!p.allowed_actions.includes(a.type)) err('actions', `The policy does not allow “${a.type}”.`);
    if (!TRIGGER_ACTIONS[input.trigger].includes(a.type)) err('actions', `“${a.type}” is not available for this trigger.`);
    if (a.type === 'notify' && (input.trigger === 'listening.alert' || input.trigger === 'content.approved') && (a.to !== 'users' || !a.user_ids?.length)) err('actions', 'Choose who to notify.');
    if (a.type === 'integration_job' && !TRIGGER_INTEGRATION_KINDS[input.trigger].includes(a.kind)) err('actions', 'This integration action does not apply to this trigger.');
    if (CUSTOMER_FACING_ACTIONS.includes(a.type) && input.trigger !== 'inbox.message_received') err('actions', 'Automatic replies only answer new customer messages.');
    const people = a.type === 'assign' || a.type === 'escalate' ? [a.assignee_id] : a.type === 'notify' ? (a.user_ids ?? []) : [];
    for (const u of people.filter((x): x is string => !!x)) {
      const s = await loadUserAuthz(u, ctx.access.workspaceId, null, db);
      const perm = input.trigger === 'listening.alert' ? 'listening.read' : input.trigger === 'content.approved' ? 'content.read' : 'inbox.read';
      if (s.subject.status !== 'active' || !input.scope.brand_ids.every((b) => staffAllowed(s, perm, b))) err('actions', perm === 'inbox.read' ? 'Choose people with inbox access on every brand in scope.' : 'Choose people who can see this on every brand in scope.');
    }
    if ((a.type === 'assign' || a.type === 'escalate') && a.team_id && !(await maybeOne(db, `SELECT 1 FROM teams WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL`, [a.team_id, ctx.access.workspaceId]))) err('actions', 'Unknown team.');
    if (a.type === 'reply_saved' && !(await maybeOne(db, `SELECT 1 FROM inbox_saved_replies WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL AND (brand_id IS NULL OR brand_id = ANY($3::uuid[]))`, [a.saved_reply_id, ctx.access.workspaceId, input.scope.brand_ids]))) err('actions', 'Choose a saved reply for these brands.');
    if (a.type === 'integration_job') {
      const i = await maybeOne<{ connector: string }>(db, `SELECT connector FROM integration_connections WHERE id=$1 AND workspace_id=$2 AND disconnected_at IS NULL`, [a.integration_id, ctx.access.workspaceId]);
      if (!i || !a.kind.startsWith(`${i.connector}.`)) err('actions', 'Choose a connected integration.');
      if (input.enabled && !syncExecutor(a.kind)) err('actions', 'This integration action is not available yet.');
    }
  }
  if (input.schedule?.sla_policy_id && !(await maybeOne(db, `SELECT 1 FROM care_sla_policies WHERE id=$1 AND workspace_id=$2`, [input.schedule.sla_policy_id, ctx.access.workspaceId]))) err('schedule.sla_policy_id', 'Unknown service-level policy.');
}

async function ruleDto(db: Queryable, r: RuleRow): Promise<AutomationRuleDto> {
  const s = await one<{ last: Date | null; n: string }>(db, `SELECT max(created_at) AS last, count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS n FROM automation_runs WHERE rule_id=$1 AND NOT is_test`, [r.id]);
  return {
    id: r.id, policy_id: r.policy_id, name: r.name, trigger: r.trigger, trigger_params: r.trigger_params ?? {}, conditions: r.conditions, actions: r.actions, scope: r.scope,
    schedule: r.schedule, limits: r.limits, enabled: r.enabled, position: r.position, version: r.version, last_run_at: s.last?.toISOString() ?? null, runs_24h: Number(s.n),
    created_at: r.created_at.toISOString(), updated_at: r.updated_at.toISOString(),
  };
}

async function loadRule(ctx: Ctx, id: string, db: Queryable = getPool(), lock = false): Promise<RuleRow> {
  assertUuid(id, 'Rule');
  requireAction(ctx, 'automation.manage');
  const r = await maybeOne<RuleRow>(db, `SELECT * FROM automation_rules WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [id, ctx.access.workspaceId]);
  if (!r) throw notFound('Rule');
  return r;
}

export async function listRules(ctx: Ctx, q: { policy_id?: string | null } = {}): Promise<{ items: AutomationRuleDto[] }> {
  requireAction(ctx, 'automation.manage');
  const rows = await many<RuleRow>(getPool(), `SELECT * FROM automation_rules WHERE workspace_id=$1 AND deleted_at IS NULL ${q.policy_id ? 'AND policy_id=$2' : ''} ORDER BY position, created_at LIMIT 200`,
    q.policy_id ? [ctx.access.workspaceId, q.policy_id] : [ctx.access.workspaceId]);
  const out: AutomationRuleDto[] = [];
  for (const r of rows) out.push(await ruleDto(getPool(), r));
  return { items: out };
}

export async function getRule(ctx: Ctx, id: string): Promise<AutomationRuleDto> {
  return ruleDto(getPool(), await loadRule(ctx, id));
}

const DEFAULT_LIMITS = { max_per_hour: 30, per_conversation_cooldown_minutes: 60 };

export async function createRule(ctx: Ctx, raw: unknown): Promise<AutomationRuleDto> {
  requireAction(ctx, 'automation.manage');
  const input = ruleSchema.parse(raw);
  const r = await withTx(async (tx) => {
    const p = await loadPolicy(ctx, input.policy_id, tx);
    await validateRule(ctx, input, p, tx);
    const row = await one<RuleRow>(tx,
      `INSERT INTO automation_rules(workspace_id, policy_id, name, trigger, trigger_params, conditions, actions, scope, schedule, limits, enabled, position, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING *`,
      [ctx.access.workspaceId, p.id, input.name, input.trigger, JSON.stringify(input.trigger_params ?? {}), JSON.stringify(input.conditions), JSON.stringify(input.actions),
        JSON.stringify(input.scope), JSON.stringify(input.schedule ?? { mode: 'always' }), JSON.stringify(input.limits ?? DEFAULT_LIMITS), input.enabled ?? false, input.position ?? 0, ctx.actor.userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'automation.rule_created', resourceType: 'automation_rule', resourceId: row.id,
      diff: { policy_id: p.id, trigger: input.trigger, actions: input.actions.map((a) => a.type), enabled: row.enabled }, correlationId: ctx.correlationId });
    return row;
  });
  return ruleDto(getPool(), r);
}

export async function updateRule(ctx: Ctx, id: string, raw: unknown, expectedVersion?: number | null): Promise<AutomationRuleDto> {
  const input = ruleSchema.parse(raw);
  const r = await withTx(async (tx) => {
    const cur = await loadRule(ctx, id, tx, true);
    if (expectedVersion && expectedVersion !== cur.version) throw new AppError('version_conflict', 'Someone else changed this rule. Reload and try again.');
    const p = await loadPolicy(ctx, input.policy_id, tx);
    await validateRule(ctx, input, p, tx);
    const row = await one<RuleRow>(tx,
      `UPDATE automation_rules SET policy_id=$2, name=$3, trigger=$4, trigger_params=$5, conditions=$6, actions=$7, scope=$8, schedule=$9, limits=$10, enabled=$11, position=$12,
         version=version+1, updated_by=$13, updated_at=now() WHERE id=$1 RETURNING *`,
      [id, p.id, input.name, input.trigger, JSON.stringify(input.trigger_params ?? {}), JSON.stringify(input.conditions), JSON.stringify(input.actions), JSON.stringify(input.scope),
        JSON.stringify(input.schedule ?? { mode: 'always' }), JSON.stringify(input.limits ?? DEFAULT_LIMITS), input.enabled ?? cur.enabled, input.position ?? cur.position, ctx.actor.userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'automation.rule_updated', resourceType: 'automation_rule', resourceId: id,
      diff: { version: row.version, enabled: row.enabled }, correlationId: ctx.correlationId });
    return row;
  });
  return ruleDto(getPool(), r);
}

export async function setRuleEnabled(ctx: Ctx, id: string, enabled: boolean): Promise<AutomationRuleDto> {
  const cur = await loadRule(ctx, id);
  const { id: _i, version: _v, last_run_at: _l, runs_24h: _n, created_at: _c, updated_at: _u, ...rest } = await ruleDto(getPool(), cur);
  return updateRule(ctx, id, { ...rest, enabled }, cur.version);
}

export async function deleteRule(ctx: Ctx, id: string): Promise<void> {
  const cur = await loadRule(ctx, id);
  await getPool().query(`UPDATE automation_rules SET deleted_at=now(), enabled=false, updated_by=$2, updated_at=now() WHERE id=$1`, [id, ctx.actor.userId]);
  await audit(getPool(), { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'automation.rule_deleted', resourceType: 'automation_rule', resourceId: id, diff: { name: cur.name }, correlationId: ctx.correlationId });
}

// ------------------------------------------------------------------ test preview (dry run — changes nothing)
function wouldRun(p: PolicyRow, a: RuleAction, classification: ReturnType<typeof classifyText> | null, text: string | null): RunActionResult {
  if (!p.allowed_actions.includes(a.type)) return { type: a.type, status: 'blocked', detail: 'Not allowed by the policy.', refs: {} };
  if (a.type === 'reply_saved' || a.type === 'reply_ai') {
    const why = replyBlocker(p, classification ? { ...classification, conversation_id: '', message_id: '', created_at: '' } : null, text);
    if (why) return { type: a.type, status: 'blocked', detail: `Would escalate instead: ${why}`, refs: {} };
    return { type: a.type, status: 'would_run', detail: a.type === 'reply_ai' ? 'Would draft from approved knowledge and send only if every check passes.' : 'Would send the saved reply.', refs: {} };
  }
  if (a.type === 'integration_job' && !syncExecutor(a.kind)) return { type: a.type, status: 'blocked', detail: 'This integration action is not available yet.', refs: {} };
  return { type: a.type, status: 'would_run', detail: 'Would run.', refs: {} };
}

/** Evaluate a (possibly unsaved) rule against recent data in scope. Nothing is changed, sent or recorded. */
export async function testRule(ctx: Ctx, raw: unknown): Promise<RuleTestResult> {
  requireAction(ctx, 'automation.manage');
  const input = ruleSchema.parse(raw);
  const db = getPool();
  const p = await loadPolicy(ctx, input.policy_id, db);
  await validateRule(ctx, { ...input, enabled: false }, p, db);
  const samples: RuleTestResult['samples'] = [];
  if (input.trigger === 'inbox.message_received') {
    const channels = input.scope.channel_ids.length ? input.scope.channel_ids : p.channel_ids;
    const rows = await many<{ id: string; kind: string; priority: string; assignee_id: string | null; labels: string[]; channel_kind: string; body: string | null; inbound: string }>(db,
      `SELECT c.id, c.kind, c.priority, c.assignee_id, c.labels, ch.kind AS channel_kind,
              (SELECT body FROM inbox_messages m WHERE m.conversation_id=c.id AND m.direction='inbound' AND m.deleted_at IS NULL ORDER BY provider_created_at DESC LIMIT 1) AS body,
              (SELECT count(*) FROM inbox_messages m WHERE m.conversation_id=c.id AND m.direction='inbound') AS inbound
         FROM inbox_conversations c JOIN inbox_channels ch ON ch.id=c.channel_id
        WHERE c.workspace_id=$1 AND c.brand_id = ANY($2::uuid[]) AND c.channel_id = ANY($3::uuid[]) AND c.status <> 'spam' ORDER BY c.last_message_at DESC LIMIT 25`,
      [ctx.access.workspaceId, input.scope.brand_ids, channels]);
    for (const r of rows) {
      if (!r.body) continue;
      const cl = classifyText(r.body);
      const ev = evaluateConditions(input.conditions, { channel_kind: r.channel_kind, conversation_kind: r.kind, category: cl.category, sentiment: cl.sentiment, language: cl.language, urgency: cl.urgency,
        priority: r.priority, assigned: !!r.assignee_id, text: r.body, first_message: Number(r.inbound) <= 1, labels: r.labels });
      samples.push({ conversation_id: r.id, matched: ev.matched, category: cl.category, conditions: ev.results, actions: ev.matched ? input.actions.map((a) => wouldRun(p, a, cl, r.body)) : [] });
    }
  } else if (input.trigger === 'case.sla_nearing' || input.trigger === 'case.changed') {
    const rows = await many<{ id: string; priority: string; owner_id: string | null; conv: string | null; due: Date | null }>(db,
      `SELECT k.id, k.priority, k.owner_id, (SELECT id FROM inbox_conversations WHERE case_id=k.id LIMIT 1) AS conv, least(k.first_response_due_at, k.resolution_due_at) AS due
         FROM care_cases k WHERE k.workspace_id=$1 AND k.brand_id = ANY($2::uuid[]) AND k.state IN ('open','reopened') ORDER BY k.opened_at DESC LIMIT 25`, [ctx.access.workspaceId, input.scope.brand_ids]);
    for (const r of rows) {
      const mins = r.due ? Math.round((r.due.getTime() - Date.now()) / 60_000) : null;
      const ev = evaluateConditions(input.conditions, { priority: r.priority, assigned: !!r.owner_id, minutes_to_deadline: mins, case_change: 'created' });
      const nearing = input.trigger !== 'case.sla_nearing' || (mins !== null && mins >= 0 && mins <= (input.trigger_params?.minutes_before ?? 60));
      const matched = ev.matched && nearing;
      samples.push({ conversation_id: r.conv ?? r.id, matched, category: 'other', conditions: ev.results, actions: matched ? input.actions.map((a) => wouldRun(p, a, null, null)) : [] });
    }
  } else {
    // listening.alert / content.approved have no conditions: every recent alert/approval in scope would run the actions.
    const rows = input.trigger === 'listening.alert'
      ? await many<{ id: string }>(db, `SELECT id FROM listening_alerts WHERE workspace_id=$1 AND brand_id = ANY($2::uuid[]) ORDER BY created_at DESC LIMIT 10`, [ctx.access.workspaceId, input.scope.brand_ids])
      : await many<{ id: string }>(db, `SELECT post_id AS id FROM approvals WHERE workspace_id=$1 AND brand_id = ANY($2::uuid[]) AND decision='approved' ORDER BY decided_at DESC NULLS LAST LIMIT 10`, [ctx.access.workspaceId, input.scope.brand_ids]);
    for (const r of rows) samples.push({ conversation_id: r.id, matched: true, category: 'other', conditions: [], actions: input.actions.map((a) => wouldRun(p, a, null, null)) });
  }
  return { evaluated: samples.length, matched: samples.filter((s) => s.matched).length, samples: samples.slice(0, 25) };
}

// ------------------------------------------------------------------ history + catalog
interface RunRow { id: string; rule_id: string | null; rule_name: string | null; policy_id: string | null; trigger: AutomationRunDto['trigger']; subject_type: AutomationRunDto['subject']['type']; subject_id: string; outcome: AutomationRunDto['outcome']; reason: string | null; conditions: AutomationRunDto['conditions']; actions: RunActionResult[]; is_test: boolean; created_at: Date; finished_at: Date | null }

export async function listAutomationRuns(ctx: Ctx, q: { rule_id?: string | null; subject_id?: string | null; limit?: number | string | null } = {}): Promise<{ items: AutomationRunDto[] }> {
  requireAction(ctx, 'automation.manage');
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const params: unknown[] = [ctx.access.workspaceId, limit];
  const where: string[] = [];
  if (q.rule_id) { assertUuid(q.rule_id, 'Rule'); params.push(q.rule_id); where.push(`ar.rule_id=$${params.length}`); }
  if (q.subject_id) { assertUuid(q.subject_id, 'Subject'); params.push(q.subject_id); where.push(`ar.subject_id=$${params.length}`); }
  const rows = await many<RunRow>(getPool(),
    `SELECT ar.*, r.name AS rule_name FROM automation_runs ar LEFT JOIN automation_rules r ON r.id=ar.rule_id WHERE ar.workspace_id=$1 ${where.map((w) => `AND ${w}`).join(' ')}
      ORDER BY ar.created_at DESC LIMIT $2`, params);
  return { items: rows.map((r) => ({ id: r.id, rule: r.rule_id ? { id: r.rule_id, name: r.rule_name ?? 'Deleted rule' } : null, policy_id: r.policy_id, trigger: r.trigger,
    subject: { type: r.subject_type, id: r.subject_id }, outcome: r.outcome, reason: r.reason, conditions: r.conditions, actions: r.actions, is_test: r.is_test,
    created_at: r.created_at.toISOString(), finished_at: r.finished_at?.toISOString() ?? null })) };
}

export async function automationCatalog(ctx: Ctx): Promise<AutomationCatalogDto> {
  requireAction(ctx, 'automation.manage');
  const db = getPool();
  const channels = await many<{ id: string; brand_id: string; kind: AutomationCatalogDto['channels'][number]['kind']; display_name: string; is_simulated: boolean }>(db,
    `SELECT id, brand_id, kind, display_name, is_simulated FROM inbox_channels WHERE workspace_id=$1 AND disconnected_at IS NULL ORDER BY display_name LIMIT 200`, [ctx.access.workspaceId]);
  const integ = await many<{ id: string; connector: string; display_name: string; status: string; paused: boolean }>(db,
    `SELECT id, connector, display_name, status, paused FROM integration_connections WHERE workspace_id=$1 AND disconnected_at IS NULL ORDER BY connector LIMIT 100`, [ctx.access.workspaceId]).catch(() => []);
  const integrationJobs = integ.flatMap((i) => {
    const a = INTEGRATION_ACTIONS[i.connector];
    // Kinds without an executor in this process are hidden, not offered (Mailchimp drafts are made from approved posts).
    if (!a || !syncExecutor(a.kind)) return [];
    const reason = !syncExecutor(a.kind) ? 'Not available yet.' : i.paused ? 'Paused.' : i.status !== 'active' ? 'Needs attention.' : null;
    return [{ integration_id: i.id, connector: i.connector, display_name: `${a.label} · ${i.display_name}`, kind: a.kind, available: !reason, reason }];
  });
  return {
    triggers: AUTOMATION_TRIGGERS.map((t) => ({ trigger: t, available: !triggerAvailability(t), reason: triggerAvailability(t) })),
    actions: AUTOMATION_ACTIONS.map((t) => ({
      type: t, customer_facing: CUSTOMER_FACING_ACTIONS.includes(t),
      available: t === 'integration_job' ? integrationJobs.some((j) => j.available) : true,
      reason: t === 'integration_job' && !integrationJobs.some((j) => j.available) ? (integrationJobs.length ? 'Needs attention.' : 'Connect an integration first.') : null,
    })),
    integration_jobs: integrationJobs, channels, conversation_kinds: CONVERSATION_KINDS, categories: MESSAGE_CATEGORIES,
    emergency_stop: await emergencyStopState(ctx.access.workspaceId, db),
  };
}
