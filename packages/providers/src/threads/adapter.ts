// Threads API adapter: containers → status → threads_publish. Sources: docs/providers/threads.md.
//  prepare: create the media containers (not visible): carousel children first (is_carousel_item), then the
//           CAROUSEL parent; poll each container's status until FINISHED. Checkpoint keeps container ids
//           (24 h lifetime) so a restart never re-creates finished containers.
//  publish: POST /{user-id}/threads_publish creation_id (publishes:true).
//  reconcile: the container status is definitive (PUBLISHED / FINISHED / EXPIRED / ERROR); the media id is
//             found in the user's recent threads.
import {
  altTextFor, composeTextWithLink, validateVariant,
  type AdapterContext, type AttemptReference, type ChannelCapabilities, type ChannelConstraints, type Checkpoint,
  type ConnectionHealth, type PrepareOutcome, type ProviderCredentials, type PublishConnection, type PublishInput,
  type PublishOutcome, type PublishingAdapter, type ReconcileOutcome, type ValidationIssue, type ValidationResult,
} from '@social-lite/core';
import { ProviderHttpError, oauthAccessToken } from '../shared/http.js';
import { prepareFromClass, prepareTransport, publishFromClass, publishTransport } from '../shared/classify.js';
import { factsOf, isVideoMedia } from '../shared/media.js';
import { THREADS_VERSION, classifyThreads, threadsCall, threadsTextLength } from './api.js';
import { refreshThreadsCredentials, threadsMe } from './oauth.js';

export const THREADS_CONSTRAINTS_VERSION = 'threads-api-v1.0@2026-11-07';

export const THREADS_CONSTRAINTS: ChannelConstraints = {
  maxTextLength: 500,           // + emoji-as-UTF-8-bytes rule checked separately
  maxCaptionLength: 500,
  textCounting: 'codepoints',
  requiresMedia: false,
  supportsTextOnly: true,
  supportsLink: true,
  supportsButtons: false,
  maxButtons: 0,
  maxImages: 20,
  maxAlbumItems: 20,
  minAlbumItems: 2,
  albumAllowsVideo: true,
  imageMimes: ['image/jpeg', 'image/png'],
  maxImageBytes: 8 * 1024 * 1024,
  maxAspectRatio: 10,
  minAspectRatio: 0.1,
  maxVideos: 1,
  videoMimes: ['video/mp4', 'video/quicktime'],
  maxVideoBytes: 1024 * 1024 * 1024,
  maxVideoSeconds: 300,
  videoCodecs: ['h264', 'hevc'],
  audioCodecs: ['aac'],
  minFrameRate: 23,
  maxFrameRate: 60,
  minVideoAspectRatio: 0.01,
  maxVideoAspectRatio: 10,
  maxVideoWidth: 1920,
};

function capabilities(): ChannelCapabilities {
  return {
    provider: 'threads', formats: ['text', 'image', 'album', 'video'], canPublish: true, canEditPublished: false, canDeletePublished: false,
    canReadMetrics: true, canReconcile: true, constraints: THREADS_CONSTRAINTS, constraintsVersion: THREADS_CONSTRAINTS_VERSION, checkedAt: new Date().toISOString(),
    publishMode: 'direct', nativeScheduling: false,
    eligibility: { status: 'eligible', message: 'Requires Threads app review (advanced access) for accounts other than testers; 250 posts / 24 h.' },
    requiredOptions: [],
  };
}

/** Text actually sent: link_attachment for text-only posts, otherwise the link is appended. */
const outgoingText = (input: Pick<PublishInput, 'variant' | 'media'>) => (input.media.length ? composeTextWithLink(input.variant.text, input.variant.link) : input.variant.text);

function validate(input: Pick<PublishInput, 'variant' | 'media' | 'connection'>): ValidationResult {
  const base = validateVariant({
    provider: 'threads', connectionId: input.connection.id, constraints: THREADS_CONSTRAINTS,
    text: input.variant.text, link: input.variant.link, buttons: input.variant.buttons, media: factsOf(input.media), linkIsSeparateField: input.media.length === 0,
  });
  const issues: ValidationIssue[] = base.issues.filter((i) => i.code !== 'too_long');
  const n = threadsTextLength(outgoingText(input));
  if (n > 500) issues.push({ connectionId: input.connection.id, provider: 'threads', field: 'text', code: 'too_long', message: `Threads: text is ${n} of 500 allowed (emojis count as their UTF-8 bytes). Shorten by ${n - 500}.` });
  return { ok: issues.length === 0, issues };
}

