import type { Queryable } from '@social-lite/db';
import { redact } from './log.js';

export async function audit(
  db: Queryable,
  e: {
    workspaceId: string | null; brandId?: string | null; actorUserId?: string | null; actorService?: string | null;
    action: string; resourceType: string; resourceId?: string | null; diff?: Record<string, unknown>; correlationId?: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_events(workspace_id, brand_id, actor_user_id, actor_service, action, resource_type, resource_id, diff, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [e.workspaceId, e.brandId ?? null, e.actorUserId ?? null, e.actorService ?? null, e.action, e.resourceType, e.resourceId ?? null,
      JSON.stringify(redact(e.diff ?? {})), e.correlationId ?? null],
  );
}
