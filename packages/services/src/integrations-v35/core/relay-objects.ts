// Relay objects that may be linked to external records (posts, campaigns, conversations, cases, listening alerts),
// loaded with the caller's domain permission on their brand. Summaries are deliberately minimal: identifiers, titles
// and a secure Relay link — never message bodies or customer contact details (brief §4, §8).
import { notFound } from '@social-lite/core';
import { getPool, maybeOne, type Queryable } from '@social-lite/db';
import type { Permission } from '@social-lite/core';
import type { Ctx } from '../../context.js';
import { assertUuid, brandAllowed, requireAction } from '../../tenancy.js';
import { baseUrl } from './runtime.js';

export type LinkableType = 'post' | 'campaign' | 'conversation' | 'case' | 'listening_alert' | 'insight';
export interface RelayObject { type: LinkableType; id: string; brandId: string; title: string; path: string; url: string; label: string }

/** Permission needed to send a summary of this object to an external tool. */
export const LINK_PERMISSION: Record<LinkableType, Permission> = {
  post: 'content.edit', campaign: 'content.edit', conversation: 'inbox.read', case: 'cases.manage', listening_alert: 'listening.read', insight: 'listening.read',
};

export async function loadRelayObject(ctx: Ctx, type: LinkableType, id: string, perm: Permission = LINK_PERMISSION[type], db: Queryable = getPool()): Promise<RelayObject> {
  assertUuid(id, 'Item');
  const ws = ctx.access.workspaceId;
  let r: { brand_id: string; title: string | null } | null = null;
  let path = '';
  let label = '';
  switch (type) {
    case 'post':
      r = await maybeOne(db, `SELECT brand_id, coalesce(nullif(title,''), 'Untitled post') AS title FROM posts WHERE id=$1 AND workspace_id=$2`, [id, ws]);
      path = `/posts/${id}`; label = 'Post'; break;
    case 'campaign':
      r = await maybeOne(db, `SELECT brand_id, name AS title FROM campaigns WHERE id=$1 AND workspace_id=$2`, [id, ws]);
      path = `/campaigns?c=${id}`; label = 'Campaign'; break;
    case 'conversation':
      r = await maybeOne(db, `SELECT c.brand_id, ch.display_name || ' conversation' AS title FROM inbox_conversations c JOIN inbox_channels ch ON ch.id=c.channel_id WHERE c.id=$1 AND c.workspace_id=$2`, [id, ws]);
      path = `/inbox?c=${id}`; label = 'Conversation'; break;
    case 'case':
      r = await maybeOne(db, `SELECT brand_id, 'Case #' || number || ': ' || title AS title FROM care_cases WHERE id=$1 AND workspace_id=$2`, [id, ws]);
      path = `/inbox?case=${id}`; label = 'Case'; break;
    case 'listening_alert':
    case 'insight': {
      const exists = await maybeOne<{ t: string | null }>(db, `SELECT to_regclass('public.listening_alerts')::text AS t`);
      if (exists?.t) r = await maybeOne<{ brand_id: string; title: string | null }>(db, `SELECT brand_id, 'Listening alert' AS title FROM listening_alerts WHERE id=$1 AND workspace_id=$2`, [id, ws]).catch(() => null);
      path = `/listening?alert=${id}`; label = 'Listening alert'; break;
    }
  }
  if (!r || !brandAllowed(ctx, r.brand_id)) throw notFound(label || 'Item');
  requireAction(ctx, perm, { brandId: r.brand_id });
  return { type, id, brandId: r.brand_id, title: (r.title ?? label).slice(0, 200), path, url: `${baseUrl()}${path}`, label };
}

/** Safe default description for an external record: what it is + a Relay link (sign-in required to open). */
export function safeSummary(o: RelayObject): string {
  return `${o.title}\n\nOpen in Relay (sign-in required): ${o.url}`;
}
