// Pinterest API v5 adapter: create Pins on the connected board. Sources: docs/providers/pinterest.md.
//  Images: media_source image_url / multiple_image_urls (Pinterest fetches the signed URL) — no preparation.
//  Video:  prepare = POST /v5/media → multipart POST to upload_url (S3) → GET /v5/media/{id} until succeeded.
//  publish: POST /v5/pins (publishes:true) → 201 {id}. reconcile: the board's recent Pins.
import {
  validateVariant,
  type AdapterContext, type AttemptReference, type ChannelCapabilities, type ChannelConstraints, type Checkpoint,
  type ConnectionHealth, type PrepareOutcome, type ProviderCredentials, type PublishConnection, type PublishInput,
  type PublishOutcome, type PublishingAdapter, type ReconcileOutcome, type ValidationIssue, type ValidationResult,
} from '@social-lite/core';
import { ProviderHttpError, call, oauthAccessToken } from '../shared/http.js';
import { prepareFromClass, prepareTransport, publishFromClass, publishTransport } from '../shared/classify.js';
import { factsOf, isVideoMedia, loadBytes, providerOptions } from '../shared/media.js';
import { classifyPinterest, parsePinterestError, pinCall } from './api.js';
import { refreshPinterestCredentials, userAccount } from './oauth.js';

export const PINTEREST_CONSTRAINTS_VERSION = 'pinterest-v5.28@2026-11-07';

export const PINTEREST_CONSTRAINTS: ChannelConstraints = {
  maxTextLength: 800,           // description ≤ 800 (unit not stated; code points assumed)
  maxCaptionLength: 800,
  textCounting: 'codepoints',
  requiresMedia: true,
  supportsTextOnly: false,
  supportsLink: true,           // destination link (separate `link` field, ≤ 2048)
  supportsButtons: false,
  maxButtons: 0,
  maxImages: 5,                 // multiple_image_urls: 2–5
  maxAlbumItems: 5,
  minAlbumItems: 2,
  albumAllowsVideo: false,
  imageMimes: ['image/jpeg', 'image/png'],
  maxImageBytes: 20 * 1024 * 1024,
  maxVideos: 1,
  videoMimes: ['video/mp4', 'video/quicktime', 'video/x-m4v'],
  maxVideoBytes: 2 * 1024 * 1024 * 1024,
  minVideoSeconds: 4,
  maxVideoSeconds: 15 * 60,
  videoCodecs: ['h264', 'hevc'],
};

export interface PinterestOptions { title: string; altText: string }
const optsOf = (input: Pick<PublishInput, 'variant'>) => providerOptions<PinterestOptions>(input.variant.options, 'pinterest');

function capabilities(connection: PublishConnection): ChannelCapabilities {
  const trial = connection.metadata.access_tier !== 'standard';
  return {
    provider: 'pinterest', formats: ['image', 'album', 'video'], canPublish: true, canEditPublished: false, canDeletePublished: false,
    canReadMetrics: true, canReconcile: true, constraints: PINTEREST_CONSTRAINTS, constraintsVersion: PINTEREST_CONSTRAINTS_VERSION, checkedAt: new Date().toISOString(),
    publishMode: 'direct', nativeScheduling: false,
    eligibility: trial
      ? { status: 'restricted', message: 'Pinterest Trial access: Pins are created as sandbox entities visible only to you until the app is upgraded to Standard access.' }
      : { status: 'eligible', message: 'Pinterest Standard access.' },
    requiredOptions: [],
  };
}

function validate(input: Pick<PublishInput, 'variant' | 'media' | 'connection'>): ValidationResult {
  const base = validateVariant({
    provider: 'pinterest', connectionId: input.connection.id, constraints: PINTEREST_CONSTRAINTS,
    text: input.variant.text, link: input.variant.link, buttons: input.variant.buttons, media: factsOf(input.media), linkIsSeparateField: true,
  });
  const issues: ValidationIssue[] = [...base.issues];
  const add = (field: ValidationIssue['field'], code: string, message: string) => issues.push({ connectionId: input.connection.id, provider: 'pinterest', field, code, message: `Pinterest: ${message}` });
  const o = optsOf(input);
  if (o.title && [...o.title].length > 100) add('options', 'pinterest_title_too_long', `title is ${[...o.title].length} of 100 characters.`);
  if (o.altText && [...o.altText].length > 500) add('options', 'pinterest_alt_too_long', `alt text is ${[...o.altText].length} of 500 characters.`);
  if (input.variant.link && input.variant.link.length > 2048) add('link', 'pinterest_link_too_long', 'the destination link is longer than 2048 characters.');
  if (!input.connection.providerAccountId) add('destination', 'pinterest_board_required', 'choose a board.');
  return { ok: issues.length === 0, issues };
}

