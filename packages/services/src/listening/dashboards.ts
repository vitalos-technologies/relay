// Saved listening dashboards (brief §15): a named, ordered set of widgets over saved searches of ONE brand. Widgets are
// rendered from the same read endpoints (each with its own coverage statement). Shared dashboards are visible to everyone
// with listening.read on the brand; personal ones only to their creator. Creating/editing needs listening.read (own
// dashboards) — a dashboard never widens access: every widget re-checks the searches it shows.
import { AppError, notFound } from '@social-lite/core';
import { WIDGET_TYPES, type DashboardDto } from '@social-lite/core/contracts/v35-listening';
import { getPool, many, maybeOne, one, withTx } from '@social-lite/db';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { assertUuid } from '../tenancy.js';
import { canListen, listeningBrands, requireBrand, LISTENING_MANAGE } from './shared.js';

const widget = z.object({ type: z.enum(WIDGET_TYPES), search_ids: z.array(z.string().uuid()).min(1).max(8), days: z.number().int().min(1).max(365).default(30), title: z.string().trim().max(80).nullable().optional() }).strict();
export const dashboardSchema = z.object({ brand_id: z.string().uuid(), name: z.string().trim().min(1).max(80), widgets: z.array(widget).max(12).default([]), shared: z.boolean().default(true) }).strict();
export const updateDashboardSchema = dashboardSchema.omit({ brand_id: true }).partial().strict();

interface Row { id: string; workspace_id: string; brand_id: string; name: string; widgets: DashboardDto['widgets']; shared: boolean; created_by: string | null; updated_at: Date }

const dto = (ctx: Ctx, r: Row): DashboardDto => ({ id: r.id, brand_id: r.brand_id, name: r.name, widgets: r.widgets, shared: r.shared, created_by: r.created_by, updated_at: r.updated_at.toISOString(),
  can_manage: r.created_by === ctx.actor.userId || canListen(ctx, r.brand_id, LISTENING_MANAGE) });

async function assertWidgetSearches(ctx: Ctx, brandId: string, widgets: z.infer<typeof widget>[]): Promise<void> {
  const ids = [...new Set(widgets.flatMap((w) => w.search_ids))];
  if (!ids.length) return;
  const ok = await many<{ id: string }>(getPool(), `SELECT id FROM listening_searches WHERE id = ANY($1::uuid[]) AND workspace_id=$2 AND brand_id=$3 AND archived_at IS NULL`, [ids, ctx.access.workspaceId, brandId]);
  if (ok.length !== ids.length) throw new AppError('validation_failed', 'Widgets can only use this brand’s saved searches', { widgets: 'Unknown search' });
  for (const w of widgets) if (w.type === 'share_of_voice' && w.search_ids.length < 2) throw new AppError('validation_failed', 'Share of voice compares at least two searches', { widgets: 'Two or more searches' });
}

export async function listDashboards(ctx: Ctx, q: { brand_id?: string | null } = {}): Promise<{ items: DashboardDto[] }> {
  const brands = await listeningBrands(ctx, q.brand_id);
  const rows = await many<Row>(getPool(), `SELECT * FROM listening_dashboards WHERE workspace_id=$1 AND brand_id = ANY($2::uuid[]) AND archived_at IS NULL AND (shared OR created_by=$3) ORDER BY name`,
    [ctx.access.workspaceId, brands, ctx.actor.userId]);
  return { items: rows.map((r) => dto(ctx, r)) };
}

async function load(ctx: Ctx, id: string, manage = false): Promise<Row> {
  assertUuid(id, 'Dashboard');
  const r = await maybeOne<Row>(getPool(), `SELECT * FROM listening_dashboards WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL`, [id, ctx.access.workspaceId]);
  if (!r || !canListen(ctx, r.brand_id) || (!r.shared && r.created_by !== ctx.actor.userId)) throw notFound('Dashboard');
  if (manage && !dto(ctx, r).can_manage) throw new AppError('forbidden', 'Only its creator or a listening manager can change this dashboard');
  return r;
}

export async function getDashboard(ctx: Ctx, id: string): Promise<DashboardDto> { return dto(ctx, await load(ctx, id)); }

export async function createDashboard(ctx: Ctx, input: z.infer<typeof dashboardSchema>): Promise<DashboardDto> {
  requireBrand(ctx, input.brand_id);
  await assertWidgetSearches(ctx, input.brand_id, input.widgets);
  const r = await withTx(async (tx) => {
    const row = await one<Row>(tx, `INSERT INTO listening_dashboards(workspace_id, brand_id, name, widgets, shared, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [ctx.access.workspaceId, input.brand_id, input.name, JSON.stringify(input.widgets), input.shared, ctx.actor.userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: input.brand_id, actorUserId: ctx.actor.userId, action: 'listening.dashboard_created', resourceType: 'listening_dashboard', resourceId: row.id, correlationId: ctx.correlationId });
    return row;
  });
  return dto(ctx, r);
}

export async function updateDashboard(ctx: Ctx, id: string, input: z.infer<typeof updateDashboardSchema>): Promise<DashboardDto> {
  const cur = await load(ctx, id, true);
  if (input.widgets) await assertWidgetSearches(ctx, cur.brand_id, input.widgets);
  const r = await one<Row>(getPool(), `UPDATE listening_dashboards SET name=$2, widgets=$3, shared=$4, updated_at=now() WHERE id=$1 RETURNING *`,
    [id, input.name ?? cur.name, JSON.stringify(input.widgets ?? cur.widgets), input.shared ?? cur.shared]);
  return dto(ctx, r);
}

export async function archiveDashboard(ctx: Ctx, id: string): Promise<{ ok: true }> {
  const cur = await load(ctx, id, true);
  await getPool().query(`UPDATE listening_dashboards SET archived_at=now() WHERE id=$1`, [id]);
  await audit(getPool(), { workspaceId: ctx.access.workspaceId, brandId: cur.brand_id, actorUserId: ctx.actor.userId, action: 'listening.dashboard_archived', resourceType: 'listening_dashboard', resourceId: id, correlationId: ctx.correlationId });
  return { ok: true };
}
