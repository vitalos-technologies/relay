// Destination delivery state machine (spec §11). Every state write in the engine
// must pass assertTransition. Permanent failure may occur from any active state.
import type { DeliveryState, PostAggregateStatus } from './types.js';

const ACTIVE: DeliveryState[] = ['scheduled', 'preparing', 'publishing', 'processing', 'retry_wait', 'blocked', 'paused'];

const T: Record<DeliveryState, DeliveryState[]> = {
  scheduled: ['preparing', 'blocked', 'paused', 'cancelled', 'expired', 'failed'],
  preparing: ['publishing', 'retry_wait', 'scheduled', 'processing', 'blocked', 'paused', 'cancelled', 'expired', 'failed'],
  publishing: ['published', 'processing', 'unknown', 'retry_wait', 'failed', 'blocked'],
  processing: ['published', 'unknown', 'failed', 'processing'],
  retry_wait: ['scheduled', 'preparing', 'failed', 'expired', 'cancelled', 'paused', 'blocked'],
  blocked: ['scheduled', 'cancelled', 'expired', 'failed'],
  paused: ['scheduled', 'cancelled', 'expired'],
  unknown: ['published', 'failed', 'scheduled' /* manual retry with duplicate-risk ack */],
  published: [],
  failed: ['scheduled' /* manual retry */],
  cancelled: [],
  expired: [],
};

export function canTransition(from: DeliveryState, to: DeliveryState): boolean {
  if (from === to && from === 'processing') return true;
  return T[from].includes(to);
}

export function assertTransition(from: DeliveryState, to: DeliveryState): void {
  if (!canTransition(from, to)) throw new Error(`illegal delivery transition ${from} -> ${to}`);
}

export function isActive(s: DeliveryState): boolean {
  return ACTIVE.includes(s);
}

/** Cancellation is only guaranteed before the outbound request begins. */
export function isCancellable(s: DeliveryState, phase: string): boolean {
  if (s === 'preparing') return phase !== 'sending';
  return s === 'scheduled' || s === 'retry_wait' || s === 'blocked' || s === 'paused';
}

/** DE-02: derive a parent status from destination states. Never hides failures. */
export function aggregateStatus(states: DeliveryState[]): PostAggregateStatus {
  if (states.length === 0) return 'draft';
  const n = (s: DeliveryState) => states.filter((x) => x === s).length;
  const published = n('published');
  const attention = n('unknown') + n('blocked');
  const failed = n('failed') + n('expired');
  const inFlight = n('preparing') + n('publishing') + n('processing') + n('retry_wait');
  const waiting = n('scheduled') + n('paused');
  if (published === states.length) return 'published';
  if (n('cancelled') === states.length) return 'cancelled';
  if (n('expired') === states.length) return 'expired';
  if (attention > 0) return 'needs_attention';
  if (inFlight > 0) return 'publishing';
  if (published > 0 && (failed > 0 || n('cancelled') > 0) && waiting === 0) return 'partial';
  if (published > 0 && waiting > 0) return 'publishing';
  if (failed > 0 && waiting === 0) return 'failed';
  return 'scheduled';
}

export const DELIVERY_STATE_LABEL: Record<DeliveryState, string> = {
  scheduled: 'Scheduled', preparing: 'Preparing', publishing: 'Publishing', processing: 'Processing',
  retry_wait: 'Retrying soon', published: 'Published', failed: 'Failed', blocked: 'Blocked',
  paused: 'Paused', cancelled: 'Cancelled', expired: 'Expired', unknown: 'Unknown — needs review',
};
