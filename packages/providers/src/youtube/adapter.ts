// YouTube Data API v3 adapter: resumable upload, explicit privacy, optional native scheduling (publishAt).
// Sources: docs/providers/youtube.md.
//  prepare: open a resumable session and upload every chunk EXCEPT the last (no video exists until the upload
//           completes); a restart asks the session for its Range and continues; a 404 starts a new session.
//  publish: final chunk (publishes:true) → 201 video resource → 'processing' until processed.
//  reconcile: videos.list(status, processingDetails); a lost final response is resolved by asking the session.
//  cancelRemoteSchedule: videos.update(status) to private without publishAt, then re-read to confirm.
import {
  composeTextWithLink, utf8Length, validateVariant,
  type AdapterContext, type AttemptReference, type ChannelCapabilities, type ChannelConstraints, type Checkpoint,
  type ConnectionHealth, type PrepareOutcome, type ProviderCredentials, type PublishConnection, type PublishInput,
  type PublishOutcome, type PublishingAdapter, type ReconcileOutcome, type RemoteScheduleCancelOutcome, type ValidationIssue, type ValidationResult,
} from '@social-lite/core';
import { ProviderHttpError, header, oauthAccessToken } from '../shared/http.js';
import { prepareFromClass, prepareTransport, publishFromClass, publishTransport } from '../shared/classify.js';
import { factsOf, isVideoMedia, loadBytes, providerOptions } from '../shared/media.js';
import { grantedScopes, missingScopes } from '../shared/oauth.js';
import { YT_CHUNK_BYTES, classifyYouTube, nextByteFromRange, ytCall } from './api.js';
import { YOUTUBE_REQUIRED_SCOPES, YT_SCOPE_FORCE_SSL, myChannels, refreshYouTubeCredentials } from './oauth.js';

export const YOUTUBE_CONSTRAINTS_VERSION = 'youtube-data-v3@2026-11-07';

export const YOUTUBE_CONSTRAINTS: ChannelConstraints = {
  maxTextLength: 5000,            // description ≤ 5000 BYTES (checked separately in bytes)
  maxCaptionLength: 5000,
  textCounting: 'codepoints',
  requiresMedia: true,
  supportsTextOnly: false,
  supportsLink: true,             // appended to the description (clickable only for eligible channels)
  supportsButtons: false,
  maxButtons: 0,
  maxImages: 0,
  imageMimes: [],
  maxImageBytes: 0,
  maxVideos: 1,
  videoMimes: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo', 'video/mpeg'],
  maxVideoBytes: 256 * 1024 * 1024 * 1024,
  maxVideoSeconds: 15 * 60,       // unverified channels (assumed); 12 h when longUploadsStatus = allowed
};

export type YouTubePrivacy = 'public' | 'unlisted' | 'private';
/** variant.options.youtube — required: title, privacyStatus, madeForKids. */
export interface YouTubeOptions {
  title: string;
  privacyStatus: YouTubePrivacy;
  madeForKids: boolean;
  tags: string[];
  categoryId: string;
  containsSyntheticMedia: boolean;
  notifySubscribers: boolean;
  /** 'provider' = YouTube holds the release (publishAt); 'app' (default) = the worker uploads at the due time. */
  schedulingOwner: 'app' | 'provider';
  publishAt: string;
}

const optsOf = (input: Pick<PublishInput, 'variant'>) => providerOptions<YouTubeOptions>(input.variant.options, 'youtube');
const nativeAllowed = (c: PublishConnection) => c.metadata.native_scheduling !== false;
const longAllowed = (c: PublishConnection) => c.metadata.long_uploads === 'allowed';

function constraintsFor(c: PublishConnection): ChannelConstraints {
  return longAllowed(c) ? { ...YOUTUBE_CONSTRAINTS, maxVideoSeconds: 12 * 3600 } : YOUTUBE_CONSTRAINTS;
}

function capabilities(connection: PublishConnection): ChannelCapabilities {
  const scopes = Array.isArray(connection.metadata.granted_scopes) ? (connection.metadata.granted_scopes as string[]) : [];
  return {
    provider: 'youtube', formats: ['video'], canPublish: true, canEditPublished: false, canDeletePublished: false,
    canReadMetrics: !scopes.length || scopes.includes('https://www.googleapis.com/auth/yt-analytics.readonly'),
    canReconcile: true, constraints: constraintsFor(connection), constraintsVersion: YOUTUBE_CONSTRAINTS_VERSION, checkedAt: new Date().toISOString(),
    publishMode: 'direct', nativeScheduling: nativeAllowed(connection),
    eligibility: { status: 'eligible', message: 'Videos.insert uses the project\'s 100 uploads/day bucket; Shorts classification is decided by YouTube.' },
    requiredOptions: ['youtube.title', 'youtube.privacyStatus', 'youtube.madeForKids'],
  };
}

