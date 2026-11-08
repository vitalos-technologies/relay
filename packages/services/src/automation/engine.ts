// Rule engine (brief §17–18). For each event:
//   classification (inbound messages) → enabled rules for the trigger whose ACTIVE policy covers the brand + channel →
//   conditions → one run per (rule, event) [UNIQUE index: repeated delivery never runs twice] → policy re-check (status,
//   expiry, emergency stop) → schedule → limits (rule/hour, conversation cooldown, policy actions/hour, replies/day) →
//   escalation checks → actions through the normal domain services as the policy's service actor, inside
//   withOrigin({kind:'automation'}) so the events they cause never trigger rules again (loop prevention).
// Customer-facing replies: only categories the policy allows, never refund/complaint/sensitive, never when the
// classifier is uncertain, the message contains instruction-like text, sentiment/keyword escalation fires, or the
// daily cap is reached — and never on model confidence alone. Anything else escalates to a person.
import { AppError } from '@social-lite/core';
import { ALWAYS_ESCALATE, type ClassificationDto } from '@social-lite/core/contracts/v35-ai';
import type { AutomationRunDto, AutomationTrigger, RuleAction, RuleLimits, RuleSchedule, RuleScope, RunActionResult, RunOutcome } from '@social-lite/core/contracts/v35-automation';
import { businessMsBetween } from '@social-lite/core/contracts/v35-sla';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { log } from '../log.js';
import { addNote, assignConversation, updateConversation } from '../inbox/conversations.js';
import { requestReply } from '../inbox/replies.js';
import { calendarOf, createCase } from '../inbox/cases.js';
import { loadConversation, type ConversationRow } from '../inbox/shared.js';
import { deliverNotification } from '../collab/notifications.js';
import { enqueueSyncJob } from '../connectors/jobs.js';
import { syncExecutor } from '../connectors/registry.js';
import { queueAutomationRun } from '../assistant/runs.js';
import { classifyMessage } from '../assistant/classification.js';
import { withOrigin } from './origin.js';
import { policyCtx } from './actor.js';
import { emergencyStopState, escalationOf, policyActive, policyUsage, type PolicyRow } from './policies.js';
import { evaluateConditions, type Facts } from './conditions.js';

export interface RuleRow {
  id: string; workspace_id: string; policy_id: string; name: string; trigger: AutomationTrigger; trigger_params: { minutes_before?: number }; conditions: import('@social-lite/core/contracts/v35-automation').RuleCondition[];
  actions: RuleAction[]; scope: RuleScope; schedule: RuleSchedule; limits: RuleLimits; enabled: boolean; position: number; version: number; created_at: Date; updated_at: Date; deleted_at: Date | null;
}

export interface EngineEvent {
  workspaceId: string;
  trigger: AutomationTrigger;
  eventKey: string;
  subject: { type: 'conversation' | 'case'; id: string };
  brandId: string;
  channelId: string | null;
  conversationId: string | null;
  facts: Facts;
  classification: ClassificationDto | null;
  /** Conversation version when the event was evaluated (automatic replies send against it: any change ⇒ no send). */
  conversationVersion: number | null;
  /** The new customer message (keyword conditions/escalation only; never stored). */
  messageText?: string | null;
}

interface RunRow { id: string; workspace_id: string; rule_id: string | null; policy_id: string | null; outcome: RunOutcome; actions: RunActionResult[] }

// ------------------------------------------------------------------ helpers
async function inBusinessHours(db: Queryable, workspaceId: string, brandId: string, policyId: string | null | undefined, at = new Date()): Promise<boolean> {
  const p = await maybeOne<Parameters<typeof calendarOf>[0] & object>(db,
    policyId ? `SELECT * FROM care_sla_policies WHERE id=$1 AND workspace_id=$2` : `SELECT * FROM care_sla_policies WHERE workspace_id=$2 AND (brand_id=$1 OR brand_id IS NULL) AND is_default ORDER BY brand_id NULLS LAST LIMIT 1`,
    [policyId ?? brandId, workspaceId]);
  const cal = calendarOf(p ?? null);
  if (!cal.business_hours) return true;
  return businessMsBetween(at, new Date(at.getTime() + 60_000), cal) > 0;
}

