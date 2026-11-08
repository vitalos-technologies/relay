// V5 AI workspace contract (stream AIW, migration 038). Served by packages/services/src/ai-workflows/** and
// /api/assistant/** (workspace, threads, workflows, attachments). Extends V3.5 (contracts/v35-ai.ts): a workflow run is
// an ai_runs row (kind='workflow') on the same queue, budget meter, retrieval and output checks.
// Rules (brief §13–15):
//  - Runs execute in the worker with the requester's CURRENT access; the page only queues and polls.
//  - Reads, drafts and internal saves (drafts, campaigns, tasks) proceed without repeated confirmation.
//  - External actions (publishing/scheduling, sending replies, …) are only PREPARED as previews; a person confirms the
//    exact destinations, content and timing, bound to the reviewed revision; the normal service re-checks permissions.
//  - Source documents, attachments and customer messages are untrusted content: they never grant permissions.
//  - Progress events are short, Relay-written descriptions of observable actions — never model reasoning.
//  - No AI provider configured ⇒ deterministic steps still run for real; model steps report "AI is not set up".
import type { KnowledgeSourceDto, ProposedActionDto } from './v35-ai.js';

export const AI_WORKFLOWS = ['campaign_from_brief', 'inbox_assistance', 'performance_analysis', 'weekly_planning', 'content_adaptation', 'ask'] as const;
export type AiWorkflow = (typeof AI_WORKFLOWS)[number];

/** Plan feature each workflow needs (V4 entitlements). Multi-step workflows need ai_workflows (Professional). */
export const WORKFLOW_FEATURE: Record<AiWorkflow, 'ai_drafting' | 'ai_workflows'> = {
  campaign_from_brief: 'ai_workflows', inbox_assistance: 'ai_workflows', performance_analysis: 'ai_workflows',
  weekly_planning: 'ai_workflows', content_adaptation: 'ai_workflows', ask: 'ai_drafting',
};

export const WORKFLOW_LABEL: Record<AiWorkflow, string> = {
  campaign_from_brief: 'Campaign from a brief',
  inbox_assistance: 'Inbox assistance',
  performance_analysis: 'Performance analysis',
  weekly_planning: 'Weekly planning',
  content_adaptation: 'Content adaptation',
  ask: 'Ask',
};

export const WORKFLOW_STATUSES = ['preparing', 'working', 'needs_input', 'needs_review', 'completed', 'partially_completed', 'failed', 'cancelled'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];
export const ACTIVE_STATUSES: readonly WorkflowStatus[] = ['preparing', 'working'];
export const TERMINAL_STATUSES: readonly WorkflowStatus[] = ['completed', 'partially_completed', 'failed', 'cancelled'];

/** Why a run stopped short. */
export type OutcomeCode = 'not_configured' | 'budget_exhausted' | 'blocked' | 'timeout' | 'entitlement' | 'step_failed' | 'cancelled' | 'interrupted';

export type StepKind = 'read' | 'model' | 'validate' | 'write' | 'external';
export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled' | 'not_configured';

export interface WorkflowStepDto {
  key: string;
  label: string;
  kind: StepKind;
  status: StepStatus;
  detail: string | null;
  attempts: number;
  started_at: string | null;
  finished_at: string | null;
}

export interface RunEventDto {
  seq: number;
  at: string;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
  step: string | null;
}

export type ResultKind = 'post_draft' | 'campaign' | 'outline' | 'reply_draft' | 'report' | 'task' | 'schedule_plan' | 'variant' | 'summary' | 'answer' | 'notice';

export type ResultActionKind = 'open' | 'edit' | 'compare_versions' | 'review_reply' | 'view_report' | 'submit_for_approval' | 'review_schedule' | 'create_task' | 'open_conversation';

export interface ResultActionDto {
  kind: ResultActionKind;
  label: string;
  /** Relay link (permission re-checked when opened). */
  href?: string;
  /** Proposed action to review/confirm (external actions). */
  action_id?: string;
}

export interface ResultIssueDto { severity: 'block' | 'warn'; message: string }

export interface ResultCardDto {
  id: string;
  step: string;
  kind: ResultKind;
  title: string;
  /** Generated (AI) or computed text. Null after the 30-day retention. */
  body: string | null;
  /** True when the text was written by the AI model (shown as "generated, review before use"). */
  generated: boolean;
  /** Small labelled facts (dates, coverage, destination, counts). */
  facts: Array<{ label: string; value: string }>;
  /** Evidence lines (verbatim quotes or stored numbers) with their source. */
  evidence: Array<{ text: string; source: string | null }>;
  issues: ResultIssueDto[];
  /** For compare_versions: the original text the variant came from. */
  compare_with: { title: string; text: string } | null;
  record: { type: 'post' | 'campaign' | 'conversation' | 'task' | 'analytics'; id: string | null; link: string } | null;
  actions: ResultActionDto[];
  created_at: string;
}

export interface NeedsInputDto {
  question: string;
  field: string;
  kind: 'choose_many' | 'choose_one' | 'confirm';
  options: Array<{ value: string; label: string; hint?: string }>;
}

export interface RunInputSummary {
  prompt: string | null;
  sources: Array<{ kind: string; id: string; title: string }>;
  attachments: Array<{ id: string; filename: string }>;
  knowledge: Array<{ id: string; title: string }>;
}

