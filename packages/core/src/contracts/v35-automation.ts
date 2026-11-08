// V3.5 rules + bounded automation contract (stream E, migration 032). Served by packages/services/src/automation/**
// and /api/automation/**. Rules (brief §17–18):
//  - Nothing runs without an ACTIVE, unexpired automation policy that names its brands + channels, allowed actions,
//    approved knowledge sources, eligible message categories, rate + spending limits, escalation triggers, an expiry /
//    review date and an emergency stop (per policy and workspace-wide).
//  - Classification + routing come first; automatic customer replies are a separate, explicitly allowed action and are
//    never authorized by model confidence alone (deterministic category + escalation checks + grounding checks).
//  - Every customer-facing send goes through the inbox reply service (requestReply: send-once, collision check, reply
//    rules) as the policy's service actor; integration actions go through enqueueSyncJob (idempotency key per run).
//  - Loop prevention: events caused by automation never trigger rules; one run per (rule, event); per-rule and
//    per-conversation limits; external echoes are dropped by the connector origin marker.
import type { ChannelKind, ConversationKind, Priority } from './v35-inbox.js';
import type { MessageCategory } from './v35-ai.js';

export const AUTOMATION_TRIGGERS = [
  'inbox.message_received',   // a customer message arrived (classified first)
  'case.sla_nearing',         // an open case is within N minutes of a service-level deadline (worker sweep)
  'case.changed',             // case created / escalated / breached
  'listening.alert',          // a listening alert fired (stream D)
  'content.approved',         // a post was approved (needs the collaboration event bridge)
] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

export const CONDITION_FIELDS = [
  'channel_kind', 'conversation_kind', 'category', 'sentiment', 'language', 'urgency', 'priority', 'assigned', 'text_contains', 'first_message',
  'case_change', 'minutes_to_deadline', 'labels',
] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number];

export const CONDITION_OPS = ['in', 'not_in', 'is', 'contains_any', 'lte'] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export interface RuleCondition {
  field: ConditionField;
  op: ConditionOp;
  /** string[] for in/not_in/contains_any; boolean for is; number for lte. */
  value: string[] | boolean | number;
}

export const AUTOMATION_ACTIONS = [
  'assign',          // route to a person and/or team (inbox.assign)
  'set_priority',    // (inbox.reply)
  'add_labels',      // (inbox.reply)
  'add_note',        // internal note — never reaches the customer
  'create_case',     // (cases.manage)
  'notify',          // in-app notification (content-free)
  'escalate',        // priority + route to the escalation team/person + note + notify
  'reply_saved',     // customer reply with an APPROVED saved reply (requestReply, automated)
  'reply_ai',        // customer reply drafted from approved knowledge; sent only if every deterministic check passes
  'integration_job', // Slack / Asana / monday.com / Mailchimp / HubSpot through enqueueSyncJob (stream C executors)
] as const;
export type AutomationActionType = (typeof AUTOMATION_ACTIONS)[number];

/** Actions that send something to a customer. */
export const CUSTOMER_FACING_ACTIONS: readonly AutomationActionType[] = ['reply_saved', 'reply_ai'];

export type RuleAction =
  | { type: 'assign'; assignee_id?: string | null; team_id?: string | null }
  | { type: 'set_priority'; priority: Priority }
  | { type: 'add_labels'; labels: string[] }
  | { type: 'add_note'; body: string }
  | { type: 'create_case'; title?: string | null }
  | { type: 'notify'; to: 'assignee' | 'case_owner' | 'users'; user_ids?: string[] }
  | { type: 'escalate'; team_id?: string | null; assignee_id?: string | null; reason?: string | null }
  | { type: 'reply_saved'; saved_reply_id: string; mode: 'public_reply' | 'private_message' }
  | { type: 'reply_ai'; mode: 'public_reply' | 'private_message' }
  | { type: 'integration_job'; integration_id: string; kind: string };

export interface RuleSchedule {
  mode: 'always' | 'business_hours' | 'outside_business_hours';
  /** Service-level policy whose business hours apply (default: the brand's default policy). */
  sla_policy_id?: string | null;
}

