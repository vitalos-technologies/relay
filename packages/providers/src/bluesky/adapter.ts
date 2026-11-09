// Bluesky (AT Protocol) adapter: app.bsky.feed.post with rich-text facets and up to 4 images.
// Sources: docs/providers/bluesky.md.
//  prepare (nothing visible): session, mention resolution, uploadBlob per image, deterministic TID rkey + createdAt.
//  publish: com.atproto.repo.createRecord with that rkey (publishes:true). A repeated create of the same rkey
//           cannot make a second post; a lost response is reconciled with getRecord (absent ⇒ not published).
import {
  altTextFor, composeTextWithLink, utf8Length, validateVariant,
  type AdapterContext, type AttemptReference, type ChannelCapabilities, type ChannelConstraints, type Checkpoint,
  type ConnectionHealth, type PrepareOutcome, type ProviderCredentials, type PublishConnection, type PublishInput,
  type PublishOutcome, type PublishingAdapter, type ReconcileOutcome, type ValidationIssue, type ValidationResult,
} from '@social-lite/core';
import { ProviderHttpError } from '../shared/http.js';
import { prepareFromClass, prepareTransport, publishFromClass, publishTransport } from '../shared/classify.js';
import { factsOf, isVideoMedia, loadBytes, providerOptions } from '../shared/media.js';
import { POST_COLLECTION, TID_RE, accessFor, classifyBluesky, deliveryTid, withAccess, xrpc } from './api.js';
import { buildFacets, detectFacets, type Facet } from './richtext.js';
import { refreshBlueskyCredentials } from './connector.js';

export const BLUESKY_CONSTRAINTS_VERSION = 'atproto-app.bsky@2026-11-07';

export const BLUESKY_CONSTRAINTS: ChannelConstraints = {
  maxTextLength: 300,           // maxGraphemes 300 (and maxLength 3000 bytes, checked separately)
  maxCaptionLength: 300,
  textCounting: 'graphemes',
  requiresMedia: false,
  supportsTextOnly: true,
  supportsLink: true,           // appended + link facet
  supportsButtons: false,
  maxButtons: 0,
  maxImages: 4,                 // app.bsky.embed.images maxLength 4
  maxAlbumItems: 4,
  imageMimes: ['image/jpeg', 'image/png', 'image/webp'],
  maxImageBytes: 2_000_000,     // blob maxSize 2,000,000 bytes
  maxVideos: 0,                 // video upload flow not verified ⇒ not supported
};

export interface BlueskyOptions { altTexts: string[]; langs: string[] }
const optsOf = (input: Pick<PublishInput, 'variant'>) => providerOptions<BlueskyOptions>(input.variant.options, 'bluesky');

function capabilities(): ChannelCapabilities {
  return {
    provider: 'bluesky', formats: ['text', 'image', 'album'], canPublish: true, canEditPublished: false, canDeletePublished: false,
    canReadMetrics: true, canReconcile: true, constraints: BLUESKY_CONSTRAINTS, constraintsVersion: BLUESKY_CONSTRAINTS_VERSION, checkedAt: new Date().toISOString(),
    publishMode: 'direct', nativeScheduling: false,
    eligibility: { status: 'eligible', message: 'Connected with an app password (AT Protocol OAuth not yet supported). Video posts are not supported.' },
    requiredOptions: [],
  };
}

function validate(input: Pick<PublishInput, 'variant' | 'media' | 'connection'>): ValidationResult {
  const base = validateVariant({
    provider: 'bluesky', connectionId: input.connection.id, constraints: BLUESKY_CONSTRAINTS,
    text: input.variant.text, link: input.variant.link, buttons: input.variant.buttons, media: factsOf(input.media),
  });
  const issues: ValidationIssue[] = [...base.issues];
  const text = composeTextWithLink(input.variant.text, input.variant.link);
  if (utf8Length(text) > 3000) issues.push({ connectionId: input.connection.id, provider: 'bluesky', field: 'text', code: 'too_long_bytes', message: `Bluesky: text is ${utf8Length(text)} of 3000 bytes.` });
  const o = optsOf(input);
  if (Array.isArray(o.langs) && o.langs.length > 3) issues.push({ connectionId: input.connection.id, provider: 'bluesky', field: 'options', code: 'bluesky_langs', message: 'Bluesky: at most 3 languages.' });
  return { ok: issues.length === 0, issues };
}