function validate(input: Pick<PublishInput, 'variant' | 'media' | 'connection'>): ValidationResult {
  const base = validateVariant({
    provider: 'youtube', connectionId: input.connection.id, constraints: constraintsFor(input.connection),
    text: input.variant.text, link: input.variant.link, buttons: input.variant.buttons, media: factsOf(input.media),
  });
  const issues: ValidationIssue[] = [...base.issues];
  const add = (field: ValidationIssue['field'], code: string, message: string) =>
    issues.push({ connectionId: input.connection.id, provider: 'youtube', field, code, message: `YouTube: ${message}` });
  const o = optsOf(input);
  if (!input.media.some(isVideoMedia)) add('media', 'youtube_video_required', 'a video is required.');
  if (input.media.length > 1) add('media', 'too_many_items', 'upload exactly one video.');
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  if (!title) add('options', 'youtube_title_required', 'a video title is required.');
  else if ([...title].length > 100) add('options', 'youtube_title_too_long', `the title is ${[...title].length} of 100 characters.`);
  if (/[<>]/.test(title) || /[<>]/.test(input.variant.text)) add('text', 'youtube_angle_brackets', 'titles and descriptions cannot contain < or >.');
  const desc = composeTextWithLink(input.variant.text, input.variant.link);
  if (utf8Length(desc) > 5000) add('text', 'too_long', `the description is ${utf8Length(desc)} of 5000 bytes.`);
  if (!o.privacyStatus || !['public', 'unlisted', 'private'].includes(o.privacyStatus)) add('options', 'youtube_privacy_required', 'choose Public, Unlisted or Private explicitly.');
  if (typeof o.madeForKids !== 'boolean') add('options', 'youtube_made_for_kids_required', 'say whether the video is made for kids (required by YouTube policy).');
  if (Array.isArray(o.tags)) {
    const len = o.tags.reduce((n, t) => n + (/\s/.test(t) ? t.length + 2 : t.length), 0) + Math.max(0, o.tags.length - 1);
    if (len > 500) add('options', 'youtube_tags_too_long', `tags use ${len} of 500 characters.`);
  }
  if (o.schedulingOwner === 'provider') {
    const at = typeof o.publishAt === 'string' ? Date.parse(o.publishAt) : NaN;
    if (!nativeAllowed(input.connection)) add('schedule', 'youtube_native_schedule_unavailable', 'YouTube-held scheduling needs the "manage videos" permission (to be able to cancel it on pause). Reconnect, or let Relay publish at the time.');
    // publishAt is supplied by the engine from Relay's schedule (engine/provider-scheduling.ts); only a malformed value is an error.
    if (o.publishAt != null && !Number.isFinite(at)) add('schedule', 'youtube_publish_at_invalid', 'the YouTube release time is not a valid date. Reschedule the post.');
    if (o.privacyStatus && o.privacyStatus !== 'public') add('schedule', 'youtube_publish_at_public_only', 'a YouTube-held release makes the video public at that time; choose Public.');
  }
  return { ok: issues.length === 0, issues };
}

// ------------------------------------------------------------------ resumable upload
interface Session { assetId: string; sessionUri: string; total: number; nextByte: number; chunkSize: number; mime: string; videoId?: string }
const sessionOf = (cp: Checkpoint | null): Session | null => {
  const d = cp?.data as Partial<Session> | undefined;
  return d && typeof d.sessionUri === 'string' && typeof d.total === 'number' && typeof d.nextByte === 'number' ? (d as Session) : null;
};
const cpOf = (s: Session, step: string): Checkpoint => ({ step, data: { ...s } });
const uploadMime = (m: string) => (m.startsWith('video/') ? m : 'application/octet-stream');

