// TikTok Content Posting API adapter. Sources: docs/providers/tiktok.md.
//  Modes (connection.metadata.publish_mode): 'direct' (Direct Post, video.publish), 'inbox' (draft upload,
//  video.upload → MANUAL HANDOFF in the TikTok app), 'manual' (no API publishing; tiktokManualHandoff()).
//  Video (FILE_UPLOAD): prepare = creator_info (direct) → init → upload every chunk EXCEPT the last (nothing is
//  visible until all bytes arrive); publish = last chunk PUT (publishes:true) → 'processing' with publish_id.
//  Photo (PULL_FROM_URL only): publish = content/init (publishes:true).
//  reconcile = status/fetch by publish_id: PUBLISH_COMPLETE ⇒ published; FAILED ⇒ not published;
//  SEND_TO_USER_INBOX ⇒ manual handoff (still unknown until the creator posts).
import {
  validateVariant,
  type AdapterContext, type AttemptReference, type ChannelCapabilities, type ChannelConstraints, type Checkpoint,
  type ConnectionHealth, type PrepareOutcome, type ProviderCredentials, type PublishConnection, type PublishInput,
  type PublishOutcome, type PublishingAdapter, type ReconcileOutcome, type ValidationIssue, type ValidationResult,
} from '@social-lite/core';
import { ProviderHttpError, oauthAccessToken } from '../shared/http.js';
import { prepareFromClass, prepareTransport, publishFromClass, publishTransport } from '../shared/classify.js';
import { factsOf, isVideoMedia, loadBytes, providerOptions } from '../shared/media.js';
import { grantedScopes } from '../shared/oauth.js';
import { TIKTOK_JSON, chunkPlan, chunkRange, classifyTikTok, tiktokCall } from './api.js';
import { fetchUserInfo, publishModeFor, queryCreatorInfo, refreshTikTokCredentials, type TikTokPublishMode } from './oauth.js';

export const TIKTOK_CONSTRAINTS_VERSION = 'tiktok-content-posting@2026-11-07';

export const TIKTOK_CONSTRAINTS: ChannelConstraints = {
  maxTextLength: 2200,          // post_info.title "2200 in UTF-16 runes" (video); photo description ≤ 4000 (we cap at 2200)
  maxCaptionLength: 2200,
  textCounting: 'utf16',
  requiresMedia: true,
  supportsTextOnly: false,
  supportsLink: false,          // no clickable links in captions
  supportsButtons: false,
  maxButtons: 0,
  maxImages: 35,                // photo post: up to 35 photo_images
  maxAlbumItems: 35,
  albumAllowsVideo: false,
  imageMimes: ['image/jpeg', 'image/webp'],
  maxImageBytes: 20 * 1024 * 1024,
  maxVideos: 1,
  videoMimes: ['video/mp4', 'video/quicktime', 'video/webm'],
  maxVideoBytes: 4 * 1024 * 1024 * 1024,
  maxVideoSeconds: 600,         // Upload Video endpoint: 10 min (creator limit re-checked via creator_info)
  videoCodecs: ['h264', 'hevc', 'vp8', 'vp9'],
  minFrameRate: 23,
  maxFrameRate: 60,
  maxVideoLongSide: 4096,
  maxVideoShortSide: 4096,
};

export const TIKTOK_PRIVACY_LEVELS = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'] as const;
export type TikTokPrivacy = (typeof TIKTOK_PRIVACY_LEVELS)[number];

/** variant.options.tiktok — the Direct Post UX fields TikTok requires (T7). */
export interface TikTokOptions {
  /** Explicit per-post mode; defaults to the connection's mode. 'inbox' = draft handoff. */
  mode: 'direct' | 'inbox';
  /** Required for Direct Post; chosen by the user from creator_info privacy_level_options, no default. */
  privacyLevel: TikTokPrivacy;
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  /** "Your brand" → labelled "Promotional content". */
  brandOrganic: boolean;
  /** "Branded content" → labelled "Paid partnership"; cannot be SELF_ONLY. */
  brandContent: boolean;
  isAigc: boolean;
  /** The user expressly consented to sending this content to TikTok (required). */
  consent: boolean;
  /** Photo posts only: title ≤ 90 UTF-16 (the text becomes the description). */
  title: string;
  autoAddMusic: boolean;
  coverTimestampMs: number;
}

