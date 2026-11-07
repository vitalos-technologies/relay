// V2 approval policies (stream C). A brand requires 0, 1 or 2 sequential review stages. Each stage needs a
// quorum of DISTINCT people who are eligible NOW (re-evaluated at approve time and again at dispatch):
// they hold content.approve on the brand, match the stage's roles/teams, are guests only when the stage
// allows guests AND the post was shared with them, and are not authors/editors of the revision when
// separation of duties is on. An approval binds revision + asset versions + destinations + links + schedule +
// policy generation; any change invalidates it. Changing a policy creates a new generation (immutable), voids
// earlier approvals and never releases anything automatically. Weakening needs brands.manage + step-up.
import { createHash } from 'node:crypto';
import { AppError, notFound, type RolePreset } from '@social-lite/core';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { writeOutbox } from '../outbox.js';
import { authorize, loadUserAuthz, type AuthzState } from '../authz.js';
import { stableStringify } from '../idempotency.js';
import { assertBrand, authorizeCtx, requireAction } from '../tenancy.js';

// ------------------------------------------------------------------ policy model
export const STAGE_ROLES = ['owner', 'admin', 'approver'] as const;
export type StageRole = (typeof STAGE_ROLES)[number];

export interface StageDef {
  position: 1 | 2;
  name: string;
  quorum: number;
  eligible_roles: StageRole[];
  eligible_team_ids: string[];
  allow_guests: boolean;
}

export interface PolicyDef {
  brand_id: string;
  generation: number;
  separation_of_duties: boolean;
  stages: StageDef[];
  updated_at: string | null;
  updated_by_email: string | null;
}

export interface PolicyInput {
  separation_of_duties: boolean;
  stages: Array<Omit<StageDef, 'position'>>;
}

const MAX_QUORUM = 10;

export async function loadPolicy(db: Queryable, workspaceId: string, brandId: string, generation?: number): Promise<PolicyDef> {
  const cur = await maybeOne<{ generation: number; updated_at: Date; email: string | null }>(db,
    `SELECT p.generation, p.updated_at, u.email FROM approval_policies p LEFT JOIN users u ON u.id=p.updated_by
      WHERE p.brand_id=$1 AND p.workspace_id=$2`, [brandId, workspaceId]);
  if (!cur) {
    // Fail closed: a brand without a policy row (should not happen; created by trigger) requires one review stage.
    return { brand_id: brandId, generation: 0, separation_of_duties: false, updated_at: null, updated_by_email: null,
      stages: [{ position: 1, name: 'Review', quorum: 1, eligible_roles: [], eligible_team_ids: [], allow_guests: false }] };
  }
  const gen = generation ?? cur.generation;
  const v = await maybeOne<{ separation_of_duties: boolean }>(db,
    `SELECT separation_of_duties FROM approval_policy_versions WHERE brand_id=$1 AND generation=$2`, [brandId, gen]);
  const stages = await many<{ position: 1 | 2; name: string; quorum: number; eligible_roles: StageRole[]; eligible_team_ids: string[]; allow_guests: boolean }>(db,
    `SELECT position, name, quorum, eligible_roles, eligible_team_ids, allow_guests FROM approval_stages
      WHERE brand_id=$1 AND generation=$2 ORDER BY position`, [brandId, gen]);
  return {
    brand_id: brandId, generation: gen, separation_of_duties: v?.separation_of_duties ?? false,
    updated_at: cur.updated_at.toISOString(), updated_by_email: cur.email, stages,
  };
}

/** True when the brand's CURRENT policy requires review before anything can be scheduled. */
export async function approvalRequiredFor(db: Queryable, workspaceId: string, brandId: string): Promise<boolean> {
  return (await loadPolicy(db, workspaceId, brandId)).stages.length > 0;
}

// ------------------------------------------------------------------ binding
export interface BindingSummary {
  revision_id: string; content_hash: string; schedule_fingerprint: string; policy_generation: number;
  assets: Array<{ id: string; sha256: string | null; status: string; alt: string | null }>;
  destinations: Array<{ id: string; provider: string; account: string; mock: boolean }>;
  links: string[];
}