// ------------------------------------------------------------------ containers
type Status = 'IN_PROGRESS' | 'FINISHED' | 'PUBLISHED' | 'ERROR' | 'EXPIRED' | 'NEW';
interface Item { assetId: string; containerId: string; status: Status }
interface State { items: Item[]; parentId: string | null; parentStatus: Status | null; createdAt: string }
const stateOf = (cp: Checkpoint | null): State | null => {
  const d = cp?.data as Partial<State> | undefined;
  return d && Array.isArray(d.items) && typeof d.createdAt === 'string' ? (d as State) : null;
};
const CONTAINER_TTL_MS = 23 * 3600_000; // containers expire after 24 h (H4)
const cpOf = (s: State, step: string): Checkpoint => ({ step, data: { ...s }, expiresAt: new Date(Date.parse(s.createdAt) + CONTAINER_TTL_MS).toISOString() });

/** Library alt text for an image or video container (`alt_text`, ≤ 1,000; fix H3). */
const alt = (m: PublishInput['media'][number]): string | undefined => altTextFor('threads', m) ?? undefined;

async function createContainer(ctx: AdapterContext, userId: string, token: string, params: Record<string, string | undefined>): Promise<string> {
  const r = await threadsCall<{ id?: string }>(ctx, { method: 'POST', path: `/${THREADS_VERSION}/${encodeURIComponent(userId)}/threads`, token, params, op: 'threads.container.create' });
  if (!r.data.id) throw new ProviderHttpError('Threads', 502, 'no_container_id', 'Threads did not return a container id', null);
  return r.data.id;
}

async function containerStatus(ctx: AdapterContext, token: string, id: string): Promise<{ status: Status; error: string | null }> {
  const r = await threadsCall<{ status?: Status; error_message?: string }>(ctx, { method: 'GET', path: `/${THREADS_VERSION}/${encodeURIComponent(id)}`, token, params: { fields: 'status,error_message' }, op: 'threads.container.status' });
  return { status: r.data.status ?? 'IN_PROGRESS', error: r.data.error_message ?? null };
}

class ContainerFailed extends Error { constructor(public readonly reason: string) { super(reason); } }

async function settle(ctx: AdapterContext, token: string, id: string, status: Status): Promise<Status> {
  if (status === 'FINISHED' || status === 'PUBLISHED') return status;
  const st = await containerStatus(ctx, token, id);
  if (st.status === 'ERROR') throw new ContainerFailed(st.error ?? 'UNKNOWN');
  if (st.status === 'EXPIRED') throw new ContainerFailed('EXPIRED');
  return st.status;
}