interface BlobRef { $type: 'blob'; ref: { $link: string }; mimeType: string; size: number }
interface Prepared { rkey: string; createdAt: string; text: string; facets: Facet[]; blobs: Array<{ assetId: string; blob: BlobRef; uploadedAt: string; width: number; height: number }> }
const preparedOf = (cp: Checkpoint | null): Prepared | null => {
  const d = cp?.data as Partial<Prepared> | undefined;
  return d && typeof d.rkey === 'string' && TID_RE.test(d.rkey) && typeof d.createdAt === 'string' && Array.isArray(d.blobs) ? (d as Prepared) : null;
};
const BLOB_REUSE_MS = 5 * 60_000; // unreferenced blobs are deleted "within … minutes"

async function prepare(ctx: AdapterContext, input: PublishInput, checkpoint: Checkpoint | null): Promise<PrepareOutcome> {
  const v = validate(input);
  if (!v.ok) return { kind: 'permanent', code: 'invalid_content', message: v.issues.map((i) => i.message).join(' ') };
  if (input.media.some(isVideoMedia)) return { kind: 'permanent', code: 'video_unsupported', message: 'Bluesky video posts are not supported yet. Remove the video.' };
  const nowMs = ctx.now().getTime();
  const prev = preparedOf(checkpoint);
  // The record key and createdAt are fixed at the first preparation and never change (no duplicates).
  const rkey = prev?.rkey ?? deliveryTid(input.deliveryId, ctx.now());
  const createdAt = prev?.createdAt ?? ctx.now().toISOString();
  const text = composeTextWithLink(input.variant.text, input.variant.link);
  const blobs: Prepared['blobs'] = [];
  try {
    return await withAccess(ctx, input.credentials, input.connection.providerAccountId, async (a) => {
      const detected = detectFacets(text);
      const dids: Record<string, string | null> = {};
      for (const d of detected.filter((x) => x.kind === 'mention')) {
        if (d.value in dids) continue;
        try {
          const r = await xrpc<{ did?: string }>(ctx, { service: a.pdsUrl, nsid: 'com.atproto.identity.resolveHandle', method: 'GET', params: { handle: d.value }, jwt: a.jwt, op: 'bluesky.handle.resolve' });
          dids[d.value] = typeof r.data.did === 'string' ? r.data.did : null;
        } catch (err) {
          if (err instanceof ProviderHttpError && err.status === 400) dids[d.value] = null; // unknown handle ⇒ plain text
          else throw err;
        }
      }
      for (let i = 0; i < input.media.length; i++) {
        const m = input.media[i]!;
        const old = prev?.blobs[i];
        if (old && old.assetId === m.assetId && nowMs - Date.parse(old.uploadedAt) < BLOB_REUSE_MS) { blobs.push(old); continue; }
        const bytes = await loadBytes(m);
        if (!bytes) throw new Error('media_unavailable');
        const r = await xrpc<{ blob?: BlobRef }>(ctx, { service: a.pdsUrl, nsid: 'com.atproto.repo.uploadBlob', method: 'POST', bytes: { data: bytes, contentType: m.mime }, jwt: a.jwt, op: 'bluesky.blob.upload', timeoutMs: 60_000 });
        if (!r.data.blob) throw new ProviderHttpError('Bluesky', 502, 'NoBlob', 'Bluesky did not return a blob reference', null);
        blobs.push({ assetId: m.assetId, blob: r.data.blob, uploadedAt: ctx.now().toISOString(), width: m.width, height: m.height });
      }
      const data: Prepared = { rkey, createdAt, text, facets: buildFacets(detected, dids), blobs };
      const oldest = blobs.map((b) => Date.parse(b.uploadedAt)).sort()[0];
      return { kind: 'ready', checkpoint: { step: 'record_ready', data: { ...data }, expiresAt: oldest ? new Date(oldest + BLOB_REUSE_MS).toISOString() : null } } as PrepareOutcome;
    });
  } catch (err) {
    const cp: Checkpoint = { step: 'record_partial', data: { rkey, createdAt, text, facets: [], blobs } };
    if (err instanceof Error && err.message === 'media_unavailable') return { kind: 'retryable', code: 'media_unavailable', message: 'An image could not be read from storage; it will be retried.', checkpoint: cp };
    if (err instanceof ProviderHttpError) return prepareFromClass(classifyBluesky(err, nowMs), cp);
    return prepareTransport(err, 'Bluesky', cp);
  }
}

