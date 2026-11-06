// Role matrix (spec §6). Enforced server-side by services; the UI only mirrors it.
import type { Role } from './types.js';

export type Action =
  | 'workspace.manage_ownership' | 'workspace.delete' | 'workspace.settings'
  | 'members.invite' | 'members.remove' | 'members.change_role'
  | 'connections.manage' | 'brands.manage'
  | 'drafts.edit' | 'approvals.decide'
  | 'schedule.publish' | 'pause.emergency' | 'history.read' | 'history.export'
  | 'assets.upload' | 'diagnostics.read' | 'setup.manage';

const MATRIX: Record<Action, readonly Role[]> = {
  'workspace.manage_ownership': ['owner'],
  'workspace.delete': ['owner'],
  'workspace.settings': ['owner', 'admin'],
  'members.invite': ['owner', 'admin'],
  'members.remove': ['owner', 'admin'],
  'members.change_role': ['owner', 'admin'],
  'connections.manage': ['owner', 'admin'],
  'brands.manage': ['owner', 'admin'],
  'drafts.edit': ['owner', 'admin', 'editor'],
  'approvals.decide': ['owner', 'admin', 'approver'],
  // Editors only when brand policy permits; approvers only for approved content.
  // Those conditions are evaluated by canSchedule(); this entry lists unconditional roles.
  'schedule.publish': ['owner', 'admin'],
  'pause.emergency': ['owner', 'admin', 'approver'],
  'history.read': ['owner', 'admin', 'editor', 'approver', 'viewer'],
  'history.export': ['owner', 'admin', 'editor', 'approver', 'viewer'],
  'assets.upload': ['owner', 'admin', 'editor'],
  'diagnostics.read': ['owner', 'admin'],
  'setup.manage': ['owner'],
};

export function can(role: Role, action: Action): boolean {
  return MATRIX[action].includes(role);
}

export interface ScheduleContext {
  role: Role;
  editorsCanPublish: boolean;
  approvalRequired: boolean;
  /** true when the exact revision+schedule fingerprint has a valid approval. */
  contentApproved: boolean;
}

/**
 * Who may create an active schedule / publish now.
 *  - owner/admin: yes (approval still required by brand policy before dispatch).
 *  - editor: only if brand policy permits; if approval is required, the editor submits for review instead.
 *  - approver: only content that is approved.
 */
export function canSchedule(c: ScheduleContext): { allowed: boolean; reason?: string } {
  if (c.role === 'owner' || c.role === 'admin') return { allowed: true };
  if (c.role === 'editor') {
    if (!c.editorsCanPublish) return { allowed: false, reason: 'This brand does not allow editors to schedule. Submit for review instead.' };
    return { allowed: true };
  }
  if (c.role === 'approver') {
    return c.contentApproved ? { allowed: true } : { allowed: false, reason: 'Approvers can only schedule approved content.' };
  }
  return { allowed: false, reason: 'Viewers cannot schedule or publish.' };
}

/** Admins cannot change or remove an owner; only owners manage ownership. */
export function canChangeMember(actor: Role, target: Role, newRole?: Role): boolean {
  if (target === 'owner' || newRole === 'owner') return actor === 'owner';
  return actor === 'owner' || actor === 'admin';
}
