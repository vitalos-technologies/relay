// X (Twitter) API v2 publishing adapter. See docs/providers/x.md for sources and costs.
//  prepare: POST /2/media/upload (multipart, media_category=tweet_image) => checkpoint {mediaId, expiresAt};
//           polls GET /2/media/upload?command=STATUS when processing_info is returned.
//  publish: POST /2/tweets {text (link appended), media:{media_ids}}.
//  reconcile: GET /2/users/:id/tweets around the send time (each call is a BILLABLE read).
import {
  TransportError, composeTextWithLink, validateVariant,
  type AdapterContext, type AttemptReference, type ChannelCapabilities, type ChannelConstraints, type Checkpoint,
  type ConnectionHealth, type PrepareOutcome, type ProviderCredentials, type PublishConnection, type PublishInput,
  type PublishOutcome, type PublishingAdapter, type ReconcileOutcome, type ValidationResult,
} from '@social-lite/core';
import { XApiError, accessTokenFrom, classifyXError, xCall } from './api.js';
import { X_REQUIRED_SCOPES, refreshXCredentials } from './oauth.js';

export const X_CONSTRAINTS_VERSION = 'x-api-v2@2026-11-06';

export const X_CONSTRAINTS: ChannelConstraints = {
  maxTextLength: 280,
  maxCaptionLength: 280,
  textCounting: 'x_weighted',
  requiresMedia: false,
  supportsTextOnly: true,
  supportsLink: true,
  supportsButtons: false,
  maxButtons: 0,
  maxImages: 1,                       // product scope: single image (API allows up to 4)
  imageMimes: ['image/jpeg', 'image/png'],
  maxImageBytes: 5 * 1024 * 1024,     // tweet_image: 5 MB
};

interface MediaUploadData {
  id: string;
  media_key?: string;
  expires_after_secs?: number;
  processing_info?: { state: 'pending' | 'in_progress' | 'failed' | 'succeeded'; check_after_secs?: number; progress_percent?: number };
}

export function xPostUrl(connection: PublishConnection, id: string): string | null {
  if (connection.isMock) return null;
  const u = connection.username?.replace(/^@/, '');
  return u ? `https://x.com/${u}/status/${id}` : `https://x.com/i/web/status/${id}`;
}

function capabilities(): ChannelCapabilities {
  return {
    provider: 'x', formats: ['text', 'image'], canPublish: true, canEditPublished: false, canDeletePublished: false,
    canReadMetrics: false, canReconcile: true, constraints: X_CONSTRAINTS, constraintsVersion: X_CONSTRAINTS_VERSION,
    checkedAt: new Date().toISOString(),
  };
}

function validate(input: Pick<PublishInput, 'variant' | 'media' | 'connection'>): ValidationResult {
  return validateVariant({
    provider: 'x', connectionId: input.connection.id, constraints: X_CONSTRAINTS,
    text: input.variant.text, link: input.variant.link, buttons: input.variant.buttons,
    media: input.media.map((m) => ({ assetId: m.assetId, status: 'ready', mime: m.mime, bytes: m.bytes, width: m.width, height: m.height })),
  });
}

function prepareError(err: unknown, nowMs: number): PrepareOutcome {
  if (err instanceof XApiError) {
    const c = classifyXError(err, nowMs);
    switch (c.kind) {
      case 'rate_limited': return { kind: 'retryable', code: c.code, message: c.message, retryAfterMs: c.retryAfterMs };
      case 'reconnect': return { kind: 'permanent', code: c.code, message: c.message, blocking: 'reconnect' };
      case 'budget': return { kind: 'permanent', code: c.code, message: c.message, blocking: 'budget' };
      case 'permission': return { kind: 'permanent', code: c.code, message: c.message, blocking: 'permission' };
      case 'server': return { kind: 'retryable', code: c.code, message: `${c.message} The image upload will be retried.` };
      default: return { kind: 'permanent', code: c.code === 'duplicate_content' ? 'x_media_rejected' : c.code, message: c.message };
    }
  }
  // Uploading media never creates a visible post: a lost response is safe to retry (worst case an orphan upload).
  if (err instanceof TransportError) return { kind: 'retryable', code: 'network', message: 'Could not complete the image upload to X; it will be retried.' };
  return { kind: 'retryable', code: 'unexpected', message: 'Unexpected error while uploading the image to X; it will be retried.' };
}

function mediaOutcome(ctx: AdapterContext, data: MediaUploadData, prevExpiresAt: string | null): PrepareOutcome {
  const expiresAt = data.expires_after_secs ? new Date(ctx.now().getTime() + data.expires_after_secs * 1000).toISOString() : prevExpiresAt;
  const st = data.processing_info?.state;
  if (st === 'failed') return { kind: 'permanent', code: 'x_media_processing_failed', message: 'X could not process the image. Replace it with a JPEG or PNG up to 5 MB.' };
  if (st === 'pending' || st === 'in_progress') {
    return {
      kind: 'pending',
      checkpoint: { step: 'media_processing', data: { mediaId: data.id, expiresAt }, expiresAt },
      checkAfterMs: Math.max(1, data.processing_info?.check_after_secs ?? 2) * 1000,
    };
  }
  return { kind: 'ready', checkpoint: { step: 'media_ready', data: { mediaId: data.id, expiresAt }, expiresAt } };
}