/** Why a customer-facing automatic reply must not happen (null ⇒ eligible). Deterministic; no model confidence. */
export function replyBlocker(p: Pick<PolicyRow, 'reply_categories' | 'escalation'>, c: ClassificationDto | null, text: string | null): string | null {
  if (!c) return 'The message has not been classified.';
  const esc = escalationOf(p);
  if (c.injection_suspected) return 'The message contains instruction-like text.';
  if (ALWAYS_ESCALATE.includes(c.category) || esc.categories.includes(c.category)) return `“${c.category}” messages go to a person.`;
  if (c.uncertain) return 'The classification is uncertain.';
  if (!p.reply_categories.includes(c.category)) return `The policy does not allow automatic replies to “${c.category}” messages.`;
  if (esc.negative_sentiment && c.sentiment === 'negative') return 'The message reads as negative.';
  const lower = (text ?? '').toLowerCase();
  if (esc.keywords.some((k) => lower.includes(k.toLowerCase()))) return 'An escalation keyword matched.';
  return null;
}

/** Signal-level reasons a conversation needs a person (also used when no reply action is involved). */
function escalationReason(p: PolicyRow, c: ClassificationDto | null, text: string | null): string | null {
  if (!c) return null;
  const esc = escalationOf(p);
  if (esc.categories.includes(c.category)) return `“${c.category}” message`;
  if (esc.negative_sentiment && c.sentiment === 'negative') return 'negative message';
  const lower = (text ?? '').toLowerCase();
  if (esc.keywords.some((k) => lower.includes(k.toLowerCase()))) return 'escalation keyword';
  return null;
}

const done = (type: RuleAction['type'], detail: string, refs: Record<string, string> = {}): RunActionResult => ({ type, status: 'done', detail, refs });
const blocked = (type: RuleAction['type'], detail: string): RunActionResult => ({ type, status: 'blocked', detail, refs: {} });
const failed = (type: RuleAction['type'], err: unknown): RunActionResult => ({ type, status: 'failed', detail: err instanceof AppError ? err.message : 'Unexpected error.', refs: {} });

async function updateRun(db: Queryable, id: string, outcome: RunOutcome, reason: string | null, actions: RunActionResult[] | null, conditions?: AutomationRunDto['conditions']): Promise<void> {
  await db.query(`UPDATE automation_runs SET outcome=$2, reason=$3, actions=coalesce($4, actions), conditions=coalesce($5, conditions), finished_at=CASE WHEN $2='pending' THEN NULL ELSE now() END WHERE id=$1`,
    [id, outcome, reason?.slice(0, 300) ?? null, actions ? JSON.stringify(actions) : null, conditions ? JSON.stringify(conditions) : null]);
}

function outcomeOf(results: RunActionResult[], escalated: boolean): RunOutcome {
  if (results.some((r) => r.status === 'pending')) return 'pending';
  if (escalated) return 'escalated';
  const ok = results.filter((r) => r.status === 'done').length;
  if (ok === results.length) return 'succeeded';
  if (ok > 0) return 'partial';
  return results.some((r) => r.status === 'failed') ? 'failed' : 'blocked';
}

// ------------------------------------------------------------------ escalation + replies
async function escalate(ctx: Ctx, p: PolicyRow, conv: ConversationRow, reason: string, params: { team_id?: string | null; assignee_id?: string | null } = {}): Promise<RunActionResult> {
  const esc = escalationOf(p);
  const refs: Record<string, string> = {};
  const labels = [...new Set([...conv.labels, 'escalated'])].slice(0, 20);
  await updateConversation(ctx, conv.id, { priority: conv.priority === 'urgent' ? 'urgent' : 'high', labels });
  const assignee = params.assignee_id ?? esc.assignee_id;
  const team = params.team_id ?? esc.team_id;
  if (assignee || team) {
    try {
      await assignConversation(ctx, conv.id, { assignee_id: assignee ?? conv.assignee_id, ...(team ? { team_id: team } : {}) });
      if (assignee) refs.assignee_id = assignee;
      if (team) refs.team_id = team;
    } catch (err) { log.warn('automation.escalate_assign_failed', { conversationId: conv.id, code: err instanceof AppError ? err.code : 'unexpected' }); }
  }
  const note = await addNote(ctx, conv.id, { body: `Escalated by automation: ${reason} A person needs to handle this.` });
  refs.note_id = note.id;
  return done('escalate', `Escalated to a person (${reason.replace(/\.$/, '')}).`, refs);
}

