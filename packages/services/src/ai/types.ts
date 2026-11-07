// Shared types for AI caption assistance (V1.1, spec §16). Suggestions are advisory only: the server
// never writes a draft; the user accepts a suggestion in the composer, which saves through the normal
// PATCH /api/posts/:id with expected_version.
import { z } from 'zod';

export const AI_TASKS = ['shorten', 'tone', 'variants', 'hashtags', 'repurpose'] as const;
export type AiTask = (typeof AI_TASKS)[number];

export const suggestRequestSchema = z.object({
  task: z.enum(AI_TASKS),
  connection_ids: z.array(z.string().uuid()).max(20).optional(),
  tone: z.string().trim().min(1).max(200).optional(),
  source_url: z.string().trim().url().max(2000).optional(),
  source_post_id: z.string().uuid().optional(),
}).strict();
export type SuggestRequest = z.infer<typeof suggestRequestSchema>;

/** block => the suggestion is rejected (cannot be accepted); warn => flagged for the user. */
export type IssueSeverity = 'block' | 'warn';

export type IssueCode =
  | 'fact_altered' | 'fact_dropped' | 'fact_invented'
  | 'link_dropped' | 'link_invented'
  | 'prohibited_phrase' | 'over_limit' | 'too_many_hashtags' | 'empty'
  // V3.1 (§12): wording that turns a probability/estimate into a promise ("guaranteed", "sure win") not in the source.
  | 'promise_language';

export interface SuggestionIssue {
  code: IssueCode;
  severity: IssueSeverity;
  message: string;
}

export interface Suggestion {
  /** 'base' or a connection id. */
  scope: string;
  /** Text the suggestion was generated from (left side of the diff). */
  before: string;
  text: string;
  hashtags: string[];
  note: string | null;
  issues: SuggestionIssue[];
  /** true when any issue has severity 'block'. */
  rejected: boolean;
}

export interface SuggestResponse {
  suggestions: Suggestion[];
  usage: { input: number; output: number; remaining: number; cap: number };
  fixture: boolean;
  model: string;
  post_version: number;
  notices: string[];
}

export interface AiStatus {
  configured: boolean;
  reason: string | null;
  fixture: boolean;
  model: string;
  can_use: boolean;
  period: string;
  used: number;
  cap: number;
  remaining: number;
}