async function prepare(ctx: AdapterContext, input: PublishInput, checkpoint: Checkpoint | null): Promise<PrepareOutcome> {
  const image = input.media[0];
  if (!image) return { kind: 'ready', checkpoint: { step: 'no_media', data: {} } };
  if (input.media.length > 1) return { kind: 'permanent', code: 'too_many_images', message: 'X: one image per post in this release.' };
  const token = accessTokenFrom(input.credentials);
  const nowMs = ctx.now().getTime();
  const mediaId = typeof checkpoint?.data.mediaId === 'string' ? checkpoint.data.mediaId : null;
  const expiresAt = checkpoint?.expiresAt ?? (typeof checkpoint?.data.expiresAt === 'string' ? checkpoint.data.expiresAt : null);
  const stillValid = !!mediaId && (!expiresAt || Date.parse(expiresAt) - nowMs > 5 * 60_000);

  try {
    if (stillValid && checkpoint?.step === 'media_ready') return { kind: 'ready', checkpoint };
    if (stillValid && checkpoint?.step === 'media_processing') {
      const r = await xCall<{ data: MediaUploadData }>(ctx, {
        method: 'GET', path: '/2/media/upload', query: { command: 'STATUS', media_id: mediaId! }, bearer: token, op: 'x.media.status',
      });
      return mediaOutcome(ctx, { ...r.data.data, id: r.data.data?.id ?? mediaId! }, expiresAt);
    }
    let bytes: Uint8Array;
    try {
      bytes = await image.load();
    } catch {
      return { kind: 'retryable', code: 'media_unavailable', message: 'The image could not be read from storage; it will be retried.' };
    }
    const form = new FormData();
    form.append('media', new Blob([bytes as unknown as ArrayBuffer], { type: image.mime }), image.mime === 'image/png' ? 'image.png' : 'image.jpg');
    form.append('media_category', 'tweet_image');
    const r = await xCall<{ data: MediaUploadData }>(ctx, {
      method: 'POST', path: '/2/media/upload', formData: form, bearer: token, op: 'x.media.upload', timeoutMs: 60_000,
    });
    if (!r.data?.data?.id) return { kind: 'retryable', code: 'x_media_no_id', message: 'X did not return a media id; the upload will be retried.' };
    return mediaOutcome(ctx, r.data.data, null);
  } catch (err) {
    return prepareError(err, nowMs);
  }
}

async function publish(ctx: AdapterContext, input: PublishInput, checkpoint: Checkpoint | null): Promise<PublishOutcome> {
  const token = accessTokenFrom(input.credentials);
  const text = composeTextWithLink(input.variant.text, input.variant.link);
  const body: Record<string, unknown> = {};
  if (text.trim().length) body.text = text;
  if (input.media.length) {
    const mediaId = checkpoint?.data.mediaId;
    if (typeof mediaId !== 'string' || !mediaId) {
      return { kind: 'rejected_safe_to_retry', code: 'media_not_prepared', message: 'The image was not uploaded yet; nothing was sent.' };
    }
    body.media = { media_ids: [mediaId] };
  }
  try {
    const r = await xCall<{ data: { id: string; text?: string } }>(ctx, {
      method: 'POST', path: '/2/tweets', json: body, bearer: token, op: 'x.tweets.create', publishes: true, timeoutMs: 30_000,
    });
    const id = r.data?.data?.id;
    if (!id) return { kind: 'unknown', code: 'x_no_id', message: 'X accepted the request but returned no post id; it may have been posted.' };
    return { kind: 'confirmed', providerIds: [String(id)], url: xPostUrl(input.connection, String(id)), publishedAt: ctx.now().toISOString() };
  } catch (err) {
    const nowMs = ctx.now().getTime();
    if (err instanceof XApiError) {
      const c = classifyXError(err, nowMs);
      switch (c.kind) {
        case 'rate_limited': return { kind: 'rejected_safe_to_retry', code: c.code, message: c.message, retryAfterMs: c.retryAfterMs };
        case 'reconnect': return { kind: 'permanent_failure', code: c.code, message: c.message, blocking: 'reconnect' };
        case 'budget': return { kind: 'permanent_failure', code: c.code, message: c.message, blocking: 'budget' };
        case 'permission': return { kind: 'permanent_failure', code: c.code, message: c.message, blocking: 'permission' };
        case 'duplicate': return { kind: 'unknown', code: c.code, message: c.message };
        case 'server': return { kind: 'unknown', code: c.code, message: `${c.message} The post may or may not have been created; it will be reconciled.` };
        case 'invalid': return { kind: 'permanent_failure', code: c.code, message: c.message };
      }
    }
    if (err instanceof TransportError && !err.requestMayHaveBeenSent) {
      return { kind: 'rejected_safe_to_retry', code: 'network_unreachable', message: 'Could not connect to X; nothing was sent.' };
    }
    return { kind: 'unknown', code: 'response_lost', message: 'The connection to X was lost after the post was sent; it may have been created. It will be reconciled.' };
  }
}