const connMode = (c: PublishConnection): TikTokPublishMode => {
  const m = c.metadata.publish_mode;
  return m === 'inbox' || m === 'manual' || m === 'direct' ? m : 'direct';
};
const optsOf = (input: Pick<PublishInput, 'variant'>) => providerOptions<TikTokOptions>(input.variant.options, 'tiktok');
const effectiveMode = (input: Pick<PublishInput, 'variant' | 'connection'>): TikTokPublishMode => {
  const cm = connMode(input.connection);
  if (cm === 'manual') return 'manual';
  if (optsOf(input).mode === 'inbox' || cm === 'inbox') return 'inbox';
  return 'direct';
};

function capabilities(connection: PublishConnection): ChannelCapabilities {
  const mode = connMode(connection);
  const audited = connection.metadata.direct_post_audited === true;
  const scopes = Array.isArray(connection.metadata.granted_scopes) ? (connection.metadata.granted_scopes as string[]) : [];
  return {
    provider: 'tiktok', formats: ['video', 'image', 'album'], canPublish: mode !== 'manual', canEditPublished: false, canDeletePublished: false,
    canReadMetrics: !scopes.length || scopes.includes('video.list'), canReconcile: mode !== 'manual',
    constraints: TIKTOK_CONSTRAINTS, constraintsVersion: TIKTOK_CONSTRAINTS_VERSION, checkedAt: new Date().toISOString(),
    publishMode: mode === 'direct' ? 'direct' : mode === 'inbox' ? 'draft_handoff' : 'manual',
    nativeScheduling: false,
    eligibility: mode === 'manual'
      ? { status: 'unsupported', message: 'No TikTok posting permission: use the manual handoff (download the media and caption, then post in the TikTok app).' }
      : mode === 'inbox'
        ? { status: 'restricted', message: 'Draft upload only: TikTok delivers the video to the creator\'s inbox; the creator must finish posting in the app (manual handoff).' }
        : audited
          ? { status: 'eligible', message: 'Direct Post (audited client).' }
          : { status: 'restricted', message: 'Unaudited TikTok client: posts are limited to SELF_ONLY on private accounts (max 5 creators / 24 h) until TikTok\'s audit is passed.' },
    requiredOptions: mode === 'direct' ? ['tiktok.privacyLevel', 'tiktok.consent'] : mode === 'inbox' ? ['tiktok.consent'] : [],
  };
}

function validate(input: Pick<PublishInput, 'variant' | 'media' | 'connection'>): ValidationResult {
  const base = validateVariant({
    provider: 'tiktok', connectionId: input.connection.id, constraints: TIKTOK_CONSTRAINTS,
    text: input.variant.text, link: input.variant.link, buttons: input.variant.buttons, media: factsOf(input.media),
  });
  const issues: ValidationIssue[] = [...base.issues];
  const add = (field: ValidationIssue['field'], code: string, message: string) =>
    issues.push({ connectionId: input.connection.id, provider: 'tiktok', field, code, message: `TikTok: ${message}` });
  const o = optsOf(input);
  const mode = effectiveMode(input);
  const photos = input.media.length > 0 && !input.media.some(isVideoMedia);
  if (mode === 'manual') add('destination', 'tiktok_manual_only', 'this account has no posting permission. Use the manual handoff (download and post in the TikTok app) or reconnect and approve posting.');
  if (mode !== 'manual' && o.consent !== true) add('options', 'tiktok_consent_required', 'confirm that you agree to TikTok\'s Music Usage Confirmation (and Branded Content Policy if applicable) before this is sent.');
  if (mode === 'direct') {
    if (!o.privacyLevel || !(TIKTOK_PRIVACY_LEVELS as readonly string[]).includes(o.privacyLevel)) {
      add('options', 'tiktok_privacy_required', 'choose who can view this post (there is no default).');
    } else {
      const allowed = input.connection.metadata.privacy_level_options;
      if (Array.isArray(allowed) && allowed.length && !allowed.includes(o.privacyLevel)) add('options', 'tiktok_privacy_unavailable', `privacy "${o.privacyLevel}" is not available for this creator (options: ${allowed.join(', ')}).`);
      if (o.brandContent && o.privacyLevel === 'SELF_ONLY') add('options', 'tiktok_branded_private', 'branded content visibility cannot be set to private.');
    }
  }
  if (photos && o.title && o.title.length > 90) add('options', 'tiktok_photo_title', `photo title is ${o.title.length} of 90 allowed.`);
  for (const m of input.media) {
    if (isVideoMedia(m) && m.width && m.height && Math.min(m.width, m.height) < 360) add('media', 'video_dimensions', `video is ${m.width}×${m.height}; TikTok needs at least 360 px on each side.`);
  }
  return { ok: issues.length === 0, issues };
}

