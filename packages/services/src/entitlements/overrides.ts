// Platform → Workspaces → Entitlements: audited overrides (V4 §12, §14). Relay operator or billing staff only, with a
// fresh MFA sign-in (step-up); reason (10+ chars), scope (one feature / allowance / temporary full access) and optional
// expiry (required for access). Written to the platform audit AND the workspace audit. Support staff can read the
// entitlement summary (plan, usage counts) but cannot change it. Overrides never lift a staff service suspension.
import { z } from 'zod';
import { AppError, notFound } from '@social-lite/core';
import { ALLOWANCES, FEATURES, ALWAYS_AVAILABLE } from '@social-lite/core/contracts/v4-plans';
import type { EntitlementsDto } from '@social-lite/core/contracts/v4-entitlements';
import { getPool, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import { audit } from '../audit.js';
import { assertUuid } from '../tenancy.js';
import { platformAudit, requireFresh, type PlatformCtx } from '../admin/platform.js';
import { entitlementsCore, invalidateEntitlements } from './resolve.js';
import { buildEntitlementsDto } from './usage.js';
import { reevaluateHolds } from './holds.js';

const MAX_ACCESS_DAYS = 30;
const MAX_OVERRIDE_DAYS = 366;

/** operator ⊇ everything; billing = plan/trial/override actions (BIL adds the role); support = read only. */
export function canManageEntitlements(p: PlatformCtx): boolean {
  return p.role === 'operator' || (p.role as string) === 'billing';
}
function requireEntitlementStaff(p: PlatformCtx): void {
  if (!canManageEntitlements(p)) throw new AppError('forbidden', 'Only Relay operators or billing staff can change entitlements.');
}

const reason = z.string().trim().min(10, 'Give a reason (10+ characters)').max(500);
const expires = z.string().datetime({ offset: true }).nullable().optional();
const featureKeys = FEATURES.filter((f) => !ALWAYS_AVAILABLE.includes(f)) as [string, ...string[]];

export const overrideSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('feature'), key: z.enum(featureKeys), enabled: z.boolean(), reason, expires_at: expires }).strict(),
  z.object({ kind: z.literal('allowance'), key: z.enum(ALLOWANCES), limit: z.number().int().min(0).max(1_000_000_000_000_000).nullable(), reason, expires_at: expires }).strict(),
  z.object({ kind: z.literal('access'), key: z.literal('full'), reason, expires_at: z.string().datetime({ offset: true }) }).strict(),
]);

async function assertWorkspace(db: Queryable, workspaceId: string): Promise<void> {
  assertUuid(workspaceId, 'Workspace');
  if (!await maybeOne(db, `SELECT 1 FROM workspaces WHERE id=$1`, [workspaceId])) throw notFound('Workspace');
}

/** Read: plan, features, usage, held work and override history (operator, support and billing staff). */
export async function platformEntitlements(p: PlatformCtx, workspaceId: string, db: Queryable = getPool()): Promise<EntitlementsDto & { can_override: boolean }> {
  await assertWorkspace(db, workspaceId);
  const core = await entitlementsCore(db, workspaceId);
  const dto = await buildEntitlementsDto(db, core, { detail: true, canManage: false, history: true });
  return { ...dto, can_override: canManageEntitlements(p) };
}

export async function applyOverride(p: PlatformCtx, workspaceId: string, raw: unknown) {
  requireEntitlementStaff(p);
  requireFresh(p);
  const input = overrideSchema.parse(raw);
  const exp = input.expires_at ? new Date(input.expires_at) : null;
  if (exp && exp.getTime() <= Date.now()) throw new AppError('validation_failed', 'The expiry must be in the future.', { expires_at: 'In the future' });
  const maxDays = input.kind === 'access' ? MAX_ACCESS_DAYS : MAX_OVERRIDE_DAYS;
  if (exp && exp.getTime() - Date.now() > maxDays * 86_400_000) throw new AppError('validation_failed', `At most ${maxDays} days.`, { expires_at: `At most ${maxDays} days` });
  const value = input.kind === 'feature' ? { enabled: input.enabled } : input.kind === 'allowance' ? { limit: input.limit } : { level: 'full' as const };
  const id = await withTx(async (tx) => {
    await assertWorkspace(tx, workspaceId);
    const prev = await maybeOne<{ id: string; value: unknown }>(tx,
      `UPDATE entitlement_overrides SET revoked_at=now(), revoked_by=$4, revoked_reason='Replaced by a newer override'
        WHERE workspace_id=$1 AND kind=$2 AND key=$3 AND revoked_at IS NULL RETURNING id, value`, [workspaceId, input.kind, input.key, p.actor.userId]);
    const row = await one<{ id: string }>(tx,
      `INSERT INTO entitlement_overrides(workspace_id, kind, key, value, reason, expires_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [workspaceId, input.kind, input.key, JSON.stringify(value), input.reason, exp, p.actor.userId]);
    const diff = { kind: input.kind, key: input.key, value, expires_at: exp?.toISOString() ?? null, replaced: prev?.id ?? null };
    await platformAudit(tx, p, { action: 'entitlement.override_applied', targetType: 'workspace', targetId: workspaceId, workspaceId, reason: input.reason, diff });
    await audit(tx, { workspaceId, actorUserId: p.actor.userId, action: 'entitlement.override_applied', resourceType: 'entitlement_override', resourceId: row.id,
      diff: { ...diff, reason: input.reason, by: 'relay_staff' }, correlationId: p.correlationId });
    await reevaluateHolds(workspaceId, { reason: 'override', db: tx });
    return row.id;
  });
  invalidateEntitlements(workspaceId);
  return { id, entitlements: await platformEntitlements(p, workspaceId) };
}

export const revokeSchema = z.object({ reason }).strict();

export async function revokeOverride(p: PlatformCtx, workspaceId: string, overrideId: string, raw: unknown) {
  requireEntitlementStaff(p);
  requireFresh(p);
  assertUuid(overrideId, 'Override');
  const { reason: why } = revokeSchema.parse(raw);
  await withTx(async (tx) => {
    await assertWorkspace(tx, workspaceId);
    const r = await maybeOne<{ id: string; kind: string; key: string }>(tx,
      `UPDATE entitlement_overrides SET revoked_at=now(), revoked_by=$3, revoked_reason=$4 WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL RETURNING id, kind, key`,
      [overrideId, workspaceId, p.actor.userId, why]);
    if (!r) throw notFound('Override');
    await platformAudit(tx, p, { action: 'entitlement.override_revoked', targetType: 'workspace', targetId: workspaceId, workspaceId, reason: why, diff: { override_id: r.id, kind: r.kind, key: r.key } });
    await audit(tx, { workspaceId, actorUserId: p.actor.userId, action: 'entitlement.override_revoked', resourceType: 'entitlement_override', resourceId: r.id,
      diff: { kind: r.kind, key: r.key, reason: why, by: 'relay_staff' }, correlationId: p.correlationId });
    await reevaluateHolds(workspaceId, { reason: 'override_revoked', db: tx });
  });
  invalidateEntitlements(workspaceId);
  return platformEntitlements(p, workspaceId);
}