/** Hash of everything an approval covers. Any change => different hash => approval no longer valid. */
export async function computeBinding(db: Queryable, workspaceId: string, revisionId: string, fingerprint: string, generation: number): Promise<{ hash: string; summary: BindingSummary }> {
  const rev = await one<{ content_hash: string; base_asset_ids: string[]; base_link: string | null }>(db,
    `SELECT content_hash, base_asset_ids, base_link FROM post_revisions WHERE id=$1 AND workspace_id=$2`, [revisionId, workspaceId]);
  const vs = await many<{ connection_id: string; asset_ids: string[]; link: string | null; buttons: Array<{ url?: string }> | null }>(db,
    `SELECT connection_id, asset_ids, link, buttons FROM variants WHERE revision_id=$1 AND workspace_id=$2`, [revisionId, workspaceId]);
  const assetIds = [...new Set([...rev.base_asset_ids, ...vs.flatMap((v) => v.asset_ids)])].sort();
  const assets = assetIds.length ? await many<{ id: string; checksum_sha256: string | null; status: string; alt_text: string | null }>(db,
    `SELECT id, checksum_sha256, status::text AS status, alt_text FROM assets WHERE workspace_id=$1 AND id = ANY($2::uuid[]) ORDER BY id`, [workspaceId, assetIds]) : [];
  const connIds = [...new Set(vs.map((v) => v.connection_id))].sort();
  const conns = connIds.length ? await many<{ id: string; provider: string; provider_account_id: string; is_mock: boolean }>(db,
    `SELECT id, provider, provider_account_id, is_mock FROM connections WHERE workspace_id=$1 AND id = ANY($2::uuid[]) ORDER BY id`, [workspaceId, connIds]) : [];
  const links = [...new Set([rev.base_link, ...vs.map((v) => v.link), ...vs.flatMap((v) => (v.buttons ?? []).map((b) => b.url ?? null))]
    .filter((x): x is string => !!x))].sort();
  const summary: BindingSummary = {
    revision_id: revisionId, content_hash: rev.content_hash, schedule_fingerprint: fingerprint, policy_generation: generation,
    // a missing asset/destination is part of the hash too (it changes the arrays)
    assets: assets.map((a) => ({ id: a.id, sha256: a.checksum_sha256, status: a.status, alt: a.alt_text })),
    destinations: conns.map((c) => ({ id: c.id, provider: c.provider, account: c.provider_account_id, mock: c.is_mock })),
    links,
  };
  return { hash: createHash('sha256').update(stableStringify(summary)).digest('hex'), summary };
}

// ------------------------------------------------------------------ eligibility
export type IneligibleReason = 'no_authority' | 'role_not_eligible' | 'team_not_eligible' | 'guests_not_allowed' | 'not_shared' | 'separation_of_duties';

export interface Eligibility { eligible: boolean; reason: IneligibleReason | null; asGuest: boolean }

interface ReviewerFacts { state: AuthzState; teamIds: string[]; shared: boolean }

export function stageEligibility(f: ReviewerFacts, stage: StageDef, brandId: string, userId: string, sod: { enabled: boolean; authorIds: string[] }): Eligibility {
  const d = authorize(f.state, 'content.approve', { brandId });
  if (!d.allowed) return { eligible: false, reason: 'no_authority', asGuest: false };
  const staff = d.sources.filter((s) => s.role !== 'guest');
  const asGuest = staff.length === 0;
  const no = (reason: IneligibleReason): Eligibility => ({ eligible: false, reason, asGuest });
  if (asGuest) {
    if (!stage.allow_guests) return no('guests_not_allowed');
    if (!f.shared) return no('not_shared');
  } else {
    if (stage.eligible_roles.length && !staff.some((s) => (stage.eligible_roles as RolePreset[]).includes(s.role))) return no('role_not_eligible');
    if (stage.eligible_team_ids.length && !f.teamIds.some((t) => stage.eligible_team_ids.includes(t))) return no('team_not_eligible');
  }
  if (sod.enabled && sod.authorIds.includes(userId)) return no('separation_of_duties');
  return { eligible: true, reason: null, asGuest };
}

/** Current (fresh from the database) facts about a prospective reviewer. Assurance is irrelevant for content.approve. */
export async function reviewerFacts(db: Queryable, workspaceId: string, userId: string, postId: string): Promise<ReviewerFacts> {
  const state = await loadUserAuthz(userId, workspaceId, null, db);
  const teams = await many<{ team_id: string }>(db,
    `SELECT tm.team_id FROM team_memberships tm JOIN teams t ON t.id=tm.team_id AND t.archived_at IS NULL
      WHERE tm.workspace_id=$1 AND tm.user_id=$2`, [workspaceId, userId]);
  const shared = await maybeOne(db, `SELECT 1 FROM review_shares WHERE workspace_id=$1 AND post_id=$2 AND user_id=$3 AND revoked_at IS NULL`, [workspaceId, postId, userId]);
  return { state, teamIds: teams.map((t) => t.team_id), shared: !!shared };
}

/**
 * Batched reviewerFacts for many (user, post) pairs (V3.1 PERF: approval inbox N+1). Same facts, same freshness: authority
 * is loaded from the database once per distinct user for THIS call (never cached across requests); teams and review
 * shares come from one query each.
 */
