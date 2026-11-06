// Meta Graph error normalisation (spec §11 error policy). The table below is the single source of
// truth; docs/providers/meta.md mirrors it. Messages are written by us — raw provider messages,
// bodies and tokens are never surfaced.
//
// Sources (checked 2026-11-06):
//   https://developers.facebook.com/docs/graph-api/guides/error-handling
//   https://developers.facebook.com/docs/graph-api/overview/rate-limiting
//   https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/error-codes
import { TransportError, type BlockingReason, type Checkpoint, type PrepareOutcome, type PublishOutcome } from '@social-lite/core';
import type { GraphErrorInfo } from './graph.js';

export type MetaErrorClass =
  | 'reconnect'          // token expired / revoked / invalid session
  | 'permission'         // permission not granted or removed, Page role lost
  | 'rate_limit'         // throttled; the request was rejected, nothing created
  | 'transient'          // documented temporary error (explicit is_transient or IG "try again" subcodes)
  | 'server_error'       // 5xx / unknown failure without a transient flag: ambiguous for publishes
  | 'duplicate'          // 506: an earlier attempt may already have posted it
  | 'not_ready'          // IG container not finished yet
  | 'container_expired'  // IG container expired / not found => create a fresh one
  | 'invalid'            // content / parameter problem: fail with exact fix
  | 'policy';            // policy block / spam flag / restricted account

export interface NormalizedMetaError {
  cls: MetaErrorClass;
  /** Stable internal code (stored as last_error_code). */
  code: string;
  /** Safe, user-facing message with the exact fix. */
  message: string;
  retryAfterMs?: number;
  blocking?: BlockingReason;
}

export const DEFAULT_RATE_LIMIT_BACKOFF_MS = 15 * 60_000;
const TRANSIENT_BACKOFF_MS = 60_000;

const RECONNECT_MSG = 'Meta no longer accepts this connection (the login expired, was revoked, or the password changed). Reconnect the account in Settings → Connections.';
const PERMISSION_MSG = 'Meta refused the request because a required permission is missing or your Page role changed. Reconnect and grant every requested permission, and make sure you can create content on the Page.';

interface Rule { cls: MetaErrorClass; code: string; message: string; blocking?: BlockingReason }

/** Instagram content-publishing subcodes (verified: IG error-codes reference). */
const IG_SUBCODES: Record<number, Rule> = {
  2207001: { cls: 'transient', code: 'ig_server_error', message: 'Instagram had a temporary server error. It will be retried.' },
  2207003: { cls: 'transient', code: 'ig_download_timeout', message: 'Instagram timed out downloading the image. It will be retried.' },
  2207004: { cls: 'invalid', code: 'image_too_large', message: 'Instagram: the image is larger than 8 MB. Use a smaller JPEG.' },
  2207005: { cls: 'invalid', code: 'image_format', message: 'Instagram: the image format is not supported. Use a JPEG image.' },
  2207006: { cls: 'container_expired', code: 'ig_media_not_found', message: 'Instagram could not find the prepared media. A new upload will be prepared.' },
  2207008: { cls: 'container_expired', code: 'ig_container_expired', message: 'The prepared Instagram upload expired. A new upload will be prepared.' },
  2207009: { cls: 'invalid', code: 'aspect_ratio', message: 'Instagram: the image aspect ratio must be between 4:5 and 1.91:1. Crop the image.' },
  2207010: { cls: 'invalid', code: 'caption_too_long', message: 'Instagram: captions are limited to 2,200 characters, 30 hashtags and 20 @mentions. Shorten the caption.' },
  2207020: { cls: 'container_expired', code: 'ig_media_expired', message: 'The prepared Instagram upload expired. A new upload will be prepared.' },
  2207023: { cls: 'invalid', code: 'media_type', message: 'Instagram did not recognise the media type. Use a single JPEG image.' },
  2207026: { cls: 'invalid', code: 'video_format', message: 'Instagram: unsupported video format. Only single JPEG images are supported in this release.' },
  2207027: { cls: 'not_ready', code: 'ig_media_not_ready', message: 'Instagram is still processing the image. Publishing will be retried shortly.' },
  2207032: { cls: 'transient', code: 'ig_media_create_failed', message: 'Instagram failed to create the media. It will be retried.' },
  2207040: { cls: 'invalid', code: 'too_many_mentions', message: 'Instagram: use at most 20 @mentions.' },
  2207042: { cls: 'rate_limit', code: 'ig_publish_limit', message: 'Instagram: this account reached its daily API publishing limit. Publishing will resume when the limit resets.' },
  2207050: { cls: 'policy', code: 'ig_account_restricted', message: 'Instagram: the account is inactive, checkpointed or restricted. Sign in to the Instagram app, complete any requested actions, then retry.', blocking: 'permission' },
  2207051: { cls: 'policy', code: 'ig_spam_flagged', message: 'Instagram flagged this publish action as spam and blocked it. Review the content and retry manually later.' },
  2207052: { cls: 'invalid', code: 'image_fetch_failed', message: 'Instagram could not download the image. Re-upload the image and try again.' },
  2207053: { cls: 'transient', code: 'ig_upload_error', message: 'Instagram had an unknown upload error. A new upload will be prepared.' },
};

