// Safe publication through MCP (V3 §13 "Safe publication"):
//   prepare_publication → exact revision (version + content hash of the resolved variants), destinations, resolved time
//     (timezone explicit; an ambiguous wall time returns choices instead of guessing), validation, approval state and
//     an expiring intent id + intent hash. Nothing is scheduled.
//   Trusted confirmation → recorded ONLY by the Relay web app (confirmIntent): the signed-in person the client acts
//     for, holding the authority on the brand, with step-up (fresh authentication + MFA per the V2 policy).
//   commit_publication → requires that confirmation OR an active mcp_policy_grant covering the intent; a model-supplied
//     "confirmed: true" is not an input and is ignored. Rechecks post version, content hash, destinations and time,
//     invalidating the intent on any change, then queues through the SAME shared scheduling service as the UI
//     (approvals, permissions, validation, pause handled identically) with idempotency key mcp-intent:<id>, so a
//     retried commit returns the original result and can never create a second schedule.
// An intent proves integrity, not approval: editorial review still applies (approval-required brands must use
// submit_for_review).
import { createHash } from 'node:crypto';
import { AppError, isValidTimeZone, notFound, resolveVariants, toLocalInput, type DraftContent } from '@social-lite/core';
import { getPool, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { stableStringify } from '../idempotency.js';
import { assertBrand, authorizeCtx, requireAction, type BrandRow } from '../tenancy.js';
import { loadPost, validateDraft, type PostRow } from '../posts/service.js';
import { publishNow, resolveScheduleTime, schedulePost } from '../posts/scheduling.js';
import { approvalRequiredFor } from '../posts/approval-policy.js';
import { brandConnections, contentHash, type ConnectionRow } from '../posts/shared.js';
import { MCP_LIMITS } from './config.js';
import { appUrl, callScope, McpToolError, requireHuman, requireScope, toToolError, type CallScope } from './principal.js';

export interface IntentRow {
  id: string; workspace_id: string; brand_id: string; post_id: string; client_row_id: string; actor_user_id: string; post_version: number;
  revision_hash: string; connection_ids: string[]; mode: 'scheduled' | 'immediate'; input_local_time: string | null; input_timezone: string;
  input_offset: string | null; deadline_minutes: number; due_at: Date | null; intent_hash: string;
  status: 'prepared' | 'confirmed' | 'committed' | 'invalidated' | 'expired' | 'failed'; invalid_reason: string | null; expires_at: Date;
  confirmed_at: Date | null; confirmed_by: string | null; confirmed_mfa: boolean | null; policy_grant_id: string | null; committed_at: Date | null;
  schedule_id: string | null; result: unknown; created_at: Date;
}

export interface PrepareInput {
  post_id: string;
  expected_version: number;
  connection_ids: string[];
  when: { mode: 'scheduled' | 'immediate'; local_time?: string; timezone?: string; offset?: string };
  deadline_minutes?: number;
}

function revisionHash(post: PostRow, ids: string[], conns: ConnectionRow[]): string {
  const draft: DraftContent = { ...post.draft, variants: ids.map((id) => post.draft.variants.find((v) => v.connectionId === id) ?? { connectionId: id, inheritText: true, inheritMedia: true }) };
  const resolved = resolveVariants(draft, conns);
  return contentHash(draft.baseText, draft.baseLink ?? null, draft.baseAssetIds, resolved);
}

function intentHash(i: Pick<IntentRow, 'workspace_id' | 'brand_id' | 'post_id' | 'client_row_id' | 'actor_user_id' | 'post_version' | 'revision_hash' | 'connection_ids' | 'mode' | 'input_local_time' | 'input_timezone' | 'input_offset' | 'deadline_minutes'> & { due_at: Date | null }): string {
  return createHash('sha256').update(stableStringify({
    w: i.workspace_id, b: i.brand_id, p: i.post_id, c: i.client_row_id, a: i.actor_user_id, v: i.post_version, r: i.revision_hash,
    d: [...i.connection_ids].sort(), m: i.mode, t: i.input_local_time, z: i.input_timezone, o: i.input_offset, dl: i.deadline_minutes,
    due: i.due_at ? i.due_at.toISOString() : null,
  })).digest('hex');
}

const confirmUrl = (id: string) => appUrl(`/mcp/confirm/${id}`);

function permissionFor(mode: 'scheduled' | 'immediate') {
  return mode === 'immediate' ? (['content.schedule', 'content.publish'] as const) : (['content.schedule'] as const);
}

/** Authority on the brand ignoring only the MFA gate (MFA is satisfied by the trusted confirmation / grant). */
function holdsAuthority(ctx: Ctx, brandId: string, mode: 'scheduled' | 'immediate'): { ok: boolean; mfa: boolean } {
  let mfa = false;
  for (const p of permissionFor(mode)) {
    const r = authorizeCtx(ctx, p, { brandId });
    if (r.allowed) continue;
    if (r.reason === 'mfa_required') { mfa = true; continue; }
    return { ok: false, mfa };
  }
  return { ok: true, mfa };
}

// ------------------------------------------------------------------ policy grants

interface GrantRow {
  id: string; client_row_id: string; actor_user_id: string; brand_id: string; connection_ids: string[] | null; allow_immediate: boolean;
  valid_from: Date; valid_until: Date; max_days_ahead: number; local_start_hour: number; local_end_hour: number; max_per_day: number;
  max_text_length: number | null; allow_links: boolean; allow_media: boolean; revoked_at: Date | null;
}

/** Why a grant does not cover this intent (null = covered). */
export function grantGap(g: GrantRow, i: Pick<IntentRow, 'mode' | 'connection_ids' | 'due_at' | 'input_timezone'>, post: PostRow, now = new Date()): string | null {
  if (g.revoked_at) return 'revoked';
  if (now < g.valid_from || now >= g.valid_until) return 'outside validity window';
  if (i.mode === 'immediate' && !g.allow_immediate) return 'immediate publishing not allowed';
  if (g.connection_ids && !i.connection_ids.every((c) => g.connection_ids!.includes(c))) return 'destination not allowed';
  const at = i.due_at ?? now;
  if (at.getTime() > now.getTime() + g.max_days_ahead * 86_400_000 + 60_000) return 'too far ahead';
  if (at >= g.valid_until) return 'after validity window';
  const hour = Number(toLocalInput(at, i.input_timezone).slice(11, 13));
  if (hour < g.local_start_hour || hour >= g.local_end_hour) return 'outside allowed hours';
  const text = [post.draft.baseText, ...post.draft.variants.filter((v) => i.connection_ids.includes(v.connectionId)).map((v) => v.text ?? '')];
  if (g.max_text_length !== null && text.some((t) => t.length > g.max_text_length!)) return 'text too long';
  const links = !!post.draft.baseLink || text.some((t) => /https?:\/\/|www\./i.test(t)) || post.draft.variants.some((v) => !!v.link);
  if (!g.allow_links && links) return 'links not allowed';
  const media = post.draft.baseAssetIds.length > 0 || post.draft.variants.some((v) => (v.assetIds ?? []).length > 0);
  if (!g.allow_media && media) return 'media not allowed';
  return null;
}

async function coveringGrant(db: Queryable, s: CallScope, i: IntentRow, post: PostRow): Promise<{ grant: GrantRow | null; gaps: string[] }> {
  const grants = await db.query<GrantRow>(
    `SELECT * FROM mcp_policy_grants WHERE workspace_id=$1 AND client_row_id=$2 AND actor_user_id=$3 AND brand_id=$4 AND revoked_at IS NULL ORDER BY created_at`,
    [i.workspace_id, s.client.id, i.actor_user_id, i.brand_id]);
  const gaps: string[] = [];
  for (const g of grants.rows) {
    const gap = grantGap(g, i, post);
    if (!gap) return { grant: g, gaps };
    gaps.push(gap);
  }
  return { grant: null, gaps };
}

// ------------------------------------------------------------------ recheck (shared by confirm + commit)

interface Recheck { ok: true; post: PostRow; brand: BrandRow }
type RecheckResult = Recheck | { ok: false; reason: string };

async function recheck(db: Queryable, ctx: Ctx, i: IntentRow): Promise<RecheckResult> {
  let post: PostRow;
  let brand: BrandRow;
  try {
    post = await loadPost(ctx, i.post_id, db);
    brand = await assertBrand(ctx, i.brand_id, db);
  } catch {
    return { ok: false, reason: 'The post or brand is no longer available to this client.' };
  }
  if (post.brand_id !== i.brand_id || post.archived_at || brand.archived_at) return { ok: false, reason: 'The post was moved or archived.' };
  if (post.version !== i.post_version) return { ok: false, reason: 'The post changed after the intent was prepared.' };
  const conns = await brandConnections(db, ctx.access.workspaceId, i.brand_id, true);
  if (!i.connection_ids.every((c) => conns.some((x) => x.id === c && !x.disconnected_at))) return { ok: false, reason: 'A destination was disconnected.' };
  if (revisionHash(post, i.connection_ids, conns) !== i.revision_hash) return { ok: false, reason: 'The content or destinations changed.' };
  if (i.mode === 'scheduled') {
    try {
      const t = resolveScheduleTime({ input_local_time: i.input_local_time ?? undefined, timezone: i.input_timezone, offset: i.input_offset ?? undefined, deadline_minutes: i.deadline_minutes }, brand, 'timed');
      if (!i.due_at || t.dueAt.getTime() !== i.due_at.getTime()) return { ok: false, reason: 'The resolved publication time changed.' };
    } catch (err) {
      return { ok: false, reason: err instanceof AppError ? err.message : 'The publication time is no longer valid.' };
    }
  }
  if (await approvalRequiredFor(db, ctx.access.workspaceId, i.brand_id)) return { ok: false, reason: 'This brand now requires approval: submit for review instead.' };
  if (intentHash(i) !== i.intent_hash) return { ok: false, reason: 'The intent record is inconsistent.' };
  return { ok: true, post, brand };
}

async function invalidate(db: Queryable, id: string, reason: string, status: 'invalidated' | 'expired' | 'failed' = 'invalidated') {
  await db.query(`UPDATE mcp_publication_intents SET status=$2, invalid_reason=$3 WHERE id=$1 AND status IN ('prepared','confirmed')`, [id, status, reason.slice(0, 300)]);
}

// ------------------------------------------------------------------ prepare

export async function preparePublication(s: CallScope, input: PrepareInput) {
  requireHuman(s, 'Publishing');
  requireScope(s, input.when.mode === 'immediate' ? 'publishing.publish' : 'publishing.schedule');
  const { ctx } = s;
  const db = getPool();
  const post = await loadPost(ctx, input.post_id, db);
  const brand = await assertBrand(ctx, post.brand_id, db);
  if (post.archived_at || brand.archived_at) throw new McpToolError('invalid_state', 'This post or brand is archived.');
  const authority = holdsAuthority(ctx, brand.id, input.when.mode);
  if (!authority.ok) throw new McpToolError('forbidden', input.when.mode === 'immediate' ? 'You cannot publish posts for this brand.' : 'You cannot schedule posts for this brand.');
  if (post.version !== input.expected_version) {
    throw new McpToolError('version_conflict', 'The post changed. Read it again with get_post and prepare with the current version.', { current: { version: post.version } });
  }
  const ids = [...new Set(input.connection_ids)];
  const conns = await brandConnections(db, ctx.access.workspaceId, brand.id, true);
  const destinations = ids.map((id) => {
    const c = conns.find((x) => x.id === id);
    return c ? { connection_id: c.id, provider: c.provider, display_name: c.display_name, is_mock: c.is_mock, status: c.status, paused: c.paused } : { connection_id: id, provider: null, display_name: null, is_mock: null, status: 'unknown', paused: false };
  });
  const base = {
    post: { id: post.id, version: post.version, app_url: appUrl(`/posts/${post.id}`) },
    brand: { id: brand.id, name: brand.name, timezone: brand.timezone, publishing_paused: brand.publishing_paused, paused_reason: brand.paused_reason },
    destinations,
  };
  if (await approvalRequiredFor(db, ctx.access.workspaceId, brand.id)) {
    return { ...base, status: 'approval_required' as const, intent: null, approval: { required: true },
      next_step: 'This brand requires editorial approval: use submit_for_review. Approvers decide in Relay.' };
  }
  const validation = await validateDraft(db, ctx, post, ids);
  if (!validation.ok) {
    return { ...base, status: 'invalid' as const, intent: null, approval: { required: false }, validation: { ok: false, issues: validation.issues },
      next_step: 'Fix the issues (update_draft) or choose other destinations, then prepare again.' };
  }
  const tz = input.when.timezone ?? brand.timezone;
  if (!isValidTimeZone(tz)) throw new McpToolError('validation_failed', `Unknown time zone "${tz}". Use an IANA zone such as Europe/London.`);
  if (input.when.mode === 'scheduled' && !input.when.local_time) throw new McpToolError('validation_failed', 'local_time (YYYY-MM-DDTHH:mm in the timezone) is required for a scheduled publication.');
  let time: ReturnType<typeof resolveScheduleTime>;
  try {
    time = resolveScheduleTime({ input_local_time: input.when.local_time, timezone: tz, offset: input.when.offset, deadline_minutes: input.deadline_minutes },
      brand, input.when.mode === 'immediate' ? 'immediate' : 'timed');
  } catch (err) {
    if (err instanceof AppError && err.details?.reason === 'ambiguous_time') {
      const options = (err.details.options as Array<{ offset: string; instant: string }>) ?? [];
      return { ...base, status: 'needs_choice' as const, intent: null, approval: { required: false },
        choices: options.map((o) => ({ offset: o.offset, instant: o.instant, local_time: input.when.local_time, timezone: tz })),
        next_step: 'The local time occurs twice (clock change). Ask the user which one, then prepare again with when.offset.' };
    }
    throw err;
  }
  const deadline = input.deadline_minutes ?? brand.default_deadline_minutes;
  const row: Omit<IntentRow, 'id' | 'intent_hash' | 'status' | 'invalid_reason' | 'expires_at' | 'confirmed_at' | 'confirmed_by' | 'confirmed_mfa' | 'policy_grant_id' | 'committed_at' | 'schedule_id' | 'result' | 'created_at'> = {
    workspace_id: ctx.access.workspaceId, brand_id: brand.id, post_id: post.id, client_row_id: s.client.id, actor_user_id: ctx.actor.userId,
    post_version: post.version, revision_hash: revisionHash(post, ids, conns), connection_ids: ids, mode: input.when.mode,
    input_local_time: input.when.mode === 'scheduled' ? time.localTime : null, input_timezone: time.timezone,
    input_offset: input.when.mode === 'scheduled' ? time.offset : null, deadline_minutes: deadline, due_at: input.when.mode === 'scheduled' ? time.dueAt : null,
  };
  const hash = intentHash(row);
  const expiresAt = new Date(Date.now() + MCP_LIMITS.intentTtlMs);
  const intent = await one<{ id: string }>(db,
    `INSERT INTO mcp_publication_intents(workspace_id, brand_id, post_id, client_row_id, actor_user_id, post_version, revision_hash, connection_ids, mode,
       input_local_time, input_timezone, input_offset, deadline_minutes, due_at, intent_hash, expires_at, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
    [row.workspace_id, row.brand_id, row.post_id, row.client_row_id, row.actor_user_id, row.post_version, row.revision_hash, row.connection_ids, row.mode,
      row.input_local_time, row.input_timezone, row.input_offset, row.deadline_minutes, row.due_at, hash, expiresAt, ctx.correlationId]);
  const asIntent = { ...row, id: intent.id, intent_hash: hash } as IntentRow;
  const { grant, gaps } = await coveringGrant(db, s, asIntent, post);
  return {
    ...base,
    status: 'ready' as const,
    intent: { id: intent.id, hash, expires_at: expiresAt.toISOString() },
    revision: { post_version: post.version, content_hash: row.revision_hash },
    time: {
      mode: row.mode, due_at: row.due_at?.toISOString() ?? null, local_time: row.input_local_time, timezone: row.input_timezone, offset: row.input_offset,
      publish_before: input.when.mode === 'scheduled' ? time.publishBefore.toISOString() : null, deadline_minutes: deadline,
    },
    validation: { ok: true, issues: validation.issues },
    approval: { required: false },
    authorization: grant
      ? { method: 'policy_grant' as const, policy_grant_id: grant.id, confirm_url: null }
      : { method: 'confirmation_required' as const, policy_grant_id: null, confirm_url: confirmUrl(intent.id), policy_grant_gaps: gaps.slice(0, 5) },
    next_step: grant
      ? 'An automation policy covers this. Call commit_publication with intent_id and intent_hash.'
      : 'Ask the user to open confirm_url in Relay and confirm, then call commit_publication with intent_id and intent_hash.',
  };
}

// ------------------------------------------------------------------ commit

export async function commitPublication(s: CallScope, input: { intent_id: string; intent_hash: string }) {
  requireHuman(s, 'Publishing');
  const db = getPool();
  if (!/^[0-9a-f-]{36}$/i.test(input.intent_id)) throw new McpToolError('not_found', 'Intent not found');
  const i = await maybeOne<IntentRow>(db,
    `SELECT * FROM mcp_publication_intents WHERE id=$1 AND workspace_id=$2 AND client_row_id=$3 AND actor_user_id=$4`,
    [input.intent_id, s.ctx.access.workspaceId, s.client.id, s.ctx.actor.userId]);
  if (!i) throw new McpToolError('not_found', 'Intent not found');
  requireScope(s, i.mode === 'immediate' ? 'publishing.publish' : 'publishing.schedule');
  if (i.status === 'committed') return { ...(i.result as Record<string, unknown>), duplicate: true };
  if (input.intent_hash !== i.intent_hash) throw new McpToolError('intent_stale', 'intent_hash does not match this intent. Prepare again.');
  if (i.status === 'invalidated' || i.status === 'failed') throw new McpToolError('intent_stale', `This intent is no longer valid: ${i.invalid_reason ?? i.status}. Prepare again.`);
  if (i.status === 'expired' || i.expires_at.getTime() <= Date.now()) {
    await invalidate(db, i.id, 'expired', 'expired');
    throw new McpToolError('intent_expired', 'This intent expired. Prepare again.');
  }
  const check = await recheck(db, s.ctx, i);
  if (!check.ok) {
    await invalidate(db, i.id, check.reason);
    throw new McpToolError('intent_stale', `${check.reason} Prepare again.`);
  }
  // Authorization basis: trusted confirmation recorded by the Relay app for THIS intent, or a covering policy grant.
  let basis: { kind: 'confirmation' | 'policy_grant'; grantId: string | null; mfa: boolean; authTime: string | null };
  if (i.status === 'confirmed' && i.confirmed_by === i.actor_user_id && i.confirmed_at) {
    basis = { kind: 'confirmation', grantId: null, mfa: !!i.confirmed_mfa, authTime: i.confirmed_at.toISOString() };
  } else {
    const reserved = await withTx(async (tx) => {
      const { grant } = await coveringGrant(tx, s, i, check.post);
      if (!grant) return null;
      await tx.query(`SELECT 1 FROM mcp_policy_grants WHERE id=$1 FOR UPDATE`, [grant.id]);
      const used = await one<{ n: number }>(tx,
        `SELECT count(*)::int n FROM mcp_publication_intents WHERE policy_grant_id=$1 AND status IN ('prepared','confirmed','committed')
            AND coalesce(committed_at, created_at) > now() - interval '24 hours'`, [grant.id]);
      if (used.n >= grant.max_per_day) return 'limit' as const;
      const upd = await tx.query(`UPDATE mcp_publication_intents SET policy_grant_id=$2 WHERE id=$1 AND status='prepared'`, [i.id, grant.id]);
      return upd.rowCount ? grant : null;
    });
    if (reserved === 'limit') throw new McpToolError('confirmation_required', 'The automation policy’s daily limit is used up. Ask the user to confirm this intent in Relay.', { confirm_url: confirmUrl(i.id) });
    if (!reserved) {
      throw new McpToolError('confirmation_required', 'This publication needs the user’s confirmation in Relay (a model-supplied confirmation is not accepted).', { confirm_url: confirmUrl(i.id) });
    }
    basis = { kind: 'policy_grant', grantId: reserved.id, mfa: true, authTime: null };
  }
  // The person confirmed with step-up in Relay (or set up the policy with step-up): that satisfies the MFA gate.
  const elevated = await callScope(s.principal, i.workspace_id, s.ctx.correlationId, { elevatedAssurance: { mfaVerified: basis.mfa || s.principal.assurance.mfaVerified, authTime: basis.authTime } });
  const req = { expected_version: i.post_version, connection_ids: i.connection_ids, ...(i.mode === 'scheduled'
    ? { input_local_time: i.input_local_time!, timezone: i.input_timezone, ...(i.input_offset ? { offset: i.input_offset } : {}), deadline_minutes: i.deadline_minutes }
    : {}) };
  let out: { status: number; body: unknown };
  try {
    out = i.mode === 'immediate'
      ? await publishNow(elevated.ctx, i.post_id, { expected_version: i.post_version, connection_ids: i.connection_ids }, `mcp-intent:${i.id}`)
      : await schedulePost(elevated.ctx, i.post_id, req, `mcp-intent:${i.id}`);
  } catch (err) {
    const e = toToolError(err);
    if (['version_conflict', 'validation_failed', 'approval_required', 'invalid_state', 'conflict', 'needs_choice'].includes(e.code)) {
      await invalidate(db, i.id, e.message);
      throw new McpToolError('intent_stale', `${e.message} Prepare again.`, e.details);
    }
    // Policy grant reservation is released when the commit did not happen.
    if (basis.kind === 'policy_grant') await db.query(`UPDATE mcp_publication_intents SET policy_grant_id=NULL WHERE id=$1 AND status='prepared'`, [i.id]);
    throw e;
  }
  const body = out.body as { schedule: { id: string; status: string; due_at: string | null; revision_number: number | null }; deliveries: Array<{ id: string; connection_id: string; provider: string; state: string; is_mock: boolean }> };
  const result = {
    status: 'committed' as const,
    intent_id: i.id,
    authorization: { method: basis.kind, policy_grant_id: basis.grantId },
    schedule: { id: body.schedule.id, status: body.schedule.status, due_at: body.schedule.due_at, revision_number: body.schedule.revision_number },
    deliveries: body.deliveries.map((d) => ({ id: d.id, connection_id: d.connection_id, provider: d.provider, state: d.state, simulated: d.is_mock })),
    brand_publishing_paused: check.brand.publishing_paused,
    note: check.brand.publishing_paused ? 'Publishing is paused for this brand: deliveries wait until someone resumes it in Relay.' : null,
    app_url: appUrl(`/posts/${i.post_id}`),
  };
  await withTx(async (tx) => {
    await tx.query(`UPDATE mcp_publication_intents SET status='committed', committed_at=now(), schedule_id=$2, result=$3, policy_grant_id=coalesce($4, policy_grant_id) WHERE id=$1 AND status IN ('prepared','confirmed')`,
      [i.id, body.schedule.id, JSON.stringify(result), basis.grantId]);
    await audit(tx, { workspaceId: i.workspace_id, brandId: i.brand_id, actorUserId: i.actor_user_id, action: 'mcp.publication_committed', resourceType: 'schedule', resourceId: body.schedule.id,
      correlationId: s.ctx.correlationId, diff: { intent_id: i.id, client_row_id: s.client.id, basis: basis.kind, policy_grant_id: basis.grantId, mode: i.mode } });
  });
  return result;
}

// ------------------------------------------------------------------ trusted confirmation (Relay web app only)

async function loadForPerson(db: Queryable, ctx: Ctx, intentId: string): Promise<IntentRow> {
  if (!/^[0-9a-f-]{36}$/i.test(intentId)) throw notFound('Intent');
  // Only the person the MCP client acts for can confirm (and see) the intent.
  const i = await maybeOne<IntentRow>(db, `SELECT * FROM mcp_publication_intents WHERE id=$1 AND workspace_id=$2 AND actor_user_id=$3`,
    [intentId, ctx.access.workspaceId, ctx.actor.userId]);
  if (!i) throw notFound('Intent');
  return i;
}

/** Read model for the confirmation page (/mcp/confirm/[intentId]). Shows exactly what would be published. */
export async function intentView(ctx: Ctx, intentId: string) {
  const db = getPool();
  const i = await loadForPerson(db, ctx, intentId);
  const client = await one<{ name: string; client_id: string; status: string }>(db, `SELECT name, client_id, status FROM mcp_clients WHERE id=$1`, [i.client_row_id]);
  const post = await loadPost(ctx, i.post_id, db);
  const brand = await assertBrand(ctx, i.brand_id, db);
  const conns = await brandConnections(db, ctx.access.workspaceId, i.brand_id, true);
  const expired = i.expires_at.getTime() <= Date.now();
  let stale: string | null = null;
  if (['prepared', 'confirmed'].includes(i.status) && !expired) {
    const r = await recheck(db, ctx, i);
    if (!r.ok) stale = r.reason;
  }
  const auth = holdsAuthority(ctx, i.brand_id, i.mode);
  const reason = client.status !== 'active' ? 'This client’s access was revoked.' : expired ? 'This request expired.' : stale
    ?? (i.status !== 'prepared' ? `This request is ${i.status}.` : !auth.ok ? (i.mode === 'immediate' ? 'You cannot publish for this brand.' : 'You cannot schedule for this brand.') : null);
  const variantTexts = i.connection_ids.map((id) => post.draft.variants.find((v) => v.connectionId === id));
  return {
    id: i.id,
    status: expired && ['prepared', 'confirmed'].includes(i.status) ? 'expired' as const : i.status,
    stale_reason: stale,
    client: { name: client.name, client_id: client.client_id },
    brand: { id: brand.id, name: brand.name, timezone: brand.timezone, publishing_paused: brand.publishing_paused },
    post: { id: post.id, title: post.title, text: post.draft.baseText, link: post.draft.baseLink ?? null, version: post.version,
      media_count: new Set([...post.draft.baseAssetIds, ...variantTexts.flatMap((v) => v?.assetIds ?? [])]).size },
    destinations: i.connection_ids.map((id) => {
      const c = conns.find((x) => x.id === id);
      return { connection_id: id, provider: c?.provider ?? 'unknown', display_name: c?.display_name ?? 'Removed destination', is_mock: c?.is_mock ?? false };
    }),
    mode: i.mode, due_at: i.due_at?.toISOString() ?? null, local_time: i.input_local_time, timezone: i.input_timezone,
    expires_at: i.expires_at.toISOString(), confirmed_at: i.confirmed_at?.toISOString() ?? null,
    can_confirm: !reason, cannot_confirm_reason: reason,
  };
}

/**
 * Record the trusted confirmation for ONE intent. Web session only (never reachable from /mcp): the signed-in person
 * must be the person the client acts for and hold the authority now, with step-up (fresh authentication + MFA as
 * the V2 policy requires).
 */
export async function confirmIntent(ctx: Ctx, intentId: string) {
  const db = getPool();
  const i0 = await loadForPerson(db, ctx, intentId);
  for (const p of permissionFor(i0.mode)) requireAction(ctx, p, { brandId: i0.brand_id, stepUp: true });
  return withTx(async (tx) => {
    const i = await one<IntentRow>(tx, `SELECT * FROM mcp_publication_intents WHERE id=$1 FOR UPDATE`, [i0.id]);
    if (i.status === 'confirmed' || i.status === 'committed') return { id: i.id, status: i.status, confirmed_at: i.confirmed_at?.toISOString() ?? null };
    if (i.status !== 'prepared') throw new AppError('invalid_state', `This request is ${i.status}.`);
    if (i.expires_at.getTime() <= Date.now()) {
      await invalidate(tx, i.id, 'expired', 'expired');
      throw new AppError('invalid_state', 'This request expired. Ask the assistant to prepare it again.');
    }
    const client = await maybeOne<{ status: string }>(tx, `SELECT status FROM mcp_clients WHERE id=$1 FOR SHARE`, [i.client_row_id]);
    if (client?.status !== 'active') throw new AppError('invalid_state', 'This client’s access was revoked.');
    const r = await recheck(tx, ctx, i);
    if (!r.ok) {
      await invalidate(tx, i.id, r.reason);
      throw new AppError('conflict', `${r.reason} Ask the assistant to prepare it again.`);
    }
    const mfa = !!ctx.access.authz?.subject.assurance?.mfaVerified;
    const upd = await one<{ confirmed_at: Date }>(tx,
      `UPDATE mcp_publication_intents SET status='confirmed', confirmed_at=now(), confirmed_by=$2, confirmed_session=$3, confirmed_mfa=$4 WHERE id=$1 RETURNING confirmed_at`,
      [i.id, ctx.actor.userId, /^[0-9a-f-]{36}$/i.test(ctx.actor.sessionId) ? ctx.actor.sessionId : null, mfa]);
    await audit(tx, { workspaceId: i.workspace_id, brandId: i.brand_id, actorUserId: ctx.actor.userId, action: 'mcp.intent_confirmed', resourceType: 'mcp_intent', resourceId: i.id,
      correlationId: ctx.correlationId, diff: { client_row_id: i.client_row_id, mode: i.mode, due_at: i.due_at?.toISOString() ?? null, destinations: i.connection_ids } });
    return { id: i.id, status: 'confirmed' as const, confirmed_at: upd.confirmed_at.toISOString() };
  });
}

/** Decline: invalidates the intent (the client must prepare again). */
export async function declineIntent(ctx: Ctx, intentId: string) {
  const db = getPool();
  const i = await loadForPerson(db, ctx, intentId);
  await invalidate(db, i.id, 'Declined by the user in Relay.');
  await audit(db, { workspaceId: i.workspace_id, brandId: i.brand_id, actorUserId: ctx.actor.userId, action: 'mcp.intent_declined', resourceType: 'mcp_intent', resourceId: i.id, correlationId: ctx.correlationId });
  return { id: i.id, status: 'invalidated' as const };
}
