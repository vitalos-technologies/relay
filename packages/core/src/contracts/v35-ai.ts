// V3.5 Relay AI assistant contract (stream E, migration 032). Served by packages/services/src/assistant/** and
// /api/assistant/**. Rules (brief §16–17):
//  - The assistant reads authorized data, explains, drafts, suggests and PREPARES actions. It never sends, publishes,
//    exports or changes external records itself: a proposed action is a preview a person applies through the normal
//    service (same permission + approval checks), or an administrator-configured automation policy applies it.
//  - Retrieval is scoped per run to what the requesting person may read right now (re-checked at execution time).
//  - Customer messages, comments, imported documents and listening results are UNTRUSTED DATA, never instructions.
//  - Output separates EVIDENCE (quoted from cited sources) from SUGGESTIONS (generated text). Answers about policy,
//    prices, stock, refunds or commitments must cite a current approved source or state uncertainty.
//  - No provider configured ⇒ the assistant says so and stays off (no fixture outputs in the running app).

export const ASSISTANT_SURFACES = ['composer', 'inbox', 'listening', 'analytics', 'planner', 'content_hub'] as const;
export type AssistantSurface = (typeof ASSISTANT_SURFACES)[number];

export const ASSISTANT_TASKS = [
  'draft_copy',             // draft or adapt social copy (composer, planner, content hub)
  'summarize_conversation', // inbox
  'suggest_reply',          // inbox — a draft for the agent to review; never sent by the assistant
  'suggest_triage',         // inbox — labels, routing and priority
  'translate',              // inbox message or reply draft / post copy — originals kept, never sent automatically
  'explain_analytics',      // analytics — observed numbers only
  'summarize_listening',    // listening — evidence-linked (needs listening sources)
  'campaign_brief',         // planner / composer
  'insight_to_draft',       // listening / analytics → a draft post or task preview
  'answer_question',        // any surface — authorized brand knowledge
] as const;
export type AssistantTask = (typeof ASSISTANT_TASKS)[number];

/** Which tasks each surface offers (UI + validation). */
export const SURFACE_TASKS: Record<AssistantSurface, readonly AssistantTask[]> = {
  composer: ['draft_copy', 'translate', 'campaign_brief', 'answer_question'],
  inbox: ['summarize_conversation', 'suggest_reply', 'suggest_triage', 'translate', 'answer_question'],
  listening: ['summarize_listening', 'insight_to_draft', 'answer_question'],
  analytics: ['explain_analytics', 'insight_to_draft', 'answer_question'],
  planner: ['campaign_brief', 'draft_copy', 'answer_question'],
  content_hub: ['answer_question', 'draft_copy', 'campaign_brief'],
};

export const TASK_LABEL: Record<AssistantTask, string> = {
  draft_copy: 'Draft copy',
  summarize_conversation: 'Summarize',
  suggest_reply: 'Suggest a reply',
  suggest_triage: 'Labels and routing',
  translate: 'Translate',
  explain_analytics: 'Explain results',
  summarize_listening: 'Summarize mentions',
  campaign_brief: 'Campaign brief',
  insight_to_draft: 'Insight to draft',
  answer_question: 'Ask',
};

/** What a run is about. The server resolves and authorizes it; the client only names it. */
export type AssistantContextRef =
  | { type: 'conversation'; id: string }
  | { type: 'post'; id: string }
  | { type: 'brand'; id: string }
  | { type: 'analytics'; brand_id: string; range_days: number }
  | { type: 'listening_query'; id: string };

export interface AssistantRunRequest {
  surface: AssistantSurface;
  task: AssistantTask;
  context: AssistantContextRef;
  /** Free text from the person (question, tone, brief). Their own words — still checked, never trusted for permissions. */
  prompt?: string | null;
  /** translate: target language (BCP 47 primary tag, e.g. 'de'). */
  target_language?: string | null;
  /** Client-generated; repeats return the same run. */
  idempotency_key: string;
}

export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'refused', 'not_configured', 'budget_exhausted', 'blocked', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export type SourceKind =
  | 'conversation'      // inbox messages (untrusted customer content)
  | 'saved_reply'       // approved saved reply text
  | 'knowledge'         // approved Content Hub document (snapshot)
  | 'brand_voice'       // brand settings
  | 'post'              // post draft/revision
  | 'analytics'         // stored analytics aggregates
  | 'listening';        // listening observations (stream D)

/** A source the run was allowed to read. Bodies are never stored here; `ref` is a key quoted by evidence items. */
export interface SourceRefDto {
  ref: string;                    // 's1', 's2', … (stable inside one run)
  kind: SourceKind;
  id: string | null;
  title: string;
  /** Relay link to open the source (permission re-checked on open). */
  link: string | null;
  /** When the underlying data was last refreshed / approved. */
  freshness: string | null;
  /** approved: an administrator-approved knowledge source; observed: Relay's stored data; untrusted: customer/imported content. */
  trust: 'approved' | 'observed' | 'untrusted';
  /** Knowledge past its review date: not used for commitments. */
  stale: boolean;
}

