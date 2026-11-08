// Workspace security policy (owner only, permission security.manage): who must use two-step verification, the
// step-up freshness window, and guest / invitation expiry. Stored in workspaces.security_policy; every change bumps
// the policy version (cached authorisation is re-evaluated) and is audited with before/after. Weakening anything
// (dropping an MFA requirement, a longer step-up window, longer guest access or invitation lifetime) also needs a
// fresh verification (step-up). Owners always require two-step verification.
import { z } from 'zod';
import { AppError, ROLE_PRESETS, type RolePreset } from '@social-lite/core';
import { getPool, maybeOne, withTx, type Queryable } from '@social-lite/db';
import type { Ctx } from './context.js';
import { audit } from './audit.js';
import { bumpPolicyVersion } from './authz.js';
import { requireAction } from './tenancy.js';

export const MFA_ROLE_CHOICES: readonly RolePreset[] = ROLE_PRESETS.filter((r) => r !== 'integration');

export interface SecurityPolicyView {
  mfa_required_all: boolean;
  mfa_required_for: RolePreset[];
  step_up_seconds: number;
  invite_ttl_hours: number;
  guest_max_days: number;
  guest_default_days: number;
}

export const DEFAULT_SECURITY_POLICY: SecurityPolicyView = {
  mfa_required_all: false, mfa_required_for: ['owner', 'admin', 'publisher', 'brand_manager'], step_up_seconds: 300,
  invite_ttl_hours: 72, guest_max_days: 90, guest_default_days: 30,
};

const LIMITS = { step_up_seconds: [60, 3600], invite_ttl_hours: [1, 720], guest_max_days: [1, 365], guest_default_days: [1, 365] } as const;

const updateSchema = z.object({
  mfa_required_all: z.boolean().optional(),
  mfa_required_for: z.array(z.enum(MFA_ROLE_CHOICES as [RolePreset, ...RolePreset[]])).max(20).optional(),
  step_up_seconds: z.number().int().min(LIMITS.step_up_seconds[0]).max(LIMITS.step_up_seconds[1]).optional(),
  invite_ttl_hours: z.number().int().min(LIMITS.invite_ttl_hours[0]).max(LIMITS.invite_ttl_hours[1]).optional(),
  guest_max_days: z.number().int().min(LIMITS.guest_max_days[0]).max(LIMITS.guest_max_days[1]).optional(),
  guest_default_days: z.number().int().min(LIMITS.guest_default_days[0]).max(LIMITS.guest_default_days[1]).optional(),
  expected_policy_version: z.number().int().nonnegative().optional(),
}).strict();

function normalise(raw: Record<string, unknown> | null | undefined): SecurityPolicyView {
  const p = { ...DEFAULT_SECURITY_POLICY, ...(raw ?? {}) } as SecurityPolicyView;
  const int = (v: unknown, d: number, [lo, hi]: readonly [number, number]) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(Math.round(v), lo), hi) : d);
  const roles = Array.isArray(p.mfa_required_for) ? p.mfa_required_for.filter((r): r is RolePreset => (MFA_ROLE_CHOICES as readonly string[]).includes(r)) : DEFAULT_SECURITY_POLICY.mfa_required_for;
  const guestMax = int(p.guest_max_days, 90, LIMITS.guest_max_days);
  return {
    mfa_required_all: p.mfa_required_all === true,
    mfa_required_for: [...new Set<RolePreset>(['owner', ...roles])].sort((a, b) => MFA_ROLE_CHOICES.indexOf(a) - MFA_ROLE_CHOICES.indexOf(b)),
    step_up_seconds: int(p.step_up_seconds, 300, [30, 3600]),
    invite_ttl_hours: int(p.invite_ttl_hours, 72, LIMITS.invite_ttl_hours),
    guest_max_days: guestMax,
    guest_default_days: Math.min(int(p.guest_default_days, 30, LIMITS.guest_default_days), guestMax),
  };
}

/** True when `after` is less strict than `before` in any respect. */
export function isWeakening(before: SecurityPolicyView, after: SecurityPolicyView): boolean {
  return (before.mfa_required_all && !after.mfa_required_all)
    || before.mfa_required_for.some((r) => !after.mfa_required_for.includes(r))
    || after.step_up_seconds > before.step_up_seconds
    || after.invite_ttl_hours > before.invite_ttl_hours
    || after.guest_max_days > before.guest_max_days
    || after.guest_default_days > before.guest_default_days;
}

export async function getSecurityPolicy(ctx: Ctx, db: Queryable = getPool()) {
  requireAction(ctx, 'security.manage');
  const w = await maybeOne<{ security_policy: Record<string, unknown>; policy_version: string }>(db,
    `SELECT security_policy, policy_version FROM workspaces WHERE id=$1`, [ctx.access.workspaceId]);
  return { policy: normalise(w?.security_policy), policy_version: Number(w?.policy_version ?? 0), roles: MFA_ROLE_CHOICES, limits: LIMITS };
}

export async function updateSecurityPolicy(ctx: Ctx, raw: unknown) {
  requireAction(ctx, 'security.manage');
  const input = updateSchema.parse(raw ?? {});
  return withTx(async (tx) => {
    const w = await maybeOne<{ security_policy: Record<string, unknown>; policy_version: string }>(tx,
      `SELECT security_policy, policy_version FROM workspaces WHERE id=$1 FOR UPDATE`, [ctx.access.workspaceId]);
    if (!w) throw new AppError('not_found', 'Workspace not found');
    if (input.expected_policy_version !== undefined && input.expected_policy_version !== Number(w.policy_version)) {
      throw new AppError('conflict', 'Access settings changed meanwhile. Reload and try again.');
    }
    const before = normalise(w.security_policy);
    const { expected_policy_version: _v, ...patch } = input;
    const merged = normalise({ ...before, ...patch });
    if (patch.guest_default_days !== undefined && patch.guest_default_days > merged.guest_max_days) {
      throw new AppError('validation_failed', 'Default guest access can’t exceed the maximum', { guest_default_days: `At most ${merged.guest_max_days} days` });
    }
    const weakening = isWeakening(before, merged);
    if (weakening) requireAction(ctx, 'security.manage', { stepUp: true });
    const changed = (Object.keys(merged) as Array<keyof SecurityPolicyView>).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(merged[k]));
    if (!changed.length) return { policy: before, policy_version: Number(w.policy_version), changed: [] as string[] };
    // Keep unknown keys other features may store in the same document.
    await tx.query(`UPDATE workspaces SET security_policy = security_policy || $2::jsonb WHERE id=$1`, [ctx.access.workspaceId, JSON.stringify(merged)]);
    const policyVersion = await bumpPolicyVersion(tx, ctx.access.workspaceId);
    const pick = (p: SecurityPolicyView) => Object.fromEntries(changed.map((k) => [k, p[k]]));
    await audit(tx, { workspaceId: ctx.access.workspaceId, actorUserId: ctx.actor.userId, action: 'workspace.security_policy_updated', resourceType: 'workspace',
      resourceId: ctx.access.workspaceId, correlationId: ctx.correlationId, diff: { before: pick(before), after: pick(merged), weakening, policy_version: policyVersion } });
    return { policy: merged, policy_version: policyVersion, changed };
  });
}