// ------------------------------------------------------------------ video media
interface VideoState { assetId: string; mediaId: string; uploaded: boolean; status: string }
const videoOf = (cp: Checkpoint | null): VideoState | null => {
  const d = cp?.data as Partial<VideoState> | undefined;
  return d && typeof d.mediaId === 'string' ? (d as VideoState) : null;
};

async function prepare(ctx: AdapterContext, input: PublishInput, checkpoint: Checkpoint | null): Promise<PrepareOutcome> {
  const v = validate(input);
  if (!v.ok) return { kind: 'permanent', code: 'invalid_content', message: v.issues.map((i) => i.message).join(' ') };
  const video = input.media.find(isVideoMedia);
  if (!video) return { kind: 'ready', checkpoint: { step: 'images_by_url', data: {} } };
  const token = oauthAccessToken(input.credentials, 'Pinterest');
  let s = videoOf(checkpoint);
  if (s && s.assetId !== video.assetId) s = null;
  try {
    if (!s) {
      const r = await pinCall<{ media_id?: string; upload_url?: string; upload_parameters?: Record<string, string> }>(ctx, { method: 'POST', path: '/v5/media', bearer: token, json: { media_type: 'video' }, op: 'pinterest.media.register' });
      if (!r.data.media_id || !r.data.upload_url) return { kind: 'retryable', code: 'pinterest_no_upload_url', message: 'Pinterest did not return an upload URL; it will be retried.' };
      const bytes = await loadBytes(video);
      if (!bytes) return { kind: 'retryable', code: 'media_unavailable', message: 'The video could not be read from storage; it will be retried.' };
      const form = new FormData();
      for (const [k, val] of Object.entries(r.data.upload_parameters ?? {})) form.append(k, val);
      form.append('file', new Blob([bytes as unknown as ArrayBuffer], { type: video.mime }), 'video.mp4');
      // Pre-signed S3 form POST: no Pinterest Authorization header.
      await call(ctx, { method: 'POST', url: r.data.upload_url, formData: form, op: 'pinterest.media.upload', timeoutMs: 600_000 }, parsePinterestError);
      s = { assetId: video.assetId, mediaId: r.data.media_id, uploaded: true, status: 'registered' };
    }
    const st = await pinCall<{ status?: string }>(ctx, { method: 'GET', path: `/v5/media/${encodeURIComponent(s.mediaId)}`, bearer: token, op: 'pinterest.media.status' });
    s = { ...s, status: st.data.status ?? 'processing' };
    if (s.status === 'failed') return { kind: 'permanent', code: 'pinterest_video_failed', message: 'Pinterest could not process the video. Use MP4/MOV/M4V (H.264/H.265), 4 s – 15 min, ≤ 2 GB.' };
    if (s.status !== 'succeeded') return { kind: 'pending', checkpoint: { step: 'video_processing', data: { ...s } }, checkAfterMs: 15_000 };
    return { kind: 'ready', checkpoint: { step: 'video_ready', data: { ...s } } };
  } catch (err) {
    const cp = s ? { step: 'video_processing', data: { ...s } } : undefined;
    if (err instanceof ProviderHttpError) return prepareFromClass(classifyPinterest(err, ctx.now().getTime()), cp);
    return prepareTransport(err, 'Pinterest', cp);
  }
}

export function pinBody(input: PublishInput, checkpoint: Checkpoint | null): Record<string, unknown> | null {
  const o = optsOf(input);
  const video = input.media.find(isVideoMedia);
  let media_source: Record<string, unknown>;
  if (video) {
    const s = videoOf(checkpoint);
    if (!s || s.status !== 'succeeded' || s.assetId !== video.assetId) return null;
    media_source = { source_type: 'video_id', media_id: s.mediaId, ...(video.posterUrl ? { cover_image_url: video.posterUrl } : { cover_image_key_frame_time: 0 }) };
  } else if (input.media.length > 1) {
    media_source = { source_type: 'multiple_image_urls', items: input.media.map((m) => ({ url: m.url })) };
  } else {
    media_source = { source_type: 'image_url', url: input.media[0]!.url };
  }
  return {
    board_id: input.connection.providerAccountId,
    ...(o.title ? { title: o.title } : {}),
    ...(input.variant.text ? { description: input.variant.text } : {}),
    ...(input.variant.link ? { link: input.variant.link } : {}),
    ...(o.altText ? { alt_text: o.altText } : {}),
    media_source,
  };
}

export const pinUrl = (connection: PublishConnection, id: string): string | null => (connection.isMock ? null : `https://www.pinterest.com/pin/${id}/`);

