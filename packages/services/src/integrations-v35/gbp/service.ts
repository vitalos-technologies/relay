// Google Business Profile (brief §6), stream C part: connection, explicit location selection, local posts that follow
// Relay's scheduling + approval services, location metrics, Pub/Sub notification verification. Reviews (inbox items,
// owner replies) are stream B — it uses `listGbpLocations`, `openGbpConn` and `onGbpNotification` below.
//  - Local posts: requested for one post's schedule and up to GBP_MAX_LOCATIONS_PER_REQUEST explicitly selected locations
//    (the request must restate the location count — no accidental mass updates). The text is the scheduled revision's
//    text, unchanged. At the scheduled time the worker re-runs the publishing approval gate for that exact schedule
//    (revision + fingerprint, current policy, approvers still eligible) and re-checks the requester's authority; only
//    then is the sync job created. Changed content ⇒ needs review; cancelled/rejected ⇒ cancelled.
//  - Chat is discontinued (July 2024) and not offered.
import { createPublicKey, createVerify, randomUUID } from 'node:crypto';
import { AppError, notFound } from '@social-lite/core';
import { GBP_MAX_LOCATIONS_PER_REQUEST, type GbpLocalPostJson, type GbpLocationJson, type GbpPostState } from '@social-lite/core/contracts/v35-integrations';
import type { InboundRequest, SyncOutcome, VerifyResult } from '@social-lite/core/contracts/v35-connectors';
import { getPool, many, maybeOne, withTx } from '@social-lite/db';
import {
  GBP_HOSTS, GBP_IDENTITY_SCOPES, GBP_SCOPES, gbpAccounts, gbpCreateLocalPost, gbpListLocalPosts, gbpLocations, gbpMetrics, googleAuthorizeUrl, googleExchange, googleUserInfo,
} from '@social-lite/providers/google-business/client';
import { gbpSim } from '@social-lite/providers/google-business/sim';
import { LiveBizTransport, parseJson } from '@social-lite/providers/biz/transport';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { audit } from '../../audit.js';
import { approvalGate } from '../../posts/approval-policy.js';
import { getSetting } from '../../settings.js';
import { assertUuid, brandAllowed, loadAccess, requireAction } from '../../tenancy.js';
import { digestOf } from '../../connectors/verify.js';
import { enqueueSyncJob, loadIntegration, registerInboundHandler, registerSyncExecutor, registerVerifier } from '../../connectors/index.js';
import { appErrorFrom, openConn, outcomeFromError } from '../core/runtime.js';
import { loadRelayObject } from '../core/relay-objects.js';
import type { Conn, HubAdapter } from '../core/types.js';
import { syncHold } from '../../entitlements/holds.js';