export async function reviewerFactsMany(db: Queryable, workspaceId: string, pairs: Array<{ userId: string; postId: string }>): Promise<(userId: string, postId: string) => ReviewerFacts> {
  const users = [...new Set(pairs.map((p) => p.userId))];
  const posts = [...new Set(pairs.map((p) => p.postId))];
  const states = new Map<string, AuthzState>();
  for (const u of users) states.set(u, await loadUserAuthz(u, workspaceId, null, db));
  const teams = users.length ? await many<{ user_id: string; team_id: string }>(db,
    `SELECT tm.user_id, tm.team_id FROM team_memberships tm JOIN teams t ON t.id=tm.team_id AND t.archived_at IS NULL
      WHERE tm.workspace_id=$1 AND tm.user_id = ANY($2::uuid[])`, [workspaceId, users]) : [];
  const shares = users.length && posts.length ? await many<{ user_id: string; post_id: string }>(db,
    `SELECT user_id, post_id FROM review_shares WHERE workspace_id=$1 AND user_id = ANY($2::uuid[]) AND post_id = ANY($3::uuid[]) AND revoked_at IS NULL`,
    [workspaceId, users, posts]) : [];
  const shared = new Set(shares.map((r) => `${r.user_id}:${r.post_id}`));
  return (userId, postId) => {
    const state = states.get(userId);
    if (!state) throw new Error('reviewerFactsMany: user not loaded');
    return { state, teamIds: teams.filter((t) => t.user_id === userId).map((t) => t.team_id), shared: shared.has(`${userId}:${postId}`) };
  };
}

// ------------------------------------------------------------------ review requests
export interface ReviewRequestRow {
  id: string; workspace_id: string; brand_id: string; post_id: string; revision_id: string; schedule_id: string; schedule_generation: number;
  fingerprint: string; requested_by: string | null; decision: string; policy_generation: number | null; stage_count: number; current_stage: number;
  binding_hash: string | null; author_ids: string[]; assignee_user_id: string | null; due_at: Date | null;
}

/** Authors/editors of the post content up to now: creator, every saver of a draft version, and the submitter. */
export async function postAuthors(db: Queryable, postId: string, submitter: string | null): Promise<string[]> {
  const rows = await many<{ id: string | null }>(db,
    `SELECT created_by AS id FROM posts WHERE id=$1
     UNION SELECT updated_by FROM posts WHERE id=$1
     UNION SELECT saved_by FROM post_versions WHERE post_id=$1 AND kind <> 'conflict'
     UNION SELECT created_by FROM post_revisions WHERE post_id=$1`, [postId]);
  return [...new Set([...rows.map((r) => r.id), submitter].filter((x): x is string => !!x))];
}

/** Insert the review request for a pending schedule, bound to the current policy generation. */
export async function createReviewRequest(tx: Queryable, ctx: Ctx, p: {
  postId: string; brandId: string; revisionId: string; scheduleId: string; scheduleGeneration: number; fingerprint: string;
}): Promise<{ id: string }> {
  const policy = await loadPolicy(tx, ctx.access.workspaceId, p.brandId);
  if (!policy.stages.length) throw new AppError('invalid_state', 'This brand does not require approval. Schedule it directly.');
  const binding = await computeBinding(tx, ctx.access.workspaceId, p.revisionId, p.fingerprint, policy.generation);
  const authors = await postAuthors(tx, p.postId, ctx.actor.userId);
  const prev = await maybeOne<{ assignee_user_id: string | null; due_at: Date | null }>(tx,
    `SELECT assignee_user_id, due_at FROM approvals WHERE post_id=$1 ORDER BY requested_at DESC LIMIT 1`, [p.postId]);
  const row = await one<{ id: string }>(tx,
    `INSERT INTO approvals(workspace_id, brand_id, post_id, revision_id, schedule_id, schedule_generation, fingerprint, requested_by,
                           policy_generation, stage_count, current_stage, binding_hash, binding, author_ids, assignee_user_id, due_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$12,$13,$14,$15) RETURNING id`,
    [ctx.access.workspaceId, p.brandId, p.postId, p.revisionId, p.scheduleId, p.scheduleGeneration, p.fingerprint, ctx.actor.userId,
      policy.generation, policy.stages.length, binding.hash, JSON.stringify(binding.summary), authors,
      // carry the reviewer assignment over a resubmission (it is a planning hint, never a decision)
      prev?.assignee_user_id ?? null, prev?.due_at ?? null]);
  return row;
}

export interface StageProgress {
  position: number; name: string; quorum: number; allow_guests: boolean;
  approvals: number; approver_ids: string[]; discounted: Array<{ user_id: string; reason: IneligibleReason }>; met: boolean;
}

/** Count, per stage, the DISTINCT approvers who are still eligible right now. */
export async function evaluateStages(db: Queryable, a: Pick<ReviewRequestRow, 'id' | 'workspace_id' | 'brand_id' | 'post_id' | 'author_ids'>, policy: PolicyDef): Promise<StageProgress[]> {
  const decisions = await many<{ stage: number; user_id: string }>(db,
    `SELECT stage, user_id FROM approval_decisions WHERE approval_id=$1 AND decision='approved'`, [a.id]);
  const facts = new Map<string, ReviewerFacts>();
  for (const uid of new Set(decisions.map((d) => d.user_id))) facts.set(uid, await reviewerFacts(db, a.workspace_id, uid, a.post_id));
  return stageProgressFrom(decisions, (uid) => facts.get(uid)!, a, policy);
}