export function postRecord(input: PublishInput, p: Prepared): Record<string, unknown> {
  const o = optsOf(input);
  // `alt` is required by app.bsky.embed.images: a per-post override (options.altTexts[i]) or the library alt text (fix H3), else ''.
  const alt = (i: number, assetId: string) => {
    const m = input.media.find((x) => x.assetId === assetId) ?? input.media[i];
    return (m ? altTextFor('bluesky', m, Array.isArray(o.altTexts) ? o.altTexts[i] : undefined) : null) ?? '';
  };
  return {
    $type: POST_COLLECTION,
    text: p.text,
    createdAt: p.createdAt,
    ...(p.facets.length ? { facets: p.facets } : {}),
    ...(p.blobs.length ? { embed: { $type: 'app.bsky.embed.images', images: p.blobs.map((b, i) => ({ alt: alt(i, b.assetId), image: b.blob, ...(b.width && b.height ? { aspectRatio: { width: b.width, height: b.height } } : {}) })) } } : {}),
    ...(Array.isArray(o.langs) && o.langs.length ? { langs: o.langs.slice(0, 3) } : {}),
  };
}

export function bskyPostUrl(connection: PublishConnection, handleOrDid: string | null, rkey: string): string | null {
  if (connection.isMock) return null;
  return `https://bsky.app/profile/${handleOrDid ?? connection.username ?? connection.providerAccountId}/post/${rkey}`;
}

async function publish(ctx: AdapterContext, input: PublishInput, checkpoint: Checkpoint | null): Promise<PublishOutcome> {
  const p = preparedOf(checkpoint);
  if (!p || checkpoint?.step !== 'record_ready' || p.blobs.length !== input.media.length) {
    return { kind: 'rejected_safe_to_retry', code: 'not_prepared', message: 'The Bluesky post is not prepared yet; nothing was sent.' };
  }
  try {
    return await withAccess(ctx, input.credentials, input.connection.providerAccountId, async (a) => {
      const r = await xrpc<{ uri?: string; cid?: string }>(ctx, {
        service: a.pdsUrl, nsid: 'com.atproto.repo.createRecord', method: 'POST', jwt: a.jwt, op: 'bluesky.post.create', publishes: true, timeoutMs: 30_000,
        json: { repo: a.did, collection: POST_COLLECTION, rkey: p.rkey, record: postRecord(input, p) },
      });
      if (!r.data.uri) return { kind: 'unknown', code: 'bluesky_no_uri', message: 'Bluesky accepted the post but returned no URI; it will be reconciled.' } as PublishOutcome;
      return { kind: 'confirmed', providerIds: [r.data.uri, ...(r.data.cid ? [r.data.cid] : [])], url: bskyPostUrl(input.connection, input.connection.username ?? a.handle, p.rkey), publishedAt: ctx.now().toISOString() } as PublishOutcome;
    });
  } catch (err) {
    if (err instanceof ProviderHttpError) return publishFromClass(classifyBluesky(err, ctx.now().getTime()));
    return publishTransport(err, 'Bluesky');
  }
}