export const gbpAdapter: HubAdapter = {
  connector: 'google_business_profile', hosts: GBP_HOSTS, sim: gbpSim, connect: 'oauth', pkce: true, webhook: 'global',
  required: ['GBP_CLIENT_ID', 'GBP_CLIENT_SECRET'], optional: ['GBP_PUBSUB_AUDIENCE', 'GBP_PUBSUB_SERVICE_ACCOUNT'],
  capabilities: ['Select locations explicitly', 'Local posts from approved, scheduled Relay posts', 'Location metrics', 'Reviews in the inbox (owner replies only)'],
  authorizeUrl: (cfg, p) => googleAuthorizeUrl({ clientId: cfg.values.GBP_CLIENT_ID!, redirectUri: cfg.redirectUri, state: p.state, codeChallenge: p.codeChallenge, scopes: [...GBP_SCOPES, ...GBP_IDENTITY_SCOPES] }),
  async exchange(t, cfg, p) {
    const tok = await googleExchange(t, { clientId: cfg.values.GBP_CLIENT_ID!, clientSecret: cfg.values.GBP_CLIENT_SECRET!, redirectUri: cfg.redirectUri, code: p.code, codeVerifier: p.codeVerifier });
    const me = await googleUserInfo({ t, token: tok.accessToken });
    const granted = tok.scopes.filter((s) => s.startsWith('https://www.googleapis.com/auth/business'));
    let health: { status: 'active' | 'needs_attention'; message: string } = { status: 'active', message: 'Connected.' };
    if (!granted.length) health = { status: 'needs_attention', message: 'Business Profile access was not granted.' };
    else {
      try { const acc = await gbpAccounts({ t, token: tok.accessToken }); health = { status: 'active', message: `${acc.length} business account${acc.length === 1 ? '' : 's'} available.` }; }
      catch { health = { status: 'needs_attention', message: 'Signed in, but the Business Profile APIs refused access (API access approval or quota).' }; }
    }
    return { externalAccountId: me.sub, displayName: `Google Business Profile · ${me.email ?? me.sub}`, grantedScopes: granted, creds: tok, health };
  },
  async refresh(t, cfg, creds) {
    if (!creds.refreshToken) return null;
    const tok = await googleExchange(t, { clientId: cfg.values.GBP_CLIENT_ID!, clientSecret: cfg.values.GBP_CLIENT_SECRET!, redirectUri: cfg.redirectUri, refreshToken: creds.refreshToken });
    return { accessToken: tok.accessToken, refreshToken: tok.refreshToken, expiresAt: tok.expiresAt };
  },
  async verify(c) { const acc = await gbpAccounts(c); return { status: 'active', message: `${acc.length} business account${acc.length === 1 ? '' : 's'} reachable.` }; },
  async discover(c, p) {
    const accounts = await gbpAccounts(c);
    if (p.type === 'account') return accounts.map((a) => ({ resource_type: 'account', external_id: a.name, name: a.accountName, url: null, selected: false }));
    const out = [];
    for (const a of (p.parent ? accounts.filter((x) => x.name === p.parent) : accounts).slice(0, 5)) {
      for (const l of await gbpLocations(c, a.name)) {
        // v4 resource name used by local posts and reviews: accounts/{a}/locations/{l}
        out.push({ resource_type: 'location', external_id: `${a.name}/${l.name}`, name: l.title, url: null, detail: l.address, selected: false });
      }
    }
    return out;
  },
};

// ------------------------------------------------------------------ stream B interface
/** Selected GBP locations the caller can see (stream B creates review inbox channels from these). */
export async function listGbpLocations(ctx: Ctx, opts: { brandId?: string | null } = {}): Promise<{ items: GbpLocationJson[] }> {
  requireAction(ctx, 'integrations.read');
  const rows = await many<{ integration_id: string; resource_id: string; brand_id: string | null; external_id: string; name: string; is_simulated: boolean; access_state: 'ok' | 'unavailable' }>(getPool(),
    `SELECT r.integration_id, r.id AS resource_id, i.brand_id, r.external_id, r.name, i.is_simulated, r.access_state FROM integration_resources r JOIN integration_connections i ON i.id=r.integration_id
      WHERE r.workspace_id=$1 AND i.connector='google_business_profile' AND i.disconnected_at IS NULL AND r.resource_type='location' AND r.selected
        AND ($2::uuid IS NULL OR i.brand_id IS NULL OR i.brand_id=$2) ORDER BY r.name`, [ctx.access.workspaceId, opts.brandId ?? null]);
  return { items: rows.filter((r) => !r.brand_id || brandAllowed(ctx, r.brand_id)).map((r) => ({ integration_id: r.integration_id, resource_id: r.resource_id, brand_id: r.brand_id, location_name: r.external_id, title: r.name, is_simulated: r.is_simulated, access_state: r.access_state })) };
}

/** Worker/service access to a GBP installation (transport + token; simulated installs get the simulated API). */
export const openGbpConn = (integrationId: string) => openConn(integrationId);

type GbpNotification = { integrationIds: string[]; notificationType: string; locationName: string | null; reviewName: string | null; messageId: string };
const GBP_LISTENERS: Array<(n: GbpNotification) => Promise<void>> = [];
/** Stream B: receive verified review notifications (Pub/Sub). Without a listener they are recorded and ignored. */
export function onGbpNotification(fn: (n: GbpNotification) => Promise<void>): void { if (!GBP_LISTENERS.includes(fn)) GBP_LISTENERS.push(fn); }

// ------------------------------------------------------------------ Pub/Sub push verification (Google-signed OIDC token)
type Jwk = { kid: string; kty: string; n: string; e: string; alg?: string };
let jwksCache: { keys: Jwk[]; until: number } | null = null;
let jwksOverride: Jwk[] | null = null;
/** Test seam: locally generated keys instead of Google's certs (signed fixtures). */
export function setGoogleJwksForTests(keys: Jwk[] | null): void { jwksOverride = keys; jwksCache = null; }