export interface WorkflowRunDto {
  id: string;
  thread_id: string;
  workflow: AiWorkflow;
  title: string;
  brand_id: string;
  status: WorkflowStatus;
  outcome_code: OutcomeCode | null;
  status_detail: string | null;
  input: RunInputSummary;
  steps: WorkflowStepDto[];
  /** Events after the `after` cursor (all when none was given). */
  events: RunEventDto[];
  last_event_seq: number;
  results: ResultCardDto[];
  actions: ProposedActionDto[];
  pending_input: NeedsInputDto | null;
  usage: { input_tokens: number; output_tokens: number } | null;
  cancel_requested: boolean;
  can_cancel: boolean;
  can_retry: boolean;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  deadline_at: string | null;
}

export interface ThreadDto {
  id: string;
  title: string;
  brand_id: string;
  brand_name: string;
  workflow: AiWorkflow | null;
  last_status: WorkflowStatus | null;
  run_count: number;
  created_at: string;
  updated_at: string;
}

export interface ThreadPageDto { items: ThreadDto[]; next_cursor: string | null }

export interface ThreadDetailDto extends ThreadDto { runs: WorkflowRunDto[] }

// ------------------------------------------------------------------ workspace context + suggestions
export interface WorkspaceAccountDto { id: string; provider: string; display_name: string; ready: boolean; simulated: boolean }

export interface WorkspaceBrandDto {
  id: string;
  name: string;
  timezone: string;
  accounts: WorkspaceAccountDto[];
  can: { draft: boolean; schedule: boolean; reply: boolean; read_inbox: boolean; analytics: boolean; listening: boolean; manage_knowledge: boolean };
  approval_required: boolean;
}

export interface WorkspaceDocumentDto {
  kind: 'source_item' | 'knowledge' | 'post' | 'attachment';
  id: string;
  title: string;
  brand_id: string;
  /** post: has an approved revision (content adaptation uses approved material). */
  approved?: boolean;
  updated_at: string | null;
}

export type SuggestionFlow = 'pick_document' | 'pick_conversations' | 'pick_range' | 'pick_week' | 'pick_post' | 'prompt';

export interface SuggestionDto {
  id: string;
  workflow: AiWorkflow;
  title: string;
  description: string;
  /** Why this is offered now (from real data), e.g. "4 unanswered messages". */
  reason: string;
  flow: SuggestionFlow;
  prefill: { prompt: string; inputs: Record<string, unknown> };
}

export interface AiWorkspaceDto {
  status: { configured: boolean; reason: string | null; can_use: boolean; budget: { period: string; used: number; cap: number; remaining: number } };
  features: { ai_drafting: boolean; ai_workflows: boolean; upgrade_plan: string | null };
  brand_id: string | null;
  brands: WorkspaceBrandDto[];
  documents: WorkspaceDocumentDto[];
  knowledge: KnowledgeSourceDto[];
  inbox: { unanswered: number; conversations: Array<{ id: string; title: string; waiting_since: string | null; channel: string }> } | null;
  analytics: { has_data: boolean; last_data_at: string | null } | null;
  listening: { available: boolean; searches: number };
  week: { calendar_posts: number; ready_drafts: number; slots: number };
  suggestions: SuggestionDto[];
}

/** External-action preview: exactly what will happen if the person confirms. */
export interface ActionPreviewDto {
  action: ProposedActionDto;
  kind: 'schedule_post' | 'submit_for_approval' | 'send_reply';
  hash: string;
  changed_since_prepared: boolean;
  destinations: Array<{ id: string; provider: string; display_name: string; ready: boolean }>;
  content: Array<{ destination: string | null; text: string }>;
  timing: { mode: 'scheduled' | 'on_approval' | 'immediate'; local_time: string | null; timezone: string | null; due_at: string | null } | null;
  approval_required: boolean;
  /** What confirming does, in one sentence. */
  effect: string;
  allowed: boolean;
  blocked_reason: string | null;
  record: { type: 'post' | 'conversation'; id: string; link: string };
}

export const ATTACHMENT_MAX_BYTES = 256 * 1024;
export const ATTACHMENT_TYPES = ['text/plain', 'text/markdown', 'text/csv', 'application/json'] as const;
export const RUN_DEADLINE_MINUTES = 15;

/**
 * Deterministic task-type guess for free text typed in the composer (no model involved). The composer shows the guess
 * as a chip the person can change before submitting; the server never trusts it for permissions.
 */
export function guessWorkflow(text: string): AiWorkflow {
  const t = text.toLowerCase();
  if (/\b(repl(y|ies)|unanswered|inbox|messages?|dms?|comments?|customers?)\b/.test(t)) return 'inbox_assistance';
  if (/\b(performance|analytics|results|metrics|engagement|explain (this|last) (month|week)|how did we do)\b/.test(t)) return 'performance_analysis';
  if (/\b(plan|schedule|calendar|this week|next week|weekly)\b/.test(t)) return 'weekly_planning';
  if (/\b(adapt|versions?|repurpose|platform-specific|variants?|rewrite for)\b/.test(t)) return 'content_adaptation';
  if (/\b(campaign|brief|launch)\b/.test(t)) return 'campaign_from_brief';
  return 'ask';
}
