// Posting slots and "Add to queue" (V1.1, SC-03).
//
// Queueing picks the brand's next FREE slot occurrence and calls the normal scheduling pipeline
// (schedulePost, or submitForReview when the brand requires approval) with that slot's wall time, zone
// and destination set, so every approval/permission/validation rule still applies.
//
// Concurrency: the queue transaction locks the brand's slot rows (FOR UPDATE NOWAIT + bounded retry, so
// waiting requests never hold pool connections), reads occupancy, schedules, then inserts the reservation.
// The partial unique index slot_reservations(slot_id, occurrence_at) WHERE released_at IS NULL is the
// backstop: two users can never hold the same occurrence.
//
// An occurrence is occupied when it has a live reservation whose schedule is still live
// (active / pending_approval / completed) OR when any live schedule of the brand is due at that exact instant.
import { AppError, canSchedule, can, isValidTimeZone, notFound } from '@social-lite/core';
import { getPool, many, maybeOne, one, type PoolClient, type Queryable } from '@social-lite/db';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { assertBrand, assertUuid, brandAllowed, requireAction } from '../tenancy.js';
import { beginIdempotent, completeIdempotent } from '../idempotency.js';
import { loadPost } from '../posts/service.js';
import { schedulePost, submitForReview } from '../posts/scheduling.js';
import { occurrencesAfter, type Occurrence } from './recurrence.js';

export * from './recurrence.js';

/** How far ahead queueing looks for a free occurrence. */
export const QUEUE_HORIZON_DAYS = 56;
/** Minimum lead time between "now" and the chosen occurrence. */
export const QUEUE_MIN_LEAD_MS = 2 * 60_000;

const LIVE_SCHEDULE = `('active','pending_approval','completed')`;

export interface SlotRow {
  id: string; workspace_id: string; brand_id: string; label: string | null; weekdays: number[]; local_time: string; timezone: string;
  connection_ids: string[]; active: boolean; created_at: Date; updated_at: Date; archived_at: Date | null;
}

export const slotInputSchema = z.object({
  label: z.string().trim().max(80).nullable().optional(),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  local_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)'),
  timezone: z.string().min(1).max(64).optional(),
  connection_ids: z.array(z.string().uuid()).min(1).max(50),
  active: z.boolean().optional(),
});
export const slotPatchSchema = slotInputSchema.partial();
export const queueRequestSchema = z.object({
  post_id: z.string().uuid(),
  expected_version: z.number().int().positive(),
  slot_id: z.string().uuid().optional(),
});

function slotJson(s: SlotRow) {
  return {
    id: s.id, brand_id: s.brand_id, label: s.label, weekdays: [...s.weekdays].map(Number).sort(), local_time: s.local_time, timezone: s.timezone,
    connection_ids: s.connection_ids, active: s.active, created_at: s.created_at.toISOString(), updated_at: s.updated_at.toISOString(),
  };
}

function occurrenceJson(o: Occurrence) {
  return o.kind === 'ok'
    ? { kind: 'ok' as const, local: o.local, at: o.instant.toISOString(), offset: o.offset, fold: o.fold }
    : { kind: 'gap' as const, local: o.local, at: null, offset: null, fold: false, message: o.message };
}

async function loadSlot(ctx: Ctx, slotId: string, db: Queryable = getPool()): Promise<SlotRow> {
  assertUuid(slotId, 'Slot');
  const s = await maybeOne<SlotRow>(db, `SELECT * FROM posting_slots WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL`, [slotId, ctx.access.workspaceId]);
  if (!s || !brandAllowed(ctx, s.brand_id)) throw notFound('Slot');
  return s;
}

async function assertDestinations(db: Queryable, ctx: Ctx, brandId: string, ids: string[]): Promise<string[]> {
  const uniq = [...new Set(ids)];
  const ok = await many<{ id: string }>(db,
    `SELECT id FROM connections WHERE workspace_id=$1 AND brand_id=$2 AND id = ANY($3::uuid[]) AND disconnected_at IS NULL`,
    [ctx.access.workspaceId, brandId, uniq]);
  if (ok.length !== uniq.length) throw new AppError('validation_failed', 'Choose destinations connected to this brand', { connection_ids: 'One or more destinations are not connected to this brand' });
  return uniq;
}