async function publish(ctx: AdapterContext, input: PublishInput, checkpoint: Checkpoint | null): Promise<PublishOutcome> {
  const body = pinBody(input, checkpoint);
  if (!body) return { kind: 'rejected_safe_to_retry', code: 'media_not_prepared', message: 'The Pinterest video is not ready; nothing was sent.' };
  try {
    const r = await pinCall<{ id?: string }>(ctx, { method: 'POST', path: '/v5/pins', bearer: oauthAccessToken(input.credentials, 'Pinterest'), json: body, op: 'pinterest.pins.create', publishes: true, timeoutMs: 60_000 });
    if (!r.data.id) return { kind: 'unknown', code: 'pinterest_no_id', message: 'Pinterest accepted the Pin but returned no id; it will be reconciled.' };
    return { kind: 'confirmed', providerIds: [String(r.data.id)], url: pinUrl(input.connection, String(r.data.id)), publishedAt: ctx.now().toISOString() };
  } catch (err) {
    if (err instanceof ProviderHttpError) {
      if (err.status === 404) return { kind: 'permanent_failure', code: 'pinterest_board_not_found', message: 'The Pinterest board no longer exists or is not accessible. Reconnect and choose a board.', blocking: 'permission' };
      return publishFromClass(classifyPinterest(err, ctx.now().getTime()));
    }
    return publishTransport(err, 'Pinterest');
  }
}

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

async function reconcile(ctx: AdapterContext, ref: AttemptReference): Promise<ReconcileOutcome> {
  if (ref.providerIds.length) return { kind: 'published', providerIds: ref.providerIds, url: pinUrl(ref.connection, ref.providerIds[0]!) };
  const sentMs = ref.sentAt ? Date.parse(ref.sentAt) : ctx.now().getTime() - 30 * 60_000;
  try {
    const r = await pinCall<{ items?: Array<{ id: string; description?: string | null; created_at?: string }> }>(ctx, {
      method: 'GET', path: `/v5/boards/${encodeURIComponent(ref.connection.providerAccountId)}/pins`, query: { page_size: '25' }, bearer: oauthAccessToken(ref.credentials, 'Pinterest'), op: 'pinterest.board.pins',
    });
    const want = norm(ref.variantText);
    const hit = (r.data.items ?? []).find((p) => (!p.created_at || Date.parse(p.created_at) >= sentMs - 10 * 60_000) && norm(p.description) === want);
    if (hit) return { kind: 'published', providerIds: [hit.id], url: pinUrl(ref.connection, hit.id), publishedAt: hit.created_at ?? null };
    return { kind: 'still_unknown', reason: 'No matching Pin found on the board since the send time. Check the board, then mark the delivery Published or Not published.' };
  } catch (err) {
    if (err instanceof ProviderHttpError) return { kind: 'still_unknown', reason: `Could not list the board's Pins: ${classifyPinterest(err, ctx.now().getTime()).message}` };
    return { kind: 'still_unknown', reason: 'Could not reach Pinterest to check whether the Pin exists.' };
  }
}

async function health(ctx: AdapterContext, connection: PublishConnection, credentials: ProviderCredentials): Promise<ConnectionHealth> {
  const checkedAt = ctx.now().toISOString();
  const token = oauthAccessToken(credentials, 'Pinterest');
  try {
    const me = await userAccount(ctx, token);
    if (connection.metadata.user_id && me.id && String(me.id) !== String(connection.metadata.user_id)) {
      return { status: 'reconnect_required', checkedAt, message: 'This Pinterest token belongs to a different account. Reconnect the original account.' };
    }
    const board = await pinCall<{ id?: string; name?: string; privacy?: string }>(ctx, { method: 'GET', path: `/v5/boards/${encodeURIComponent(connection.providerAccountId)}`, bearer: token, op: 'pinterest.board.get' });
    const metadata = { board_name: board.data.name ?? null, board_privacy: board.data.privacy ?? null, access_tier: ctx.config.features?.pinterest_access_tier === 'standard' ? 'standard' : 'trial' };
    return { status: 'ready', checkedAt, metadata, message: `Connected to board ${board.data.name ?? connection.displayName}.` };
  } catch (err) {
    if (err instanceof ProviderHttpError) {
      if (err.status === 404) return { status: 'missing_permission', checkedAt, missingPermissions: ['board'], message: 'The Pinterest board no longer exists or is not accessible. Reconnect and choose a board.' };
      const c = classifyPinterest(err, ctx.now().getTime());
      if (c.kind === 'reconnect') return { status: 'reconnect_required', checkedAt, message: c.message };
      if (c.kind === 'permission') return { status: 'missing_permission', checkedAt, message: c.message, missingPermissions: ['boards:read'] };
    }
    throw err;
  }
}

export const pinterestAdapter: PublishingAdapter = {
  provider: 'pinterest',
  capabilities,
  validate,
  prepare,
  publish,
  reconcile,
  health,
  refreshCredentials: refreshPinterestCredentials,
};