async function prepare(ctx: AdapterContext, input: PublishInput, checkpoint: Checkpoint | null): Promise<PrepareOutcome> {
  const v = validate(input);
  if (!v.ok) return { kind: 'permanent', code: 'invalid_content', message: v.issues.map((i) => i.message).join(' ') };
  const token = oauthAccessToken(input.credentials, 'Threads');
  const userId = input.connection.providerAccountId;
  const nowMs = ctx.now().getTime();
  let s = stateOf(checkpoint);
  if (s && (Date.parse(s.createdAt) + CONTAINER_TTL_MS <= nowMs || s.items.length > input.media.length || s.items.some((it, i) => it.assetId !== input.media[i]?.assetId))) s = null;
  s ??= { items: [], parentId: null, parentStatus: null, createdAt: ctx.now().toISOString() };
  const text = outgoingText(input);
  const carousel = input.media.length > 1;
  try {
    if (!input.media.length) {
      if (!s.parentId) {
        s = { ...s, parentId: await createContainer(ctx, userId, token, { media_type: 'TEXT', text, ...(input.variant.link ? { link_attachment: input.variant.link } : {}) }), parentStatus: 'IN_PROGRESS' };
      }
    } else if (!carousel) {
      const m = input.media[0]!;
      if (!s.parentId) {
        s = { ...s, parentId: await createContainer(ctx, userId, token, isVideoMedia(m) ? { media_type: 'VIDEO', video_url: m.url, text, alt_text: alt(m) } : { media_type: 'IMAGE', image_url: m.url, text, alt_text: alt(m) }), parentStatus: 'IN_PROGRESS' };
      }
    } else {
      for (let i = s.items.length; i < input.media.length; i++) {
        const m = input.media[i]!;
        const id = await createContainer(ctx, userId, token, isVideoMedia(m) ? { media_type: 'VIDEO', video_url: m.url, is_carousel_item: 'true', alt_text: alt(m) } : { media_type: 'IMAGE', image_url: m.url, is_carousel_item: 'true', alt_text: alt(m) });
        s = { ...s, items: [...s.items, { assetId: m.assetId, containerId: id, status: 'IN_PROGRESS' }] };
      }
      const items: Item[] = [];
      for (const it of s.items) items.push({ ...it, status: await settle(ctx, token, it.containerId, it.status) });
      s = { ...s, items };
      if (items.some((it) => it.status !== 'FINISHED')) return { kind: 'pending', checkpoint: cpOf(s, 'containers_processing'), checkAfterMs: input.media.some(isVideoMedia) ? 60_000 : 15_000 };
      if (!s.parentId) s = { ...s, parentId: await createContainer(ctx, userId, token, { media_type: 'CAROUSEL', children: items.map((it) => it.containerId).join(','), text }), parentStatus: 'IN_PROGRESS' };
    }
    const ps = await settle(ctx, token, s.parentId!, s.parentStatus ?? 'IN_PROGRESS');
    s = { ...s, parentStatus: ps };
    if (ps === 'PUBLISHED') return { kind: 'ready', checkpoint: cpOf(s, 'already_published') };
    if (ps !== 'FINISHED') return { kind: 'pending', checkpoint: cpOf(s, 'container_processing'), checkAfterMs: input.media.some(isVideoMedia) ? 60_000 : 10_000 };
    return { kind: 'ready', checkpoint: cpOf(s, 'container_ready') };
  } catch (err) {
    if (err instanceof ContainerFailed) {
      if (err.reason === 'EXPIRED') return { kind: 'retryable', code: 'threads_container_expired', message: 'The Threads container expired; it will be recreated.', checkpoint: { step: 'restart', data: {} } };
      return { kind: 'permanent', code: 'threads_media_failed', message: `Threads could not process the media (${err.reason}). Use JPEG/PNG ≤ 8 MB or MP4/MOV (H.264/HEVC, AAC, ≤ 5 min, 23–60 fps).` };
    }
    const cp = cpOf(s, 'containers_partial');
    if (err instanceof ProviderHttpError) return prepareFromClass(classifyThreads(err, nowMs), cp);
    return prepareTransport(err, 'Threads', cp);
  }
}

export const threadsPermalinkFallback = (connection: PublishConnection): string | null => (connection.isMock || !connection.username ? null : `https://www.threads.com/@${connection.username}`);

async function permalink(ctx: AdapterContext, token: string, id: string): Promise<string | null> {
  try {
    const r = await threadsCall<{ permalink?: string }>(ctx, { method: 'GET', path: `/${THREADS_VERSION}/${encodeURIComponent(id)}`, token, params: { fields: 'permalink' }, op: 'threads.media.permalink' });
    return typeof r.data.permalink === 'string' && r.data.permalink.startsWith('https://') ? r.data.permalink : null;
  } catch {
    return null;
  }
}

async function publish(ctx: AdapterContext, input: PublishInput, checkpoint: Checkpoint | null): Promise<PublishOutcome> {
  const s = stateOf(checkpoint);
  if (!s?.parentId || (checkpoint?.step !== 'container_ready' && checkpoint?.step !== 'already_published')) {
    return { kind: 'rejected_safe_to_retry', code: 'container_not_ready', message: 'The Threads post is not prepared yet; nothing was sent.' };
  }
  if (checkpoint.step === 'already_published') return { kind: 'unknown', code: 'threads_already_published', message: 'Threads reports this container as already published; it will be reconciled.' };
  const token = oauthAccessToken(input.credentials, 'Threads');
  try {
    const r = await threadsCall<{ id?: string }>(ctx, {
      method: 'POST', path: `/${THREADS_VERSION}/${encodeURIComponent(input.connection.providerAccountId)}/threads_publish`, token,
      params: { creation_id: s.parentId }, op: 'threads.publish', publishes: true, timeoutMs: 30_000,
    });
    if (!r.data.id) return { kind: 'unknown', code: 'threads_no_id', message: 'Threads accepted the request but returned no post id; it will be reconciled.' };
    const url = input.connection.isMock ? null : await permalink(ctx, token, r.data.id);
    return { kind: 'confirmed', providerIds: [r.data.id], url, publishedAt: ctx.now().toISOString() };
  } catch (err) {
    if (err instanceof ProviderHttpError) return publishFromClass(classifyThreads(err, ctx.now().getTime()));
    return publishTransport(err, 'Threads');
  }
}