async function googleJwks(): Promise<Jwk[]> {
  if (jwksOverride) return jwksOverride;
  if (jwksCache && jwksCache.until > Date.now()) return jwksCache.keys;
  const t = new LiveBizTransport({ hosts: ['www.googleapis.com'] });
  const res = await t.send({ method: 'GET', url: 'https://www.googleapis.com/oauth2/v3/certs', op: 'google.certs' });
  const j = parseJson<{ keys?: Jwk[] }>(res.body);
  if (res.status !== 200 || !j?.keys) throw new Error('google certs unavailable');
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers['cache-control'] ?? '')?.[1] ?? 3600);
  jwksCache = { keys: j.keys, until: Date.now() + Math.min(maxAge, 86_400) * 1000 };
  return j.keys;
}

export async function verifyPubsubPush(req: InboundRequest, audience: string | null, serviceAccount: string | null): Promise<VerifyResult> {
  if (!audience || !serviceAccount) return { ok: false, reason: 'not_configured' };
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return { ok: false, reason: 'bad_signature' };
  const header = parseJson<{ alg?: string; kid?: string }>(Buffer.from(h, 'base64url').toString('utf8'));
  const claims = parseJson<{ iss?: string; aud?: string; email?: string; email_verified?: boolean; exp?: number; iat?: number }>(Buffer.from(p, 'base64url').toString('utf8'));
  if (header?.alg !== 'RS256' || !header.kid || !claims) return { ok: false, reason: 'bad_signature' };
  let keys: Jwk[];
  try { keys = await googleJwks(); } catch { return { ok: false, reason: 'not_configured' }; }
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: 'bad_signature' };
  const okSig = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(createPublicKey({ key: jwk as never, format: 'jwk' }), Buffer.from(s, 'base64url'));
  if (!okSig) return { ok: false, reason: 'bad_signature' };
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss ?? '') || claims.aud !== audience || claims.email !== serviceAccount || claims.email_verified !== true) return { ok: false, reason: 'bad_signature' };
  if (!claims.exp || claims.exp * 1000 < req.now.getTime() - 60_000) return { ok: false, reason: 'stale' };
  const body = parseJson<{ message?: { data?: string; messageId?: string; message_id?: string; publishTime?: string } }>(req.rawBody);
  const msg = body?.message;
  if (!msg?.data) return { ok: false, reason: 'malformed' };
  const data = parseJson<{ notificationType?: string; location?: string; review?: string }>(Buffer.from(msg.data, 'base64').toString('utf8')) ?? {};
  const id = msg.messageId ?? msg.message_id;
  return { ok: true, kind: 'event', dedupeKey: id ? `pubsub:${id}` : `digest:${digestOf(req.rawBody)}`, eventType: String(data.notificationType ?? 'unknown').slice(0, 80),
    externalAccountId: data.location ?? null, occurredAt: msg.publishTime ?? null, summary: { type: data.notificationType ?? null } };
}

// ------------------------------------------------------------------ local posts
export const gbpPostSchema = z.object({
  post_id: z.string().uuid(), schedule_id: z.string().uuid().optional(), location_resource_ids: z.array(z.string().uuid()).min(1).max(GBP_MAX_LOCATIONS_PER_REQUEST),
  confirm_location_count: z.number().int(), call_to_action: z.object({ action_type: z.enum(['LEARN_MORE', 'BOOK', 'ORDER', 'SHOP', 'SIGN_UP']), url: z.string().url().max(500) }).nullable().optional(),
}).strict();

type PostRow = { id: string; workspace_id: string; brand_id: string; integration_id: string; location_resource_id: string; post_id: string; schedule_id: string; revision_id: string; schedule_fingerprint: string;
  summary: string; call_to_action: { actionType: string; url: string } | null; state: GbpPostState; state_detail: string | null; due_at: Date; sync_job_id: string | null; external_name: string | null; external_url: string | null; created_by: string | null; created_at: Date };