async function reconcile(ctx: AdapterContext, ref: AttemptReference): Promise<ReconcileOutcome> {
  const p = preparedOf(ref.checkpoint);
  const fromUri = ref.providerIds.find((x) => x.startsWith('at://'));
  if (fromUri) return { kind: 'published', providerIds: ref.providerIds, url: bskyPostUrl(ref.connection, null, fromUri.split('/').pop()!) };
  if (!p) return { kind: 'still_unknown', reason: 'No Bluesky record key was recorded. Check the profile, then mark the delivery Published or Not published.' };
  try {
    return await withAccess(ctx, ref.credentials, ref.connection.providerAccountId, async (a) => {
      try {
        const r = await xrpc<{ uri?: string; cid?: string }>(ctx, { service: a.pdsUrl, nsid: 'com.atproto.repo.getRecord', method: 'GET', params: { repo: a.did, collection: POST_COLLECTION, rkey: p.rkey }, jwt: a.jwt, op: 'bluesky.post.get' });
        const uri = r.data.uri ?? `at://${a.did}/${POST_COLLECTION}/${p.rkey}`;
        return { kind: 'published', providerIds: [uri, ...(r.data.cid ? [r.data.cid] : [])], url: bskyPostUrl(ref.connection, null, p.rkey), publishedAt: p.createdAt } as ReconcileOutcome;
      } catch (err) {
        if (err instanceof ProviderHttpError && (err.code === 'RecordNotFound' || err.status === 404)) return { kind: 'not_published', reason: 'Bluesky has no post with this record key; nothing was posted.' } as ReconcileOutcome;
        throw err;
      }
    });
  } catch (err) {
    if (err instanceof ProviderHttpError) return { kind: 'still_unknown', reason: `Could not check Bluesky: ${classifyBluesky(err, ctx.now().getTime()).message}` };
    return { kind: 'still_unknown', reason: 'Could not reach Bluesky to check whether the post exists.' };
  }
}

async function health(ctx: AdapterContext, connection: PublishConnection, credentials: ProviderCredentials): Promise<ConnectionHealth> {
  const checkedAt = ctx.now().toISOString();
  try {
    const a = await accessFor(ctx, credentials, connection.providerAccountId);
    const r = await xrpc<{ did?: string; handle?: string; active?: boolean; status?: string }>(ctx, { service: a.pdsUrl, nsid: 'com.atproto.server.getSession', method: 'GET', jwt: a.jwt, op: 'bluesky.session.get' });
    if (r.data.did && r.data.did !== connection.providerAccountId) return { status: 'reconnect_required', checkedAt, message: 'This app password belongs to a different Bluesky account. Reconnect the original account.' };
    if (r.data.active === false) return { status: 'missing_permission', checkedAt, missingPermissions: ['account_active'], message: `This Bluesky account is ${r.data.status ?? 'inactive'} and cannot post.` };
    return { status: 'ready', checkedAt, metadata: { handle: r.data.handle ?? null }, message: `Connected as @${r.data.handle ?? connection.username ?? connection.providerAccountId} (app password).` };
  } catch (err) {
    if (err instanceof ProviderHttpError) {
      const c = classifyBluesky(err, ctx.now().getTime());
      if (c.kind === 'reconnect') return { status: 'reconnect_required', checkedAt, message: c.message };
      if (c.kind === 'permission') return { status: 'missing_permission', checkedAt, message: c.message, missingPermissions: ['account_active'] };
    }
    throw err;
  }
}

export const blueskyAdapter: PublishingAdapter = {
  provider: 'bluesky',
  capabilities: () => capabilities(),
  validate,
  prepare,
  publish,
  reconcile,
  health,
  refreshCredentials: refreshBlueskyCredentials,
};