/** evaluateStages over already-loaded approved decisions + reviewer facts (pure; used by the batched inbox). */
export function stageProgressFrom(decisions: Array<{ stage: number; user_id: string }>, factsFor: (userId: string) => ReviewerFacts,
  a: Pick<ReviewRequestRow, 'brand_id' | 'author_ids'>, policy: PolicyDef): StageProgress[] {
  return policy.stages.map((s) => {
    const ok: string[] = [];
    const discounted: StageProgress['discounted'] = [];
    for (const uid of new Set(decisions.filter((d) => d.stage === s.position).map((d) => d.user_id))) {
      const e = stageEligibility(factsFor(uid), s, a.brand_id, uid, { enabled: policy.separation_of_duties, authorIds: a.author_ids });
      if (e.eligible) ok.push(uid); else discounted.push({ user_id: uid, reason: e.reason! });
    }
    return { position: s.position, name: s.name, quorum: s.quorum, allow_guests: s.allow_guests, approvals: ok.length, approver_ids: ok, discounted, met: ok.length >= s.quorum };
  });
}

/** Mark a pending review request invalid (and supersede its schedule) — used when what it covers changed. */
export async function invalidateRequest(tx: Queryable, ctx: Ctx, a: Pick<ReviewRequestRow, 'id' | 'brand_id' | 'schedule_id' | 'workspace_id'>, reason: string, code: string): Promise<void> {
  await tx.query(`UPDATE approvals SET decision='invalidated', decided_at=now(), reason=$2 WHERE id=$1 AND decision IN ('pending','approved')`, [a.id, reason]);
  await tx.query(`UPDATE schedules SET status='superseded' WHERE id=$1 AND status='pending_approval'`, [a.schedule_id]);
  await audit(tx, { workspaceId: a.workspace_id, brandId: a.brand_id, actorUserId: ctx.actor.userId, action: 'approval.invalidated',
    resourceType: 'approval', resourceId: a.id, diff: { reason: code }, correlationId: ctx.correlationId });
}

export type DecisionOutcome =
  | { kind: 'final'; stages: StageProgress[] }
  | { kind: 'recorded'; stage: number; stages: StageProgress[] }
  | { kind: 'error'; error: AppError };

async function checkStillValid(tx: Queryable, ctx: Ctx, a: ReviewRequestRow, policy: PolicyDef): Promise<AppError | null> {
  if (a.policy_generation !== policy.generation) {
    await invalidateRequest(tx, ctx, a, 'The approval policy changed after submission', 'policy_changed');
    return new AppError('invalid_state', 'The approval policy changed after this was submitted. Ask the author to resubmit.', undefined, { reason: 'policy_changed' });
  }
  if (a.binding_hash) {
    const b = await computeBinding(tx, a.workspace_id, a.revision_id, a.fingerprint, policy.generation);
    if (b.hash !== a.binding_hash) {
      await invalidateRequest(tx, ctx, a, 'Media, destinations or links changed after submission', 'binding_changed');
      return new AppError('invalid_state', 'Media, destinations or links changed after submission. Ask the author to resubmit.', undefined, { reason: 'binding_changed' });
    }
  }
  return null;
}

/**
 * Record the caller's approval for the first stage that is not yet satisfied. Returns 'final' when every
 * stage now has its quorum of currently eligible, distinct people. Returns an error (to throw AFTER commit,
 * so an invalidation persists) when the request is stale.
 */
export async function recordApproval(tx: Queryable, ctx: Ctx, a: ReviewRequestRow): Promise<DecisionOutcome> {
  const policy = await loadPolicy(tx, a.workspace_id, a.brand_id);
  const stale = await checkStillValid(tx, ctx, a, policy);
  if (stale) return { kind: 'error', error: stale };
  const before = await evaluateStages(tx, a, policy);
  const current = before.find((s) => !s.met);
  if (!current) return { kind: 'final', stages: before };
  const stage = policy.stages.find((s) => s.position === current.position)!;
  const facts = await reviewerFacts(tx, a.workspace_id, ctx.actor.userId, a.post_id);
  const e = stageEligibility(facts, stage, a.brand_id, ctx.actor.userId, { enabled: policy.separation_of_duties, authorIds: a.author_ids });
  if (!e.eligible) {
    const why: Record<IneligibleReason, string> = {
      no_authority: 'You do not have permission to approve for this brand.',
      role_not_eligible: `Your role is not eligible for "${stage.name}".`,
      team_not_eligible: `Only listed teams can approve "${stage.name}".`,
      guests_not_allowed: `Guests cannot approve "${stage.name}".`,
      not_shared: 'This review was not shared with you.',
      separation_of_duties: 'You worked on this content, so you cannot give its independent approval.',
    };
    return { kind: 'error', error: new AppError('forbidden', why[e.reason!], undefined, { reason: e.reason, stage: stage.position }) };
  }
  const mine = await many<{ stage: number; decision: string }>(tx, `SELECT stage, decision FROM approval_decisions WHERE approval_id=$1 AND user_id=$2`, [a.id, ctx.actor.userId]);
  if (mine.some((m) => m.stage === stage.position)) {
    return { kind: 'error', error: new AppError('conflict', 'You already approved this stage. Another eligible person must approve.', undefined, { reason: 'already_decided' }) };
  }
  if (mine.some((m) => m.decision === 'approved')) {
    return { kind: 'error', error: new AppError('conflict', 'You approved an earlier stage. A different person must approve this one.', undefined, { reason: 'one_stage_per_person' }) };
  }
  await tx.query(
    `INSERT INTO approval_decisions(workspace_id, approval_id, stage, user_id, decision, policy_generation, fingerprint, binding_hash, as_guest)
     VALUES ($1,$2,$3,$4,'approved',$5,$6,$7,$8)`,
    [a.workspace_id, a.id, stage.position, ctx.actor.userId, policy.generation, a.fingerprint, a.binding_hash, e.asGuest]);
  const after = await evaluateStages(tx, a, policy);
  const next = after.find((s) => !s.met);
  if (!next) return { kind: 'final', stages: after };
  if (next.position !== a.current_stage) {
    await tx.query(`UPDATE approvals SET current_stage=$2 WHERE id=$1`, [a.id, next.position]);
    if (next.position > current.position) {
      await writeOutbox(tx, { workspaceId: a.workspace_id, aggregateType: 'approval', aggregateId: a.id, eventType: 'approval.requested', payload: { postId: a.post_id, brandId: a.brand_id, stage: next.position } });
    }
  }
  await audit(tx, { workspaceId: a.workspace_id, brandId: a.brand_id, actorUserId: ctx.actor.userId, action: 'approval.stage_approved',
    resourceType: 'approval', resourceId: a.id, diff: { stage: stage.position, approvals: after.find((s) => s.position === stage.position)?.approvals, quorum: stage.quorum, as_guest: e.asGuest }, correlationId: ctx.correlationId });
  return { kind: 'recorded', stage: stage.position, stages: after };
}

