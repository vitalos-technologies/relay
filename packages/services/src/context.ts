// Request/actor context passed into every service call. Services enforce authorization
// themselves using this context; route handlers never bypass services for tenant data.
import type { Role } from '@social-lite/core';
import type { AuthzState } from './authz.js';

export interface Actor {
  userId: string;
  email: string;
  name: string | null;
  sessionId: string;
}

export interface WorkspaceAccess {
  workspaceId: string;
  role: Role;
  /** null => all brands in the workspace; otherwise the explicit grant list. */
  brandIds: string[] | null;
  isDemo: boolean;
  /** V2 policy state. Present for every real request (route() → loadAccess). Tests may omit it (legacy role matrix). */
  authz?: AuthzState;
  /**
   * D33: this person is over the plan's user limit (e.g. a teammate on a Free workspace). Their product access is paused
   * (no brands visible; only billing, support and workspace-read permissions pass requireAction) until the owner
   * upgrades or removes them. The value is the reason shown to them. Absent/null = not held.
   */
  memberHold?: string | null;
}

export interface Ctx {
  actor: Actor;
  access: WorkspaceAccess;
  correlationId: string;
}

export interface ServiceActor {
  service: string; // e.g. 'worker:abc'
  correlationId: string;
}