/** Send through the inbox reply service (send-once, collision check, reply rules) as the service actor. */
async function sendReply(ctx: Ctx, p: PolicyRow, run: { id: string; rule_id: string | null }, convId: string, mode: 'public_reply' | 'private_message', body: string, baseVersion: number, suffix: string): Promise<RunActionResult> {
  const u = await policyUsage(p);
  if (u.auto_replies_today >= p.max_auto_replies_per_day) return blocked('reply_saved', 'Daily limit for automatic replies reached.');
  const key = `auto_${run.id.replace(/-/g, '')}_${suffix}`.slice(0, 80);
  await getPool().query(`INSERT INTO automation_sends(workspace_id, idempotency_key, policy_id, rule_id, run_id, conversation_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [p.workspace_id, key, p.id, run.rule_id, run.id, convId]);
  const r = await requestReply(ctx, convId, { mode, body, base_version: baseVersion, idempotency_key: key });
  return done('reply_saved', r.attempt.state === 'queued' ? 'Reply queued for sending.' : `Reply ${r.attempt.state}.`, { reply_attempt_id: r.attempt.id });
}

function replyError(type: 'reply_saved' | 'reply_ai', err: unknown): RunActionResult {
  if (err instanceof AppError && (err.code === 'conflict' || err.code === 'invalid_state')) return { type, status: 'blocked', detail: `Not sent: ${err.message}`, refs: {} };
  return failed(type, err);
}

// ------------------------------------------------------------------ action execution
async function runAction(ctx: Ctx, p: PolicyRow, rule: RuleRow, run: { id: string; rule_id: string | null }, e: EngineEvent, a: RuleAction, index: number, state: { escalated: boolean; text: string | null }): Promise<RunActionResult> {
  if (!p.allowed_actions.includes(a.type)) return blocked(a.type, 'Not allowed by the policy.');
  const convId = e.conversationId;
  const needConv = async () => {
    if (!convId) throw new AppError('invalid_state', 'No conversation for this event.');
    return loadConversation(ctx, convId, 'inbox.read');
  };
  try {
    switch (a.type) {
      case 'assign': {
        const conv = await needConv();
        await assignConversation(ctx, conv.id, { assignee_id: a.assignee_id ?? null, ...(a.team_id !== undefined ? { team_id: a.team_id } : {}) });
        return done(a.type, a.assignee_id ? 'Assigned.' : a.team_id ? 'Routed to the team.' : 'Unassigned.', { ...(a.assignee_id ? { assignee_id: a.assignee_id } : {}), ...(a.team_id ? { team_id: a.team_id } : {}) });
      }
      case 'set_priority': {
        const conv = await needConv();
        await updateConversation(ctx, conv.id, { priority: a.priority });
        return done(a.type, `Priority ${a.priority}.`);
      }
      case 'add_labels': {
        const conv = await needConv();
        await updateConversation(ctx, conv.id, { labels: [...new Set([...conv.labels, ...a.labels.map((l) => l.toLowerCase())])].slice(0, 20) });
        return done(a.type, `Labels: ${a.labels.join(', ')}.`);
      }
      case 'add_note': {
        const conv = await needConv();
        const n = await addNote(ctx, conv.id, { body: `Automation (${rule.name}): ${a.body}`.slice(0, 4000) });
        return done(a.type, 'Internal note added.', { note_id: n.id });
      }
      case 'create_case': {
        const conv = await needConv();
        if (conv.case_id) return { type: a.type, status: 'skipped', detail: 'Already part of a case.', refs: { case_id: conv.case_id } };
        const c = await createCase(ctx, { conversation_id: conv.id, title: (a.title?.trim() || `${e.classification?.category ?? 'Customer'} request`).slice(0, 200), category: e.classification?.category ?? null });
        return done(a.type, `Case #${c.number} created.`, { case_id: c.id });
      }
      case 'notify': {
        const conv = await needConv();
        let users: string[] = [];
        if (a.to === 'assignee' && conv.assignee_id) users = [conv.assignee_id];
        if (a.to === 'case_owner' && conv.case_id) users = (await many<{ owner_id: string | null }>(getPool(), `SELECT owner_id FROM care_cases WHERE id=$1`, [conv.case_id])).map((x) => x.owner_id).filter((x): x is string => !!x);
        if (a.to === 'users') users = a.user_ids ?? [];
        let sent = 0;
        for (const u of users.slice(0, 20)) {
          const r = await deliverNotification(getPool(), {
            workspaceId: p.workspace_id, userId: u, event: 'assignment', kind: 'automation.notify', title: `Automation: ${rule.name}`, referenceType: 'inbox_conversation', referenceId: conv.id,
            dedupeKey: `auto:${run.id}:${index}:${u}`, requirement: { brandId: conv.brand_id, permission: 'inbox.read' }, linkPath: `/inbox?c=${conv.id}`, actorId: null,
          });
          if (r === 'created') sent++;
        }
        return sent ? done(a.type, `Notified ${sent}.`) : { type: a.type, status: 'skipped', detail: 'Nobody to notify.', refs: {} };
      }
      case 'escalate': {
        const conv = await needConv();
        state.escalated = true;
        return await escalate(ctx, p, conv, a.reason?.trim() || `Rule “${rule.name}”.`, { team_id: a.team_id, assignee_id: a.assignee_id });
      }
      case 'reply_saved':
      case 'reply_ai': {
        if (e.trigger !== 'inbox.message_received') return blocked(a.type, 'Automatic replies only answer new customer messages.');
        const conv = await needConv();
        const why = replyBlocker(p, e.classification, state.text);
        if (why) {
          if (!state.escalated) { state.escalated = true; await escalate(ctx, p, conv, why); }
          return blocked(a.type, `Escalated instead: ${why}`);
        }
        if (a.type === 'reply_saved') {
          const sr = await maybeOne<{ body: string }>(getPool(), `SELECT body FROM inbox_saved_replies WHERE id=$1 AND workspace_id=$2 AND (brand_id IS NULL OR brand_id=$3) AND archived_at IS NULL`, [a.saved_reply_id, p.workspace_id, conv.brand_id]);
          if (!sr) return blocked(a.type, 'The saved reply no longer exists.');
          try { return { ...(await sendReply(ctx, p, run, conv.id, a.mode, sr.body, e.conversationVersion ?? conv.version, `r${index}`)), type: a.type }; } catch (err) { return replyError(a.type, err); }
        }
        // reply_ai: queue an AI run (ai-assist queue); the reply is sent only if every check passes when it finishes.
        const u = await policyUsage(p);
        if (u.tokens_this_month >= p.monthly_token_budget) return blocked(a.type, 'The policy’s monthly AI budget is used up.');
        const aiRunId = await withTx((tx) => queueAutomationRun(tx, { workspaceId: p.workspace_id, brandId: conv.brand_id, conversationId: conv.id, automationRunId: run.id, idempotencyKey: `auto-ai-${run.id}-${index}` }));
        return { type: a.type, status: 'pending', detail: 'Drafting from approved knowledge…', refs: { ai_run_id: aiRunId, conv_version: String(e.conversationVersion ?? conv.version), mode: a.mode, index: String(index) } };
      }
      case 'integration_job': {
        if (!syncExecutor(a.kind)) return blocked(a.type, 'This integration action is not available yet.');
        const integ = await maybeOne<{ connector: string }>(getPool(), `SELECT connector FROM integration_connections WHERE id=$1 AND workspace_id=$2 AND disconnected_at IS NULL`, [a.integration_id, p.workspace_id]);
        if (!integ || !a.kind.startsWith(`${integ.connector}.`)) return blocked(a.type, 'The integration is not connected.');
        const relayType = e.subject.type === 'case' ? 'case' : 'conversation';
        // Minimal payload: ids, category and a secure Relay link — never the customer's private messages.
        const r = await enqueueSyncJob(ctx, {
          integrationId: a.integration_id, kind: a.kind, relayType, relayId: e.subject.id, idempotencyKey: `automation:${rule.id}:${e.eventKey}:${index}`,
          payload: { source: 'relay_automation', rule: rule.name, category: e.classification?.category ?? null, link: convId ? `/inbox?c=${convId}` : null, brand_id: e.brandId },
        });
        return done(a.type, r.created ? 'Integration job queued.' : 'Integration job already queued.', { sync_job_id: r.job.id });
      }
    }
  } catch (err) {
    log.warn('automation.action_failed', { ruleId: rule.id, runId: run.id, action: a.type, code: err instanceof AppError ? err.code : 'unexpected' });
    return failed(a.type, err);
  }
}