/** Any eligible reviewer of the current stage may reject (records evidence). */
export async function recordRejection(tx: Queryable, ctx: Ctx, a: ReviewRequestRow, reason: string): Promise<AppError | null> {
  const policy = await loadPolicy(tx, a.workspace_id, a.brand_id);
  if (a.policy_generation !== policy.generation) {
    await invalidateRequest(tx, ctx, a, 'The approval policy changed after submission', 'policy_changed');
    return new AppError('invalid_state', 'The approval policy changed after this was submitted. Ask the author to resubmit.', undefined, { reason: 'policy_changed' });
  }
  const stages = await evaluateStages(tx, a, policy);
  const current = stages.find((s) => !s.met) ?? stages[stages.length - 1];
  const stage = policy.stages.find((s) => s.position === current?.position);
  if (stage) {
    const facts = await reviewerFacts(tx, a.workspace_id, ctx.actor.userId, a.post_id);
    // Separation of duties does not stop an author withdrawing/rejecting; eligibility otherwise applies.
    const e = stageEligibility(facts, stage, a.brand_id, ctx.actor.userId, { enabled: false, authorIds: [] });
    if (!e.eligible) return new AppError('forbidden', 'You are not a reviewer for this stage.', undefined, { reason: e.reason });
    await tx.query(
      `INSERT INTO approval_decisions(workspace_id, approval_id, stage, user_id, decision, reason, policy_generation, fingerprint, binding_hash, as_guest)
       VALUES ($1,$2,$3,$4,'rejected',$5,$6,$7,$8,$9) ON CONFLICT (approval_id, stage, user_id) DO NOTHING`,
      [a.workspace_id, a.id, stage.position, ctx.actor.userId, reason.slice(0, 2000), policy.generation, a.fingerprint, a.binding_hash, e.asGuest]);
  }
  return null;
}

// ------------------------------------------------------------------ dispatch gate (engine/process.ts)
export type ApprovalGate = { ok: true } | { ok: false; code: string; message: string };

/**
 * Re-evaluated for every dispatch attempt: current policy generation, approval bound to this exact schedule
 * (revision + fingerprint), unchanged binding (assets/destinations/links), and every stage's quorum of people
 * who are STILL eligible. A schedule that went through review stays gated even if the policy is later disabled.
 */
export async function approvalGate(db: Queryable, d: { workspace_id: string; brand_id: string; schedule_id: string }): Promise<ApprovalGate> {
  const policy = await loadPolicy(db, d.workspace_id, d.brand_id);
  const s = await one<{ revision_id: string; fingerprint: string; reviewed: boolean }>(db,
    `SELECT s.revision_id, s.fingerprint, EXISTS (SELECT 1 FROM approvals a WHERE a.schedule_id=s.id) AS reviewed FROM schedules s WHERE s.id=$1`, [d.schedule_id]);
  if (!policy.stages.length && !s.reviewed) return { ok: true };
  const a = await maybeOne<ReviewRequestRow>(db,
    `SELECT * FROM approvals WHERE schedule_id=$1 AND decision='approved' AND revision_id=$2 AND fingerprint=$3 ORDER BY decided_at DESC LIMIT 1`,
    [d.schedule_id, s.revision_id, s.fingerprint]);
  if (!a) return { ok: false, code: 'approval_missing', message: 'Approval is required and was not granted for this exact version and time.' };
  if (a.policy_generation !== policy.generation) {
    return { ok: false, code: 'approval_policy_changed', message: 'The approval policy changed after this was approved. Resubmit it for review.' };
  }
  if (a.binding_hash) {
    const b = await computeBinding(db, d.workspace_id, a.revision_id, a.fingerprint, policy.generation);
    if (b.hash !== a.binding_hash) return { ok: false, code: 'approval_stale', message: 'Media, destinations or links changed after approval. Resubmit it for review.' };
  }
  const stages = await evaluateStages(db, a, policy);
  const unmet = stages.find((x) => !x.met);
  if (unmet) {
    return { ok: false, code: 'approver_authority_revoked', message: `"${unmet.name}" no longer has enough eligible approvals (an approver lost access). Ask for a new review.` };
  }
  return { ok: true };
}

