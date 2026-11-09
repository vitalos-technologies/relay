// Help Centre audience resolution (HC). Server-side only: the viewer's audiences come from the session and the database
// (membership grants, platform operator row), never from the browser.
import { getPool, type Queryable } from '@social-lite/db';
import { loadAccess } from '../tenancy.js';
import { hasAnywhere } from '../authz.js';
import { isGuestOnly } from '../collab/access.js';
import { loadOperatorRole } from '../admin/platform.js';
import type { SessionRecord } from '../auth/session.js';
import type { Actor } from '../context.js';
import { audiencesFor, type HelpAudience } from './schema.js';

export interface HelpViewer { signedIn: boolean; audiences: HelpAudience[]; admin: boolean; platformStaff: boolean }

export const SIGNED_OUT_VIEWER: HelpViewer = { signedIn: false, audiences: ['public'], admin: false, platformStaff: false };

/** Audiences for a resolved session: admin = workspace.manage on the active workspace (MFA state doesn't hide docs), or
 *  any platform role; guests with only guest grants read public articles; every other signed-in person reads
 *  user + developer articles (including people still in onboarding without a workspace). */
export async function helpViewerFor(resolved: { session: SessionRecord; actor: Actor } | null, db: Queryable = getPool()): Promise<HelpViewer> {
  if (!resolved) return SIGNED_OUT_VIEWER;
  const { session, actor } = resolved;
  const platformStaff = !!(await loadOperatorRole(actor.userId, db));
  const access = session.activeWorkspaceId ? await loadAccess(actor.userId, session.activeWorkspaceId, db) : null;
  const admin = !!access?.authz && hasAnywhere(access.authz, 'workspace.manage');
  const guestOnly = !!access?.authz && isGuestOnly(access.authz);
  return { signedIn: true, audiences: audiencesFor({ signedIn: true, admin, platformStaff, guestOnly }), admin, platformStaff };
}