// ------------------------------------------------------------------ rule run
async function limitsReason(db: Queryable, rule: RuleRow, p: PolicyRow, e: EngineEvent, runId: string): Promise<string | null> {
  const r = await one<{ hour: string; recent: string }>(db,
    `SELECT (SELECT count(*) FROM automation_runs WHERE rule_id=$1 AND id<>$4 AND NOT is_test AND outcome NOT IN ('skipped','blocked') AND created_at > now() - interval '1 hour') AS hour,
            (SELECT count(*) FROM automation_runs WHERE rule_id=$1 AND id<>$4 AND NOT is_test AND subject_id=$2 AND outcome NOT IN ('skipped','blocked') AND created_at > now() - make_interval(mins => $3)) AS recent`,
    [rule.id, e.subject.id, rule.limits.per_conversation_cooldown_minutes ?? 0, runId]);
  if (Number(r.hour) >= (rule.limits.max_per_hour ?? 30)) return 'Rule limit per hour reached.';
  if ((rule.limits.per_conversation_cooldown_minutes ?? 0) > 0 && Number(r.recent) > 0) return 'Cooling down for this conversation.';
  const u = await policyUsage(p, db);
  if (u.actions_last_hour + rule.actions.length > p.max_actions_per_hour) return 'Policy limit of actions per hour reached.';
  return null;
}

