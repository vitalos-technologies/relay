'use client';
// Shared admin status badges (used by several admin pages).
import type { AdminDeliveryItem, AdminDeliveryState, PlatformWorkspaceItem, SupportAccessDto } from '@social-lite/core/contracts/v31-admin';
import { Badge } from '@/components/ui';
import type { Tone } from '@/components/ui/feedback';

export const DISPLAY: Record<AdminDeliveryState, { label: string; tone: Tone }> = {
  awaiting_approval: { label: 'Awaiting approval', tone: 'info' }, scheduled: { label: 'Scheduled', tone: 'info' }, queued: { label: 'Queued', tone: 'info' },
  processing: { label: 'Processing', tone: 'info' }, provider_scheduled: { label: 'Provider-scheduled', tone: 'info' }, published: { label: 'Published', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' }, unknown: { label: 'Unknown', tone: 'warn' }, cancelled: { label: 'Cancelled', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'danger' }, paused: { label: 'Paused', tone: 'neutral' }, blocked: { label: 'Held', tone: 'warn' },
  retrying: { label: 'Retrying', tone: 'warn' }, handoff: { label: 'Manual handoff', tone: 'warn' },
};

export function DeliveryBadge({ d }: { d: Pick<AdminDeliveryItem, 'display_state' | 'is_mock'> }) {
  const s = DISPLAY[d.display_state];
  return <span className="inline-flex flex-wrap items-center gap-1"><Badge tone={s.tone}>{d.display_state === 'published' && d.is_mock ? 'Simulated · delivered' : s.label}</Badge></span>;
}


export function WsState({ w }: { w: Pick<PlatformWorkspaceItem, 'state' | 'is_demo' | 'publishing_paused'> }) {
  return <span className="inline-flex flex-wrap gap-1">{w.state === 'suspended' ? <Badge tone="danger">Suspended</Badge> : w.publishing_paused ? <Badge>Paused</Badge> : <Badge tone="success">Active</Badge>}{w.is_demo ? <Badge tone="info">Demo</Badge> : null}</span>;
}


export const SUPPORT_LABEL: Record<SupportAccessDto['status'], string> = { requested: 'Waiting for approval', active: 'Active', declined: 'Declined', ended: 'Ended', cancelled: 'Cancelled', lapsed: 'Lapsed' };
export const SUPPORT_TONE: Record<SupportAccessDto['status'], 'info' | 'success' | 'neutral' | 'warn'> = { requested: 'warn', active: 'success', declined: 'neutral', ended: 'neutral', cancelled: 'neutral', lapsed: 'neutral' };