// ------------------------------------------------------------------ policy builder
const stageSchemaCheck = (s: PolicyInput['stages'][number], i: number): void => {
  const name = (s.name ?? '').trim();
  if (!name || name.length > 60) throw new AppError('validation_failed', 'Each stage needs a name (1-60 characters)', { [`stages.${i}.name`]: 'Required' });
  if (!Number.isInteger(s.quorum) || s.quorum < 1 || s.quorum > MAX_QUORUM) throw new AppError('validation_failed', `Quorum must be 1-${MAX_QUORUM}`, { [`stages.${i}.quorum`]: `1-${MAX_QUORUM}` });
  if (!Array.isArray(s.eligible_roles) || s.eligible_roles.some((r) => !(STAGE_ROLES as readonly string[]).includes(r))) {
    throw new AppError('validation_failed', 'Unknown reviewer role', { [`stages.${i}.eligible_roles`]: 'Choose owner, admin or approver' });
  }
};

const subset = <T>(a: T[], b: T[]) => a.every((x) => b.includes(x));

/** A change is "weakening" unless it is a pure tightening (or no-op) of every existing requirement. */
export function isWeakening(before: Pick<PolicyDef, 'stages' | 'separation_of_duties'>, after: Pick<PolicyDef, 'stages' | 'separation_of_duties'>): boolean {
  if (before.separation_of_duties && !after.separation_of_duties) return true;
  for (const b of before.stages) {
    const a = after.stages.find((x) => x.position === b.position);
    if (!a) return true;
    if (a.quorum < b.quorum) return true;
    if (!b.allow_guests && a.allow_guests) return true;
    // an empty list means "anyone": going to empty or adding entries broadens who may approve
    if (b.eligible_roles.length && (!a.eligible_roles.length || !subset(a.eligible_roles, b.eligible_roles))) return true;
    if (b.eligible_team_ids.length && (!a.eligible_team_ids.length || !subset(a.eligible_team_ids, b.eligible_team_ids))) return true;
  }
  return false;
}

export async function getApprovalPolicy(ctx: Ctx, brandId: string) {
  const db = getPool();
  const brand = await assertBrand(ctx, brandId, db);
  const policy = await loadPolicy(db, ctx.access.workspaceId, brand.id);
  const teams = await many<{ id: string; name: string }>(db, `SELECT id, name FROM teams WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY name`, [ctx.access.workspaceId]);
  return { ...policy, teams, can_manage: authorizeCtx(ctx, 'brands.manage', { brandId }).allowed };
}

/**
 * Replace a brand's approval policy with a new generation. brands.manage on the brand; weakening (fewer
 * stages, lower quorum, broader eligibility, SoD off) additionally needs fresh authentication (step-up).
 * Every open review request is voided; approved-but-unsent schedules are held at dispatch (generation
 * mismatch) — nothing is ever released automatically.
 */