// ------------------------------------------------------------------ checkpoints
interface UploadState {
  mode: 'direct' | 'inbox';
  assetId: string;
  publishId: string;
  uploadUrl: string;
  uploadExpiresAt: string;
  videoSize: number;
  chunkSize: number;
  totalChunks: number;
  nextChunk: number;
}
const uploadState = (cp: Checkpoint | null): UploadState | null => {
  const d = cp?.data as Partial<UploadState> | undefined;
  return d && typeof d.publishId === 'string' && typeof d.uploadUrl === 'string' && typeof d.nextChunk === 'number' ? (d as UploadState) : null;
};
const cpOf = (s: UploadState, step: string): Checkpoint => ({ step, data: { ...s }, expiresAt: s.uploadExpiresAt });
const UPLOAD_URL_TTL_MS = 55 * 60_000; // "valid for one hour after issuance" — keep a 5 min margin

function postInfo(input: PublishInput, o: Partial<TikTokOptions>): Record<string, unknown> {
  return {
    title: input.variant.text,
    privacy_level: o.privacyLevel,
    disable_comment: o.allowComment !== true,
    disable_duet: o.allowDuet !== true,
    disable_stitch: o.allowStitch !== true,
    ...(typeof o.coverTimestampMs === 'number' ? { video_cover_timestamp_ms: o.coverTimestampMs } : {}),
    brand_content_toggle: o.brandContent === true,
    brand_organic_toggle: o.brandOrganic === true,
    is_aigc: o.isAigc === true,
  };
}

async function putChunk(ctx: AdapterContext, s: UploadState, bytes: Uint8Array, i: number, mime: string, publishes: boolean): Promise<number> {
  const [first, last] = chunkRange(s.videoSize, s, i);
  const r = await tiktokCall(ctx, {
    method: 'PUT', url: s.uploadUrl, op: publishes ? 'tiktok.upload.final' : 'tiktok.upload.chunk', publishes, timeoutMs: 300_000,
    bytes: { data: bytes.subarray(first, last + 1), contentType: mime === 'video/quicktime' || mime === 'video/webm' ? mime : 'video/mp4', extraHeaders: { 'content-range': `bytes ${first}-${last}/${s.videoSize}` } },
  });
  return r.status;
}

