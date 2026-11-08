// JSON shapes per docs/API.md for posts, schedules, approvals and deliveries.
import { CONNECTION_STATUS_LABEL, DELIVERY_STATE_LABEL, isDeliveryOverdue, type DeliveryState, type Provider } from '@social-lite/core';
import type { ConnectionRow } from './shared.js';

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export function connectionJson(c: ConnectionRow) {
  return {
    id: c.id, brand_id: c.brand_id, provider: c.provider, provider_account_id: c.provider_account_id,
    display_name: c.display_name, username: c.username, status: c.status, status_label: CONNECTION_STATUS_LABEL[c.status],
    is_mock: c.is_mock, capabilities: c.capabilities ?? {}, paused: c.paused,
    health: { message: (c.health_detail?.message as string) ?? '', checked_at: iso(c.health_checked_at),
      missing_permissions: c.health_detail?.missingPermissions, expires_at: c.health_detail?.expiresAt },
    throttled_until: iso(c.throttled_until), mock_scenario: c.is_mock ? (c.metadata?.mock_scenario ?? 'success') : undefined,
    created_at: iso(c.created_at), disconnected_at: iso(c.disconnected_at),
  };
}

export interface ScheduleRow {
  id: string; post_id: string; revision_id: string; revision_number?: number; generation: number; due_at: Date;
  input_timezone: string; input_local_time: string; input_offset: string | null; publish_before: Date; is_immediate: boolean;
  status: string; created_at: Date; created_by_email?: string | null; fingerprint: string;
}

export function scheduleJson(s: ScheduleRow) {
  return {
    id: s.id, post_id: s.post_id, revision_id: s.revision_id, revision_number: s.revision_number ?? null, generation: s.generation,
    due_at: iso(s.due_at), input_timezone: s.input_timezone, input_local_time: s.input_local_time, input_offset: s.input_offset,
    publish_before: iso(s.publish_before), is_immediate: s.is_immediate, status: s.status, created_at: iso(s.created_at),
    created_by_email: s.created_by_email ?? null, fingerprint: s.fingerprint,
  };
}

export interface ApprovalRow {
  id: string; decision: string; requested_by_email?: string | null; reviewer_email?: string | null; decided_at: Date | null;
  reason: string | null; fingerprint: string; requested_at: Date; post_id: string; schedule_id: string; revision_id: string; brand_id: string;
}

export function approvalJson(a: ApprovalRow) {
  return {
    id: a.id, decision: a.decision, requested_by_email: a.requested_by_email ?? null, reviewer_email: a.reviewer_email ?? null,
    decided_at: iso(a.decided_at), reason: a.reason, fingerprint: a.fingerprint, requested_at: iso(a.requested_at),
    post_id: a.post_id, schedule_id: a.schedule_id, revision_id: a.revision_id, brand_id: a.brand_id,
  };
}

export interface DeliveryRow {
  id: string; schedule_id: string; post_id: string; connection_id: string; provider: Provider; display_name?: string; is_mock: boolean;
  state: DeliveryState; phase: string; due_at: Date; publish_before: Date; attempt_count: number; max_attempts: number; next_attempt_at: Date;
  provider_ids: string[]; provider_url: string | null; published_at: Date | null; last_error_code: string | null; last_error_message: string | null;
  blocked_reason: string | null; unknown_since: Date | null; needs_reconcile: boolean; brand_id: string; workspace_id: string;
}

/** Retry eligibility shown to the UI; the server re-checks on POST. */
export function retryInfo(d: Pick<DeliveryRow, 'state' | 'publish_before'>): { can_retry: boolean; retry_requires_ack: boolean } {
  if (d.state === 'unknown') return { can_retry: true, retry_requires_ack: true };
  if (d.state === 'failed' || d.state === 'expired') return { can_retry: true, retry_requires_ack: false };
  return { can_retry: false, retry_requires_ack: false };
}

export function deliveryJson(d: DeliveryRow, attempts?: unknown[]) {
  return {
    id: d.id, schedule_id: d.schedule_id, post_id: d.post_id, connection_id: d.connection_id, provider: d.provider,
    display_name: d.display_name ?? null, is_mock: d.is_mock, state: d.state,
    state_label: d.is_mock && d.state === 'published' ? 'Simulated' : DELIVERY_STATE_LABEL[d.state],
    phase: d.phase, due_at: iso(d.due_at), publish_before: iso(d.publish_before), attempt_count: d.attempt_count, max_attempts: d.max_attempts,
    next_attempt_at: iso(d.next_attempt_at), provider_ids: d.provider_ids, provider_url: d.provider_url, published_at: iso(d.published_at),
    last_error_code: d.last_error_code, last_error_message: d.last_error_message, blocked_reason: d.blocked_reason,
    unknown_since: iso(d.unknown_since), needs_reconcile: d.needs_reconcile, ...retryInfo(d),
    overdue: isDeliveryOverdue(d.state, d.next_attempt_at),
    ...(attempts ? { attempts } : {}),
  };
}

export const DELIVERY_SELECT = `d.id, d.schedule_id, d.post_id, d.connection_id, d.provider, c.display_name, d.is_mock, d.state, d.phase,
  d.due_at, d.publish_before, d.attempt_count, d.max_attempts, d.next_attempt_at, d.provider_ids, d.provider_url, d.published_at,
  d.last_error_code, d.last_error_message, d.blocked_reason, d.unknown_since, d.needs_reconcile, d.brand_id, d.workspace_id`;