function inScope(rule: RuleRow, p: PolicyRow, e: EngineEvent): boolean {
  if (!p.brand_ids.includes(e.brandId) || !rule.scope.brand_ids.includes(e.brandId)) return false;
  if (e.channelId) {
    if (!p.channel_ids.includes(e.channelId)) return false;
    if (rule.scope.channel_ids.length && !rule.scope.channel_ids.includes(e.channelId)) return false;
  } else if (rule.scope.channel_ids.length && e.trigger === 'inbox.message_received') return false;
  return true;
}

async function runRule(rule: RuleRow, p: PolicyRow, e: EngineEvent): Promise<string | null> {
  const db = getPool();
  if (!inScope(rule, p, e)) return null;
  const cond = evaluateConditions(rule.conditions, e.facts);
  if (!cond.matched) return null;
  const ins = await maybeOne<RunRow>(db,
    `INSERT INTO automation_runs(workspace_id, rule_id, policy_id, trigger, event_key, subject_type, subject_id, brand_id, outcome, conditions)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9) ON CONFLICT (rule_id, event_key) WHERE NOT is_test DO NOTHING RETURNING *`,
    [e.workspaceId, rule.id, p.id, e.trigger, e.eventKey.slice(0, 300), e.subject.type, e.subject.id, e.brandId, JSON.stringify(cond.results)]);
  if (!ins) return null; // duplicate delivery: already handled
  const active = await policyActive(p, db);
  if (!active.ok) { await updateRun(db, ins.id, 'blocked', active.reason, []); return ins.id; }
  if (rule.schedule.mode !== 'always') {
    const open = await inBusinessHours(db, e.workspaceId, e.brandId, rule.schedule.sla_policy_id);
    if ((rule.schedule.mode === 'business_hours') !== open) { await updateRun(db, ins.id, 'skipped', rule.schedule.mode === 'business_hours' ? 'Outside business hours.' : 'Inside business hours.', []); return ins.id; }
  }
  const lim = await limitsReason(db, rule, p, e, ins.id);
  if (lim) { await updateRun(db, ins.id, 'skipped', lim, []); return ins.id; }
  let ctx: Ctx;
  try { ctx = await policyCtx(p, ins.id, db); } catch (err) { await updateRun(db, ins.id, 'blocked', err instanceof AppError ? err.message : 'Policy actor unavailable.', []); return ins.id; }

  const text = e.messageText ?? null;
  const state = { escalated: false, text };
  const results: RunActionResult[] = [];
  await withOrigin({ kind: 'automation', id: ins.id }, async () => {
    // Signals that always need a person: escalate first, even if the rule only routes (no customer-facing action runs).
    const reason = e.trigger === 'inbox.message_received' && p.allowed_actions.includes('escalate') ? escalationReason(p, e.classification, text) : null;
    const customerFacing = rule.actions.some((a) => a.type === 'reply_saved' || a.type === 'reply_ai');
    if (reason && customerFacing && e.conversationId) {
      try {
        const conv = await loadConversation(ctx, e.conversationId, 'inbox.read');
        state.escalated = true;
        results.push(await escalate(ctx, p, conv, `${reason}.`));
      } catch (err) { results.push(failed('escalate', err)); }
    }
    for (const [i, a] of rule.actions.entries()) results.push(await runAction(ctx, p, rule, { id: ins.id, rule_id: rule.id }, e, a, i, state));
  });
  await updateRun(db, ins.id, outcomeOf(results, state.escalated && !results.some((r) => r.status === 'pending')), null, results);
  return ins.id;
}