export async function requestGbpLocalPosts(ctx: Ctx, input: z.infer<typeof gbpPostSchema>): Promise<{ items: GbpLocalPostJson[] }> {
  const post = await loadRelayObject(ctx, 'post', input.post_id, 'content.schedule');
  const ids = [...new Set(input.location_resource_ids)];
  if (input.confirm_location_count !== ids.length) throw new AppError('validation_failed', `Confirm the number of locations (${ids.length}).`, { confirm_location_count: 'Does not match' });
  const sched = await maybeOne<{ id: string; status: string; revision_id: string; fingerprint: string; due_at: Date; base_text: string }>(getPool(),
    `SELECT s.id, s.status, s.revision_id, s.fingerprint, s.due_at, r.base_text FROM schedules s JOIN post_revisions r ON r.id=s.revision_id
      WHERE s.post_id=$1 AND s.workspace_id=$2 AND ($3::uuid IS NULL OR s.id=$3) AND s.status IN ('pending_approval','active') ORDER BY s.generation DESC LIMIT 1`,
    [post.id, ctx.access.workspaceId, input.schedule_id ?? null]);
  if (!sched) throw new AppError('invalid_state', 'Schedule the post (or submit it for review) first. Google posts follow its schedule and approval.');
  const summary = sched.base_text.trim();
  if (!summary) throw new AppError('validation_failed', 'The scheduled version has no text.');
  if (summary.length > 1500) throw new AppError('validation_failed', 'Google posts allow up to 1,500 characters. Shorten the post and reschedule it.');
  const locs = await many<{ id: string; integration_id: string; brand_id: string | null; name: string; is_simulated: boolean; disconnected_at: Date | null; status: string }>(getPool(),
    `SELECT r.id, r.integration_id, i.brand_id, r.name, i.is_simulated, i.disconnected_at, i.status FROM integration_resources r JOIN integration_connections i ON i.id=r.integration_id
      WHERE r.id = ANY($1::uuid[]) AND r.workspace_id=$2 AND r.resource_type='location' AND r.selected AND r.access_state='ok' AND i.connector='google_business_profile'`, [ids, ctx.access.workspaceId]);
  if (locs.length !== ids.length) throw new AppError('validation_failed', 'Choose locations selected in Google Business Profile settings.');
  for (const l of locs) {
    if (l.brand_id && l.brand_id !== post.brandId) throw new AppError('validation_failed', `${l.name} belongs to another brand.`);
    if (l.disconnected_at || l.status === 'reconnect_required') throw new AppError('invalid_state', 'Reconnect Google Business Profile first.');
    await loadIntegration(ctx, l.integration_id, 'integrations.read');
  }
  const created: string[] = [];
  await withTx(async (tx) => {
    for (const l of locs) {
      const id = randomUUID();
      const r = await tx.query(
        `INSERT INTO gbp_local_posts(id, workspace_id, brand_id, integration_id, location_resource_id, post_id, schedule_id, revision_id, schedule_fingerprint, summary, call_to_action, state, due_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (schedule_id, location_resource_id) WHERE state <> 'cancelled' DO NOTHING`,
        [id, ctx.access.workspaceId, post.brandId, l.integration_id, l.id, post.id, sched.id, sched.revision_id, sched.fingerprint, summary,
          input.call_to_action ? JSON.stringify({ actionType: input.call_to_action.action_type, url: input.call_to_action.url }) : null,
          sched.status === 'active' ? 'scheduled' : 'waiting_approval', sched.due_at, ctx.actor.userId]);
      if (r.rowCount) created.push(id);
    }
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: post.brandId, actorUserId: ctx.actor.userId, action: 'integration.gbp_posts_requested', resourceType: 'post', resourceId: post.id,
      diff: { schedule_id: sched.id, locations: locs.length, created: created.length }, correlationId: ctx.correlationId });
  });
  return listGbpLocalPosts(ctx, post.id);
}

const postJson = (r: PostRow & { location_name: string; is_simulated: boolean }): GbpLocalPostJson => ({
  id: r.id, integration_id: r.integration_id, location_resource_id: r.location_resource_id, location_name: r.location_name, post_id: r.post_id, schedule_id: r.schedule_id, summary: r.summary,
  state: r.state, state_detail: r.state_detail, due_at: r.due_at.toISOString(), external_url: r.external_url, is_simulated: r.is_simulated, created_at: r.created_at.toISOString(),
});