/** Live occupancy (instant ms) of the given slots from `from` onwards. */
async function occupancy(db: Queryable, workspaceId: string, brandId: string, slotIds: string[], from: Date) {
  const res = await many<{ slot_id: string; occurrence_at: Date; post_id: string; title: string | null; schedule_status: string | null }>(db,
    `SELECT r.slot_id, r.occurrence_at, r.post_id, p.title, s.status AS schedule_status
       FROM slot_reservations r JOIN posts p ON p.id=r.post_id LEFT JOIN schedules s ON s.id=r.schedule_id
      WHERE r.workspace_id=$1 AND r.slot_id = ANY($2::uuid[]) AND r.released_at IS NULL AND r.occurrence_at >= $3
        AND s.status IN ${LIVE_SCHEDULE}`, [workspaceId, slotIds, from]);
  const sched = await many<{ due_at: Date; post_id: string; title: string | null; status: string }>(db,
    `SELECT s.due_at, s.post_id, p.title, s.status FROM schedules s JOIN posts p ON p.id=s.post_id
      WHERE s.workspace_id=$1 AND s.brand_id=$2 AND s.status IN ('active','pending_approval') AND NOT s.is_immediate AND s.due_at >= $3`,
    [workspaceId, brandId, from]);
  return { reservations: res, schedules: sched };
}

// ------------------------------------------------------------------ slot CRUD
export async function listSlots(ctx: Ctx, brandId: string, opts: { preview?: number } = {}) {
  const db = getPool();
  await assertBrand(ctx, brandId, db);
  const slots = await many<SlotRow>(db, `SELECT * FROM posting_slots WHERE workspace_id=$1 AND brand_id=$2 AND archived_at IS NULL ORDER BY local_time, created_at`,
    [ctx.access.workspaceId, brandId]);
  const now = new Date();
  const occ = slots.length ? await occupancy(db, ctx.access.workspaceId, brandId, slots.map((s) => s.id), now) : { reservations: [], schedules: [] };
  const n = Math.min(Math.max(opts.preview ?? 5, 1), 20);
  return {
    items: slots.map((s) => {
      const next = occurrencesAfter({ weekdays: s.weekdays.map(Number), localTime: s.local_time, timezone: s.timezone }, now, 28).slice(0, n + 2);
      return {
        ...slotJson(s),
        next: next.slice(0, n).map((o) => {
          const at = o.kind === 'ok' ? o.instant.getTime() : null;
          const r = at !== null ? occ.reservations.find((x) => x.slot_id === s.id && x.occurrence_at.getTime() === at) : undefined;
          const other = at !== null && !r ? occ.schedules.find((x) => x.due_at.getTime() === at) : undefined;
          const holder = r ?? other;
          return { ...occurrenceJson(o), taken_by: holder ? { post_id: holder.post_id, title: holder.title } : null };
        }),
      };
    }),
  };
}