const norm = (s: string) => s.replace(/https?:\/\/\S+/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

async function reconcile(ctx: AdapterContext, ref: AttemptReference): Promise<ReconcileOutcome> {
  if (ref.providerIds.length) return { kind: 'published', providerIds: ref.providerIds, url: null };
  const s = stateOf(ref.checkpoint);
  const token = oauthAccessToken(ref.credentials, 'Threads');
  if (!s?.parentId) return { kind: 'still_unknown', reason: 'No Threads container was recorded. Check the profile, then mark the delivery Published or Not published.' };
  try {
    const st = await containerStatus(ctx, token, s.parentId);
    if (st.status === 'FINISHED') return { kind: 'not_published', reason: 'The Threads container was never published.' };
    if (st.status === 'EXPIRED' || st.status === 'ERROR') return { kind: 'not_published', reason: `The Threads container is ${st.status.toLowerCase()}${st.error ? ` (${st.error})` : ''}; nothing was posted.` };
    if (st.status !== 'PUBLISHED') return { kind: 'still_unknown', reason: `The Threads container is ${st.status}.` };
    const since = Math.floor((ref.sentAt ? Date.parse(ref.sentAt) : Date.parse(s.createdAt)) / 1000) - 600;
    const r = await threadsCall<{ data?: Array<{ id: string; text?: string; timestamp?: string; permalink?: string }> }>(ctx, {
      method: 'GET', path: `/${THREADS_VERSION}/${encodeURIComponent(ref.connection.providerAccountId)}/threads`, token,
      params: { fields: 'id,text,timestamp,permalink', since: String(since), limit: '25' }, op: 'threads.user.threads',
    });
    const want = norm(ref.variantText);
    const hit = (r.data.data ?? []).find((t) => norm(t.text ?? '') === want);
    return hit
      ? { kind: 'published', providerIds: [hit.id], url: hit.permalink ?? null, publishedAt: hit.timestamp ?? null }
      : { kind: 'published', providerIds: [], url: threadsPermalinkFallback(ref.connection) };
  } catch (err) {
    if (err instanceof ProviderHttpError) return { kind: 'still_unknown', reason: `Could not check the Threads container: ${classifyThreads(err, ctx.now().getTime()).message}` };
    return { kind: 'still_unknown', reason: 'Could not reach Threads to check whether the post exists.' };
  }
}

async function health(ctx: AdapterContext, connection: PublishConnection, credentials: ProviderCredentials): Promise<ConnectionHealth> {
  const checkedAt = ctx.now().toISOString();
  try {
    const me = await threadsMe(ctx, oauthAccessToken(credentials, 'Threads'));
    if (me.id && String(me.id) !== connection.providerAccountId) return { status: 'reconnect_required', checkedAt, message: 'This Threads token belongs to a different profile. Reconnect the original profile.' };
    const metadata = { display_name: me.name ?? null, username: me.username ?? null };
    if (credentials.kind === 'oauth2' && credentials.expiresAt && Date.parse(credentials.expiresAt) - ctx.now().getTime() < 3 * 86_400_000) {
      return { status: 'expiring', checkedAt, expiresAt: credentials.expiresAt, metadata, message: 'The Threads token expires within 3 days and could not be refreshed yet. Reconnect if it is not refreshed automatically.' };
    }
    return { status: 'ready', checkedAt, metadata, message: `Connected as @${me.username ?? connection.username ?? connection.providerAccountId}.` };
  } catch (err) {
    if (err instanceof ProviderHttpError) {
      const c = classifyThreads(err, ctx.now().getTime());
      if (c.kind === 'reconnect') return { status: 'reconnect_required', checkedAt, message: c.message };
      if (c.kind === 'permission') return { status: 'missing_permission', checkedAt, message: c.message, missingPermissions: ['threads_basic'] };
    }
    throw err;
  }
}

export const threadsAdapter: PublishingAdapter = {
  provider: 'threads',
  capabilities: () => capabilities(),
  validate,
  prepare,
  publish,
  reconcile,
  health,
  refreshCredentials: refreshThreadsCredentials,
};