async function prepare(ctx: AdapterContext, input: PublishInput, checkpoint: Checkpoint | null): Promise<PrepareOutcome> {
  const v = validate(input);
  if (!v.ok) return { kind: 'permanent', code: 'invalid_content', message: v.issues.map((i) => i.message).join(' ') };
  const mode = effectiveMode(input);
  if (mode === 'manual') return { kind: 'permanent', code: 'tiktok_manual_only', message: 'TikTok: manual handoff only for this account.', blocking: 'permission' };
  const token = oauthAccessToken(input.credentials, 'TikTok');
  const nowMs = ctx.now().getTime();
  const o = optsOf(input);
  const video = input.media.find(isVideoMedia);
  let state = uploadState(checkpoint);
  try {
    // Fresh creator settings at post time (T7): privacy options, interaction settings, max duration.
    if (mode === 'direct' && !(state && state.mode === 'direct')) {
      const ci = await queryCreatorInfo(ctx, token);
      if (Array.isArray(ci.privacy_level_options) && o.privacyLevel && !ci.privacy_level_options.includes(o.privacyLevel)) {
        return { kind: 'permanent', code: 'tiktok_privacy_mismatch', message: `TikTok: privacy "${o.privacyLevel}" is no longer available for this creator (options: ${ci.privacy_level_options.join(', ')}). Edit the post.` };
      }
      if (video?.durationMs && ci.max_video_post_duration_sec && video.durationMs / 1000 > ci.max_video_post_duration_sec + 0.001) {
        return { kind: 'permanent', code: 'tiktok_video_too_long', message: `TikTok: this creator can post videos up to ${ci.max_video_post_duration_sec} s. Trim the video.` };
      }
    }
    if (!video) return { kind: 'ready', checkpoint: { step: 'photo_ready', data: { mode } } };

    const usable = state && state.assetId === video.assetId && state.mode === mode && Date.parse(state.uploadExpiresAt) - nowMs > 0 && state.nextChunk < state.totalChunks;
    if (!usable) state = null;
    const bytes = await loadBytes(video);
    if (!bytes) return { kind: 'retryable', code: 'media_unavailable', message: 'The video could not be read from storage; it will be retried.', ...(state ? { checkpoint: cpOf(state, 'uploading') } : {}) };
    if (!state) {
      const plan = chunkPlan(bytes.byteLength);
      const source_info = { source: 'FILE_UPLOAD', video_size: bytes.byteLength, chunk_size: plan.chunkSize, total_chunk_count: plan.totalChunks };
      const r = await tiktokCall<{ data?: { publish_id?: string; upload_url?: string } }>(ctx, {
        method: 'POST', path: mode === 'direct' ? '/v2/post/publish/video/init/' : '/v2/post/publish/inbox/video/init/', bearer: token,
        headers: { 'content-type': TIKTOK_JSON }, json: mode === 'direct' ? { post_info: postInfo(input, o), source_info } : { source_info },
        op: mode === 'direct' ? 'tiktok.video.init' : 'tiktok.inbox.init',
      });
      const pid = r.data.data?.publish_id;
      const url = r.data.data?.upload_url;
      if (!pid || !url) return { kind: 'retryable', code: 'tiktok_no_upload_url', message: 'TikTok did not return an upload URL; it will be retried.' };
      state = { mode, assetId: video.assetId, publishId: pid, uploadUrl: url, uploadExpiresAt: new Date(nowMs + UPLOAD_URL_TTL_MS).toISOString(),
        videoSize: bytes.byteLength, chunkSize: plan.chunkSize, totalChunks: plan.totalChunks, nextChunk: 0 };
    }
    // Upload every chunk except the last one: the final chunk is the publishing step.
    while (state.nextChunk < state.totalChunks - 1) {
      try {
        await putChunk(ctx, state, bytes, state.nextChunk, video.mime, false);
      } catch (err) {
        if (err instanceof ProviderHttpError && err.status === 403) {
          return { kind: 'retryable', code: 'tiktok_upload_url_expired', message: 'The TikTok upload URL expired; the upload will restart.', checkpoint: { step: 'restart', data: {} } };
        }
        throw err;
      }
      state = { ...state, nextChunk: state.nextChunk + 1 };
    }
    return { kind: 'ready', checkpoint: cpOf(state, 'upload_ready') };
  } catch (err) {
    const cp = state ? cpOf(state, 'uploading') : undefined;
    if (err instanceof ProviderHttpError) return prepareFromClass(classifyTikTok(err, nowMs), cp);
    return prepareTransport(err, 'TikTok', cp);
  }
}