function videoResource(input: PublishInput): Record<string, unknown> {
  const o = optsOf(input);
  const provider = o.schedulingOwner === 'provider';
  return {
    snippet: {
      title: (o.title ?? '').trim(),
      description: composeTextWithLink(input.variant.text, input.variant.link),
      ...(Array.isArray(o.tags) && o.tags.length ? { tags: o.tags } : {}),
      ...(o.categoryId ? { categoryId: o.categoryId } : {}),
    },
    status: {
      // Always explicit (omitted ⇒ public on YouTube). A provider-held release is private until publishAt.
      privacyStatus: provider ? 'private' : o.privacyStatus,
      ...(provider ? { publishAt: new Date(String(o.publishAt)).toISOString() } : {}),
      selfDeclaredMadeForKids: o.madeForKids === true,
      ...(typeof o.containsSyntheticMedia === 'boolean' ? { containsSyntheticMedia: o.containsSyntheticMedia } : {}),
    },
  };
}

/** Ask a resumable session where it is: 308 ⇒ next byte, 200/201 ⇒ complete (video resource). */
async function sessionStatus(ctx: AdapterContext, token: string, s: Session): Promise<{ complete: false; nextByte: number } | { complete: true; videoId: string | null }> {
  const r = await ytCall<{ id?: string }>(ctx, {
    method: 'PUT', url: s.sessionUri, bearer: token, headers: { 'content-length': '0', 'content-range': `bytes */${s.total}` }, op: 'youtube.upload.status', acceptStatus: [308],
  });
  if (r.status === 308) return { complete: false, nextByte: nextByteFromRange(header(r.headers, 'range')) };
  return { complete: true, videoId: typeof r.data.id === 'string' ? r.data.id : null };
}

async function putBytes(ctx: AdapterContext, token: string, s: Session, bytes: Uint8Array, first: number, last: number, publishes: boolean) {
  return ytCall<{ id?: string }>(ctx, {
    method: 'PUT', url: s.sessionUri, bearer: token, op: publishes ? 'youtube.upload.final' : 'youtube.upload.chunk', publishes, timeoutMs: 600_000, acceptStatus: [308],
    bytes: { data: bytes.subarray(first, last + 1), contentType: s.mime, extraHeaders: { 'content-range': `bytes ${first}-${last}/${s.total}` } },
  });
}

async function prepare(ctx: AdapterContext, input: PublishInput, checkpoint: Checkpoint | null): Promise<PrepareOutcome> {
  const v = validate(input);
  if (!v.ok) return { kind: 'permanent', code: 'invalid_content', message: v.issues.map((i) => i.message).join(' ') };
  const video = input.media.find(isVideoMedia)!;
  const token = oauthAccessToken(input.credentials, 'YouTube');
  const nowMs = ctx.now().getTime();
  let s = sessionOf(checkpoint);
  if (s && s.assetId !== video.assetId) s = null;
  if (s?.videoId) return { kind: 'ready', checkpoint: cpOf(s, 'uploaded') };
  try {
    const bytes = await loadBytes(video);
    if (!bytes) return { kind: 'retryable', code: 'media_unavailable', message: 'The video could not be read from storage; it will be retried.', ...(s ? { checkpoint: cpOf(s, 'uploading') } : {}) };
    if (s) {
      try {
        const st = await sessionStatus(ctx, token, s);
        // An earlier publish already completed the upload: never upload again.
        if (st.complete) return { kind: 'ready', checkpoint: cpOf({ ...s, nextByte: s.total, videoId: st.videoId ?? undefined }, 'uploaded') };
        s = { ...s, nextByte: st.nextByte };
      } catch (err) {
        if (err instanceof ProviderHttpError && (err.status === 404 || err.status === 410)) s = null; // session expired ⇒ new session
        else throw err;
      }
    }
    if (!s) {
      const o = optsOf(input);
      const r = await ytCall(ctx, {
        method: 'POST', path: '/upload/youtube/v3/videos', bearer: token, op: 'youtube.upload.init',
        query: { uploadType: 'resumable', part: 'snippet,status', ...(o.notifySubscribers === false ? { notifySubscribers: 'false' } : {}) },
        headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-length': String(bytes.byteLength), 'x-upload-content-type': uploadMime(video.mime) },
        json: videoResource(input),
      });
      const loc = header(r.headers, 'location');
      if (!loc) return { kind: 'retryable', code: 'youtube_no_session', message: 'YouTube did not return an upload session; it will be retried.' };
      s = { assetId: video.assetId, sessionUri: loc, total: bytes.byteLength, nextByte: 0, chunkSize: YT_CHUNK_BYTES, mime: uploadMime(video.mime) };
    }
    while (s.nextByte + s.chunkSize < s.total) {
      const cur: Session = s;
      const first: number = cur.nextByte;
      const r = await putBytes(ctx, token, cur, bytes, first, first + cur.chunkSize - 1, false);
      const next: number = r.status === 308 ? (nextByteFromRange(header(r.headers, 'range')) || first + cur.chunkSize) : first + cur.chunkSize;
      s = { ...cur, nextByte: next };
    }
    return { kind: 'ready', checkpoint: cpOf(s, 'upload_ready') };
  } catch (err) {
    const cp = s ? cpOf(s, 'uploading') : undefined;
    if (err instanceof ProviderHttpError) {
      if (err.status === 404 && s) return { kind: 'retryable', code: 'youtube_session_expired', message: 'The YouTube upload session expired; the upload will restart.', checkpoint: { step: 'restart', data: {} } };
      return prepareFromClass(classifyYouTube(err, nowMs), cp);
    }
    return prepareTransport(err, 'YouTube', cp);
  }
}