/** Normalise post text for matching: X wraps links in t.co, appends media links and HTML-escapes &<>. */
export function normalizeForMatch(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function reconcile(ctx: AdapterContext, ref: AttemptReference): Promise<ReconcileOutcome> {
  if (ref.providerIds.length) {
    return { kind: 'published', providerIds: ref.providerIds, url: xPostUrl(ref.connection, ref.providerIds[0]!) };
  }
  const token = accessTokenFrom(ref.credentials);
  const sentMs = ref.sentAt ? Date.parse(ref.sentAt) : ctx.now().getTime() - 30 * 60_000;
  const start = new Date(sentMs - 10 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const want = normalizeForMatch(ref.variantText);
  try {
    // NOTE: billable read (post read pricing per returned resource) — the engine must budget reconcile polls.
    const r = await xCall<{ data?: Array<{ id: string; text: string; created_at?: string }>; meta?: { result_count?: number } }>(ctx, {
      method: 'GET', path: `/2/users/${encodeURIComponent(ref.connection.providerAccountId)}/tweets`,
      // Only default fields (id, text) are requested: the field-selector name changed (tweet.fields -> post.fields) in current docs.
      query: { start_time: start, max_results: '20', exclude: 'replies,retweets' },
      bearer: token, op: 'x.users.tweets',
    });
    const hit = (r.data.data ?? []).find((t) => normalizeForMatch(t.text) === want);
    if (hit) {
      return { kind: 'published', providerIds: [hit.id], url: xPostUrl(ref.connection, hit.id), publishedAt: hit.created_at ?? null };
    }
    return { kind: 'still_unknown', reason: `No matching post found on the account since ${start}. Check the X account, then mark the delivery Published or Not published.` };
  } catch (err) {
    if (err instanceof XApiError) {
      const c = classifyXError(err, ctx.now().getTime());
      return { kind: 'still_unknown', reason: `Could not read the account timeline: ${c.message}` };
    }
    return { kind: 'still_unknown', reason: 'Could not reach X to check whether the post exists.' };
  }
}

async function health(ctx: AdapterContext, connection: PublishConnection, credentials: ProviderCredentials): Promise<ConnectionHealth> {
  const checkedAt = ctx.now().toISOString();
  const token = accessTokenFrom(credentials);
  let me: { id: string; name?: string; username?: string };
  try {
    // NOTE: billable user read.
    const r = await xCall<{ data: { id: string; name?: string; username?: string } }>(ctx, {
      method: 'GET', path: '/2/users/me', query: { 'user.fields': 'name,username,profile_image_url' }, bearer: token, op: 'x.users.me',
    });
    me = r.data.data;
  } catch (err) {
    if (err instanceof XApiError) {
      const c = classifyXError(err, ctx.now().getTime());
      if (c.kind === 'reconnect') return { status: 'reconnect_required', checkedAt, message: c.message };
      if (c.kind === 'permission') return { status: 'missing_permission', checkedAt, message: c.message, missingPermissions: ['api_access'] };
    }
    throw err;
  }
  if (String(me.id) !== connection.providerAccountId) {
    return { status: 'reconnect_required', checkedAt, message: `This token now belongs to a different X account (@${me.username ?? me.id}). Reconnect the original account.` };
  }
  const metadata = { display_name: me.name ?? null, username: me.username ?? null };
  if (credentials.kind === 'oauth2') {
    const granted = new Set((credentials.scope ?? '').split(/\s+/).filter(Boolean));
    const missing = credentials.scope ? X_REQUIRED_SCOPES.filter((s) => !granted.has(s)) : [];
    if (missing.length) {
      return { status: 'missing_permission', checkedAt, missingPermissions: missing, metadata, message: `X did not grant: ${missing.join(', ')}. Click Reconnect and approve all requested permissions.` };
    }
    if (!credentials.refreshToken && credentials.expiresAt) {
      const left = Date.parse(credentials.expiresAt) - ctx.now().getTime();
      if (left < 24 * 3600_000) {
        return { status: 'expiring', checkedAt, expiresAt: credentials.expiresAt, metadata, message: 'This X authorization has no refresh token and expires soon. Reconnect to keep posting.' };
      }
    }
  }
  return { status: 'ready', checkedAt, metadata, message: `Connected as @${me.username ?? me.id}.` };
}

export const xAdapter: PublishingAdapter = {
  provider: 'x',
  capabilities: () => capabilities(),
  validate,
  prepare,
  publish,
  reconcile,
  health,
  refreshCredentials: refreshXCredentials,
};
