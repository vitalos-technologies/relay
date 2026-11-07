// Client shapes for stream C (collaboration) APIs.
import type { Provider } from '@social-lite/core';

export interface StageDef { position?: number; name: string; quorum: number; eligible_roles: Array<'owner' | 'admin' | 'approver'>; eligible_team_ids: string[]; allow_guests: boolean }
export interface PolicyDto {
  brand_id: string; generation: number; separation_of_duties: boolean; stages: StageDef[]; updated_at: string | null; updated_by_email: string | null;
  teams: Array<{ id: string; name: string }>; can_manage: boolean;
}

export interface StageProgress { position: number; name: string; quorum: number; approvals: number; met: boolean; allow_guests: boolean }
export interface ReviewState {
  policy_generation: number | null; current_policy_generation: number; separation_of_duties: boolean; current_stage: number; stage_count: number;
  stages: StageProgress[];
  decisions: Array<{ stage: number; decision: string; by: string | null; as_guest: boolean; at: string; reason: string | null; counted: boolean }>;
  me: { eligible: boolean; reason: string | null; stage: number | null };
  assignee: { id: string; email: string } | null; due_at: string | null;
}

export interface InboxItem {
  id: string; decision: 'pending' | 'approved' | 'rejected' | 'invalidated'; post_id: string; brand_id: string; brand_name: string; title: string | null; excerpt: string;
  requested_by_email: string | null; reviewer_email: string | null; requested_at: string; decided_at: string | null; fingerprint: string;
  due_at: string | null; publish_on_approval: boolean; input_timezone: string; review_due_at: string | null; revision_number: number;
  assignee: { id: string; email: string | null; name: string | null } | null; campaign_name: string | null;
  destinations: Array<{ provider: Provider }>;
  stage: { current: number; count: number; name: string | null; approvals?: number; quorum?: number };
  can_decide: boolean;
}

export interface CommentDto {
  id: string; post_id: string; approval_id: string | null; visibility: 'internal' | 'shared';
  author: { id: string; name: string | null; email: string | null } | null; body: string; created_at: string; mine: boolean; mentions: string[];
}

export interface VersionDto {
  id: string; version: number | null; base_version: number; kind: 'created' | 'saved' | 'conflict' | 'restored' | 'recovered'; title: string | null;
  draft: { baseText?: string; baseLink?: string | null; variants?: Array<{ connectionId: string; text?: string; inheritText?: boolean }> };
  saved_by_email: string | null; restored_from: string | null; created_at: string;
}

export interface PlanningDto {
  campaign: { id: string; name: string | null } | null; assignee: { id: string; email: string | null; name: string | null } | null;
  due_at: string | null; team: { id: string; name: string | null } | null; can_edit: boolean;
}

export const INELIGIBLE: Record<string, string> = {
  no_authority: 'No approval permission on this brand',
  role_not_eligible: 'Your role isn’t eligible for this stage',
  team_not_eligible: 'Only listed teams can approve this stage',
  guests_not_allowed: 'Guests can’t approve this stage',
  not_shared: 'Not shared with you',
  separation_of_duties: 'You worked on this content',
  decided: 'You already approved',
  not_pending: 'Closed',
  stale: 'Policy changed — needs resubmission',
};

// ------------------------------------------------------------------ collaboration completion
export interface PersonRef { name: string; email: string | null; active: boolean }
export type People = Record<string, PersonRef>;

export interface ThreadComment {
  id: string; thread_id: string; post_id: string; approval_id: string | null; visibility: 'internal' | 'shared';
  author: { id: string; name: string | null; email: string | null } | null; body: string | null; deleted: boolean; edited: boolean; edited_at: string | null;
  created_at: string; mine: boolean; can_edit: boolean; can_delete: boolean; mentions: string[];
}

export type ThreadAnchor =
  | { kind: 'text'; field: 'base' | 'variant'; connection_id?: string | null; quote: string; prefix?: string; suffix?: string }
  | { kind: 'media'; asset_id: string };

export interface ThreadDto {
  id: string; post_id: string; approval_id: string | null; visibility: 'internal' | 'shared'; created_by: string | null; created_at: string;
  resolved: boolean; resolved_at: string | null; last_activity_at: string; anchor: ThreadAnchor | null; anchor_version: number | null;
  anchor_status: 'none' | 'current' | 'moved' | 'outdated'; revision_number: number | null; comment_count: number; hidden_replies: number; unread: boolean;
  can: { reply: boolean; resolve: boolean; change_visibility: boolean };
  comments: ThreadComment[];
}

export interface ThreadList {
  items: ThreadDto[]; counts: { open: number; resolved: number; unread: number }; cursor: number; next_cursor: string | null; people: People;
  can: { internal: boolean; shared: boolean; moderate: boolean }; current_version: number;
}

export type TaskStatus = 'open' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export interface TaskDto {
  id: string; brand: { id: string; name: string }; title: string; description: string | null;
  reference: { type: 'review'; id: string; post_id: string | null } | { type: 'post'; id: string; title: string | null } | { type: 'campaign'; id: string; name: string | null } | null;
  post_id: string | null; campaign_id: string | null; approval_id: string | null;
  assignee: { id: string; name: string | null; email: string | null } | null; creator: { id: string; name: string | null; email: string | null } | null;
  due_at: string | null; due_timezone: string; due_local: string | null; overdue: boolean; priority: TaskPriority; status: TaskStatus; blocked_reason: string | null;
  needs_reassignment: boolean; version: number; created_at: string; updated_at: string; closed_at: string | null; follower_count: number; following: boolean;
  next_action: string; can: { edit: boolean; change_status: boolean };
  followers?: Array<{ id: string; name: string | null; email: string }>;
  history?: Array<{ id: string; kind: string; detail: Record<string, unknown>; actor: { id: string | null; name: string | null; email: string | null } | null; at: string }>;
}

export interface HistoryItem {
  id: string; version: number | null; base_version: number; kind: string; current: boolean; author: { id: string; name: string | null; email: string | null } | null;
  created_at: string; restored_from: string | null; changed: string[]; summary: string; open_threads: number;
}
export interface RevisionItem {
  id: string; revision_number: number; created_at: string; created_by: string | null; post_version: number | null; older_than_current: boolean;
  approvals: Array<{ id: string; decision: string; requested_at: string; decided_at: string | null; reason: string | null; stage: number; stage_count: number; applies_to_current: boolean }>;
  publications: Array<{ provider: string; account: string; state: string; url: string | null; published_at: string | null; simulated: boolean }>;
}
export interface HistoryPage { current_version: number; items: HistoryItem[]; next_cursor: string | null; revisions: RevisionItem[]; can_restore: boolean }

export interface CompareDto {
  from: { ref: string; label: string; version: number | null; schedule: { due_at: string | null; status: string; timezone: string } | null };
  to: { ref: string; label: string; version: number | null; schedule: { due_at: string | null; status: string; timezone: string } | null };
  changed: string[]; summary: string;
  title: { before: string; after: string }; text: { before: string; after: string }; link: { before: string | null; after: string | null };
  media: { before: string[]; after: string[] }; destinations: { added: string[]; removed: string[] };
  variants: Array<{ connection_id: string; provider: string | null; account: string; before_text: string | null; after_text: string | null; custom_before: boolean | null; custom_after: boolean | null;
    link_before: string | null; link_after: string | null; media_before: string[]; media_after: string[]; options_changed: string[]; changed: boolean }>;
  assets: Array<{ id: string; thumb_url: string | null; alt_text: string | null; media_kind: string }>;
}
