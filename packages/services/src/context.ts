// Request/actor context passed into every service call. Services enforce authorization
// themselves using this context; route handlers never bypass services for tenant data.
import type { Role } from '@social-lite/core';

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