async function publish(ctx: AdapterContext, input: PublishInput, checkpoint: Checkpoint | null): Promise<PublishOutcome> {
  const token = oauthAccessToken(input.credentials, 'TikTok');
  const mode = effectiveMode(input);
  if (mode === 'manual') return { kind: 'permanent_failure', code: 'tiktok_manual_only', message: 'TikTok: manual handoff only for this account.', blocking: 'permission' };
  const o = optsOf(input);
  const video = input.media.find(isVideoMedia);
  try {
    if (!video) {
      // Photo post: PULL_FROM_URL is the only source (the storage domain must be verified, T3/T6).
      const r = await tiktokCall<{ data?: { publish_id?: string } }>(ctx, {
        method: 'POST', path: '/v2/post/publish/content/init/', bearer: token, headers: { 'content-type': TIKTOK_JSON }, publishes: true, op: 'tiktok.photo.init',
        json: {
          post_info: mode === 'direct'
            ? { ...(o.title ? { title: o.title } : {}), description: input.variant.text, privacy_level: o.privacyLevel, disable_comment: o.allowComment !== true,
                auto_add_music: o.autoAddMusic === true, brand_content_toggle: o.brandContent === true, brand_organic_toggle: o.brandOrganic === true }
            : { ...(o.title ? { title: o.title } : {}), description: input.variant.text },
          source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: input.media.map((m) => m.url) },
          post_mode: mode === 'direct' ? 'DIRECT_POST' : 'MEDIA_UPLOAD',
          media_type: 'PHOTO',
          ...(o.isAigc ? { is_aigc: true } : {}),
        },
      });
      const pid = r.data.data?.publish_id;
      if (!pid) return { kind: 'unknown', code: 'tiktok_no_publish_id', message: 'TikTok accepted the request but returned no publish id; check the TikTok account.' };
      return { kind: 'processing', providerIds: [pid], checkAfterMs: 15_000, checkpoint: { step: 'submitted', data: { mode, publishId: pid } } };
    }
    const s = uploadState(checkpoint);
    if (!s || checkpoint?.step !== 'upload_ready' || s.assetId !== video.assetId) {
      return { kind: 'rejected_safe_to_retry', code: 'media_not_prepared', message: 'The TikTok upload is not ready; nothing was sent.' };
    }
    if (Date.parse(s.uploadExpiresAt) <= ctx.now().getTime()) {
      return { kind: 'rejected_safe_to_retry', code: 'tiktok_upload_url_expired', message: 'The TikTok upload URL expired before the final chunk; the upload will restart. Nothing was posted.' };
    }
    const bytes = await loadBytes(video);
    if (!bytes) return { kind: 'rejected_safe_to_retry', code: 'media_unavailable', message: 'The video could not be read from storage; nothing was sent.' };
    const status = await putChunk(ctx, s, bytes, s.totalChunks - 1, video.mime, true);
    if (status === 206) return { kind: 'rejected_safe_to_retry', code: 'tiktok_upload_incomplete', message: 'TikTok has not received every chunk yet; the upload will resume. Nothing was posted.' };
    return { kind: 'processing', providerIds: [s.publishId], checkAfterMs: 15_000, checkpoint: cpOf({ ...s, nextChunk: s.totalChunks }, 'submitted') };
  } catch (err) {
    if (err instanceof ProviderHttpError) {
      if (video && err.status === 403 && !err.code) return { kind: 'rejected_safe_to_retry', code: 'tiktok_upload_url_expired', message: 'The TikTok upload URL expired; the upload will restart. Nothing was posted.' };
      return publishFromClass(classifyTikTok(err, ctx.now().getTime()));
    }
    return publishTransport(err, 'TikTok');
  }
}

interface StatusData { status?: string; fail_reason?: string; publicaly_available_post_id?: Array<number | string> }

export const TIKTOK_INBOX_HANDOFF = 'Manual handoff: the video was delivered to the creator\'s TikTok inbox as a draft. Open TikTok, finish and post it there; this delivery updates automatically when TikTok reports it posted. It was not published automatically.';

export function tiktokVideoUrl(connection: PublishConnection, postId: string): string | null {
  if (connection.isMock) return null;
  return connection.username ? `https://www.tiktok.com/@${connection.username.replace(/^@/, '')}/video/${postId}` : null;
}