export async function saveApprovalPolicy(ctx: Ctx, brandId: string, input: PolicyInput & { expected_generation: number; reason?: string }) {
  requireAction(ctx, 'brands.manage', { brandId });
  if (!Array.isArray(input.stages) || input.stages.length > 2) throw new AppError('validation_failed', 'A policy has 0, 1 or 2 stages', { stages: 'At most 2 stages' });
  input.stages.forEach(stageSchemaCheck);
  return withTx(async (tx) => {
    const brand = await assertBrand(ctx, brandId, tx);
    const lock = await maybeOne<{ generation: number }>(tx, `SELECT generation FROM approval_policies WHERE brand_id=$1 AND workspace_id=$2 FOR UPDATE`, [brand.id, ctx.access.workspaceId]);
    if (!lock) throw notFound('Approval policy');
    if (lock.generation !== input.expected_generation) {
      throw new AppError('version_conflict', 'Someone else changed this approval policy. Reload and try again.', undefined, { current: { generation: lock.generation } });
    }
    const before = await loadPolicy(tx, ctx.access.workspaceId, brand.id);
    // Validate teams belong to this workspace.
    const teamIds = [...new Set(input.stages.flatMap((s) => s.eligible_team_ids ?? []))];
    if (teamIds.length) {
      const ok = await many<{ id: string }>(tx, `SELECT id FROM teams WHERE workspace_id=$1 AND id = ANY($2::uuid[]) AND archived_at IS NULL`, [ctx.access.workspaceId, teamIds]);
      if (ok.length !== teamIds.length) throw new AppError('validation_failed', 'Unknown team', { stages: 'Choose teams from this workspace' });
    }
    const after: Pick<PolicyDef, 'stages' | 'separation_of_duties'> = {
      separation_of_duties: !!input.separation_of_duties,
      stages: input.stages.map((s, i) => ({ position: (i + 1) as 1 | 2, name: s.name.trim(), quorum: s.quorum, eligible_roles: [...new Set(s.eligible_roles)].sort(),
        eligible_team_ids: [...new Set(s.eligible_team_ids ?? [])].sort(), allow_guests: !!s.allow_guests })),
    };
    const weakening = isWeakening(before, after);
    if (weakening) requireAction(ctx, 'brands.manage', { brandId, stepUp: true });
    const gen = lock.generation + 1;
    await tx.query(`INSERT INTO approval_policy_versions(workspace_id, brand_id, generation, separation_of_duties, stage_count, created_by, reason)
                    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [ctx.access.workspaceId, brand.id, gen, after.separation_of_duties, after.stages.length, ctx.actor.userId, input.reason?.slice(0, 500) ?? null]);
    for (const s of after.stages) {
      await tx.query(`INSERT INTO approval_stages(workspace_id, brand_id, generation, position, name, quorum, eligible_roles, eligible_team_ids, allow_guests)
                      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [ctx.access.workspaceId, brand.id, gen, s.position, s.name, s.quorum, s.eligible_roles, s.eligible_team_ids, s.allow_guests]);
    }
    await tx.query(`UPDATE approval_policies SET generation=$2, updated_by=$3, updated_at=now() WHERE brand_id=$1`, [brand.id, gen, ctx.actor.userId]);
    await tx.query(`SELECT set_config('social_lite.approval_policy_write', 'on', true)`);
    await tx.query(`UPDATE brands SET approval_required=$2 WHERE id=$1`, [brand.id, after.stages.length > 0]);
    // Void open requests: they were bound to the previous generation. Approved schedules are NOT touched here:
    // the dispatch gate holds them (generation mismatch) until someone explicitly resubmits — never auto-released.
    const open = await many<ReviewRequestRow>(tx, `SELECT * FROM approvals WHERE brand_id=$1 AND workspace_id=$2 AND decision='pending'`, [brand.id, ctx.access.workspaceId]);
    for (const a of open) await invalidateRequest(tx, ctx, a, 'The approval policy changed', 'policy_changed');
    const held = await one<{ n: number }>(tx,
      `SELECT count(DISTINCT s.id)::int n FROM schedules s JOIN approvals a ON a.schedule_id=s.id AND a.decision='approved'
        WHERE s.brand_id=$1 AND s.status='active'`, [brand.id]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: brand.id, actorUserId: ctx.actor.userId,
      action: weakening ? 'approval_policy.weakened' : 'approval_policy.updated', resourceType: 'approval_policy', resourceId: brand.id,
      diff: { generation: { from: lock.generation, to: gen }, before: { sod: before.separation_of_duties, stages: before.stages }, after,
        voided_requests: open.length, held_schedules: held.n, step_up: weakening }, correlationId: ctx.correlationId });
    return { policy: await loadPolicy(tx, ctx.access.workspaceId, brand.id), weakening, voided_requests: open.length, held_schedules: held.n };
  });
}

/**
 * Compatibility for the V1 "Require approval" brand switch: true => one default stage (strengthening);
 * false => no stages (weakening: step-up). Runs inside the caller's transaction.
 */
export async function setApprovalRequiredCompat(tx: Queryable, ctx: Ctx, brandId: string, required: boolean): Promise<void> {
  const before = await loadPolicy(tx, ctx.access.workspaceId, brandId);
  if ((before.stages.length > 0) === required) return;
  const stages = required ? [{ name: 'Review', quorum: 1, eligible_roles: [] as StageRole[], eligible_team_ids: [] as string[], allow_guests: false }] : [];
  // reuse the full path (validation, step-up for weakening, audit, voiding) in a nested savepoint-free way
  if (!required) requireAction(ctx, 'brands.manage', { brandId, stepUp: true });
  const gen = before.generation + 1;
  await tx.query(`INSERT INTO approval_policy_versions(workspace_id, brand_id, generation, separation_of_duties, stage_count, created_by, reason) VALUES ($1,$2,$3,$4,$5,$6,'brand_setting')`,
    [ctx.access.workspaceId, brandId, gen, required ? before.separation_of_duties : false, stages.length, ctx.actor.userId]);
  for (const [i, s] of stages.entries()) {
    await tx.query(`INSERT INTO approval_stages(workspace_id, brand_id, generation, position, name, quorum) VALUES ($1,$2,$3,$4,$5,$6)`, [ctx.access.workspaceId, brandId, gen, i + 1, s.name, s.quorum]);
  }
  await tx.query(`UPDATE approval_policies SET generation=$2, updated_by=$3, updated_at=now() WHERE brand_id=$1`, [brandId, gen, ctx.actor.userId]);
  await tx.query(`SELECT set_config('social_lite.approval_policy_write', 'on', true)`);
  const open = await many<ReviewRequestRow>(tx, `SELECT * FROM approvals WHERE brand_id=$1 AND workspace_id=$2 AND decision='pending'`, [brandId, ctx.access.workspaceId]);
  for (const a of open) await invalidateRequest(tx, ctx, a, 'The approval policy changed', 'policy_changed');
  await audit(tx, { workspaceId: ctx.access.workspaceId, brandId, actorUserId: ctx.actor.userId, action: required ? 'approval_policy.updated' : 'approval_policy.weakened',
    resourceType: 'approval_policy', resourceId: brandId, diff: { generation: { from: before.generation, to: gen }, stages: stages.length, via: 'brand_setting', voided_requests: open.length }, correlationId: ctx.correlationId });
}