export async function createSlot(ctx: Ctx, brandId: string, raw: unknown) {
  requireAction(ctx, 'brands.manage');
  const input = slotInputSchema.parse(raw);
  const db = getPool();
  const brand = await assertBrand(ctx, brandId, db);
  if (brand.archived_at) throw new AppError('invalid_state', 'This brand is archived');
  const tz = input.timezone ?? brand.timezone;
  if (!isValidTimeZone(tz)) throw new AppError('validation_failed', `Unknown time zone "${tz}"`, { timezone: 'Choose a valid time zone' });
  const conns = await assertDestinations(db, ctx, brandId, input.connection_ids);
  const s = await one<SlotRow>(db,
    `INSERT INTO posting_slots(workspace_id, brand_id, label, weekdays, local_time, timezone, connection_ids, active, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [ctx.access.workspaceId, brandId, input.label || null, [...new Set(input.weekdays)].sort(), input.local_time, tz, conns, input.active ?? true, ctx.actor.userId]);
  await audit(db, { workspaceId: ctx.access.workspaceId, brandId, actorUserId: ctx.actor.userId, action: 'slot.created', resourceType: 'posting_slot', resourceId: s.id,
    diff: { weekdays: s.weekdays, local_time: s.local_time, timezone: s.timezone, destinations: conns.length }, correlationId: ctx.correlationId });
  return slotJson(s);
}

/** Editing a slot never moves posts already queued into it (their schedules keep their UTC instant). */
export async function updateSlot(ctx: Ctx, slotId: string, raw: unknown) {
  requireAction(ctx, 'brands.manage');
  const patch = slotPatchSchema.parse(raw);
  const db = getPool();
  const s = await loadSlot(ctx, slotId, db);
  if (patch.timezone !== undefined && !isValidTimeZone(patch.timezone)) throw new AppError('validation_failed', `Unknown time zone "${patch.timezone}"`, { timezone: 'Choose a valid time zone' });
  const conns = patch.connection_ids ? await assertDestinations(db, ctx, s.brand_id, patch.connection_ids) : null;
  const u = await one<SlotRow>(db,
    `UPDATE posting_slots SET label=CASE WHEN $3 THEN $4 ELSE label END, weekdays=coalesce($5, weekdays), local_time=coalesce($6, local_time),
            timezone=coalesce($7, timezone), connection_ids=coalesce($8, connection_ids), active=coalesce($9, active), updated_at=now()
      WHERE id=$1 AND workspace_id=$2 RETURNING *`,
    [s.id, ctx.access.workspaceId, patch.label !== undefined, patch.label || null, patch.weekdays ? [...new Set(patch.weekdays)].sort() : null,
      patch.local_time ?? null, patch.timezone ?? null, conns, patch.active ?? null]);
  await audit(db, { workspaceId: ctx.access.workspaceId, brandId: s.brand_id, actorUserId: ctx.actor.userId, action: 'slot.updated', resourceType: 'posting_slot', resourceId: s.id,
    diff: { before: { weekdays: s.weekdays, local_time: s.local_time, timezone: s.timezone, active: s.active }, after: { weekdays: u.weekdays, local_time: u.local_time, timezone: u.timezone, active: u.active } },
    correlationId: ctx.correlationId });
  return slotJson(u);
}

export async function deleteSlot(ctx: Ctx, slotId: string) {
  requireAction(ctx, 'brands.manage');
  const db = getPool();
  const s = await loadSlot(ctx, slotId, db);
  await db.query(`UPDATE posting_slots SET archived_at=now(), active=false, updated_at=now() WHERE id=$1`, [s.id]);
  await audit(db, { workspaceId: ctx.access.workspaceId, brandId: s.brand_id, actorUserId: ctx.actor.userId, action: 'slot.deleted', resourceType: 'posting_slot', resourceId: s.id, correlationId: ctx.correlationId });
  return { ok: true };
}

// ------------------------------------------------------------------ queue
interface Pick { slot: SlotRow; occ: Extract<Occurrence, { kind: 'ok' }>; skipped: Array<Extract<Occurrence, { kind: 'gap' }>> }

/** Earliest free occurrence across the candidate slots (pure over the occupancy snapshot). */
export function pickFreeOccurrence(slots: SlotRow[], occ: Awaited<ReturnType<typeof occupancy>>, now: Date, horizonDays = QUEUE_HORIZON_DAYS): Pick | null {
  const after = new Date(now.getTime() + QUEUE_MIN_LEAD_MS);
  const taken = new Set(occ.reservations.map((r) => `${r.slot_id}|${r.occurrence_at.getTime()}`));
  const busy = new Set(occ.schedules.map((s) => s.due_at.getTime()));
  let best: Pick | null = null;
  for (const slot of slots) {
    const all = occurrencesAfter({ weekdays: slot.weekdays.map(Number), localTime: slot.local_time, timezone: slot.timezone }, after, horizonDays);
    const skipped: Pick['skipped'] = [];
    for (const o of all) {
      if (o.kind === 'gap') { skipped.push(o); continue; }
      const t = o.instant.getTime();
      if (taken.has(`${slot.id}|${t}`) || busy.has(t)) continue;
      if (!best || t < best.occ.instant.getTime() || (t === best.occ.instant.getTime() && slot.id < best.slot.id)) best = { slot, occ: o, skipped };
      break;
    }
  }
  if (best) best.skipped = best.skipped.filter((g) => g.local < best!.occ.local);
  return best;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run fn in a transaction holding FOR UPDATE locks on the brand's slots; waits without holding a connection. */
async function withSlotLock<T>(ctx: Ctx, brandId: string, slotId: string | undefined, fn: (tx: PoolClient, slots: SlotRow[]) => Promise<T>): Promise<T> {
  const pool = getPool();
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    let retry = false;
    try {
      await client.query('BEGIN');
      try {
        const slots = (await client.query<SlotRow>(
          `SELECT * FROM posting_slots WHERE workspace_id=$1 AND brand_id=$2 AND archived_at IS NULL AND active ${slotId ? 'AND id=$3' : ''}
            ORDER BY id FOR UPDATE NOWAIT`, slotId ? [ctx.access.workspaceId, brandId, slotId] : [ctx.access.workspaceId, brandId])).rows;
        const out = await fn(client, slots);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        if ((err as { code?: string }).code === '55P03' && attempt < 400) retry = true;
        else throw err;
      }
    } finally {
      client.release();
    }
    if (retry) await sleep(20 + Math.floor(Math.random() * 40));
  }
}

/**
 * "Add to queue": schedule the post into the brand's next free slot occurrence (or a specific slot).
 * Approval-required brands: submits for review at that time instead. Returns the normal schedule response
 * plus the chosen slot occurrence and any DST-gap occurrences that were skipped.
 */
export async function queuePost(ctx: Ctx, raw: unknown, idemKey: string | null, opts: { now?: Date } = {}) {
  const req = queueRequestSchema.parse(raw);
  const post = await loadPost(ctx, req.post_id);
  const brand = await assertBrand(ctx, post.brand_id);
  if (brand.approval_required) requireAction(ctx, 'drafts.edit');
  else {
    const sc = canSchedule({ role: ctx.access.role, editorsCanPublish: brand.editors_can_publish, approvalRequired: false, contentApproved: false });
    if (!sc.allowed) throw new AppError('forbidden', sc.reason ?? 'You cannot schedule posts');
  }
  if (req.slot_id) await loadSlot(ctx, req.slot_id);
  if (!idemKey || idemKey.length < 8 || idemKey.length > 190) throw new AppError('validation_failed', 'An Idempotency-Key header (8-190 characters) is required for this request');

  let result: { status: number; body: unknown };
  try {
    result = await withSlotLock(ctx, post.brand_id, req.slot_id, async (tx, slots) => {
      const idem = await beginIdempotent(tx, { workspaceId: ctx.access.workspaceId, userId: ctx.actor.userId, action: 'post.queue', key: idemKey, body: req });
      if (idem) return idem;
      if (!slots.length) throw new AppError('invalid_state', req.slot_id ? 'That slot is paused.' : 'This brand has no active posting slots. Add one first.', undefined, { reason: 'no_slots' });
      // opts.now only moves the search window (tests); the scheduler still rejects times in the past.
      const now = opts.now && opts.now.getTime() > Date.now() ? opts.now : new Date();
      // Lazily release reservations whose schedule is no longer live (cancelled / superseded / rejected / deleted).
      await tx.query(
        `UPDATE slot_reservations r SET released_at=now()
          WHERE r.workspace_id=$1 AND r.slot_id = ANY($2::uuid[]) AND r.released_at IS NULL
            AND (r.schedule_id IS NULL OR NOT EXISTS (SELECT 1 FROM schedules s WHERE s.id=r.schedule_id AND s.status IN ${LIVE_SCHEDULE}))`,
        [ctx.access.workspaceId, slots.map((s) => s.id)]);
      const occ = await occupancy(tx, ctx.access.workspaceId, post.brand_id, slots.map((s) => s.id), now);
      const pick = pickFreeOccurrence(slots, occ, now);
      if (!pick) throw new AppError('conflict', `Every slot is taken for the next ${QUEUE_HORIZON_DAYS / 7} weeks. Add a slot or pick a time.`, undefined, { reason: 'queue_full' });
      const scheduleReq = { expected_version: req.expected_version, connection_ids: pick.slot.connection_ids, input_local_time: pick.occ.local, timezone: pick.slot.timezone, offset: pick.occ.offset };
      // The schedule runs in its own transaction (separate connection). It never touches posting_slots or
      // slot_reservations, so holding our slot locks meanwhile cannot deadlock.
      const fn = brand.approval_required ? submitForReview : schedulePost;
      const r = await fn(ctx, post.id, scheduleReq, `queue:${idemKey}`);
      const schedule = (r.body as { schedule: { id: string } }).schedule;
      await tx.query(
        `INSERT INTO slot_reservations(workspace_id, brand_id, slot_id, occurrence_at, local_time, utc_offset, post_id, schedule_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [ctx.access.workspaceId, post.brand_id, pick.slot.id, pick.occ.instant, pick.occ.local, pick.occ.offset, post.id, schedule.id, ctx.actor.userId]);
      await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: post.brand_id, actorUserId: ctx.actor.userId, action: 'post.queued', resourceType: 'post', resourceId: post.id,
        diff: { slot_id: pick.slot.id, local: pick.occ.local, timezone: pick.slot.timezone, offset: pick.occ.offset, fold: pick.occ.fold, skipped_gaps: pick.skipped.map((g) => g.local), submitted: brand.approval_required },
        correlationId: ctx.correlationId });
      const body = {
        ...(r.body as Record<string, unknown>),
        queue: {
          slot: slotJson(pick.slot), occurrence: occurrenceJson(pick.occ),
          skipped: pick.skipped.map(occurrenceJson), mode: brand.approval_required ? 'submitted_for_review' : 'scheduled',
        },
      };
      await completeIdempotent(tx, { workspaceId: ctx.access.workspaceId, action: 'post.queue', key: idemKey, status: r.status, body });
      return { status: r.status, body };
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new AppError('conflict', 'That slot was just taken. Try again.');
    throw err;
  }
  return result;
}

