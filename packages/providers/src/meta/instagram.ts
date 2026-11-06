// Instagram professional-account publishing via the Facebook Login route (graph.facebook.com,
// Page access token). Single JPEG image + caption.
//
//  prepare  → POST /{ig-user-id}/media { image_url, caption }  → container id (checkpoint, expires +24h)
//             GET  /{container-id}?fields=status_code,status    → IN_PROGRESS | FINISHED | ERROR | EXPIRED | PUBLISHED
//  publish  → GET  /{ig-user-id}/content_publishing_limit       (quota guard; failures are non-fatal)
//             POST /{ig-user-id}/media_publish { creation_id }  → media id   (publishes: true)
//             GET  /{media-id}?fields=id,permalink,timestamp    (best effort)
//  reconcile→ container status + /{ig-user-id}/media?fields=id,caption,timestamp,permalink
//
// Links: Instagram captions do not make links clickable. supportsLink=false, so a variant with a
// link fails validation with an exact fix ("link_unsupported"); we never silently drop it.
import type {
  AdapterContext, AttemptReference, Checkpoint, ConnectionHealth, PrepareOutcome, ProviderCredentials,
  PublishConnection, PublishInput, PublishOutcome, PublishingAdapter, ReconcileOutcome,
} from '@social-lite/core';
import { capabilitiesFor, igUserIdOf, textMatches, validateMeta, validationFailureMessage } from './common.js';
import {
  isTransportError, normalizeGraphError, prepareOutcomeFromGraphError, prepareOutcomeFromTransportError,
  publishOutcomeFromGraphError, publishOutcomeFromTransportError,
} from './errors.js';
import { graph, pageToken, str } from './graph.js';
import { metaHealth } from './health.js';

export const CONTAINER_TTL_MS = 24 * 60 * 60_000;
/** Do not publish a container this close to its provider-side expiry; make a fresh one instead. */
const EXPIRY_SAFETY_MS = 10 * 60_000;
/** Give up on a container stuck IN_PROGRESS after this long; a fresh container is made on retry. */
export const PROCESSING_TIMEOUT_MS = 10 * 60_000;
const RECONCILE_WINDOW_MS = 10 * 60_000;
/** After this long with the container still unpublished, non-publication is considered established. */
const NOT_PUBLISHED_AFTER_MS = 10 * 60_000;

type StatusCode = 'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'EXPIRED' | 'PUBLISHED';

interface ContainerData {
  containerId: string;
  createdAt: string;
  expiresAt: string;
  polls: number;
  published?: boolean;
}

function containerFrom(cp: Checkpoint | null | undefined): ContainerData | null {
  const d = cp?.data as Partial<ContainerData> | undefined;
  if (!d || typeof d.containerId !== 'string' || !d.containerId) return null;
  return {
    containerId: d.containerId,
    createdAt: typeof d.createdAt === 'string' ? d.createdAt : new Date(0).toISOString(),
    expiresAt: typeof d.expiresAt === 'string' ? d.expiresAt : (cp?.expiresAt ?? new Date(0).toISOString()),
    polls: typeof d.polls === 'number' ? d.polls : 0,
    published: d.published === true,
  };
}

function checkpointOf(step: string, c: ContainerData): Checkpoint {
  return { step, data: { ...c }, expiresAt: c.expiresAt };
}

/** Poll delay: quick first checks (images usually finish in seconds), then back off to 60s. */
export function pollDelayMs(polls: number): number {
  const schedule = [5_000, 5_000, 10_000, 15_000, 30_000];
  return schedule[polls] ?? 60_000;
}

const credentialsMissing = 'This Instagram account has no usable credentials. Reconnect it in Settings → Connections.';

const ERROR_STATUS_MESSAGE = 'Instagram could not process this image. Use a JPEG (sRGB) between 4:5 and 1.91:1, at least 320px wide and under 8 MB, then try again.';

async function containerStatus(ctx: AdapterContext, token: string, containerId: string) {
  return graph<{ id?: string; status_code?: string; status?: string }>(ctx, {
    method: 'GET', path: containerId, token, params: { fields: 'status_code,status' }, op: 'meta.instagram.container_status',
  });
}

interface IgMedia { id?: string; caption?: string; timestamp?: string; permalink?: string }