export interface EvidenceItem {
  source: string;                 // SourceRefDto.ref
  quote: string;                  // verbatim excerpt (checked against the source text)
  verified: boolean;              // false ⇒ the quote was not found in the cited source (shown as unverified)
}

export interface SuggestionItem {
  kind: 'reply' | 'copy' | 'summary' | 'translation' | 'brief' | 'answer' | 'labels' | 'explanation';
  text: string;
  /** Language of `text` (translation, replies). */
  language: string | null;
  /** Source refs the suggestion relies on. */
  based_on: string[];
  /** Deterministic checks (invented links/numbers, commitments without an approved source, length). */
  issues: Array<{ code: AssistantIssueCode; severity: 'block' | 'warn'; message: string }>;
}

export type AssistantIssueCode =
  | 'unsupported_number' | 'unsupported_link' | 'commitment_without_source' | 'stale_source' | 'empty' | 'too_long'
  | 'injection_in_source' | 'uncertain';

export const PROPOSED_ACTION_KINDS = [
  'use_reply_draft',      // put the suggested reply into the composer (the agent sends it)
  'apply_labels',         // inbox labels (inbox.reply)
  'set_priority',         // (inbox.reply)
  'assign',               // (inbox.assign)
  'add_note',             // internal note (inbox.read)
  'use_copy',             // put copy into the composer (drafts.edit; the person saves)
  'create_task',          // Relay task from an insight/brief (content.create)
] as const;
/** V5 (AIW): external actions a workflow run PREPARES; executed only after the person confirms the exact preview. Never model-proposable. */
export const EXTERNAL_ACTION_KINDS = ['schedule_post', 'submit_for_approval', 'send_reply'] as const;
export type ProposedActionKind = (typeof PROPOSED_ACTION_KINDS)[number] | (typeof EXTERNAL_ACTION_KINDS)[number];

export type ProposedActionStatus = 'proposed' | 'applied' | 'dismissed' | 'expired' | 'failed';

export interface ProposedActionDto {
  id: string;
  run_id: string;
  kind: ProposedActionKind;
  target: { type: 'conversation' | 'post' | 'brand'; id: string };
  /** Exactly what will change. */
  preview: { title: string; detail: string; params: Record<string, unknown> };
  /** Permission the person needs to apply it (checked again on apply). */
  requires: string;
  status: ProposedActionStatus;
  decided_at: string | null;
  error: string | null;
  expires_at: string;
}

export interface AssistantOutputDto {
  /** One short paragraph for the person. */
  summary: string;
  evidence: EvidenceItem[];
  suggestions: SuggestionItem[];
  /** True when the model said it could not answer from the sources, or checks found unsupported claims. */
  uncertain: boolean;
  uncertainty_reason: string | null;
  /** Instructions found inside untrusted sources (ignored; shown so the person knows). */
  ignored_instructions: number;
  notices: string[];
}

export interface AssistantRunDto {
  id: string;
  surface: AssistantSurface;
  task: AssistantTask;
  context: AssistantContextRef;
  brand_id: string | null;
  status: RunStatus;
  status_detail: string | null;
  output: AssistantOutputDto | null;
  sources: SourceRefDto[];
  actions: ProposedActionDto[];
  usage: { input_tokens: number; output_tokens: number; cost_estimate_usd: number | null } | null;
  provider: string | null;
  model: string | null;
  latency_ms: number | null;
  requested_by: { id: string; name: string | null } | null;
  automated: boolean;
  created_at: string;
  finished_at: string | null;
}

export interface AssistantStatusDto {
  /** A provider key is configured (env or Setup). Never reveals the key. */
  configured: boolean;
  reason: string | null;
  provider: string | null;
  can_use: boolean;
  period: string;
  used: number;
  cap: number;
  remaining: number;
}

export interface KnowledgeSourceDto {
  id: string;
  brand_id: string;
  kind: 'source_item' | 'saved_reply';
  ref_id: string;
  title: string;
  topics: string[];
  /** After this date the source is stale: never used for policy/price/refund/commitment answers. */
  review_by: string | null;
  approved_by: { id: string; name: string | null } | null;
  approved_at: string;
  available: boolean;           // the underlying item still exists and is readable (linked / not deleted)
  stale: boolean;
}

/** Message categories (deterministic classifier + optional model). Sensitive ones always escalate. */
export const MESSAGE_CATEGORIES = [
  'question', 'order_status', 'pricing', 'refund', 'complaint', 'praise', 'feedback', 'support', 'sales', 'spam', 'sensitive', 'other',
] as const;
export type MessageCategory = (typeof MESSAGE_CATEGORIES)[number];

/** Categories that always go to a person (never auto-replied). */
export const ALWAYS_ESCALATE: readonly MessageCategory[] = ['refund', 'complaint', 'sensitive'];

export interface ClassificationDto {
  conversation_id: string;
  message_id: string;
  category: MessageCategory;
  sentiment: 'negative' | 'neutral' | 'positive';
  language: string | null;
  urgency: 'low' | 'normal' | 'high';
  /** Why (matched signals) — never message text. */
  signals: string[];
  /** Instruction-like text found in the message (treated as data). */
  injection_suspected: boolean;
  uncertain: boolean;
  method: 'rules' | 'model';
  created_at: string;
}
