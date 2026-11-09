// Per-call MCP context: effective permission = intersection(
//   user / service-account V2 grants (central policy, loaded fresh from the database on every call),
//   the client's scopes (token scopes ∩ scopes the user granted at consent),
//   the consented workspace and brands,
//   product policy (publication intents, pause, approvals — enforced by the shared services)).
// Scopes and brand consent are applied through the policy's own restriction mechanism, so every shared service
// (requireAction / authorizeCtx / assertBrand / brandFilter) enforces them without MCP-specific code paths.
import { randomUUID } from 'node:crypto';
import { AppError, PERMISSIONS, type Permission } from '@social-lite/core';
import { MCP_SCOPE_PERMISSIONS, isMcpScope, type McpErrorCode, type McpScope } from '@social-lite/core/contracts/mcp';
import { getPool, many, maybeOne, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { loadAccess } from '../tenancy.js';
import { serviceAccountCtx } from '../service-accounts.js';
import { config } from '../config.js';
import type { ClientRow, McpPrincipal } from './auth.js';

export class McpToolError extends Error {
  /** `code` is typed against MCP_ERROR_CODES so every code a tool can return is in the published list. */
  constructor(readonly code: McpErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'McpToolError';
  }
}

export interface CallScope {
  ctx: Ctx;
  client: ClientRow;
  scopes: McpScope[];
  principal: McpPrincipal;
}

export function appUrl(path: string): string {
  const base = config().APP_BASE_URL.replace(/\/$/, '');
  return `${base}${path}`;
}

export function permissionsForScopes(scopes: McpScope[]): Set<Permission> {
  return new Set(scopes.flatMap((s) => [...MCP_SCOPE_PERMISSIONS[s]]));
}

/** Registration that admits this principal in `workspaceId`, or a precise consent/revocation error. */
export async function clientFor(p: McpPrincipal, workspaceId: string, db: Queryable = getPool()): Promise<ClientRow> {
  if (p.kind === 'service_account') {
    if (p.workspaceId !== workspaceId) throw new McpToolError('not_found', 'Workspace not found');
    const row = await maybeOne<ClientRow>(db, `SELECT * FROM mcp_clients WHERE kind='api_key' AND api_key_id=$1 AND status='active'`, [p.apiKeyId]);
    if (!row) throw new McpToolError('client_revoked', 'MCP access for this API key was revoked in Relay.');
    return row;
  }
  const rows = await many<ClientRow>(db,
    `SELECT * FROM mcp_clients WHERE kind='oauth' AND client_id=$1 AND owner_user_id=$2 AND (workspace_id=$3 OR status='pending') ORDER BY created_at DESC`,
    [p.clientId, p.userId, workspaceId]);
  const active = rows.find((r) => r.status === 'active' && r.workspace_id === workspaceId);
  if (active) return active;
  const pending = rows.find((r) => r.status === 'pending');
  if (pending) {
    throw new McpToolError('consent_required', 'Approve this client for the workspace in Relay first.', { consent_url: appUrl(`/mcp/connect/${pending.id}`) });
  }
  if (rows.some((r) => r.status === 'revoked')) throw new McpToolError('client_revoked', 'MCP access for this client was revoked in this workspace.');
  // No registration for this workspace (e.g. consented elsewhere): treat the workspace as invisible.
  throw new McpToolError('not_found', 'Workspace not found');
}

/** Build the request context for one tool call in one workspace (fresh authorization state every call). */
export async function callScope(p: McpPrincipal, workspaceId: string, correlationId: string = randomUUID(),
  opts: { elevatedAssurance?: { mfaVerified: boolean; authTime: string | null } } = {}, db: Queryable = getPool()): Promise<CallScope> {
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) throw new McpToolError('not_found', 'Workspace not found');
  const client = await clientFor(p, workspaceId, db);
  const granted = client.granted_scopes.filter(isMcpScope);
  const scopes = p.tokenScopes.filter((s) => granted.includes(s));
  let ctx: Ctx;
  if (p.kind === 'service_account') {
    try {
      ctx = await serviceAccountCtx({ serviceAccountId: p.serviceAccountId!, workspaceId, name: p.name ?? undefined, keyId: p.apiKeyId ?? undefined }, correlationId, db);
    } catch {
      throw new McpToolError('client_revoked', 'The API key or its service account is no longer active.');
    }
  } else {
    const assurance = opts.elevatedAssurance ?? p.assurance;
    const access = await loadAccess(p.userId!, workspaceId, db, assurance);
    if (!access) throw new McpToolError('not_found', 'Workspace not found');
    ctx = { actor: { userId: p.userId!, email: p.email, name: p.name, sessionId: `mcp:${client.id}` }, access, correlationId };
  }
  const authz = ctx.access.authz!;
  // (1) client scopes: deny every permission no granted scope covers.
  const allowed = permissionsForScopes(scopes);
  const denied = PERMISSIONS.filter((x) => !allowed.has(x));
  if (denied.length) authz.subject.restrictions.push({ brandId: null, actions: denied, expiresAt: null });
  // (2) consented brands: narrow visibility AND deny everything on other brands of the workspace.
  if (client.brand_ids) {
    const consented = new Set(client.brand_ids);
    ctx.access.brandIds = ctx.access.brandIds === null ? [...consented] : ctx.access.brandIds.filter((b) => consented.has(b));
    const others = await many<{ id: string }>(db, `SELECT id FROM brands WHERE workspace_id=$1 AND NOT (id = ANY($2::uuid[]))`, [workspaceId, client.brand_ids]);
    for (const b of others) authz.subject.restrictions.push({ brandId: b.id, actions: ['*'], expiresAt: null });
  }
  return { ctx, client, scopes, principal: p };
}

