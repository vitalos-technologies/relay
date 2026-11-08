// Settings → Developer → MCP (web app, session-authenticated): connected clients, consent, revocation, audit and
// automation policies. These are NEVER reachable from /mcp (an MCP client cannot consent, revoke, confirm or create
// policies for itself).
//  - Members see and manage their own clients; holders of service_accounts.manage see and revoke every client of the
//    workspace; holders of audit.read see the whole workspace MCP audit trail.
//  - Consent and automation policies need step-up (fresh authentication + MFA per the V2 policy).
//  - Revoking a client also revokes its automation policies, invalidates its open publication intents and cancels its
//    queued jobs; the next request from that client is rejected.
import { z } from 'zod';
import { AppError, notFound } from '@social-lite/core';
import { MCP_SCOPES, isMcpScope, type McpAuditView, type McpClientView, type McpOverview, type McpPolicyGrantView, type McpScope } from '@social-lite/core/contracts/mcp';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { assertBrand, authorizeCtx, requireAction } from '../tenancy.js';
import { listBrands } from '../brands.js';
import type { ClientRow } from './auth.js';
import { mcpSetupInfo } from './setup.js';

const may = (ctx: Ctx, perm: Parameters<typeof authorizeCtx>[1]) => {
  const r = authorizeCtx(ctx, perm);
  return r.allowed || r.reason === 'mfa_required';
};
const canManage = (ctx: Ctx) => may(ctx, 'service_accounts.manage');
const scopesOf = (a: string[]) => a.filter(isMcpScope) as McpScope[];

async function clientViews(db: Queryable, ctx: Ctx, rows: Array<ClientRow & { email: string; owner_name: string | null }>): Promise<McpClientView[]> {
  const brandIds = [...new Set(rows.flatMap((r) => r.brand_ids ?? []))];
  const brands = brandIds.length ? await many<{ id: string; name: string }>(db, `SELECT id, name FROM brands WHERE workspace_id=$1 AND id = ANY($2::uuid[])`, [ctx.access.workspaceId, brandIds]) : [];
  return rows.map((r) => ({
    id: r.id, kind: r.kind, client_id: r.client_id, name: r.name,
    owner: { user_id: r.owner_user_id, email: r.email, name: r.owner_name },
    status: r.status, requested_scopes: scopesOf(r.requested_scopes), granted_scopes: scopesOf(r.granted_scopes),
    brands: r.brand_ids ? r.brand_ids.map((id) => ({ id, name: brands.find((b) => b.id === id)?.name ?? 'Removed brand' })) : null,
    created_at: r.created_at.toISOString(), consented_at: r.consented_at?.toISOString() ?? null, last_activity_at: r.last_activity_at?.toISOString() ?? null,
    last_tool: r.last_tool, revoked_at: r.revoked_at?.toISOString() ?? null,
    is_mine: r.owner_user_id === ctx.actor.userId,
    can_revoke: r.status !== 'revoked' && (r.owner_user_id === ctx.actor.userId || canManage(ctx)),
  }));
}

export async function mcpOverview(ctx: Ctx): Promise<McpOverview> {
  const db = getPool();
  const all = canManage(ctx);
  // This workspace's registrations (own, or all for managers) + the caller's pending registrations (no workspace yet).
  const rows = await many<ClientRow & { email: string; owner_name: string | null }>(db,
    `SELECT c.*, u.email, u.name AS owner_name FROM mcp_clients c JOIN users u ON u.id=c.owner_user_id
      WHERE (c.workspace_id=$1 AND ($3 OR c.owner_user_id=$2)) OR (c.status='pending' AND c.owner_user_id=$2)
      ORDER BY (c.status='pending') DESC, (c.status='revoked'), c.last_activity_at DESC NULLS LAST, c.created_at DESC LIMIT 200`,
    [ctx.access.workspaceId, ctx.actor.userId, all]);
  return { setup: mcpSetupInfo(), clients: await clientViews(db, ctx, rows), can_manage: all };
}