async function findMediaByCaption(ctx: AdapterContext, token: string, igUserId: string, caption: string, notBefore: Date): Promise<IgMedia | null | 'error'> {
  const r = await graph<{ data?: IgMedia[] }>(ctx, {
    method: 'GET', path: `${igUserId}/media`, token, op: 'meta.instagram.media_list',
    params: { fields: 'id,caption,timestamp,permalink', limit: 25 },
  });
  if (!r.ok) return 'error';
  return (r.data.data ?? []).find((m) => {
    if (!str(m.id)) return false;
    const t = m.timestamp ? Date.parse(m.timestamp) : NaN;
    if (Number.isFinite(t) && t < notBefore.getTime()) return false;
    return textMatches(m.caption, caption);
  }) ?? null;
}

async function createContainer(ctx: AdapterContext, input: PublishInput, token: string): Promise<PrepareOutcome> {
  const igUserId = igUserIdOf(input.connection);
  const image = input.media[0]!;
  let res;
  try {
    res = await graph<{ id?: string }>(ctx, {
      method: 'POST', path: `${igUserId}/media`, token, op: 'meta.instagram.media_create', timeoutMs: 60_000,
      params: { image_url: image.url, caption: input.variant.text || undefined },
    });
  } catch (err) {
    if (isTransportError(err)) return prepareOutcomeFromTransportError(err); // containers are invisible; safe to recreate
    throw err;
  }
  if (!res.ok) return prepareOutcomeFromGraphError(res.error, res.headers);
  const id = str(res.data.id);
  if (!id) return { kind: 'retryable', code: 'missing_container_id', message: 'Instagram did not return an upload ID. It will be retried.', retryAfterMs: 30_000 };
  const now = ctx.now();
  const c: ContainerData = { containerId: id, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + CONTAINER_TTL_MS).toISOString(), polls: 0 };
  return pollContainer(ctx, token, c, input, true);
}

async function pollContainer(ctx: AdapterContext, token: string, c: ContainerData, input: PublishInput, fresh: boolean): Promise<PrepareOutcome> {
  let res;
  try {
    res = await containerStatus(ctx, token, c.containerId);
  } catch (err) {
    if (isTransportError(err)) return prepareOutcomeFromTransportError(err, checkpointOf('container_created', c));
    throw err;
  }
  if (!res.ok) {
    const n = normalizeGraphError(res.error, res.headers);
    if (n.cls === 'container_expired' && !fresh) return createContainer(ctx, input, token);
    return prepareOutcomeFromGraphError(res.error, res.headers, checkpointOf('container_created', c));
  }
  const status = (res.data.status_code ?? '') as StatusCode;
  const next: ContainerData = { ...c, polls: c.polls + 1 };
  switch (status) {
    case 'FINISHED':
      return { kind: 'ready', checkpoint: checkpointOf('container_ready', next) };
    case 'PUBLISHED':
      // Already published by an earlier attempt: never publish again; publish() resolves the media.
      return { kind: 'ready', checkpoint: checkpointOf('container_published', { ...next, published: true }) };
    case 'EXPIRED':
      if (fresh) return { kind: 'retryable', code: 'ig_container_expired', message: 'Instagram expired the upload immediately. It will be retried.', retryAfterMs: 60_000 };
      return createContainer(ctx, input, token);
    case 'ERROR': {
      const sub = Number(/\d{7}/.exec(res.data.status ?? '')?.[0] ?? NaN);
      if (Number.isFinite(sub)) {
        const n = normalizeGraphError({ httpStatus: 400, code: null, subcode: sub, type: null, isTransient: false, rawMessage: null, fbtraceId: null });
        if (n.cls === 'transient' || n.cls === 'container_expired') {
          return { kind: 'retryable', code: n.code, message: n.message, retryAfterMs: 30_000 }; // fresh container next time
        }
        if (n.cls === 'invalid') return { kind: 'permanent', code: n.code, message: n.message };
      }
      return { kind: 'permanent', code: 'ig_container_error', message: ERROR_STATUS_MESSAGE };
    }
    case 'IN_PROGRESS':
    default: {
      const age = ctx.now().getTime() - Date.parse(c.createdAt);
      if (age > PROCESSING_TIMEOUT_MS) {
        return { kind: 'retryable', code: 'ig_processing_timeout', message: 'Instagram is taking too long to process the image. A fresh upload will be tried.', retryAfterMs: 60_000 };
      }
      return { kind: 'pending', checkpoint: checkpointOf('container_created', next), checkAfterMs: pollDelayMs(c.polls) };
    }
  }
}