// ------------------------------------------------------------------ read model for detail/inbox
export interface ReviewStateDto {
  policy_generation: number | null; current_policy_generation: number; separation_of_duties: boolean;
  current_stage: number; stage_count: number;
  stages: Array<{ position: number; name: string; quorum: number; approvals: number; met: boolean; allow_guests: boolean }>;
  decisions: Array<{ stage: number; decision: string; by: string | null; as_guest: boolean; at: string; reason: string | null; counted: boolean }>;
  me: { eligible: boolean; reason: IneligibleReason | 'decided' | 'not_pending' | 'stale' | null; stage: number | null };
  binding: BindingSummary | null;
  assignee: { id: string; email: string } | null; due_at: string | null;
}

export async function reviewState(db: Queryable, ctx: Ctx, a: ReviewRequestRow & { binding?: BindingSummary | null }, opts: { guestView?: boolean } = {}): Promise<ReviewStateDto> {
  const current = await loadPolicy(db, a.workspace_id, a.brand_id);
  const policy = a.policy_generation ? await loadPolicy(db, a.workspace_id, a.brand_id, a.policy_generation) : current;
  const progress = await evaluateStages(db, a, policy);
  const rows = await many<{ stage: number; decision: string; user_id: string; email: string; as_guest: boolean; created_at: Date; reason: string | null }>(db,
    `SELECT d.stage, d.decision, d.user_id, u.email, d.as_guest, d.created_at, d.reason FROM approval_decisions d JOIN users u ON u.id=d.user_id
      WHERE d.approval_id=$1 ORDER BY d.created_at`, [a.id]);
  const firstUnmet = progress.find((s) => !s.met);
  let me: ReviewStateDto['me'] = { eligible: false, reason: null, stage: firstUnmet?.position ?? null };
  if (a.decision !== 'pending') me = { eligible: false, reason: 'not_pending', stage: null };
  else if (a.policy_generation !== current.generation) me = { eligible: false, reason: 'stale', stage: null };
  else if (firstUnmet) {
    const stage = policy.stages.find((s) => s.position === firstUnmet.position)!;
    const facts = await reviewerFacts(db, a.workspace_id, ctx.actor.userId, a.post_id);
    const e = stageEligibility(facts, stage, a.brand_id, ctx.actor.userId, { enabled: policy.separation_of_duties, authorIds: a.author_ids });
    const already = rows.some((r) => r.user_id === ctx.actor.userId && (r.stage === stage.position || r.decision === 'approved'));
    me = { eligible: e.eligible && !already, reason: already ? 'decided' : e.reason, stage: stage.position };
  }
  const assignee = a.assignee_user_id ? await maybeOne<{ id: string; email: string }>(db, `SELECT id, email FROM users WHERE id=$1`, [a.assignee_user_id]) : null;
  const counted = new Set(progress.flatMap((p) => p.approver_ids.map((u) => `${p.position}:${u}`)));
  return {
    policy_generation: a.policy_generation, current_policy_generation: current.generation, separation_of_duties: policy.separation_of_duties,
    current_stage: firstUnmet?.position ?? a.stage_count, stage_count: policy.stages.length,
    stages: progress.map((p) => ({ position: p.position, name: p.name, quorum: p.quorum, approvals: p.approvals, met: p.met, allow_guests: p.allow_guests })),
    // Guests see stage progress and their own decisions only — never internal reviewer identities.
    decisions: rows.filter((r) => !opts.guestView || r.user_id === ctx.actor.userId).map((r) => ({
      stage: r.stage, decision: r.decision, by: r.email, as_guest: r.as_guest, at: r.created_at.toISOString(), reason: r.reason,
      counted: r.decision === 'approved' && counted.has(`${r.stage}:${r.user_id}`),
    })),
    me,
    binding: opts.guestView ? null : (a.binding ?? null),
    assignee: opts.guestView ? null : assignee, due_at: a.due_at?.toISOString() ?? null,
  };
}