export const youtubeWatchUrl = (connection: PublishConnection, id: string): string | null => (connection.isMock ? null : `https://www.youtube.com/watch?v=${id}`);

/** Provider-held release: the processing checkpoint carries `remoteSchedule` (engine/remote-schedule.ts). */
function withRemote(input: PublishInput, cp: Checkpoint, videoId: string): Checkpoint {
  const o = optsOf(input);
  if (o.schedulingOwner !== 'provider' || typeof o.publishAt !== 'string') return cp;
  return { ...cp, data: { ...cp.data, remoteSchedule: { provider: 'youtube', publishAt: new Date(o.publishAt).toISOString(), videoId } } };
}

async function publish(ctx: AdapterContext, input: PublishInput, checkpoint: Checkpoint | null): Promise<PublishOutcome> {
  const s = sessionOf(checkpoint);
  const video = input.media.find(isVideoMedia);
  if (!s || !video || s.assetId !== video.assetId || (checkpoint?.step !== 'upload_ready' && checkpoint?.step !== 'uploaded')) {
    return { kind: 'rejected_safe_to_retry', code: 'media_not_prepared', message: 'The YouTube upload is not ready; nothing was sent.' };
  }
  if (s.videoId) return { kind: 'processing', providerIds: [s.videoId], checkAfterMs: 30_000, checkpoint: withRemote(input, cpOf(s, 'uploaded'), s.videoId) };
  const token = oauthAccessToken(input.credentials, 'YouTube');
  const bytes = await loadBytes(video);
  if (!bytes) return { kind: 'rejected_safe_to_retry', code: 'media_unavailable', message: 'The video could not be read from storage; nothing was sent.' };
  try {
    const r = await putBytes(ctx, token, s, bytes, s.nextByte, s.total - 1, true);
    if (r.status === 308) return { kind: 'rejected_safe_to_retry', code: 'youtube_upload_incomplete', message: 'YouTube has not received the whole file yet; the upload will resume. No video was created.' };
    const id = typeof r.data.id === 'string' ? r.data.id : null;
    if (!id) return { kind: 'unknown', code: 'youtube_no_id', message: 'YouTube completed the upload but returned no video id; it will be reconciled.' };
    return { kind: 'processing', providerIds: [id], checkAfterMs: 30_000, checkpoint: withRemote(input, cpOf({ ...s, nextByte: s.total, videoId: id }, 'uploaded'), id) };
  } catch (err) {
    if (err instanceof ProviderHttpError) {
      if (err.status === 404) return { kind: 'rejected_safe_to_retry', code: 'youtube_session_expired', message: 'The YouTube upload session expired before completion; the upload will restart. No video was created.' };
      return publishFromClass(classifyYouTube(err, ctx.now().getTime()));
    }
    return publishTransport(err, 'YouTube');
  }
}

interface VideoStatus {
  id: string;
  status?: { uploadStatus?: string; privacyStatus?: string; publishAt?: string; failureReason?: string; rejectionReason?: string; selfDeclaredMadeForKids?: boolean; embeddable?: boolean; license?: string; publicStatsViewable?: boolean };
  processingDetails?: { processingStatus?: string };
}

async function getVideo(ctx: AdapterContext, token: string, id: string): Promise<VideoStatus | null> {
  const r = await ytCall<{ items?: VideoStatus[] }>(ctx, { method: 'GET', path: '/youtube/v3/videos', query: { part: 'status,processingDetails', id }, bearer: token, op: 'youtube.videos.status' });
  return r.data.items?.[0] ?? null;
}

