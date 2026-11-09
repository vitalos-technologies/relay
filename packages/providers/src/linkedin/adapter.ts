// LinkedIn Posts API adapter (versioned REST). Sources: docs/providers/linkedin.md.
//  Author = connection.providerAccountId (urn:li:person:… member, or urn:li:organization:… with a posting role).
//  prepare: Images API initializeUpload + PUT (org images polled until AVAILABLE; member tokens cannot GET images);
//           Videos API initializeUpload → PUT parts (ETags) → finalizeUpload → poll until AVAILABLE.
//  publish: POST /rest/posts (publishes:true) → 201, id in x-restli-id.
//  reconcile: organizations — posts by author since the send time; members — manual (r_member_social is restricted).
import {
  altTextFor, composeTextWithLink, validateVariant,
  type AdapterContext, type AttemptReference, type ChannelCapabilities, type ChannelConstraints, type Checkpoint,
  type ConnectionHealth, type PrepareOutcome, type ProviderCredentials, type PublishConnection, type PublishInput, type PublishMedia,
  type PublishOutcome, type PublishingAdapter, type ReconcileOutcome, type ValidationIssue, type ValidationResult,
} from '@social-lite/core';
import { ProviderHttpError, header, oauthAccessToken } from '../shared/http.js';
import { prepareFromClass, prepareTransport, publishFromClass, publishTransport } from '../shared/classify.js';
import { factsOf, isVideoMedia, loadBytes, providerOptions } from '../shared/media.js';
import { grantedScopes } from '../shared/oauth.js';
import { classifyLinkedIn, encUrn, liCall, liRest, littleEscape, littleUnescape } from './api.js';
import { LI_POSTING_ROLES, postingAcls, refreshLinkedInCredentials, userInfo } from './oauth.js';

export const LINKEDIN_CONSTRAINTS_VERSION = 'linkedin-rest-202610@2026-11-07';
export const LI_MAX_PIXELS = 36_152_320;

export const LINKEDIN_CONSTRAINTS: ChannelConstraints = {
  maxTextLength: 3000,          // assumed (not on the fetched pages)
  maxCaptionLength: 3000,
  textCounting: 'utf16',
  requiresMedia: false,
  supportsTextOnly: true,
  supportsLink: true,           // appended to the commentary
  supportsButtons: false,
  maxButtons: 0,
  maxImages: 20,                // MultiImage: 2–20
  maxAlbumItems: 20,
  minAlbumItems: 2,
  albumAllowsVideo: false,
  imageMimes: ['image/jpeg', 'image/png', 'image/gif'],
  maxImageBytes: 10 * 1024 * 1024, // app-side cap (LinkedIn documents pixels, not bytes)
  maxVideos: 1,
  videoMimes: ['video/mp4'],
  maxVideoBytes: 500 * 1024 * 1024,
  minVideoSeconds: 3,
  maxVideoSeconds: 30 * 60,
};

export interface LinkedInOptions { visibility: 'PUBLIC' | 'CONNECTIONS'; altTexts: string[]; videoTitle: string }
const optsOf = (input: Pick<PublishInput, 'variant'>) => providerOptions<LinkedInOptions>(input.variant.options, 'linkedin');
const isOrg = (c: PublishConnection) => c.providerAccountId.startsWith('urn:li:organization:') || c.metadata.account_type === 'organization';

function capabilities(connection: PublishConnection): ChannelCapabilities {
  const scopes = Array.isArray(connection.metadata.granted_scopes) ? (connection.metadata.granted_scopes as string[]) : [];
  const org = isOrg(connection);
  return {
    provider: 'linkedin', formats: ['text', 'image', 'album', 'video'], canPublish: true, canEditPublished: false, canDeletePublished: false,
    canReadMetrics: !scopes.length || scopes.includes(org ? 'rw_organization_admin' : 'r_member_postAnalytics'),
    canReconcile: org, constraints: LINKEDIN_CONSTRAINTS, constraintsVersion: LINKEDIN_CONSTRAINTS_VERSION, checkedAt: new Date().toISOString(),
    publishMode: 'direct', nativeScheduling: false,
    eligibility: org
      ? { status: 'eligible', message: 'Organization posting (Community Management API; requires an approved Page role).' }
      : { status: 'eligible', message: 'Member posting (Share on LinkedIn). Lost results must be checked manually.' },
    requiredOptions: [],
  };
}

