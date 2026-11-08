// Listening access helpers (stream D). Reads need listening.read on the brand; definitions, alert rules, corrections,
// exclusions and source settings need listening.manage (owner/admin presets). Private messages are never observed, so
// listening never exposes inbox DMs; opening the linked conversation still needs inbox.read (checked by the inbox).
// Platform operators get nothing implicitly (no workspace grant ⇒ no listening access).
import { AppError, notFound, type Permission } from '@social-lite/core';
import { getPool, many, maybeOne, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { assertUuid, authorizeCtx, brandAllowed, requireAction } from '../tenancy.js';

export const LISTENING_READ: Permission = 'listening.read';
export const LISTENING_MANAGE: Permission = 'listening.manage';

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function canListen(ctx: Ctx, brandId: string, perm: Permission = LISTENING_READ): boolean {
  return brandAllowed(ctx, brandId) && authorizeCtx(ctx, perm, { brandId }).allowed;
}

/** Brands on which the caller holds `perm` (optionally narrowed to one requested brand). */
export async function listeningBrands(ctx: Ctx, brandId?: string | null, perm: Permission = LISTENING_READ, db: Queryable = getPool()): Promise<string[]> {
  requireAction(ctx, perm);
  if (brandId) {
    assertUuid(brandId, 'Brand');
    const b = await maybeOne<{ id: string }>(db, `SELECT id FROM brands WHERE id=$1 AND workspace_id=$2`, [brandId, ctx.access.workspaceId]);
    if (!b || !canListen(ctx, b.id, perm)) throw notFound('Brand');
    return [b.id];
  }
  const rows = await many<{ id: string }>(db, `SELECT id FROM brands WHERE workspace_id=$1 AND archived_at IS NULL`, [ctx.access.workspaceId]);
  return rows.map((r) => r.id).filter((b) => canListen(ctx, b, perm));
}

export function requireBrand(ctx: Ctx, brandId: string, perm: Permission = LISTENING_READ): void {
  if (!brandAllowed(ctx, brandId) || !authorizeCtx(ctx, LISTENING_READ, { brandId }).allowed) throw notFound('Brand');
  if (perm !== LISTENING_READ) requireAction(ctx, perm, { brandId });
}

export interface SearchRow {
  id: string; workspace_id: string; brand_id: string; name: string; role: 'own' | 'competitor' | 'topic'; terms: string[]; keywords: string[]; exclusions: string[];
  boolean_query: string | null; languages: string[]; sources: string[]; kinds: Array<'comment' | 'mention' | 'review'>; version: number; matched_version: number;
  rematch_state: 'idle' | 'pending' | 'running'; created_by: string | null; created_at: Date; updated_at: Date; archived_at: Date | null;
}

export async function loadSearch(ctx: Ctx, id: string, perm: Permission = LISTENING_READ, db: Queryable = getPool(), forUpdate = false): Promise<SearchRow> {
  assertUuid(id, 'Saved search');
  const s = await maybeOne<SearchRow>(db, `SELECT * FROM listening_searches WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL${forUpdate ? ' FOR UPDATE' : ''}`, [id, ctx.access.workspaceId]);
  if (!s || !canListen(ctx, s.brand_id)) throw notFound('Saved search');
  if (perm !== LISTENING_READ) requireAction(ctx, perm, { brandId: s.brand_id });
  return s;
}

export interface ObservationRow {
  id: string; workspace_id: string; brand_id: string; layer: 'connected' | 'broad'; source_key: string; channel_id: string | null; inbox_message_id: string | null;
  conversation_id: string | null; conversation_kind: 'comment' | 'mention' | 'review'; external_id: string | null; body: string | null; language: string | null;
  fingerprint: string | null; duplicate_of: string | null; terms: string[]; sentiment_label: string; sentiment_score: number | null; sentiment_confidence: number;
  sentiment_method: string; sentiment_evidence: string[]; corrected_label: string | null; corrected_by: string | null; corrected_at: Date | null;
  excluded_at: Date | null; excluded_by: string | null; excluded_reason: string | null; source_revision: number; needs_reprocess: boolean;
  occurred_at: Date; observed_at: Date; removed_at: Date | null; is_simulated: boolean;
}

export async function loadObservation(ctx: Ctx, id: string, perm: Permission = LISTENING_READ, db: Queryable = getPool(), forUpdate = false): Promise<ObservationRow> {
  assertUuid(id, 'Mention');
  const o = await maybeOne<ObservationRow>(db, `SELECT * FROM listening_observations WHERE id=$1 AND workspace_id=$2${forUpdate ? ' FOR UPDATE' : ''}`, [id, ctx.access.workspaceId]);
  if (!o || !canListen(ctx, o.brand_id)) throw notFound('Mention');
  if (perm !== LISTENING_READ) requireAction(ctx, perm, { brandId: o.brand_id });
  return o;
}

/** "live" unless the request asks for simulated data. Simulated and live data are never mixed in one result. */
export function datasetOf(v: unknown): 'live' | 'simulated' | null {
  if (v === 'simulated' || v === 'live') return v;
  if (v === undefined || v === null || v === '') return null;
  throw new AppError('validation_failed', 'Unknown dataset', { dataset: 'Use live or simulated' });
}

export function clampDays(v: unknown, def = 30, max = 365): number {
  const n = Number(v ?? def);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(max, Math.floor(n));
}

/** Window [from, to) ending now (or at `to`). */
export function windowOf(q: { days?: unknown; from?: unknown; to?: unknown }): { from: Date; to: Date; days: number } {
  const to = typeof q.to === 'string' && !Number.isNaN(Date.parse(q.to)) ? new Date(q.to) : new Date();
  if (typeof q.from === 'string' && !Number.isNaN(Date.parse(q.from))) {
    const from = new Date(q.from);
    if (from >= to) throw new AppError('validation_failed', 'The window must start before it ends', { from: 'Before “to”' });
    if (to.getTime() - from.getTime() > 366 * 86_400_000) throw new AppError('validation_failed', 'Choose at most a year', { from: 'Max 366 days' });
    return { from, to, days: Math.ceil((to.getTime() - from.getTime()) / 86_400_000) };
  }
  const days = clampDays(q.days);
  return { from: new Date(to.getTime() - days * 86_400_000), to, days };
}
