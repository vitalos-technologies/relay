// Normalised error classes for the V3 providers and their mapping to engine outcomes.
// Each provider classifies its own error bodies into an ErrorClass; these helpers turn that into
// PrepareOutcome / PublishOutcome / MetricsOutcome consistently:
//   auth ⇒ reconnect, permission ⇒ missing permission, budget/quota ⇒ blocking, rate limit ⇒ retry later,
//   server error or lost response on a publishing request ⇒ unknown (never blindly re-sent).
import { TransportError, type BlockingReason, type Checkpoint, type PrepareOutcome, type PublishOutcome } from '@social-lite/core';
import type { MetricsOutcome } from '../metrics.js';

export type ErrorClass =
  | { kind: 'rate_limited'; code: string; message: string; retryAfterMs: number }
  /** Daily/user cap: the request was refused safely; try again much later (not a blocking budget). */
  | { kind: 'cap'; code: string; message: string; retryAfterMs: number }
  | { kind: 'budget'; code: string; message: string }
  | { kind: 'reconnect'; code: string; message: string }
  | { kind: 'permission'; code: string; message: string }
  | { kind: 'duplicate'; code: string; message: string }
  | { kind: 'not_found'; code: string; message: string }
  | { kind: 'invalid'; code: string; message: string }
  | { kind: 'server'; code: string; message: string };

const blockingOf = (k: ErrorClass['kind']): BlockingReason | undefined =>
  k === 'reconnect' ? 'reconnect' : k === 'permission' ? 'permission' : k === 'budget' ? 'budget' : undefined;

/** Preparation creates nothing visible: server errors and lost responses are safely retryable. */
export function prepareFromClass(c: ErrorClass, checkpoint?: Checkpoint): PrepareOutcome {
  switch (c.kind) {
    case 'rate_limited':
    case 'cap':
      return { kind: 'retryable', code: c.code, message: c.message, retryAfterMs: c.retryAfterMs, ...(checkpoint ? { checkpoint } : {}) };
    case 'server':
      return { kind: 'retryable', code: c.code, message: `${c.message} Media preparation will be retried.`, ...(checkpoint ? { checkpoint } : {}) };
    case 'reconnect':
    case 'permission':
    case 'budget':
      return { kind: 'permanent', code: c.code, message: c.message, blocking: blockingOf(c.kind) };
    default:
      return { kind: 'permanent', code: c.code, message: c.message };
  }
}

/** Final publish: anything that may have reached the provider without a definite answer is Unknown. */
export function publishFromClass(c: ErrorClass): PublishOutcome {
  switch (c.kind) {
    case 'rate_limited':
    case 'cap':
      return { kind: 'rejected_safe_to_retry', code: c.code, message: c.message, retryAfterMs: c.retryAfterMs };
    case 'server':
      return { kind: 'unknown', code: c.code, message: `${c.message} The post may or may not have been created; it will be reconciled.` };
    case 'duplicate':
      return { kind: 'unknown', code: c.code, message: c.message };
    case 'reconnect':
    case 'permission':
    case 'budget':
      return { kind: 'permanent_failure', code: c.code, message: c.message, blocking: blockingOf(c.kind) };
    default:
      return { kind: 'permanent_failure', code: c.code, message: c.message };
  }
}

export function metricsFromClass(c: ErrorClass, provider: string): MetricsOutcome {
  switch (c.kind) {
    case 'reconnect': return { kind: 'reconnect', message: c.message };
    case 'permission': return { kind: 'permission_missing', message: c.message };
    case 'budget': return { kind: 'budget', message: c.message };
    case 'rate_limited':
    case 'cap': return { kind: 'rate_limited', message: c.message, retryAfterMs: c.retryAfterMs };
    case 'not_found': return { kind: 'not_found', message: c.message };
    default: return { kind: 'error', code: c.code, message: `${provider} could not return metrics right now.` };
  }
}

/** Transport failure during preparation (no visible content): always retryable. */
export function prepareTransport(err: unknown, provider: string, checkpoint?: Checkpoint): PrepareOutcome {
  const what = err instanceof TransportError ? 'network' : 'unexpected';
  return { kind: 'retryable', code: what, message: `Could not complete the upload to ${provider}; it will be retried from the last checkpoint.`, ...(checkpoint ? { checkpoint } : {}) };
}

/** Transport failure on a publishing request: only a pre-connect failure is provably safe. */
export function publishTransport(err: unknown, provider: string): PublishOutcome {
  if (err instanceof TransportError && !err.requestMayHaveBeenSent) {
    return { kind: 'rejected_safe_to_retry', code: 'network_unreachable', message: `Could not connect to ${provider}; nothing was sent.` };
  }
  return { kind: 'unknown', code: 'response_lost', message: `The connection to ${provider} was lost after the request was sent; the post may have been created. It will be reconciled.` };
}

export const HOUR_MS = 3_600_000;
