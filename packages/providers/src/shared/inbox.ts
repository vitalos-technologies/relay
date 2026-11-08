// Shared helpers for the V3.5 inbox adapters (stream B): outcome mapping for customer replies and small parsing
// utilities. Replies follow the foundation rules (contracts/v35-inbox.ts): a refusal before acting is `retry`, a provider
// refusal is `rejected` (nothing sent), and anything that may have reached the provider without a definite answer is
// `unknown` (reconciled through findSent, never resent blindly).
import { TransportError } from '@social-lite/core';
import type { ModerationResult, SendReplyResult } from '@social-lite/core/contracts/v35-inbox';
import type { ErrorClass } from './classify.js';
import { ProviderHttpError } from './http.js';

export const clip = (s: unknown, n = 4000): string => (typeof s === 'string' ? s.slice(0, n) : '');
export const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null);

export function epochToIso(v: unknown, fallback = new Date()): string {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  if (Number.isFinite(n)) return new Date(n > 1e12 ? n : n * 1000).toISOString();
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return fallback.toISOString();
}

/** Map a classified provider error to a reply outcome. `server`/`duplicate` on a send ⇒ unknown (may have been sent). */
export function replyFromClass(c: ErrorClass, network: string): SendReplyResult {
  switch (c.kind) {
    case 'rate_limited': case 'cap':
      return { kind: 'retry', code: c.code, message: `${network} is rate-limiting this account. The reply will be retried.`, retryAfterMs: c.retryAfterMs };
    case 'server': case 'duplicate':
      return { kind: 'unknown', code: c.code, message: `${network} did not confirm the reply. Checking whether it was sent before doing anything else.` };
    case 'reconnect':
      return { kind: 'rejected', code: c.code, message: `${network} no longer accepts this connection. Reconnect the account.`, reconnect: true };
    case 'permission':
      return { kind: 'rejected', code: 'permission_denied', message: `${network} refused the reply: a permission is missing or was removed.` };
    case 'budget':
      return { kind: 'rejected', code: c.code, message: c.message };
    default:
      return { kind: 'rejected', code: c.code, message: `${network} rejected the reply. ${c.message}`.trim() };
  }
}

/** Transport failures: never connected ⇒ safe retry; otherwise the request may have arrived ⇒ unknown. */
export function replyFromTransport(err: TransportError, network: string): SendReplyResult {
  if (!err.requestMayHaveBeenSent) return { kind: 'retry', code: 'connect_failed', message: `${network} could not be reached. The reply will be retried.` };
  return { kind: 'unknown', code: 'response_lost', message: `The connection to ${network} dropped after sending. Checking whether the reply arrived.` };
}

export function replyFromError(err: unknown, classify: (e: ProviderHttpError, nowMs: number) => ErrorClass, network: string, nowMs = Date.now()): SendReplyResult {
  if (err instanceof TransportError) return replyFromTransport(err, network);
  if (err instanceof ProviderHttpError) return replyFromClass(classify(err, nowMs), network);
  throw err;
}

/** Moderation is idempotent at the provider (hide twice = hidden): every failure that is not a refusal is retryable. */
export function moderationFromError(err: unknown, classify: ((e: ProviderHttpError, nowMs: number) => ErrorClass) | null, network: string, nowMs = Date.now()): ModerationResult {
  if (err instanceof TransportError) return { ok: false, code: 'network', message: `${network} could not be reached. Try again.`, retryable: true };
  if (err instanceof ProviderHttpError && classify) {
    const c = classify(err, nowMs);
    if (c.kind === 'reconnect') return { ok: false, code: c.code, message: `${network} no longer accepts this connection. Reconnect the account.`, retryable: false, reconnect: true };
    if (c.kind === 'permission') return { ok: false, code: 'permission_denied', message: `${network} refused: a moderation permission is missing.`, retryable: false };
    if (c.kind === 'rate_limited' || c.kind === 'cap' || c.kind === 'server') return { ok: false, code: c.code, message: `${network} is busy. Try again shortly.`, retryable: true };
    return { ok: false, code: c.code, message: `${network} refused this action.`, retryable: false };
  }
  throw err;
}

/** Normalised text equality used by findSent (whitespace-insensitive, exact otherwise). */
export const sameText = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a ?? '').replace(/\s+/g, ' ').trim() === (b ?? '').replace(/\s+/g, ' ').trim();

/** One match ⇒ found; several ⇒ ambiguous (a person decides); none ⇒ not found. */
export function oneMatch<T extends { id: string }>(items: T[]): { found: true; externalId: string } | { found: false } | { found: 'ambiguous' } {
  if (items.length === 1) return { found: true, externalId: items[0]!.id };
  return items.length > 1 ? { found: 'ambiguous' } : { found: false };
}