async function loadRow(db: Queryable, ctx: Ctx, id: string, lock = false): Promise<ClientRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Client');
  const r = await maybeOne<ClientRow>(db, `SELECT * FROM mcp_clients WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  // Visible: my own registration (pending ones have no workspace) or, for managers, any in this workspace.
  const mine = r && r.owner_user_id === ctx.actor.userId && (r.workspace_id === null || r.workspace_id === ctx.access.workspaceId);
  const managed = r && r.workspace_id === ctx.access.workspaceId && canManage(ctx);
  if (!r || (!mine && !managed)) throw notFound('Client');
  return r;
}

/** Consent page data: the client, what it asked for, and the brands the person can grant. */
export async function consentView(ctx: Ctx, id: string) {
  const db = getPool();
  const r = await loadRow(db, ctx, id);
  if (r.owner_user_id !== ctx.actor.userId) throw notFound('Client');
  const u = await one<{ email: string; name: string | null }>(db, `SELECT email, name FROM users WHERE id=$1`, [r.owner_user_id]);
  const [view] = await clientViews(db, ctx, [{ ...r, email: u.email, owner_name: u.name }]);
  const brands = (await listBrands(ctx)).map((b) => ({ id: b.id, name: b.name }));
  return { client: view!, brands, scopes: MCP_SCOPES, workspace_id: ctx.access.workspaceId };
}

export const consentSchema = z.object({
  scopes: z.array(z.enum(MCP_SCOPES)).min(1).max(MCP_SCOPES.length),
  brand_ids: z.array(z.string().uuid()).max(200).nullable(),
}).strict();

/**
 * Approve (or edit) a client for THIS workspace. Only the person the client acts for; step-up required.
 * A pending registration becomes active here; a client already approved elsewhere gets a new registration here.
 */
export async function consentClient(ctx: Ctx, id: string, raw: unknown) {
  const input = consentSchema.parse(raw);
  requireAction(ctx, 'content.read', { stepUp: true, message: 'You cannot connect clients in this workspace' });
  if (input.brand_ids) for (const b of input.brand_ids) await assertBrand(ctx, b);
  return withTx(async (tx) => {
    const r = await loadRow(tx, ctx, id, true);
    if (r.owner_user_id !== ctx.actor.userId) throw notFound('Client');
    if (r.kind !== 'oauth') throw new AppError('invalid_state', 'API-key access follows the service account’s grants. Manage it in Service accounts.');
    const scopes = MCP_SCOPES.filter((s) => input.scopes.includes(s));
    let rowId: string;
    const existing = await maybeOne<{ id: string }>(tx,
      `SELECT id FROM mcp_clients WHERE kind='oauth' AND client_id=$1 AND owner_user_id=$2 AND workspace_id=$3 AND status='active' FOR UPDATE`,
      [r.client_id, r.owner_user_id, ctx.access.workspaceId]);
    if (existing) {
      await tx.query(`UPDATE mcp_clients SET granted_scopes=$2, brand_ids=$3, consented_at=now(), consented_by=$4 WHERE id=$1`, [existing.id, scopes, input.brand_ids, ctx.actor.userId]);
      rowId = existing.id;
      if (r.status === 'pending' && r.id !== existing.id) await tx.query(`DELETE FROM mcp_clients WHERE id=$1`, [r.id]);
    } else if (r.status === 'pending') {
      await tx.query(`UPDATE mcp_clients SET workspace_id=$2, status='active', granted_scopes=$3, brand_ids=$4, consented_at=now(), consented_by=$5 WHERE id=$1`,
        [r.id, ctx.access.workspaceId, scopes, input.brand_ids, ctx.actor.userId]);
      rowId = r.id;
    } else {
      // Allow again after revocation, or approve here a client approved in another workspace.
      const n = await one<{ id: string }>(tx,
        `INSERT INTO mcp_clients(workspace_id, owner_user_id, kind, client_id, issuer, name, requested_scopes, granted_scopes, brand_ids, status, consented_at, consented_by)
         VALUES ($1,$2,'oauth',$3,$4,$5,$6,$7,$8,'active',now(),$2) RETURNING id`,
        [ctx.access.workspaceId, r.owner_user_id, r.client_id, r.issuer, r.name, r.requested_scopes, scopes, input.brand_ids]);
      rowId = n.id;
    }
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'mcp.client_consented', resourceType: 'mcp_client', resourceId: rowId,
      correlationId: ctx.correlationId, diff: { client_id: r.client_id, scopes, brand_ids: input.brand_ids } });
    return { id: rowId, status: 'active' as const };
  });
}

/** Revoke a registration; the client is rejected from its next request. Removing access never needs step-up. */
export async function revokeClient(ctx: Ctx, id: string, reason?: string | null) {
  return withTx(async (tx) => {
    const r = await loadRow(tx, ctx, id, true);
    if (r.status === 'revoked') return { id: r.id, status: 'revoked' as const };
    await tx.query(`UPDATE mcp_clients SET status='revoked', revoked_at=now(), revoked_by=$2, revoked_reason=$3 WHERE id=$1`, [r.id, ctx.actor.userId, reason?.slice(0, 200) ?? null]);
    const grants = await tx.query(`UPDATE mcp_policy_grants SET revoked_at=now(), revoked_by=$2 WHERE client_row_id=$1 AND revoked_at IS NULL`, [r.id, ctx.actor.userId]);
    await tx.query(`UPDATE mcp_publication_intents SET status='invalidated', invalid_reason='Client access revoked.' WHERE client_row_id=$1 AND status IN ('prepared','confirmed')`, [r.id]);
    await tx.query(`UPDATE mcp_jobs SET status='cancelled', error_code='client_revoked', finished_at=now(), updated_at=now() WHERE client_row_id=$1 AND status='queued'`, [r.id]);
    await audit(tx, { workspaceId: r.workspace_id ?? ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'mcp.client_revoked', resourceType: 'mcp_client', resourceId: r.id,
      correlationId: ctx.correlationId, diff: { client_id: r.client_id, owner_user_id: r.owner_user_id, policies_revoked: grants.rowCount } });
    return { id: r.id, status: 'revoked' as const };
  });
}

// ------------------------------------------------------------------ audit

export async function listMcpAudit(ctx: Ctx, q: { client_row_id?: string | null; cursor?: string | null; limit?: number | null }) {
  const db = getPool();
  const all = may(ctx, 'audit.read');
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 100);
  const params: unknown[] = [ctx.access.workspaceId];
  let where = `a.workspace_id=$1`;
  if (!all) { params.push(ctx.actor.userId); where += ` AND c.owner_user_id=$${params.length}`; }
  if (q.client_row_id) {
    if (!/^[0-9a-f-]{36}$/i.test(q.client_row_id)) throw notFound('Client');
    params.push(q.client_row_id); where += ` AND a.client_row_id=$${params.length}`;
  }
  if (q.cursor) {
    if (!/^\d+$/.test(q.cursor)) throw new AppError('validation_failed', 'Invalid cursor');
    params.push(q.cursor); where += ` AND a.id < $${params.length}::bigint`;
  }
  params.push(limit + 1);
  const rows = await many<{ id: string; created_at: Date; tool: string; result: McpAuditView['result']; error_code: string | null; client_row_id: string | null; name: string | null;
    client_id: string | null; actor_user_id: string | null; email: string | null; actor_service_account_id: string | null; resource_ids: Record<string, string>; correlation_id: string; latency_ms: number }>(db,
    `SELECT a.id::text, a.created_at, a.tool, a.result, a.error_code, a.client_row_id, c.name, a.client_id, a.actor_user_id, u.email, a.actor_service_account_id,
            a.resource_ids, a.correlation_id, a.latency_ms
       FROM mcp_audit a LEFT JOIN mcp_clients c ON c.id=a.client_row_id LEFT JOIN users u ON u.id=a.actor_user_id
      WHERE ${where} ORDER BY a.id DESC LIMIT $${params.length}`, params);
  const page = rows.slice(0, limit);
  return {
    items: page.map((r): McpAuditView => ({ id: r.id, created_at: r.created_at.toISOString(), tool: r.tool, result: r.result, error_code: r.error_code,
      client: { id: r.client_row_id, name: r.name, client_id: r.client_id }, actor: { user_id: r.actor_user_id, email: r.email, service_account_id: r.actor_service_account_id },
      resource_ids: r.resource_ids, correlation_id: r.correlation_id, latency_ms: r.latency_ms })),
    next_cursor: rows.length > limit ? page[page.length - 1]!.id : null,
    scope: all ? 'workspace' as const : 'mine' as const,
  };
}

// ------------------------------------------------------------------ automation policies

interface GrantRow {
  id: string; client_row_id: string; client_name: string; actor_user_id: string; actor_email: string; brand_id: string; brand_name: string; connection_ids: string[] | null;
  allow_immediate: boolean; valid_from: Date; valid_until: Date; max_days_ahead: number; local_start_hour: number; local_end_hour: number; max_per_day: number;
  max_text_length: number | null; allow_links: boolean; allow_media: boolean; note: string | null; created_at: Date; created_by_email: string | null; revoked_at: Date | null;
}

const grantView = (g: GrantRow): McpPolicyGrantView => {
  const now = Date.now();
  return {
    id: g.id, client_row_id: g.client_row_id, client_name: g.client_name, actor: { user_id: g.actor_user_id, email: g.actor_email }, brand: { id: g.brand_id, name: g.brand_name },
    connection_ids: g.connection_ids, allow_immediate: g.allow_immediate, valid_from: g.valid_from.toISOString(), valid_until: g.valid_until.toISOString(),
    max_days_ahead: g.max_days_ahead, local_start_hour: g.local_start_hour, local_end_hour: g.local_end_hour, max_per_day: g.max_per_day, max_text_length: g.max_text_length,
    allow_links: g.allow_links, allow_media: g.allow_media, note: g.note, created_at: g.created_at.toISOString(), created_by_email: g.created_by_email,
    revoked_at: g.revoked_at?.toISOString() ?? null,
    status: g.revoked_at ? 'revoked' : g.valid_until.getTime() <= now ? 'expired' : g.valid_from.getTime() > now ? 'scheduled' : 'active',
  };
};

const GRANT_SELECT = `SELECT g.*, c.name AS client_name, u.email AS actor_email, b.name AS brand_name, cu.email AS created_by_email
  FROM mcp_policy_grants g JOIN mcp_clients c ON c.id=g.client_row_id JOIN users u ON u.id=g.actor_user_id JOIN brands b ON b.id=g.brand_id
  LEFT JOIN users cu ON cu.id=g.created_by`;

export async function listPolicyGrants(ctx: Ctx) {
  const all = canManage(ctx);
  const rows = await many<GrantRow>(getPool(), `${GRANT_SELECT} WHERE g.workspace_id=$1 AND ($3 OR g.actor_user_id=$2) ORDER BY g.revoked_at NULLS FIRST, g.created_at DESC LIMIT 200`,
    [ctx.access.workspaceId, ctx.actor.userId, all]);
  return { items: rows.map(grantView) };
}

export const policyGrantSchema = z.object({
  client_row_id: z.string().uuid(),
  brand_id: z.string().uuid(),
  connection_ids: z.array(z.string().uuid()).min(1).max(20).nullable().default(null),
  allow_immediate: z.boolean().default(false),
  valid_from: z.string().datetime({ offset: true }).optional(),
  valid_until: z.string().datetime({ offset: true }),
  max_days_ahead: z.number().int().min(0).max(90).default(14),
  local_start_hour: z.number().int().min(0).max(23).default(0),
  local_end_hour: z.number().int().min(1).max(24).default(24),
  max_per_day: z.number().int().min(1).max(50).default(3),
  max_text_length: z.number().int().min(1).max(100_000).nullable().default(null),
  allow_links: z.boolean().default(true),
  allow_media: z.boolean().default(true),
  note: z.string().trim().max(300).nullable().optional(),
}).strict();

/** Pre-authorise one of MY clients to commit publications within limits (step-up; I must hold the authority). */
export async function createPolicyGrant(ctx: Ctx, raw: unknown) {
  const input = policyGrantSchema.parse(raw);
  const from = input.valid_from ? new Date(input.valid_from) : new Date();
  const until = new Date(input.valid_until);
  if (until <= from) throw new AppError('validation_failed', 'The end must be after the start', { valid_until: 'After the start' });
  if (until.getTime() - Date.now() > 90 * 86_400_000) throw new AppError('validation_failed', 'A policy can last at most 90 days', { valid_until: 'At most 90 days' });
  if (input.local_end_hour <= input.local_start_hour) throw new AppError('validation_failed', 'The hours window is empty', { local_end_hour: 'After the start hour' });
  const brand = await assertBrand(ctx, input.brand_id);
  requireAction(ctx, 'content.schedule', { brandId: brand.id, stepUp: true, message: 'You cannot schedule posts for this brand' });
  if (input.allow_immediate) requireAction(ctx, 'content.publish', { brandId: brand.id, stepUp: true, message: 'You cannot publish posts for this brand' });
  return withTx(async (tx) => {
    const c = await loadRow(tx, ctx, input.client_row_id, true);
    if (c.owner_user_id !== ctx.actor.userId || c.workspace_id !== ctx.access.workspaceId) throw notFound('Client');
    if (c.status !== 'active') throw new AppError('invalid_state', 'Approve the client first.');
    if (c.kind !== 'oauth') throw new AppError('invalid_state', 'Automation policies are for OAuth clients acting for you.');
    const needed: McpScope = input.allow_immediate ? 'publishing.publish' : 'publishing.schedule';
    if (!c.granted_scopes.includes(needed)) throw new AppError('invalid_state', `Grant the client the ${needed} scope first.`);
    if (c.brand_ids && !c.brand_ids.includes(brand.id)) throw new AppError('invalid_state', 'The client is not approved for this brand.');
    if (input.connection_ids) {
      const ok = await many<{ id: string }>(tx, `SELECT id FROM connections WHERE workspace_id=$1 AND brand_id=$2 AND id = ANY($3::uuid[])`, [ctx.access.workspaceId, brand.id, input.connection_ids]);
      if (ok.length !== new Set(input.connection_ids).size) throw new AppError('validation_failed', 'Destinations must belong to the brand', { connection_ids: 'Choose this brand’s destinations' });
    }
    const g = await one<{ id: string }>(tx,
      `INSERT INTO mcp_policy_grants(workspace_id, client_row_id, actor_user_id, brand_id, connection_ids, allow_immediate, valid_from, valid_until, max_days_ahead,
         local_start_hour, local_end_hour, max_per_day, max_text_length, allow_links, allow_media, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$3) RETURNING id`,
      [ctx.access.workspaceId, c.id, ctx.actor.userId, brand.id, input.connection_ids, input.allow_immediate, from, until, input.max_days_ahead,
        input.local_start_hour, input.local_end_hour, input.max_per_day, input.max_text_length, input.allow_links, input.allow_media, input.note ?? null]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: brand.id, actorUserId: ctx.actor.userId, action: 'mcp.policy_grant_created', resourceType: 'mcp_policy_grant', resourceId: g.id,
      correlationId: ctx.correlationId, diff: { client_row_id: c.id, allow_immediate: input.allow_immediate, valid_until: until.toISOString(), max_per_day: input.max_per_day, connection_ids: input.connection_ids } });
    return grantView(await one<GrantRow>(tx, `${GRANT_SELECT} WHERE g.id=$1`, [g.id]));
  });
}

export async function revokePolicyGrant(ctx: Ctx, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Policy');
  return withTx(async (tx) => {
    const g = await maybeOne<{ id: string; actor_user_id: string; brand_id: string; revoked_at: Date | null }>(tx,
      `SELECT id, actor_user_id, brand_id, revoked_at FROM mcp_policy_grants WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [id, ctx.access.workspaceId]);
    if (!g || (g.actor_user_id !== ctx.actor.userId && !canManage(ctx))) throw notFound('Policy');
    if (!g.revoked_at) {
      await tx.query(`UPDATE mcp_policy_grants SET revoked_at=now(), revoked_by=$2 WHERE id=$1`, [g.id, ctx.actor.userId]);
      // Reservations under this policy that have not been committed lose their basis.
      await tx.query(`UPDATE mcp_publication_intents SET policy_grant_id=NULL WHERE policy_grant_id=$1 AND status='prepared'`, [g.id]);
      await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: g.brand_id, actorUserId: ctx.actor.userId, action: 'mcp.policy_grant_revoked', resourceType: 'mcp_policy_grant', resourceId: g.id, correlationId: ctx.correlationId });
    }
    return grantView(await one<GrantRow>(tx, `${GRANT_SELECT} WHERE g.id=$1`, [g.id]));
  });
}