export async function listGbpLocalPosts(ctx: Ctx, postId: string): Promise<{ items: GbpLocalPostJson[] }> {
  await loadRelayObject(ctx, 'post', postId, 'content.read');
  const rows = await many<PostRow & { location_name: string; is_simulated: boolean }>(getPool(),
    `SELECT g.*, r.name AS location_name, i.is_simulated FROM gbp_local_posts g JOIN integration_resources r ON r.id=g.location_resource_id JOIN integration_connections i ON i.id=g.integration_id
      WHERE g.workspace_id=$1 AND g.post_id=$2 ORDER BY g.created_at DESC, r.name LIMIT 100`, [ctx.access.workspaceId, postId]);
  return { items: rows.map(postJson) };
}

export async function cancelGbpLocalPost(ctx: Ctx, id: string): Promise<void> {
  assertUuid(id, 'Google post');
  const r = await maybeOne<PostRow>(getPool(), `SELECT * FROM gbp_local_posts WHERE id=$1 AND workspace_id=$2`, [id, ctx.access.workspaceId]);
  if (!r || !brandAllowed(ctx, r.brand_id)) throw notFound('Google post');
  requireAction(ctx, 'content.schedule', { brandId: r.brand_id });
  if (!['waiting_approval', 'scheduled', 'needs_review', 'failed'].includes(r.state)) throw new AppError('invalid_state', 'This Google post was already sent. Delete it in Google if needed.');
  await getPool().query(`UPDATE gbp_local_posts SET state='cancelled', state_detail='Cancelled in Relay', updated_at=now() WHERE id=$1`, [id]);
  await audit(getPool(), { workspaceId: r.workspace_id, brandId: r.brand_id, actorUserId: ctx.actor.userId, action: 'integration.gbp_post_cancelled', resourceType: 'post', resourceId: r.post_id, diff: { id }, correlationId: ctx.correlationId });
}

async function setState(id: string, state: GbpPostState, detail: string | null, extra: { job?: string | null; name?: string | null; url?: string | null } = {}): Promise<void> {
  await getPool().query(`UPDATE gbp_local_posts SET state=$2, state_detail=$3, sync_job_id=coalesce($4, sync_job_id), external_name=coalesce($5, external_name), external_url=coalesce($6, external_url), updated_at=now() WHERE id=$1`,
    [id, state, detail, extra.job ?? null, extra.name ?? null, extra.url ?? null]);
}

/** The schedule gate, evaluated at dispatch: exact version, current approval, requester still authorised. */
async function gate(r: PostRow): Promise<{ ok: true; ctx: Ctx } | { ok: false; state: GbpPostState; detail: string }> {
  const s = await maybeOne<{ status: string; fingerprint: string; revision_id: string; publish_before: Date }>(getPool(), `SELECT status, fingerprint, revision_id, publish_before FROM schedules WHERE id=$1`, [r.schedule_id]);
  if (!s || s.status === 'cancelled' || s.status === 'rejected') return { ok: false, state: 'cancelled', detail: s?.status === 'rejected' ? 'The post was rejected in review.' : 'The post schedule was cancelled.' };
  if (s.status === 'superseded' || s.fingerprint !== r.schedule_fingerprint || s.revision_id !== r.revision_id) return { ok: false, state: 'needs_review', detail: 'The post changed after this was requested. Request it again for the new version.' };
  if (s.status === 'pending_approval') return { ok: false, state: 'waiting_approval', detail: 'Waiting for approval.' };
  if (s.publish_before.getTime() < Date.now()) return { ok: false, state: 'failed', detail: 'The publish-before deadline passed.' };
  const g = await approvalGate(getPool(), { workspace_id: r.workspace_id, brand_id: r.brand_id, schedule_id: r.schedule_id });
  if (!g.ok) return { ok: false, state: g.code === 'approval_missing' ? 'waiting_approval' : 'needs_review', detail: g.message };
  if (!r.created_by) return { ok: false, state: 'failed', detail: 'The requester no longer exists.' };
  const access = await loadAccess(r.created_by, r.workspace_id);
  const user = await maybeOne<{ email: string; name: string | null }>(getPool(), `SELECT email, name FROM users WHERE id=$1`, [r.created_by]);
  if (!access || !user) return { ok: false, state: 'failed', detail: 'The requester no longer has access.' };
  const ctx: Ctx = { actor: { userId: r.created_by, email: user.email, name: user.name, sessionId: '' }, access, correlationId: `gbp:${r.id}` };
  try { requireAction(ctx, 'content.read', { brandId: r.brand_id }); requireAction(ctx, 'integrations.read', { brandId: r.brand_id }); } catch {
    return { ok: false, state: 'failed', detail: 'The requester no longer has permission for this brand.' };
  }
  return { ok: true, ctx };
}