function validate(input: Pick<PublishInput, 'variant' | 'media' | 'connection'>): ValidationResult {
  const base = validateVariant({
    provider: 'linkedin', connectionId: input.connection.id, constraints: LINKEDIN_CONSTRAINTS,
    text: input.variant.text, link: input.variant.link, buttons: input.variant.buttons, media: factsOf(input.media),
  });
  const issues: ValidationIssue[] = [...base.issues];
  const add = (field: ValidationIssue['field'], code: string, message: string) =>
    issues.push({ connectionId: input.connection.id, provider: 'linkedin', field, code, message: `LinkedIn: ${message}` });
  for (const m of input.media) {
    if (!isVideoMedia(m) && m.width * m.height >= LI_MAX_PIXELS) add('media', 'linkedin_too_many_pixels', `image has ${(m.width * m.height).toLocaleString('en')} pixels; LinkedIn accepts fewer than 36,152,320.`);
    if (isVideoMedia(m) && m.bytes && m.bytes < 75 * 1024) add('media', 'video_too_small', 'LinkedIn videos must be at least 75 KB.');
  }
  const o = optsOf(input);
  if (o.visibility === 'CONNECTIONS' && isOrg(input.connection)) add('options', 'linkedin_visibility', 'organization posts are public; "Connections only" applies to member posts.');
  if (!input.variant.text.trim() && !input.media.length) add('text', 'empty', 'write some text or add media.');
  return { ok: issues.length === 0, issues };
}

// ------------------------------------------------------------------ media upload
interface Part { url: string; first: number; last: number }
interface Item { assetId: string; urn: string; video: boolean; state: 'uploading' | 'finalizing' | 'processing' | 'ready'; parts?: Part[]; etags?: string[]; uploadToken?: string; uploadUrl?: string; expiresAt?: number | null }
const itemsOf = (cp: Checkpoint | null): Item[] => {
  const raw = (cp?.data as { items?: unknown } | undefined)?.items;
  return Array.isArray(raw) ? raw.filter((x): x is Item => !!x && typeof (x as Item).urn === 'string' && typeof (x as Item).assetId === 'string') : [];
};
const cpOf = (items: Item[]): Checkpoint => ({
  step: items.every((i) => i.state === 'ready') ? 'media_ready' : items.some((i) => i.state === 'uploading' || i.state === 'finalizing') ? 'media_uploading' : 'media_processing',
  data: { items },
});

async function initImage(ctx: AdapterContext, token: string, owner: string): Promise<{ urn: string; uploadUrl: string; expiresAt: number | null }> {
  const r = await liRest<{ value?: { uploadUrl?: string; image?: string; uploadUrlExpiresAt?: number } }>(ctx, {
    method: 'POST', path: '/rest/images', rawQuery: 'action=initializeUpload', bearer: token, json: { initializeUploadRequest: { owner } }, op: 'linkedin.images.init',
  });
  if (!r.data.value?.uploadUrl || !r.data.value.image) throw new ProviderHttpError('LinkedIn', 502, 'no_upload_url', 'LinkedIn did not return an upload URL', null);
  return { urn: r.data.value.image, uploadUrl: r.data.value.uploadUrl, expiresAt: r.data.value.uploadUrlExpiresAt ?? null };
}

async function mediaStatus(ctx: AdapterContext, token: string, item: Item): Promise<string | null> {
  const r = await liRest<{ status?: string }>(ctx, { method: 'GET', path: `/rest/${item.video ? 'videos' : 'images'}/${encUrn(item.urn)}`, bearer: token, op: item.video ? 'linkedin.videos.get' : 'linkedin.images.get' });
  return r.data.status ?? null;
}

class ProcessingFailed extends Error {}

