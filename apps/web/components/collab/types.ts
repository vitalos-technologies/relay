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