/** Evaluate every enabled rule for an event. Returns the run ids created. */
export async function processEvent(e: EngineEvent): Promise<string[]> {
  const db = getPool();
  if ((await emergencyStopState(e.workspaceId, db)).active) return [];
  const rows = await many<RuleRow & { p: PolicyRow }>(db,
    `SELECT r.*, to_jsonb(p.*) AS p FROM automation_rules r JOIN automation_policies p ON p.id=r.policy_id
      WHERE r.workspace_id=$1 AND r.trigger=$2 AND r.enabled AND r.deleted_at IS NULL AND p.status='active' ORDER BY r.position, r.created_at LIMIT 100`, [e.workspaceId, e.trigger]);
  const out: string[] = [];
  for (const r of rows) {
    const p = hydratePolicy(r.p);
    try {
      const id = await runRule(r, p, e);
      if (id) out.push(id);
    } catch (err) {
      log.error('automation.rule_failed', { ruleId: r.id, err: err as Error });
    }
  }
  return out;
}

/** to_jsonb turns timestamps into strings: restore the Date fields the services expect. */
export function hydratePolicy(j: Record<string, unknown> | PolicyRow): PolicyRow {
  const d = (v: unknown) => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v)));
  const x = j as Record<string, unknown>;
  return { ...(x as unknown as PolicyRow), expires_at: d(x.expires_at)!, review_by: d(x.review_by), activated_at: d(x.activated_at), stopped_at: d(x.stopped_at), created_at: d(x.created_at)! };
}