async function reconcile(ctx: AdapterContext, ref: AttemptReference): Promise<ReconcileOutcome> {
  const fromCp = (ref.checkpoint?.data as { publishId?: unknown } | undefined)?.publishId;
  const publishId = ref.providerIds.find((x) => !/^\d+$/.test(x)) ?? (typeof fromCp === 'string' ? fromCp : null);
  if (!publishId) return { kind: 'still_unknown', reason: 'No TikTok publish id was recorded. Check the TikTok account, then mark the delivery Published or Not published.' };
  let data: StatusData;
  let rawPostIds: string[] | null = null;
  try {
    const r = await tiktokCall<{ data?: StatusData }>(ctx, {
      method: 'POST', path: '/v2/post/publish/status/fetch/', bearer: oauthAccessToken(ref.credentials, 'TikTok'), headers: { 'content-type': TIKTOK_JSON },
      json: { publish_id: publishId }, op: 'tiktok.status.fetch',
    });
    data = r.data.data ?? {};
    const m = /"publicaly_available_post_id"\s*:\s*\[([^\]]*)\]/.exec(r.raw.body);
    if (m) rawPostIds = m[1]!.split(',').map((x) => x.trim().replace(/^"|"$/g, '')).filter((x) => /^\d+$/.test(x));
  } catch (err) {
    if (err instanceof ProviderHttpError) return { kind: 'still_unknown', reason: `Could not read the TikTok publish status: ${classifyTikTok(err, ctx.now().getTime()).message}` };
    return { kind: 'still_unknown', reason: 'Could not reach TikTok to check the publish status.' };
  }
  switch (data.status) {
    case 'PUBLISH_COMPLETE': {
      // int64 ids: read them from the raw JSON text (JSON.parse would round 19-digit numbers).
      const postIds = rawPostIds ?? (data.publicaly_available_post_id ?? []).map(String);
      return { kind: 'published', providerIds: [publishId, ...postIds], url: postIds[0] ? tiktokVideoUrl(ref.connection, postIds[0]) : null };
    }
    case 'FAILED':
      return { kind: 'not_published', reason: `TikTok could not post this (${data.fail_reason ?? 'unknown reason'}).` };
    case 'SEND_TO_USER_INBOX':
      return { kind: 'handoff', reason: TIKTOK_INBOX_HANDOFF, providerIds: [publishId] };
    case 'PROCESSING_UPLOAD':
    case 'PROCESSING_DOWNLOAD':
      return { kind: 'processing', checkAfterMs: 15_000 };
    default:
      return { kind: 'still_unknown', reason: `TikTok reported status ${data.status ?? 'none'}.` };
  }
}

async function health(ctx: AdapterContext, connection: PublishConnection, credentials: ProviderCredentials): Promise<ConnectionHealth> {
  const checkedAt = ctx.now().toISOString();
  let me: Awaited<ReturnType<typeof fetchUserInfo>>;
  try {
    me = await fetchUserInfo(ctx, oauthAccessToken(credentials, 'TikTok'));
  } catch (err) {
    if (err instanceof ProviderHttpError) {
      const c = classifyTikTok(err, ctx.now().getTime());
      if (c.kind === 'reconnect') return { status: 'reconnect_required', checkedAt, message: c.message };
      if (c.kind === 'permission') return { status: 'missing_permission', checkedAt, message: c.message, missingPermissions: ['user.info.basic'] };
    }
    throw err;
  }
  if (me.open_id && String(me.open_id) !== connection.providerAccountId) {
    return { status: 'reconnect_required', checkedAt, message: 'This TikTok token now belongs to a different account. Reconnect the original account.' };
  }
  const scopes = grantedScopes(credentials);
  const mode = publishModeFor(scopes);
  const metadata = { display_name: me.display_name ?? null, publish_mode: mode, granted_scopes: scopes, direct_post_audited: ctx.config.features?.tiktok_direct_post_audited === true };
  if (credentials.kind === 'oauth2' && !credentials.refreshToken && credentials.expiresAt && Date.parse(credentials.expiresAt) - ctx.now().getTime() < 24 * 3600_000) {
    return { status: 'expiring', checkedAt, expiresAt: credentials.expiresAt, metadata, message: 'This TikTok authorization has no refresh token and expires soon. Reconnect to keep posting.' };
  }
  if (mode === 'manual') return { status: 'missing_permission', checkedAt, metadata, missingPermissions: ['video.publish', 'video.upload'], message: 'TikTok posting permission was not granted: only manual handoff is possible. Reconnect and approve posting.' };
  return { status: 'ready', checkedAt, metadata, message: mode === 'inbox' ? 'Connected for draft upload (manual handoff in the TikTok app).' : `Connected as ${me.display_name ?? connection.displayName}.` };
}

/** Manual handoff package (no API call): caption + media for download, then post in the TikTok app. */
export function tiktokManualHandoff(input: Pick<PublishInput, 'variant' | 'media'>): { label: 'Manual handoff'; caption: string; media: Array<{ url: string; mime: string }>; openUrl: string; instructions: string } {
  return {
    label: 'Manual handoff',
    caption: input.variant.text,
    media: input.media.map((m) => ({ url: m.url, mime: m.mime })),
    openUrl: 'https://www.tiktok.com/upload',
    instructions: 'Download the media, open the TikTok app, create the post and paste the caption. Relay does not publish this automatically.',
  };
}

export const tiktokAdapter: PublishingAdapter = {
  provider: 'tiktok',
  capabilities,
  validate,
  prepare,
  publish,
  reconcile,
  health,
  refreshCredentials: refreshTikTokCredentials,
};