async function confirmFromMediaId(ctx: AdapterContext, token: string, mediaId: string): Promise<{ url: string | null; publishedAt: string | null }> {
  try {
    const r = await graph<IgMedia>(ctx, { method: 'GET', path: mediaId, token, params: { fields: 'id,permalink,timestamp' }, op: 'meta.instagram.media_lookup' });
    if (r.ok) return { url: str(r.data.permalink), publishedAt: str(r.data.timestamp) };
  } catch { /* best effort */ }
  return { url: null, publishedAt: null };
}

export const instagramAdapter: PublishingAdapter = {
  provider: 'instagram',

  capabilities(connection: PublishConnection) {
    return capabilitiesFor('instagram', connection);
  },

  validate(input) {
    return validateMeta('instagram', input);
  },

  async prepare(ctx: AdapterContext, input: PublishInput, checkpoint: Checkpoint | null): Promise<PrepareOutcome> {
    const v = validateMeta('instagram', input);
    if (!v.ok) return { kind: 'permanent', code: 'invalid_content', message: validationFailureMessage(v) };
    const token = pageToken(input.credentials);
    if (!token) return { kind: 'permanent', code: 'credentials_missing', message: credentialsMissing, blocking: 'reconnect' };

    const c = containerFrom(checkpoint);
    if (!c) return createContainer(ctx, input, token);
    if (c.published) return { kind: 'ready', checkpoint: checkpointOf('container_published', c) };
    const expiresAt = Date.parse(c.expiresAt);
    if (!Number.isFinite(expiresAt) || ctx.now().getTime() >= expiresAt - EXPIRY_SAFETY_MS) {
      // Past (or about to pass) the 24h container lifetime — but never recreate a container that
      // may already have been published: check first.
      try {
        const s = await containerStatus(ctx, token, c.containerId);
        if (s.ok && s.data.status_code === 'PUBLISHED') return { kind: 'ready', checkpoint: checkpointOf('container_published', { ...c, published: true }) };
      } catch { /* fall through: an unreachable status does not block recreation of an expired container */ }
      return createContainer(ctx, input, token);
    }
    return pollContainer(ctx, token, c, input, false);
  },

  async publish(ctx: AdapterContext, input: PublishInput, checkpoint: Checkpoint | null): Promise<PublishOutcome> {
    const v = validateMeta('instagram', input);
    if (!v.ok) return { kind: 'permanent_failure', code: 'invalid_content', message: validationFailureMessage(v) };
    const token = pageToken(input.credentials);
    if (!token) return { kind: 'permanent_failure', code: 'credentials_missing', message: credentialsMissing, blocking: 'reconnect' };
    const c = containerFrom(checkpoint);
    if (!c) return { kind: 'rejected_safe_to_retry', code: 'not_prepared', message: 'The Instagram upload was not prepared yet. It will be prepared and retried.', retryAfterMs: 5_000 };
    const igUserId = igUserIdOf(input.connection);

    if (c.published) {
      // An earlier attempt already published this container. Resolve the media id; never publish again.
      const found = await findMediaByCaption(ctx, token, igUserId, input.variant.text, new Date(Date.parse(c.createdAt) - RECONCILE_WINDOW_MS)).catch(() => 'error' as const);
      if (found && found !== 'error') return { kind: 'confirmed', providerIds: [found.id!], url: str(found.permalink), publishedAt: str(found.timestamp) };
      return { kind: 'unknown', code: 'ig_already_published', message: 'Instagram reports this upload as already published, but the post could not be located yet. Checking again.' };
    }

    // Quota guard (verified endpoint: /{ig-user-id}/content_publishing_limit). Non-fatal on failure.
    try {
      const q = await graph<{ data?: Array<{ quota_usage?: number; config?: { quota_total?: number; quota_duration?: number } }> }>(ctx, {
        method: 'GET', path: `${igUserId}/content_publishing_limit`, token, params: { fields: 'quota_usage,config' }, op: 'meta.instagram.publishing_limit',
      });
      if (q.ok) {
        const row = q.data.data?.[0];
        const used = Number(row?.quota_usage ?? NaN);
        const total = Number(row?.config?.quota_total ?? NaN);
        if (Number.isFinite(used) && Number.isFinite(total) && total > 0 && used >= total) {
          return {
            kind: 'permanent_failure', code: 'ig_publish_limit', blocking: 'rate_limit',
            message: `Instagram: this account has used its ${total} API posts for the last 24 hours. Publishing resumes when the rolling limit frees up.`,
          };
        }
      } else {
        const n = normalizeGraphError(q.error, q.headers);
        if (n.cls === 'reconnect' || n.cls === 'permission') return { kind: 'permanent_failure', code: n.code, message: n.message, blocking: n.blocking };
      }
    } catch (err) {
      if (!isTransportError(err)) throw err;
      // Quota check unreachable: continue; media_publish enforces the limit itself.
    }

    let res;
    try {
      res = await graph<{ id?: string }>(ctx, {
        method: 'POST', path: `${igUserId}/media_publish`, token, params: { creation_id: c.containerId }, op: 'meta.instagram.media_publish', publishes: true, timeoutMs: 60_000,
      });
    } catch (err) {
      if (isTransportError(err)) return publishOutcomeFromTransportError(err);
      throw err;
    }
    if (!res.ok) return publishOutcomeFromGraphError(res.error, res.headers);
    const mediaId = str(res.data.id);
    if (!mediaId) return { kind: 'unknown', code: 'missing_media_id', message: 'Instagram accepted the request but returned no media ID. Checking whether it was published.' };
    const extra = await confirmFromMediaId(ctx, token, mediaId);
    return { kind: 'confirmed', providerIds: [mediaId], url: extra.url, publishedAt: extra.publishedAt ?? ctx.now().toISOString() };
  },

  async reconcile(ctx: AdapterContext, ref: AttemptReference): Promise<ReconcileOutcome> {
    const token = pageToken(ref.credentials);
    if (!token) return { kind: 'still_unknown', reason: 'No usable credentials to check Instagram; reconnect the account, then check again.' };
    const igUserId = igUserIdOf(ref.connection);
    const now = ctx.now();
    const sentAt = ref.sentAt ? new Date(ref.sentAt) : null;
    const c = containerFrom(ref.checkpoint);
    const notBefore = new Date((sentAt ?? (c ? new Date(c.createdAt) : new Date(now.getTime() - 60 * 60_000))).getTime() - RECONCILE_WINDOW_MS);
    try {
      for (const id of ref.providerIds) {
        const r = await graph<IgMedia>(ctx, { method: 'GET', path: id, token, params: { fields: 'id,permalink,timestamp' }, op: 'meta.instagram.media_lookup' });
        if (r.ok && str(r.data.id)) return { kind: 'published', providerIds: [r.data.id!], url: str(r.data.permalink), publishedAt: str(r.data.timestamp) };
      }

      let status: StatusCode | null = null;
      if (c) {
        const s = await containerStatus(ctx, token, c.containerId);
        if (s.ok) status = (s.data.status_code ?? null) as StatusCode | null;
      }

      const found = await findMediaByCaption(ctx, token, igUserId, ref.variantText, notBefore);
      if (found && found !== 'error') return { kind: 'published', providerIds: [found.id!], url: str(found.permalink), publishedAt: str(found.timestamp) };

      if (status === 'PUBLISHED') {
        // Provider says the container is published; the media is not in the recent list yet.
        return { kind: 'published', providerIds: [], url: null, publishedAt: null };
      }
      if (status === 'EXPIRED' || status === 'ERROR') {
        return { kind: 'not_published', reason: `Instagram reports the prepared upload as ${status}; it was never published.` };
      }
      const elapsed = sentAt ? now.getTime() - sentAt.getTime() : 0;
      if ((status === 'FINISHED' || status === 'IN_PROGRESS') && found !== 'error' && elapsed >= NOT_PUBLISHED_AFTER_MS) {
        return { kind: 'not_published', reason: `Instagram reports the prepared upload as ${status} (not published) ${Math.round(elapsed / 60_000)} minutes after sending, and no matching post exists.` };
      }
      return { kind: 'still_unknown', reason: 'No matching Instagram post found yet. Will check again before deciding.' };
    } catch (err) {
      if (isTransportError(err)) return { kind: 'still_unknown', reason: 'Could not reach Instagram to check. Will check again.' };
      throw err;
    }
  },

  async health(ctx: AdapterContext, connection: PublishConnection, credentials: ProviderCredentials): Promise<ConnectionHealth> {
    return metaHealth(ctx, 'instagram', connection, credentials);
  },
};