/** Worker sweep: move requests along with their schedule; create the sync job when due and approved. */
export async function dispatchDueGbpPosts(limit = 25): Promise<number> {
  const rows = await many<PostRow>(getPool(), `SELECT * FROM gbp_local_posts WHERE state IN ('waiting_approval','scheduled') AND (state='waiting_approval' OR due_at <= now() + interval '1 minute') ORDER BY due_at LIMIT $1`, [limit]);
  let n = 0;
  for (const r of rows) {
    const g = await gate(r);
    if (!g.ok) { if (g.state !== r.state || g.detail !== r.state_detail) await setState(r.id, g.state, g.detail); continue; }
    if (r.due_at.getTime() > Date.now()) { if (r.state !== 'scheduled') await setState(r.id, 'scheduled', null); continue; }
    // V4 entitlements: business integrations held by the plan/billing state ⇒ stays scheduled with the reason (never failed).
    const hold = await syncHold(getPool(), r.workspace_id);
    if (hold.held) { if (r.state !== 'scheduled' || r.state_detail !== hold.message) await setState(r.id, 'scheduled', hold.message); continue; }
    try {
      const { job } = await enqueueSyncJob(g.ctx, { integrationId: r.integration_id, kind: 'gbp.local_post', relayType: 'post', relayId: r.post_id, idempotencyKey: `gbp.local_post:${r.id}`, payload: { request_id: r.id } });
      await setState(r.id, 'publishing', null, { job: job.id });
      n++;
    } catch (err) {
      await setState(r.id, 'failed', err instanceof AppError ? err.message : 'Could not queue the Google post.');
    }
  }
  return n;
}

async function runLocalPost(job: { id: string; workspaceId: string; integrationId: string; payload: Record<string, unknown> }): Promise<SyncOutcome> {
  const r = await maybeOne<PostRow & { location: string }>(getPool(), `SELECT g.*, res.external_id AS location FROM gbp_local_posts g JOIN integration_resources res ON res.id=g.location_resource_id WHERE g.id=$1`, [String(job.payload.request_id)]);
  if (!r) return { kind: 'failed', code: 'not_found', message: 'The Google post request no longer exists.' };
  if (r.state === 'cancelled') return { kind: 'failed', code: 'cancelled', message: 'Cancelled in Relay.' };
  if (r.external_name) return { kind: 'succeeded', result: { name: r.external_name, already: true } };
  const g = await gate(r);   // re-checked immediately before the provider call
  if (!g.ok) { await setState(r.id, g.state, g.detail); return { kind: 'failed', code: 'gate_closed', message: g.detail }; }
  let c: Conn;
  try { c = await openConn(job.integrationId); } catch (err) { return outcomeFromError(err, { integrationId: job.integrationId, workspaceId: job.workspaceId }, false); }
  try {
    const p = await gbpCreateLocalPost(c, r.location, { summary: r.summary, languageCode: 'en', callToAction: r.call_to_action });
    const state: GbpPostState = p.state === 'LIVE' ? 'live' : p.state === 'REJECTED' ? 'rejected' : 'processing';
    await setState(r.id, state, p.state === 'REJECTED' ? 'Google rejected the post.' : null, { name: p.name, url: p.searchUrl });
    return { kind: 'succeeded', result: { name: p.name, state: p.state } };
  } catch (err) {
    const o = await outcomeFromError(err, c, true);
    await setState(r.id, o.kind === 'failed' ? 'failed' : o.kind === 'unknown' ? 'unknown' : 'publishing', o.kind === 'succeeded' ? null : o.message);
    return o;
  }
}