async function reconcile(ctx: AdapterContext, ref: AttemptReference): Promise<ReconcileOutcome> {
  const token = oauthAccessToken(ref.credentials, 'YouTube');
  const s = sessionOf(ref.checkpoint);
  let id = ref.providerIds[0] ?? s?.videoId ?? null;
  try {
    if (!id) {
      if (!s) return { kind: 'still_unknown', reason: 'No YouTube upload session was recorded. Check the channel, then mark the delivery Published or Not published.' };
      try {
        const st = await sessionStatus(ctx, token, s);
        if (!st.complete) return { kind: 'not_published', reason: 'The upload never completed, so YouTube created no video.' };
        id = st.videoId;
      } catch (err) {
        if (err instanceof ProviderHttpError && err.status === 404) return { kind: 'not_published', reason: 'The upload session expired without completing; YouTube created no video.' };
        throw err;
      }
      if (!id) return { kind: 'still_unknown', reason: 'YouTube reports the upload complete but returned no video id. Check the channel.' };
    }
    const v = await getVideo(ctx, token, id);
    if (!v) return { kind: 'not_published', reason: 'The video no longer exists on YouTube.' };
    const st = v.status ?? {};
    if (st.uploadStatus === 'failed') return { kind: 'not_published', reason: `YouTube processing failed (${st.failureReason ?? 'unknown'}).` };
    if (st.uploadStatus === 'rejected') return { kind: 'not_published', reason: `YouTube rejected the video (${st.rejectionReason ?? 'unknown'}).` };
    if (st.uploadStatus === 'deleted') return { kind: 'not_published', reason: 'The video was deleted on YouTube.' };
    if (st.uploadStatus !== 'processed' || v.processingDetails?.processingStatus === 'processing') return { kind: 'processing', checkAfterMs: 60_000 };
    if (st.privacyStatus === 'private' && st.publishAt && Date.parse(st.publishAt) > ctx.now().getTime()) {
      // Provider-held release: not public yet.
      return { kind: 'processing', checkAfterMs: Math.min(3600_000, Math.max(60_000, Date.parse(st.publishAt) - ctx.now().getTime())) };
    }
    return { kind: 'published', providerIds: [id], url: youtubeWatchUrl(ref.connection, id), publishedAt: null };
  } catch (err) {
    if (err instanceof ProviderHttpError) return { kind: 'still_unknown', reason: `Could not read the video status: ${classifyYouTube(err, ctx.now().getTime()).message}` };
    return { kind: 'still_unknown', reason: 'Could not reach YouTube to check the video.' };
  }
}

/** Cancel a provider-held release (videos.update → private, no publishAt) and confirm by re-reading. */
async function cancelRemoteSchedule(ctx: AdapterContext, ref: AttemptReference): Promise<RemoteScheduleCancelOutcome> {
  const id = ref.providerIds[0] ?? sessionOf(ref.checkpoint)?.videoId ?? null;
  if (!id) return { kind: 'uncertain', message: 'No YouTube video id is known for this delivery; if the upload completed, the scheduled release may still happen. Check YouTube Studio.' };
  const scopes = grantedScopes(ref.credentials);
  if (scopes.length && !scopes.includes(YT_SCOPE_FORCE_SSL)) return { kind: 'unsupported', message: 'Relay lacks permission to edit this video; cancel the scheduled release in YouTube Studio.' };
  const token = oauthAccessToken(ref.credentials, 'YouTube');
  let scheduledFor: string | null = null;
  try {
    const before = await getVideo(ctx, token, id);
    if (!before) return { kind: 'cancelled', message: 'The video no longer exists on YouTube; nothing will be released.' };
    scheduledFor = before.status?.publishAt ?? null;
    if (before.status?.privacyStatus !== 'private' || !scheduledFor) {
      return before.status?.privacyStatus === 'private'
        ? { kind: 'cancelled', message: 'The video is private with no scheduled release.' }
        : { kind: 'too_late', message: `The video is already ${before.status?.privacyStatus ?? 'visible'} on YouTube.` };
    }
    if (Date.parse(scheduledFor) <= ctx.now().getTime()) return { kind: 'too_late', message: 'The scheduled YouTube release time has already passed.' };
    const st = before.status;
    await ytCall(ctx, {
      method: 'PUT', path: '/youtube/v3/videos', query: { part: 'status' }, bearer: token, op: 'youtube.videos.unschedule',
      // Omitted status properties are reset by videos.update (Y4): resend the ones we know, without publishAt.
      json: { id, status: { privacyStatus: 'private', ...(typeof st.selfDeclaredMadeForKids === 'boolean' ? { selfDeclaredMadeForKids: st.selfDeclaredMadeForKids } : {}),
        ...(typeof st.embeddable === 'boolean' ? { embeddable: st.embeddable } : {}), ...(st.license ? { license: st.license } : {}),
        ...(typeof st.publicStatsViewable === 'boolean' ? { publicStatsViewable: st.publicStatsViewable } : {}) } },
    });
    const after = await getVideo(ctx, token, id);
    if (after?.status?.privacyStatus === 'private' && !after.status.publishAt) return { kind: 'cancelled', message: 'The scheduled YouTube release was cancelled; the video stays private.' };
    return { kind: 'uncertain', scheduledFor, message: `YouTube still reports a scheduled release (${after?.status?.publishAt ?? scheduledFor}). Cancel it in YouTube Studio.` };
  } catch (err) {
    const why = err instanceof ProviderHttpError ? classifyYouTube(err, ctx.now().getTime()).message : 'YouTube could not be reached.';
    return { kind: 'uncertain', scheduledFor, message: `Could not cancel the scheduled YouTube release (${why}) It may still be published at ${scheduledFor ?? 'the scheduled time'}; cancel it in YouTube Studio.` };
  }
}