// ------------------------------------------------------------------ event sources
/** inbox.message_received hook: classify first, then evaluate rules. Ignores changes made by automation. */
export async function onMessageReceived(ev: { workspaceId: string; aggregateId: string; payload: Record<string, unknown>; origin: { kind: string } }): Promise<string[]> {
  if (ev.origin.kind === 'automation') return [];
  const messageId = typeof ev.payload.messageId === 'string' ? ev.payload.messageId : null;
  if (!messageId) return [];
  const db = getPool();
  const classification = await classifyMessage(messageId, db);
  const m = await maybeOne<{ body: string | null }>(db, `SELECT body FROM inbox_messages WHERE id=$1`, [messageId]);
  const conv = await maybeOne<ConversationRow & { channel_kind: string; inbound_count: string }>(db,
    `SELECT c.*, ch.kind AS channel_kind, (SELECT count(*) FROM inbox_messages im WHERE im.conversation_id=c.id AND im.direction='inbound') AS inbound_count
       FROM inbox_conversations c JOIN inbox_channels ch ON ch.id=c.channel_id WHERE c.id=$1 AND c.workspace_id=$2`, [ev.aggregateId, ev.workspaceId]);
  if (!conv || !classification || conv.status === 'spam') return [];
  return processEvent({
    workspaceId: ev.workspaceId, trigger: 'inbox.message_received', eventKey: `msg:${messageId}`, subject: { type: 'conversation', id: conv.id }, brandId: conv.brand_id,
    channelId: conv.channel_id, conversationId: conv.id, classification, conversationVersion: conv.version, messageText: m?.body ?? null,
    facts: {
      channel_kind: conv.channel_kind, conversation_kind: conv.kind, category: classification.category, sentiment: classification.sentiment, language: classification.language ?? conv.language,
      urgency: classification.urgency, priority: conv.priority, assigned: !!conv.assignee_id, text: m?.body ?? null, first_message: Number(conv.inbound_count) <= 1, labels: conv.labels,
    },
  });
}

/** case.changed hook. */
export async function onCaseChanged(ev: { workspaceId: string; aggregateId: string; payload: Record<string, unknown>; origin: { kind: string } }): Promise<string[]> {
  if (ev.origin.kind === 'automation') return [];
  const c = await maybeOne<{ id: string; brand_id: string; priority: string; owner_id: string | null; version: number }>(getPool(), `SELECT id, brand_id, priority, owner_id, version FROM care_cases WHERE id=$1 AND workspace_id=$2`, [ev.aggregateId, ev.workspaceId]);
  if (!c) return [];
  const conv = await maybeOne<{ id: string; channel_id: string; version: number }>(getPool(), `SELECT id, channel_id, version FROM inbox_conversations WHERE case_id=$1 ORDER BY created_at LIMIT 1`, [c.id]);
  const change = String(ev.payload.change ?? 'details');
  return processEvent({
    workspaceId: ev.workspaceId, trigger: 'case.changed', eventKey: `case:${c.id}:${change}:${c.version}${ev.payload.which ? `:${String(ev.payload.which)}` : ''}`, subject: { type: 'case', id: c.id }, brandId: c.brand_id,
    channelId: conv?.channel_id ?? null, conversationId: conv?.id ?? null, classification: null, conversationVersion: conv?.version ?? null,
    facts: { case_change: change, priority: c.priority, assigned: !!c.owner_id },
  });
}

/** Worker sweep: open cases approaching a service-level deadline (once per case, target and deadline). */
export async function sweepSlaNearing(limit = 200): Promise<number> {
  const db = getPool();
  const rules = await many<{ workspace_id: string; minutes: number }>(db,
    `SELECT r.workspace_id, max(coalesce((r.trigger_params->>'minutes_before')::int, 60)) AS minutes FROM automation_rules r JOIN automation_policies p ON p.id=r.policy_id
      WHERE r.trigger='case.sla_nearing' AND r.enabled AND r.deleted_at IS NULL AND p.status='active' GROUP BY r.workspace_id`);
  let n = 0;
  for (const w of rules) {
    const cases = await many<{ id: string; brand_id: string; priority: string; owner_id: string | null; which: string; due: Date }>(db,
      `SELECT id, brand_id, priority, owner_id, 'first_response' AS which, first_response_due_at AS due FROM care_cases
        WHERE workspace_id=$1 AND state IN ('open','reopened') AND first_responded_at IS NULL AND first_response_breached_at IS NULL AND first_response_due_at BETWEEN now() AND now() + make_interval(mins => $2)
       UNION ALL
       SELECT id, brand_id, priority, owner_id, 'resolution', resolution_due_at FROM care_cases
        WHERE workspace_id=$1 AND state IN ('open','reopened') AND resolved_at IS NULL AND resolution_breached_at IS NULL AND resolution_due_at BETWEEN now() AND now() + make_interval(mins => $2)
       LIMIT $3`, [w.workspace_id, w.minutes, limit]);
    for (const c of cases) {
      const conv = await maybeOne<{ id: string; channel_id: string; version: number }>(db, `SELECT id, channel_id, version FROM inbox_conversations WHERE case_id=$1 ORDER BY created_at LIMIT 1`, [c.id]);
      const ids = await processEvent({
        workspaceId: w.workspace_id, trigger: 'case.sla_nearing', eventKey: `sla:${c.id}:${c.which}:${c.due.toISOString()}`, subject: { type: 'case', id: c.id }, brandId: c.brand_id,
        channelId: conv?.channel_id ?? null, conversationId: conv?.id ?? null, classification: null, conversationVersion: conv?.version ?? null,
        facts: { priority: c.priority, assigned: !!c.owner_id, minutes_to_deadline: Math.max(0, Math.round((c.due.getTime() - Date.now()) / 60_000)) },
      });
      n += ids.length;
    }
  }
  return n;
}