async function advance(ctx: AdapterContext, token: string, owner: string, m: PublishMedia, prev: Item | null, org: boolean, progress: (i: Item) => void): Promise<Item> {
  const nowMs = ctx.now().getTime();
  let item = prev && (!prev.expiresAt || prev.expiresAt > nowMs || prev.state === 'processing' || prev.state === 'ready') ? prev : null;
  if (item?.state === 'ready') return item;
  if (!item || item.state === 'uploading' || item.state === 'finalizing') {
    const bytes = await loadBytes(m);
    if (!bytes) throw new Error('media_unavailable');
    if (!isVideoMedia(m)) {
      if (!item) { const i = await initImage(ctx, token, owner); item = { assetId: m.assetId, urn: i.urn, video: false, state: 'uploading', uploadUrl: i.uploadUrl, expiresAt: i.expiresAt }; progress(item); }
      await liCall(ctx, { method: 'PUT', url: item.uploadUrl!, bearer: token, bytes: { data: bytes, contentType: 'application/octet-stream' }, op: 'linkedin.images.upload', timeoutMs: 120_000 });
      item = { ...item, state: org ? 'processing' : 'ready', uploadUrl: undefined };
      progress(item);
    } else {
      if (!item) {
        const r = await liRest<{ value?: { video?: string; uploadInstructions?: Array<{ uploadUrl: string; firstByte: number; lastByte: number }>; uploadToken?: string; uploadUrlsExpireAt?: number } }>(ctx, {
          method: 'POST', path: '/rest/videos', rawQuery: 'action=initializeUpload', bearer: token, op: 'linkedin.videos.init',
          json: { initializeUploadRequest: { owner, fileSizeBytes: bytes.byteLength, uploadCaptions: false, uploadThumbnail: false } },
        });
        const v = r.data.value;
        if (!v?.video || !v.uploadInstructions?.length) throw new ProviderHttpError('LinkedIn', 502, 'no_upload_instructions', 'LinkedIn did not return upload instructions', null);
        item = { assetId: m.assetId, urn: v.video, video: true, state: 'uploading', uploadToken: v.uploadToken ?? '', expiresAt: v.uploadUrlsExpireAt ?? null,
          parts: v.uploadInstructions.map((p) => ({ url: p.uploadUrl, first: p.firstByte, last: p.lastByte })), etags: [] };
        progress(item);
      }
      for (let i = item.etags?.length ?? 0; item.state === 'uploading' && i < item.parts!.length; i++) {
        const p = item.parts![i]!;
        const r = await liCall(ctx, { method: 'PUT', url: p.url, bytes: { data: bytes.subarray(p.first, p.last + 1), contentType: 'application/octet-stream' }, op: 'linkedin.videos.part', timeoutMs: 300_000 });
        const etag = header(r.headers, 'etag');
        if (!etag) throw new ProviderHttpError('LinkedIn', 502, 'no_etag', 'LinkedIn did not return an ETag for a video part', null);
        item = { ...item, etags: [...(item.etags ?? []), etag] };
        progress(item);
      }
      if (item.state === 'uploading') { item = { ...item, state: 'finalizing' }; progress(item); }
      await liRest(ctx, { method: 'POST', path: '/rest/videos', rawQuery: 'action=finalizeUpload', bearer: token, op: 'linkedin.videos.finalize',
        json: { finalizeUploadRequest: { video: item.urn, uploadToken: item.uploadToken ?? '', uploadedPartIds: item.etags } } });
      item = { ...item, state: 'processing', parts: undefined };
      progress(item);
    }
  }
  if (item.state === 'processing') {
    const st = await mediaStatus(ctx, token, item);
    if (st === 'PROCESSING_FAILED') throw new ProcessingFailed();
    if (st === 'AVAILABLE') item = { ...item, state: 'ready' };
  }
  return item;
}

async function prepare(ctx: AdapterContext, input: PublishInput, checkpoint: Checkpoint | null): Promise<PrepareOutcome> {
  if (!input.media.length) return { kind: 'ready', checkpoint: { step: 'no_media', data: {} } };
  const v = validate(input);
  if (!v.ok) return { kind: 'permanent', code: 'invalid_content', message: v.issues.map((i) => i.message).join(' ') };
  const token = oauthAccessToken(input.credentials, 'LinkedIn');
  const owner = input.connection.providerAccountId;
  const org = isOrg(input.connection);
  const prev = itemsOf(checkpoint);
  const items: Item[] = [];
  for (let i = 0; i < input.media.length; i++) {
    const m = input.media[i]!;
    const p = prev[i] && prev[i]!.assetId === m.assetId ? prev[i]! : null;
    let latest: Item | null = p;
    try {
      items.push(await advance(ctx, token, owner, m, p, org, (it) => { latest = it; }));
    } catch (err) {
      const cp = cpOf([...items, ...(latest ? [latest] : [])]);
      if (err instanceof ProcessingFailed) return { kind: 'permanent', code: 'linkedin_media_processing_failed', message: `LinkedIn could not process the ${isVideoMedia(m) ? 'video (MP4, 3 s – 30 min, ≤ 500 MB)' : 'image (JPG/PNG/GIF)'}. Replace it.` };
      if (err instanceof Error && err.message === 'media_unavailable') return { kind: 'retryable', code: 'media_unavailable', message: 'The media could not be read from storage; it will be retried.', checkpoint: cp };
      if (err instanceof ProviderHttpError) return prepareFromClass(classifyLinkedIn(err, ctx.now().getTime()), cp);
      return prepareTransport(err, 'LinkedIn', cp);
    }
  }
  const cp = cpOf(items);
  return cp.step === 'media_ready' ? { kind: 'ready', checkpoint: cp } : { kind: 'pending', checkpoint: cp, checkAfterMs: items.some((i) => i.video) ? 15_000 : 5_000 };
}