/** IG top-level codes whose documented subcode we know (used when the subcode is absent). */
const IG_CODE_ALIASES: Record<number, number> = { 36000: 2207004, 36001: 2207005, 36003: 2207009, 36004: 2207010, 25: 2207050 };

const RECONNECT_SUBCODES = new Set([458, 459, 460, 463, 464, 467]);
const RATE_LIMIT_CODES = new Set([4, 17, 32, 341, 613, 80001, 80002]);

function rule(e: GraphErrorInfo): Rule {
  const code = e.code;
  if (e.subcode !== null && IG_SUBCODES[e.subcode]) return IG_SUBCODES[e.subcode]!;
  if (e.subcode === 492) return { cls: 'permission', code: 'page_role_missing', message: 'Your Facebook account no longer has a role on this Page that allows posting. Ask a Page admin to restore your access, then reconnect.', blocking: 'permission' };
  if (e.subcode === 459 || e.subcode === 464) return { cls: 'reconnect', code: 'user_checkpointed', message: 'Facebook requires you to log in on facebook.com to resolve a security check. Do that, then reconnect the account.', blocking: 'reconnect' };
  if (code === 190 || code === 102 || code === 104 || code === 2500 || (e.subcode !== null && RECONNECT_SUBCODES.has(e.subcode))) {
    return { cls: 'reconnect', code: 'token_invalid', message: RECONNECT_MSG, blocking: 'reconnect' };
  }
  if (code === 10 || code === 3 || (code !== null && code >= 200 && code <= 299)) {
    return { cls: 'permission', code: 'permission_denied', message: PERMISSION_MSG, blocking: 'permission' };
  }
  if (code === 9 && e.subcode === null) return { cls: 'rate_limit', code: 'ig_publish_limit', message: IG_SUBCODES[2207042]!.message };
  if (code !== null && RATE_LIMIT_CODES.has(code)) return { cls: 'rate_limit', code: 'rate_limited', message: 'Meta is rate-limiting this account. Publishing will be retried after the limit resets.' };
  if (code === 506) return { cls: 'duplicate', code: 'duplicate_post', message: 'Facebook rejected this as a duplicate of a recent post — an earlier attempt may already have published it. Checking before doing anything else.' };
  if (code === 368) return { cls: 'policy', code: 'policy_block', message: 'Meta temporarily blocked this account from posting for a policy reason. Review Meta notifications for the Page and retry manually later.' };
  if (code === 9007) return { cls: 'not_ready', code: 'ig_media_not_ready', message: IG_SUBCODES[2207027]!.message };
  if (code === 9004) return IG_SUBCODES[2207052]!;
  if (code !== null && IG_CODE_ALIASES[code]) return IG_SUBCODES[IG_CODE_ALIASES[code]!]!;
  if (code === 1609005) return { cls: 'invalid', code: 'link_unreachable', message: 'Facebook could not read the link. Check the URL is public and correct, then try again.' };
  if (code === 324) return { cls: 'invalid', code: 'image_invalid', message: 'Facebook could not read the image. Re-upload a JPEG or PNG under 10 MB.' };
  if (code === 100 && e.subcode === 33) return { cls: 'permission', code: 'object_inaccessible', message: 'Meta cannot access this Page or account with the current connection. Reconnect and select it again.', blocking: 'permission' };
  if (code === 100) return { cls: 'invalid', code: 'invalid_request', message: 'Meta rejected the post content or parameters (code 100). Check the text, link and image, then try again.' };
  if ((code === 1 || code === 2 || code === -1 || code === -2) && e.isTransient) return { cls: 'transient', code: 'provider_transient', message: 'Meta reported a temporary error. It will be retried.' };
  if (e.isTransient) return { cls: 'transient', code: 'provider_transient', message: 'Meta reported a temporary error. It will be retried.' };
  if (code === 1 || code === 2 || code === -1 || code === -2 || e.httpStatus >= 500 || code === null) {
    return { cls: 'server_error', code: 'provider_unavailable', message: 'Meta returned a server error.' };
  }
  return { cls: 'invalid', code: 'provider_rejected', message: `Meta rejected the request (code ${code}). Check the post and connection, then try again.` };
}