/** Upcoming queue for a brand: each slot occurrence in the next `days`, free or taken, plus DST gaps. */
export async function queueView(ctx: Ctx, brandId: string, days = 14) {
  const db = getPool();
  await assertBrand(ctx, brandId, db);
  const slots = await many<SlotRow>(db, `SELECT * FROM posting_slots WHERE workspace_id=$1 AND brand_id=$2 AND archived_at IS NULL AND active`, [ctx.access.workspaceId, brandId]);
  const now = new Date();
  const occ = slots.length ? await occupancy(db, ctx.access.workspaceId, brandId, slots.map((s) => s.id), now) : { reservations: [], schedules: [] };
  const span = Math.min(Math.max(days, 1), 56);
  const items = slots.flatMap((s) => occurrencesAfter({ weekdays: s.weekdays.map(Number), localTime: s.local_time, timezone: s.timezone }, now, span).map((o) => {
    const at = o.kind === 'ok' ? o.instant.getTime() : null;
    const r = at !== null ? occ.reservations.find((x) => x.slot_id === s.id && x.occurrence_at.getTime() === at) : undefined;
    const other = at !== null && !r ? occ.schedules.find((x) => x.due_at.getTime() === at) : undefined;
    const holder = r ?? other;
    return { slot_id: s.id, slot_label: s.label, timezone: s.timezone, connection_ids: s.connection_ids, ...occurrenceJson(o),
      taken_by: holder ? { post_id: holder.post_id, title: holder.title, status: r ? r.schedule_status : (other as { status: string }).status } : null };
  }));
  items.sort((a, b) => (a.at ?? `${a.local}:00.000Z`).localeCompare(b.at ?? `${b.local}:00.000Z`));
  return { items, can_queue: can(ctx.access.role, 'drafts.edit') };
}