export const linkedinPostUrl = (connection: PublishConnection, urn: string): string | null => (connection.isMock ? null : `https://www.linkedin.com/feed/update/${urn}/`);

export function postBody(input: PublishInput, checkpoint: Checkpoint | null): Record<string, unknown> | null {
  const o = optsOf(input);
  const items = itemsOf(checkpoint);
  if (input.media.length && (items.length !== input.media.length || items.some((i) => i.state !== 'ready'))) return null;
  // Image altText (≤ 4,086): a per-post override (options.altTexts[i]) or the library alt text (fix H3).
  const alt = (i: number) => {
    const m = input.media[i];
    const t = m ? altTextFor('linkedin', m, Array.isArray(o.altTexts) ? o.altTexts[i] : undefined) : null;
    return t ? { altText: t } : {};
  };
  let content: Record<string, unknown> | undefined;
  if (items.length === 1) content = { media: { id: items[0]!.urn, ...(items[0]!.video ? (o.videoTitle ? { title: o.videoTitle } : {}) : alt(0)) } };
  else if (items.length > 1) content = { multiImage: { images: items.map((it, i) => ({ id: it.urn, ...alt(i) })) } };
  return {
    author: input.connection.providerAccountId,
    commentary: littleEscape(composeTextWithLink(input.variant.text, input.variant.link)),
    visibility: o.visibility === 'CONNECTIONS' && !isOrg(input.connection) ? 'CONNECTIONS' : 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    ...(content ? { content } : {}),
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };
}

async function publish(ctx: AdapterContext, input: PublishInput, checkpoint: Checkpoint | null): Promise<PublishOutcome> {
  const body = postBody(input, checkpoint);
  if (!body) return { kind: 'rejected_safe_to_retry', code: 'media_not_prepared', message: 'The LinkedIn media is not ready yet; nothing was sent.' };
  try {
    const r = await liRest(ctx, { method: 'POST', path: '/rest/posts', bearer: oauthAccessToken(input.credentials, 'LinkedIn'), json: body, op: 'linkedin.posts.create', publishes: true, timeoutMs: 30_000 });
    const id = header(r.headers, 'x-restli-id') ?? header(r.headers, 'x-linkedin-id');
    if (!id) return { kind: 'unknown', code: 'linkedin_no_id', message: 'LinkedIn accepted the post but returned no id; it will be reconciled.' };
    return { kind: 'confirmed', providerIds: [id], url: linkedinPostUrl(input.connection, id), publishedAt: ctx.now().toISOString() };
  } catch (err) {
    if (err instanceof ProviderHttpError) return publishFromClass(classifyLinkedIn(err, ctx.now().getTime()));
    return publishTransport(err, 'LinkedIn');
  }
}

