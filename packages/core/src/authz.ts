// V2 authorization policy (pure; no IO). One evaluation function used by every server path.
// Precedence (highest first):
//   1. No active membership (missing/removed/suspended) or service account disabled/expired ⇒ DENY
//   2. Explicit restriction covering the action + scope ⇒ DENY
//   3. Mandatory assurance (MFA / fresh authentication) not met ⇒ DENY (reason mfa_required / step_up_required)
//   4. Union of active, unexpired grants (direct + via teams) whose scope covers the resource ⇒ ALLOW
//   5. Otherwise ⇒ DENY (default deny)
export const PERMISSIONS = [
  'workspace.read', 'workspace.manage', 'workspace.transfer_owner',
  'members.read', 'members.invite', 'members.manage',
  'teams.read', 'teams.manage',
  'brands.read', 'brands.manage',
  'connections.read', 'connections.manage',
  'content.read', 'content.create', 'content.edit', 'content.archive',
  'content.submit', 'content.approve', 'content.schedule', 'content.publish',
  'publishing.pause', 'publishing.resume', 'publishing.retry',
  'assets.read', 'assets.upload', 'assets.manage',
  'analytics.read', 'exports.create',
  'audit.read', 'security.manage', 'service_accounts.manage',
  // narrow, guest/integration-oriented permissions
  'comments.shared', 'comments.internal', 'content.create_draft',
  // V3.5 (reserved by the foundation stream for every V3.5 stream; docs/V3_5_WORKSTREAMS.md). Private customer
  // conversations need inbox.read; platform operators never get it implicitly.
  'inbox.read', 'inbox.reply', 'inbox.assign', 'inbox.manage', 'cases.manage',
  'integrations.read', 'integrations.manage', 'listening.read', 'listening.manage', 'ai.use', 'automation.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PRESETS = ['owner', 'admin', 'team_manager', 'brand_manager', 'editor', 'approver', 'publisher', 'analyst', 'viewer', 'exporter', 'guest', 'integration', 'care_agent'] as const;
export type RolePreset = (typeof ROLE_PRESETS)[number];

const ALL = PERMISSIONS as readonly Permission[];
const READ: Permission[] = ['brands.read', 'connections.read', 'content.read', 'assets.read', 'comments.internal'];

export const PRESET_PERMISSIONS: Record<RolePreset, readonly Permission[]> = {
  owner: ALL,
  // Admin: everything operational except ownership transfer and security policy weakening.
  admin: ALL.filter((p) => p !== 'workspace.transfer_owner' && p !== 'security.manage'),
  team_manager: ['workspace.read', 'members.read', 'teams.read'],
  brand_manager: [...READ, 'brands.manage', 'content.create', 'content.edit', 'content.archive', 'content.submit', 'content.schedule', 'content.publish',
    'publishing.pause', 'publishing.resume', 'publishing.retry', 'assets.upload', 'assets.manage', 'analytics.read', 'comments.shared',
    'inbox.read', 'inbox.reply', 'inbox.assign', 'cases.manage', 'integrations.read', 'listening.read', 'ai.use'],
  editor: [...READ, 'content.create', 'content.edit', 'content.archive', 'content.submit', 'assets.upload', 'comments.shared', 'listening.read', 'ai.use'],
  approver: [...READ, 'content.approve', 'publishing.pause', 'comments.shared'],
  publisher: [...READ, 'content.schedule', 'content.publish', 'publishing.pause', 'publishing.resume', 'publishing.retry'],
  analyst: [...READ, 'analytics.read', 'listening.read'],
  viewer: READ,
  exporter: ['exports.create'],
  // Guests: only what is explicitly shared with them (review requests); never internal notes or the library.
  guest: ['content.read', 'content.approve', 'comments.shared'],
  // Service accounts (e.g. TipSignal): create drafts on one brand, nothing else.
  integration: ['content.create_draft'],
  // V3.5: customer care on a brand — read/answer/assign conversations and run cases; no publishing, no settings.
  care_agent: [...READ, 'inbox.read', 'inbox.reply', 'inbox.assign', 'cases.manage', 'integrations.read', 'ai.use'],
};

/** Workspace-level permissions are meaningful only at workspace scope. */
export const WORKSPACE_ONLY: ReadonlySet<Permission> = new Set([
  'workspace.read', 'workspace.manage', 'workspace.transfer_owner', 'members.read', 'members.invite', 'members.manage',
  'teams.read', 'teams.manage', 'audit.read', 'security.manage', 'service_accounts.manage',
]);

/** Actions that always require verified MFA in the current session (when the policy requires MFA for the role). */
export const SENSITIVE_PERMISSIONS: ReadonlySet<Permission> = new Set([
  'workspace.manage', 'workspace.transfer_owner', 'members.invite', 'members.manage', 'teams.manage', 'connections.manage',
  'security.manage', 'service_accounts.manage', 'content.publish', 'content.schedule', 'exports.create', 'integrations.manage', 'automation.manage',
]);

export interface Grant {
  role: RolePreset;
  scopeType: 'workspace' | 'brand' | 'connection';
  brandId: string | null;
  connectionId: string | null;
  expiresAt: string | null;   // ISO
  via: 'direct' | 'team';
  teamId?: string | null;
  grantId: string;
}

export interface Restriction { brandId: string | null; actions: string[]; expiresAt: string | null }

export interface Assurance {
  mfaVerified: boolean;
  authTime: string | null;    // ISO
}

export interface SecurityPolicy {
  mfa_required_for: string[];
  mfa_required_all: boolean;
  step_up_seconds: number;
}

export interface Subject {
  kind: 'user' | 'service_account';
  status: 'active' | 'suspended' | 'removed' | 'missing' | 'disabled' | 'expired';
  grants: Grant[];
  restrictions: Restriction[];
  assurance: Assurance | null;   // null for service accounts
}

export interface Resource { brandId?: string | null; connectionId?: string | null }

export type DenyReason = 'not_member' | 'suspended' | 'disabled' | 'restricted' | 'no_grant' | 'mfa_required' | 'step_up_required' | 'workspace_scope_required';

export interface Decision {
  allowed: boolean;
  reason: DenyReason | 'granted';
  /** Grants that produced the allow (for the Effective access view). */
  sources: Array<{ grantId: string; role: RolePreset; via: 'direct' | 'team'; teamId?: string | null }>;
}

const active = (expiresAt: string | null, now: Date) => !expiresAt || new Date(expiresAt).getTime() > now.getTime();

function covers(g: Grant, perm: Permission, r: Resource): boolean {
  if (WORKSPACE_ONLY.has(perm)) return g.scopeType === 'workspace';
  if (g.scopeType === 'workspace') return true;
  if (!r.brandId || g.brandId !== r.brandId) return false;
  if (g.scopeType === 'brand') return true;
  // connection-scoped grants: only for connection-bound actions on that connection
  return !!r.connectionId && g.connectionId === r.connectionId;
}

export function requiresMfa(subject: Subject, policy: SecurityPolicy, now: Date): boolean {
  if (subject.kind !== 'user') return false;
  if (policy.mfa_required_all) return true;
  return subject.grants.some((g) => active(g.expiresAt, now) && policy.mfa_required_for.includes(g.role));
}

export function evaluate(subject: Subject, perm: Permission, resource: Resource, policy: SecurityPolicy, now = new Date(), opts: { stepUp?: boolean } = {}): Decision {
  const deny = (reason: DenyReason): Decision => ({ allowed: false, reason, sources: [] });
  if (subject.status === 'missing' || subject.status === 'removed') return deny('not_member');
  if (subject.status === 'suspended') return deny('suspended');
  if (subject.status === 'disabled' || subject.status === 'expired') return deny('disabled');
  for (const r of subject.restrictions) {
    if (!active(r.expiresAt, now)) continue;
    const scopeHit = r.brandId === null || r.brandId === (resource.brandId ?? null);
    if (scopeHit && (r.actions.includes('*') || r.actions.includes(perm))) return deny('restricted');
  }
  const sources = subject.grants
    .filter((g) => active(g.expiresAt, now) && PRESET_PERMISSIONS[g.role].includes(perm) && covers(g, perm, resource))
    .map((g) => ({ grantId: g.grantId, role: g.role, via: g.via, teamId: g.teamId ?? null }));
  if (!sources.length) return deny(WORKSPACE_ONLY.has(perm) && subject.grants.some((g) => PRESET_PERMISSIONS[g.role].includes(perm)) ? 'workspace_scope_required' : 'no_grant');
  if (subject.kind === 'user' && subject.assurance) {
    const needMfa = requiresMfa(subject, policy, now) && (SENSITIVE_PERMISSIONS.has(perm) || opts.stepUp);
    if (needMfa && !subject.assurance.mfaVerified) return deny('mfa_required');
    if (opts.stepUp) {
      const age = subject.assurance.authTime ? (now.getTime() - new Date(subject.assurance.authTime).getTime()) / 1000 : Infinity;
      if (age > policy.step_up_seconds) return deny('step_up_required');
    }
  }
  return { allowed: true, reason: 'granted', sources };
}

/**
 * Brands on which the subject holds ANY permission (for list filtering). null = all brands (workspace grant).
 * Guest grants never make a brand visible: guests reach only explicitly shared review requests (review portal).
 */
export function visibleBrands(subject: Subject, now = new Date()): string[] | null {
  if (subject.status !== 'active') return [];
  const live = subject.grants.filter((g) => active(g.expiresAt, now) && g.role !== 'exporter' && g.role !== 'team_manager' && g.role !== 'guest');
  if (live.some((g) => g.scopeType === 'workspace')) return null;
  return [...new Set(live.map((g) => g.brandId!).filter(Boolean))];
}

/** Roles a delegator may grant: never more than they hold themselves; only owners grant owner/admin. */
export function canDelegate(delegatorRoles: RolePreset[], role: RolePreset): boolean {
  if (role === 'owner') return false; // ownership only moves via the transfer flow
  if (delegatorRoles.includes('owner')) return true;
  if (role === 'admin') return false;
  if (delegatorRoles.includes('admin')) return true;
  const mine = new Set(delegatorRoles.flatMap((r) => [...PRESET_PERMISSIONS[r]]));
  return PRESET_PERMISSIONS[role].every((p) => mine.has(p));
}

/** V1 Action names → V2 permission identifiers (compatibility for existing call sites). */
export const LEGACY_ACTION_MAP: Record<string, Permission> = {
  'workspace.manage_ownership': 'workspace.transfer_owner',
  'workspace.delete': 'workspace.transfer_owner',
  'workspace.settings': 'workspace.manage',
  'members.invite': 'members.invite',
  'members.remove': 'members.manage',
  'members.change_role': 'members.manage',
  'connections.manage': 'connections.manage',
  'brands.manage': 'brands.manage',
  'drafts.edit': 'content.edit',
  'approvals.decide': 'content.approve',
  'schedule.publish': 'content.schedule',
  'pause.emergency': 'publishing.pause',
  'history.read': 'content.read',
  'history.export': 'exports.create',
  'assets.upload': 'assets.upload',
  'diagnostics.read': 'workspace.manage',
  'setup.manage': 'security.manage',
};