/** Time until calls may resume, from X-Business-Use-Case-Usage (minutes) when present. */
export function retryAfterFromHeaders(headers: Record<string, string>): number | null {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  let maxMin = 0;
  const buc = lower['x-business-use-case-usage'];
  if (buc) {
    try {
      const parsed = JSON.parse(buc) as Record<string, Array<{ estimated_time_to_regain_access?: number }>>;
      for (const entries of Object.values(parsed)) {
        for (const e of Array.isArray(entries) ? entries : []) {
          const m = Number(e?.estimated_time_to_regain_access ?? 0);
          if (Number.isFinite(m) && m > maxMin) maxMin = m;
        }
      }
    } catch { /* ignore malformed header */ }
  }
  if (maxMin > 0) return Math.round(maxMin * 60_000);
  const appUsage = lower['x-app-usage'] ?? lower['x-ad-account-usage'];
  if (appUsage) {
    try {
      const u = JSON.parse(appUsage) as Record<string, number>;
      const worst = Math.max(Number(u.call_count ?? 0), Number(u.total_time ?? 0), Number(u.total_cputime ?? 0));
      // X-App-Usage is a rolling one-hour window with no reset time; at/over 100% wait the default.
      if (worst >= 100) return DEFAULT_RATE_LIMIT_BACKOFF_MS;
    } catch { /* ignore */ }
  }
  return null;
}

export function normalizeGraphError(e: GraphErrorInfo, headers: Record<string, string> = {}): NormalizedMetaError {
  const r = rule(e);
  const out: NormalizedMetaError = { cls: r.cls, code: r.code, message: r.message, blocking: r.blocking };
  if (r.cls === 'rate_limit') out.retryAfterMs = retryAfterFromHeaders(headers) ?? DEFAULT_RATE_LIMIT_BACKOFF_MS;
  if (r.cls === 'transient') out.retryAfterMs = TRANSIENT_BACKOFF_MS;
  return out;
}

/** Map a Graph error from a FINAL PUBLISH call to a PublishOutcome. */
export function publishOutcomeFromGraphError(e: GraphErrorInfo, headers: Record<string, string> = {}): PublishOutcome {
  const n = normalizeGraphError(e, headers);
  switch (n.cls) {
    case 'reconnect':
    case 'permission':
      return { kind: 'permanent_failure', code: n.code, message: n.message, blocking: n.blocking };
    case 'rate_limit':
      return { kind: 'rejected_safe_to_retry', code: n.code, message: n.message, retryAfterMs: n.retryAfterMs };
    case 'transient':
      return { kind: 'rejected_safe_to_retry', code: n.code, message: n.message, retryAfterMs: n.retryAfterMs };
    case 'not_ready':
      return { kind: 'rejected_safe_to_retry', code: n.code, message: n.message, retryAfterMs: 10_000 };
    case 'container_expired':
      return { kind: 'rejected_safe_to_retry', code: n.code, message: n.message, retryAfterMs: 5_000 };
    case 'duplicate':
      return { kind: 'unknown', code: n.code, message: n.message };
    case 'server_error':
      return { kind: 'unknown', code: n.code, message: 'Meta returned a server error while publishing; the post may or may not have been created. Checking before doing anything else.' };
    case 'invalid':
    case 'policy':
      return { kind: 'permanent_failure', code: n.code, message: n.message, blocking: n.blocking };
  }
}

/** Map a Graph error from a NON-publishing call (container creation, status polls, lookups). */
export function prepareOutcomeFromGraphError(e: GraphErrorInfo, headers: Record<string, string> = {}, checkpoint?: Checkpoint): PrepareOutcome {
  const n = normalizeGraphError(e, headers);
  switch (n.cls) {
    case 'reconnect':
    case 'permission':
    case 'invalid':
    case 'policy':
      return { kind: 'permanent', code: n.code, message: n.message, blocking: n.blocking };
    case 'rate_limit':
    case 'transient':
    case 'not_ready':
      return { kind: 'retryable', code: n.code, message: n.message, retryAfterMs: n.retryAfterMs ?? 10_000, checkpoint };
    case 'server_error':
    case 'duplicate':
      return { kind: 'retryable', code: n.code, message: 'Meta returned a temporary server error. It will be retried.', retryAfterMs: TRANSIENT_BACKOFF_MS, checkpoint };
    case 'container_expired':
      // Callers handle expiry by recreating; if it reaches here, retry without the stale checkpoint.
      return { kind: 'retryable', code: n.code, message: n.message, retryAfterMs: 5_000 };
  }
}

/** Network failure during a final publish call. */
export function publishOutcomeFromTransportError(err: TransportError): PublishOutcome {
  if (err.requestMayHaveBeenSent) {
    return { kind: 'unknown', code: 'response_lost', message: 'The connection to Meta was lost after the post was sent; it may or may not have been published. Checking before doing anything else.' };
  }
  return { kind: 'rejected_safe_to_retry', code: 'network_unreachable', message: 'Could not reach Meta. Nothing was sent; it will be retried.' };
}

/** Network failure during a non-visible step (container creation, polls): always safe to retry. */
export function prepareOutcomeFromTransportError(err: TransportError, checkpoint?: Checkpoint): PrepareOutcome {
  return {
    kind: 'retryable', code: err.requestMayHaveBeenSent ? 'network_error' : 'network_unreachable',
    message: 'Could not reach Meta while preparing the post. It will be retried.', retryAfterMs: 30_000, checkpoint,
  };
}

export function isTransportError(e: unknown): e is TransportError {
  return e instanceof TransportError || (e instanceof Error && e.name === 'TransportError' && 'requestMayHaveBeenSent' in e);
}