/** Throw insufficient_scope unless one of `anyOf` is effective for this call. */
export function requireScope(s: Pick<CallScope, 'scopes'>, ...anyOf: McpScope[]): void {
  if (!anyOf.some((x) => s.scopes.includes(x))) {
    throw new McpToolError('insufficient_scope', `This needs the ${anyOf.join(' or ')} scope, granted to this client in Relay.`, { required_scopes: anyOf });
  }
}

/** Mutations that record a human author need a user principal (service accounts can only create drafts). */
export function requireHuman(s: CallScope, what = 'This action'): void {
  if (s.principal.kind !== 'user') throw new McpToolError('unsupported_principal', `${what} needs a user sign-in (OAuth); API keys can read and create drafts only.`);
}

/** Map service/AppError failures to safe MCP error codes. */
export function toToolError(err: unknown): McpToolError {
  if (err instanceof McpToolError) return err;
  if (err instanceof AppError) {
    const map: Record<string, McpErrorCode> = {
      not_found: 'not_found', forbidden: 'forbidden', validation_failed: 'validation_failed', version_conflict: 'version_conflict',
      conflict: 'conflict', invalid_state: 'invalid_state', idempotency_conflict: 'idempotency_conflict', rate_limited: 'rate_limited',
      budget_exhausted: 'budget_exhausted', mfa_required: 'mfa_required', step_up_required: 'mfa_required', unauthenticated: 'forbidden',
      provider_not_configured: 'not_configured', entitlement_required: 'entitlement_required',
    };
    const code: McpErrorCode = err.details?.reason === 'ambiguous_time' ? 'needs_choice' : err.details?.reason === 'approval_required' ? 'approval_required' : (map[err.code] ?? 'internal');
    // Details are already user-safe in services (no secrets); pass through a small allow-list only.
    const details: Record<string, unknown> = {};
    for (const k of ['issues', 'per_destination', 'options', 'current', 'reason', 'retry_after_seconds', 'conflict_copy_id', 'feature', 'allowance', 'upgrade_to', 'access']) if (err.details?.[k] !== undefined) details[k] = err.details[k];
    if (err.fieldErrors) details.field_errors = err.fieldErrors;
    if (code === 'forbidden' && err.details?.reason === 'restricted') return new McpToolError('insufficient_scope', 'This client is not allowed to do that (scope or brand not granted in Relay).');
    if (code === 'mfa_required') return new McpToolError('mfa_required', 'This action needs a recent second-factor sign-in. Re-authorize the client with your second factor, or confirm it in Relay.');
    return new McpToolError(code, code === 'internal' ? 'Something went wrong.' : err.message, Object.keys(details).length ? details : undefined);
  }
  return new McpToolError('internal', 'Something went wrong.');
}