export interface RuleLimits {
  max_per_hour: number;                  // runs of this rule per hour (workspace)
  per_conversation_cooldown_minutes: number;
}

export interface RuleScope {
  brand_ids: string[];                   // ⊆ policy brands
  channel_ids: string[];                 // ⊆ policy channels; [] = all of the policy's channels
}

export interface AutomationRuleDto {
  id: string;
  policy_id: string;
  name: string;
  trigger: AutomationTrigger;
  /** case.sla_nearing: minutes before the deadline. */
  trigger_params: { minutes_before?: number } ;
  conditions: RuleCondition[];
  actions: RuleAction[];
  scope: RuleScope;
  schedule: RuleSchedule;
  limits: RuleLimits;
  enabled: boolean;
  position: number;
  version: number;
  last_run_at: string | null;
  runs_24h: number;
  created_at: string;
  updated_at: string;
}

export const POLICY_STATUSES = ['draft', 'active', 'paused', 'stopped', 'expired'] as const;
export type PolicyStatus = (typeof POLICY_STATUSES)[number];

export interface EscalationSettings {
  /** Categories that always go to a person (refund, complaint, sensitive are always included). */
  categories: MessageCategory[];
  negative_sentiment: boolean;
  /** Keywords (case-insensitive) that force escalation. */
  keywords: string[];
  team_id: string | null;
  assignee_id: string | null;
}

export interface AutomationPolicyDto {
  id: string;
  name: string;
  status: PolicyStatus;
  brand_ids: string[];
  channel_ids: string[];
  allowed_actions: AutomationActionType[];
  knowledge_source_ids: string[];
  /** Message categories eligible for automatic customer replies. */
  reply_categories: MessageCategory[];
  limits: { max_actions_per_hour: number; max_auto_replies_per_day: number; monthly_token_budget: number };
  escalation: EscalationSettings;
  expires_at: string;
  review_by: string | null;
  /** The person whose CURRENT permissions bound what the policy's service actor may do. */
  owner: { id: string; name: string | null } | null;
  activated_at: string | null;
  stopped_at: string | null;
  stop_reason: string | null;
  version: number;
  usage: { actions_last_hour: number; auto_replies_today: number; tokens_this_month: number };
  created_at: string;
}

export const RUN_OUTCOMES = ['pending', 'succeeded', 'partial', 'skipped', 'blocked', 'escalated', 'failed', 'test'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export interface RunActionResult {
  type: AutomationActionType;
  status: 'done' | 'skipped' | 'blocked' | 'failed' | 'would_run' | 'pending';
  detail: string;
  /** Ids of what was created (reply attempt, case, note, sync job, AI run). */
  refs: Record<string, string>;
}

export interface AutomationRunDto {
  id: string;
  rule: { id: string; name: string } | null;
  policy_id: string | null;
  trigger: AutomationTrigger;
  subject: { type: 'conversation' | 'case' | 'post' | 'listening_alert'; id: string };
  outcome: RunOutcome;
  reason: string | null;
  conditions: Array<{ field: ConditionField; matched: boolean }>;
  actions: RunActionResult[];
  is_test: boolean;
  created_at: string;
  finished_at: string | null;
}

/** Catalog for the rule builder: what is available in this workspace right now (and why not). */
export interface AutomationCatalogDto {
  triggers: Array<{ trigger: AutomationTrigger; available: boolean; reason: string | null }>;
  actions: Array<{ type: AutomationActionType; available: boolean; reason: string | null; customer_facing: boolean }>;
  integration_jobs: Array<{ integration_id: string; connector: string; display_name: string; kind: string; available: boolean; reason: string | null }>;
  channels: Array<{ id: string; brand_id: string; kind: ChannelKind; display_name: string; is_simulated: boolean }>;
  conversation_kinds: readonly ConversationKind[];
  categories: readonly MessageCategory[];
  emergency_stop: { active: boolean; at: string | null; by: string | null };
}

export interface RuleTestResult {
  /** Dry run over recent conversations in scope: nothing is changed or sent. */
  evaluated: number;
  matched: number;
  samples: Array<{ conversation_id: string; matched: boolean; category: MessageCategory; conditions: AutomationRunDto['conditions']; actions: RunActionResult[] }>;
}