async function health(ctx: AdapterContext, connection: PublishConnection, credentials: ProviderCredentials): Promise<ConnectionHealth> {
  const checkedAt = ctx.now().toISOString();
  let channels: Awaited<ReturnType<typeof myChannels>>;
  try {
    channels = await myChannels(ctx, oauthAccessToken(credentials, 'YouTube'));
  } catch (err) {
    if (err instanceof ProviderHttpError) {
      const c = classifyYouTube(err, ctx.now().getTime());
      if (c.kind === 'reconnect') return { status: 'reconnect_required', checkedAt, message: c.message };
      if (c.kind === 'permission') return { status: 'missing_permission', checkedAt, message: c.message, missingPermissions: ['youtube.readonly'] };
    }
    throw err;
  }
  const ch = channels.find((c) => c.id === connection.providerAccountId);
  if (!ch) return { status: 'reconnect_required', checkedAt, message: 'This Google authorization no longer covers the connected YouTube channel. Reconnect the channel.' };
  const scopes = grantedScopes(credentials);
  const metadata = { display_name: ch.snippet?.title ?? null, long_uploads: ch.status?.longUploadsStatus ?? null, granted_scopes: scopes, native_scheduling: !scopes.length || scopes.includes(YT_SCOPE_FORCE_SSL) };
  const missing = missingScopes(YOUTUBE_REQUIRED_SCOPES, scopes);
  if (missing.length) return { status: 'missing_permission', checkedAt, metadata, missingPermissions: missing, message: `Google did not grant: ${missing.join(', ')}. Click Reconnect and allow YouTube uploads.` };
  return { status: 'ready', checkedAt, metadata, message: `Connected to ${ch.snippet?.title ?? 'the YouTube channel'}.` };
}

/** Custom thumbnail (thumbnails.set, ≤ 50 MB JPEG/PNG; the channel must be allowed custom thumbnails). Not wired into publish. */
export async function setYouTubeThumbnail(ctx: AdapterContext, credentials: ProviderCredentials, videoId: string, image: { data: Uint8Array; mime: string }): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  try {
    await ytCall(ctx, { method: 'POST', path: '/upload/youtube/v3/thumbnails/set', query: { videoId }, bearer: oauthAccessToken(credentials, 'YouTube'), bytes: { data: image.data, contentType: image.mime }, op: 'youtube.thumbnails.set' });
    return { ok: true };
  } catch (err) {
    if (err instanceof ProviderHttpError) { const c = classifyYouTube(err, ctx.now().getTime()); return { ok: false, code: c.code, message: c.message }; }
    return { ok: false, code: 'network', message: 'YouTube could not be reached.' };
  }
}

export const youtubeAdapter: PublishingAdapter = {
  provider: 'youtube',
  capabilities,
  validate,
  prepare,
  publish,
  reconcile,
  health,
  refreshCredentials: refreshYouTubeCredentials,
  cancelRemoteSchedule,
};