/** Unknown create: look for a post with exactly this text created after the request (posts are public: no marker). */
async function reconcileLocalPost(job: { id: string; integrationId: string; payload: Record<string, unknown> }) {
  const r = await maybeOne<PostRow & { location: string; job_created: Date }>(getPool(),
    `SELECT g.*, res.external_id AS location, j.created_at AS job_created FROM gbp_local_posts g JOIN integration_resources res ON res.id=g.location_resource_id JOIN integration_sync_jobs j ON j.id=$2 WHERE g.id=$1`,
    [String(job.payload.request_id), job.id]);
  if (!r) return { found: false as const };
  const c = await openConn(job.integrationId);
  const hit = (await gbpListLocalPosts(c, r.location)).find((p) => p.summary === r.summary && p.createTime && Date.parse(p.createTime) >= r.job_created.getTime() - 60_000);
  if (!hit) return { found: false as const };
  await setState(r.id, hit.state === 'LIVE' ? 'live' : hit.state === 'REJECTED' ? 'rejected' : 'processing', null, { name: hit.name, url: hit.searchUrl });
  await getPool().query(`UPDATE integration_sync_jobs SET state='succeeded', external_id=$2, result='{"reconciled":true}'::jsonb, finished_at=now(), updated_at=now() WHERE id=$1 AND state='unknown'`, [job.id, hit.name]);
  return { found: false as const };
}

/** Location metrics (explicit refresh; stored on the resource so pages render from stored data). */
export async function refreshGbpMetrics(ctx: Ctx, resourceId: string): Promise<{ metrics: Record<string, number>; fetched_at: string }> {
  assertUuid(resourceId, 'Location');
  const r = await maybeOne<{ id: string; integration_id: string; external_id: string }>(getPool(), `SELECT id, integration_id, external_id FROM integration_resources WHERE id=$1 AND workspace_id=$2 AND resource_type='location'`, [resourceId, ctx.access.workspaceId]);
  if (!r) throw notFound('Location');
  await loadIntegration(ctx, r.integration_id, 'integrations.read');
  const c = await openConn(r.integration_id);
  try {
    const metrics = await gbpMetrics(c, r.external_id);
    const at = new Date().toISOString();
    await getPool().query(`UPDATE integration_resources SET metadata = metadata || jsonb_build_object('metrics', $2::jsonb, 'metrics_at', $3::text, 'metrics_days', 28), updated_at=now() WHERE id=$1`, [r.id, JSON.stringify(metrics), at]);
    return { metrics, fetched_at: at };
  } catch (err) { throw await appErrorFrom(err, c); }
}

export async function gbpLocationMetrics(ctx: Ctx, integrationId: string) {
  await loadIntegration(ctx, integrationId, 'integrations.read');
  const rows = await many<{ id: string; name: string; metadata: { metrics?: Record<string, number>; metrics_at?: string } }>(getPool(),
    `SELECT id, name, metadata FROM integration_resources WHERE integration_id=$1 AND resource_type='location' AND selected ORDER BY name`, [integrationId]);
  return { items: rows.map((r) => ({ resource_id: r.id, name: r.name, metrics: r.metadata.metrics ?? null, fetched_at: r.metadata.metrics_at ?? null, days: 28 })) };
}

export function registerGbp(): void {
  registerSyncExecutor({ kind: 'gbp.local_post', run: runLocalPost, reconcile: reconcileLocalPost });
  registerVerifier('google_business_profile', async (req) => verifyPubsubPush(req, (await getSetting('GBP_PUBSUB_AUDIENCE')) ?? null, (await getSetting('GBP_PUBSUB_SERVICE_ACCOUNT')) ?? null));
  registerInboundHandler({
    connector: 'google_business_profile',
    async handle(e) {
      const msg = (e.body as { message?: { data?: string; messageId?: string } })?.message;
      const data = msg?.data ? parseJson<{ notificationType?: string; location?: string; review?: string }>(Buffer.from(msg.data, 'base64').toString('utf8')) ?? {} : {};
      const loc = data.location ?? null;
      const ints = loc ? await many<{ integration_id: string }>(getPool(), `SELECT DISTINCT r.integration_id FROM integration_resources r JOIN integration_connections i ON i.id=r.integration_id
          WHERE i.connector='google_business_profile' AND i.disconnected_at IS NULL AND r.resource_type='location' AND r.selected AND r.external_id=$1`, [loc]) : [];
      if (!ints.length || !GBP_LISTENERS.length) return { outcome: 'ignored', detail: !ints.length ? 'location not selected' : 'no review listener (stream B)' };
      for (const fn of GBP_LISTENERS) await fn({ integrationIds: ints.map((i) => i.integration_id), notificationType: data.notificationType ?? 'unknown', locationName: loc, reviewName: data.review ?? null, messageId: msg?.messageId ?? e.id });
      return { outcome: 'processed' };
    },
  });
}