const norm = (s: string) => littleUnescape(s).replace(/https?:\/\/\S+/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

async function reconcile(ctx: AdapterContext, ref: AttemptReference): Promise<ReconcileOutcome> {
  if (ref.providerIds.length) return { kind: 'published', providerIds: ref.providerIds, url: linkedinPostUrl(ref.connection, ref.providerIds[0]!) };
  if (!isOrg(ref.connection)) {
    return { kind: 'still_unknown', reason: 'LinkedIn does not let apps list a member\'s posts (r_member_social is restricted). Check the LinkedIn profile, then mark the delivery Published or Not published.' };
  }
  const sentMs = ref.sentAt ? Date.parse(ref.sentAt) : ctx.now().getTime() - 30 * 60_000;
  try {
    const r = await liRest<{ elements?: Array<{ id: string; commentary?: string; createdAt?: number }> }>(ctx, {
      method: 'GET', path: '/rest/posts', rawQuery: `author=${encUrn(ref.connection.providerAccountId)}&q=author&count=20&sortBy=CREATED`,
      headers: { 'x-restli-method': 'FINDER' }, bearer: oauthAccessToken(ref.credentials, 'LinkedIn'), op: 'linkedin.posts.by_author',
    });
    const want = norm(ref.variantText);
    const hit = (r.data.elements ?? []).find((p) => (p.createdAt ?? 0) >= sentMs - 10 * 60_000 && norm(p.commentary ?? '') === want);
    if (hit) return { kind: 'published', providerIds: [hit.id], url: linkedinPostUrl(ref.connection, hit.id), publishedAt: hit.createdAt ? new Date(hit.createdAt).toISOString() : null };
    return { kind: 'still_unknown', reason: 'No matching post found on the LinkedIn Page since the send time. Check the Page, then mark the delivery Published or Not published.' };
  } catch (err) {
    if (err instanceof ProviderHttpError) return { kind: 'still_unknown', reason: `Could not list the Page's posts: ${classifyLinkedIn(err, ctx.now().getTime()).message}` };
    return { kind: 'still_unknown', reason: 'Could not reach LinkedIn to check whether the post exists.' };
  }
}

/**
 * The token's member (userinfo `sub`) is the connected member. A live member connection's id is `urn:li:person:<sub>`
 * (strict). A simulated (mock_) member connection's id is the simulator's `sub` itself (ids of simulated connections
 * must start with `mock_`, so they carry no URN prefix): compared as-is, and only for simulated connections.
 */
export function sameMember(connection: Pick<PublishConnection, 'providerAccountId' | 'isMock'>, sub: string): boolean {
  if (connection.providerAccountId === `urn:li:person:${sub}`) return true;
  return connection.isMock && connection.providerAccountId.startsWith('mock_') && connection.providerAccountId === sub;
}

async function health(ctx: AdapterContext, connection: PublishConnection, credentials: ProviderCredentials): Promise<ConnectionHealth> {
  const checkedAt = ctx.now().toISOString();
  const token = oauthAccessToken(credentials, 'LinkedIn');
  try {
    const me = await userInfo(ctx, token);
    if (!isOrg(connection) && me.sub && !sameMember(connection, me.sub)) {
      return { status: 'reconnect_required', checkedAt, message: 'This LinkedIn token belongs to a different member. Reconnect the original account.' };
    }
    if (isOrg(connection)) {
      const roles = (await postingAcls(ctx, token)).get(connection.providerAccountId) ?? [];
      if (!roles.some((r) => LI_POSTING_ROLES.has(r))) {
        return { status: 'missing_permission', checkedAt, missingPermissions: ['page_role'], metadata: { roles }, message: 'Your LinkedIn Page role no longer allows posting. Ask a Page admin for the Content admin or Administrator role, then reconnect.' };
      }
    }
    const scopes = grantedScopes(credentials);
    const need = isOrg(connection) ? 'w_organization_social' : 'w_member_social';
    if (scopes.length && !scopes.includes(need)) return { status: 'missing_permission', checkedAt, missingPermissions: [need], message: `LinkedIn did not grant ${need}. Reconnect and approve posting.` };
    if (credentials.kind === 'oauth2' && credentials.expiresAt && !credentials.refreshToken && Date.parse(credentials.expiresAt) - ctx.now().getTime() < 7 * 86_400_000) {
      return { status: 'expiring', checkedAt, expiresAt: credentials.expiresAt, message: 'LinkedIn access expires within 7 days (tokens last 60 days). Reconnect to keep posting.' };
    }
    return { status: 'ready', checkedAt, message: `Connected as ${connection.displayName}.` };
  } catch (err) {
    if (err instanceof ProviderHttpError) {
      const c = classifyLinkedIn(err, ctx.now().getTime());
      if (c.kind === 'reconnect') return { status: 'reconnect_required', checkedAt, message: c.message };
      if (c.kind === 'permission') return { status: 'missing_permission', checkedAt, message: c.message, missingPermissions: ['api_access'] };
    }
    throw err;
  }
}

export const linkedinAdapter: PublishingAdapter = {
  provider: 'linkedin',
  capabilities,
  validate,
  prepare,
  publish,
  reconcile,
  health,
  refreshCredentials: refreshLinkedInCredentials,
};