// ------------------------------------------------------------------ AI auto-reply completion (bridge)
/** Called when a policy-driven AI run settles: send only if everything still holds, otherwise escalate. */
export async function onAutomationAiRunFinished(aiRunId: string): Promise<void> {
  const db = getPool();
  const ai = await maybeOne<{ id: string; status: string; automation_run_id: string; output: import('@social-lite/core/contracts/v35-ai').AssistantOutputDto | null; context: { id: string }; status_detail: string | null }>(db,
    `SELECT id, status, automation_run_id, output, context, status_detail FROM ai_runs WHERE id=$1`, [aiRunId]);
  if (!ai?.automation_run_id) return;
  const run = await maybeOne<RunRow & { subject_id: string }>(db, `SELECT * FROM automation_runs WHERE id=$1`, [ai.automation_run_id]);
  if (!run || !run.policy_id) return;
  const idx = run.actions.findIndex((x) => x.status === 'pending' && x.refs.ai_run_id === aiRunId);
  if (idx < 0) return;
  const pending = run.actions[idx]!;
  const p = await maybeOne<PolicyRow>(db, `SELECT * FROM automation_policies WHERE id=$1`, [run.policy_id]);
  if (!p) return;
  const convId = ai.context.id;
  let result: RunActionResult;
  let escalated = false;
  try {
    const ctx = await policyCtx(p, run.id, db);
    await withOrigin({ kind: 'automation', id: run.id }, async () => {
      const conv = await loadConversation(ctx, convId, 'inbox.read');
      const reply = ai.output?.suggestions.find((s) => s.kind === 'reply');
      const why = ai.status !== 'succeeded' ? `AI draft unavailable (${ai.status_detail ?? ai.status}).`
        : !reply ? 'The approved sources do not answer this message.'
          : reply.issues.length ? `The AI draft failed checks: ${reply.issues.map((i) => i.code).join(', ')}.`
            : ai.output!.uncertain ? 'The AI draft is not fully supported by approved sources.' : null;
      if (why) {
        escalated = true;
        await escalate(ctx, p, conv, why);
        result = { type: 'reply_ai', status: 'blocked', detail: `Escalated instead: ${why}`, refs: { ai_run_id: aiRunId } };
        return;
      }
      try {
        const r = await sendReply(ctx, p, { id: run.id, rule_id: run.rule_id }, conv.id, (pending.refs.mode as 'public_reply' | 'private_message') ?? 'private_message', reply!.text, Number(pending.refs.conv_version), `ai${pending.refs.index ?? idx}`);
        result = { ...r, type: 'reply_ai', refs: { ...r.refs, ai_run_id: aiRunId } };
        if (r.status !== 'done') { escalated = true; await escalate(ctx, p, conv, r.detail); }
      } catch (err) {
        result = { ...replyError('reply_ai', err), refs: { ai_run_id: aiRunId } };
        escalated = true;
        await escalate(ctx, p, conv, 'The automatic reply could not be sent.');
      }
    });
  } catch (err) {
    result = { type: 'reply_ai', status: 'blocked', detail: err instanceof AppError ? err.message : 'Policy no longer allows this.', refs: { ai_run_id: aiRunId } };
  }
  const actions = [...run.actions];
  actions[idx] = result!;
  await updateRun(db, run.id, outcomeOf(actions, escalated), null, actions);
}
