// "Receive updates" for Asana projects / monday.com boards: registers a provider webhook pointing at the generic ingress
// with ?i=<installation> (per-installation secret: Asana's X-Hook-Secret handshake; monday's app signing secret).
// Polling (work/tasks.ts pollLinkedTasks) stays on regardless: Asana webhooks are at-most-once.
import { AppError } from '@social-lite/core';
import { getPool, maybeOne } from '@social-lite/db';
import { asanaCreateWebhook } from '@social-lite/providers/asana/client';
import { mondayCreateWebhook } from '@social-lite/providers/monday/client';
import type { Ctx } from '../../context.js';
import { audit } from '../../audit.js';
import { loadIntegration, recordActivity } from '../../connectors/index.js';
import { appErrorFrom, openConn, webhookUrlFor } from '../core/runtime.js';

export async function registerTaskWebhook(ctx: Ctx, integrationId: string, resourceId: string): Promise<{ ok: true; webhook_id: string }> {
  const integ = await loadIntegration(ctx, integrationId, 'integrations.manage');
  if (integ.connector !== 'asana' && integ.connector !== 'monday') throw new AppError('validation_failed', 'Webhooks here are for Asana projects and monday.com boards.');
  const res = await maybeOne<{ id: string; external_id: string; metadata: Record<string, unknown> }>(getPool(),
    `SELECT id, external_id, metadata FROM integration_resources WHERE id=$1 AND integration_id=$2 AND resource_type IN ('project','board') AND selected`, [resourceId, integ.id]);
  if (!res) throw new AppError('validation_failed', 'Select the project or board first.');
  const c = await openConn(integ.id);
  const url = webhookUrlFor(integ.connector, integ.id);
  let id: string;
  try {
    id = integ.connector === 'asana' ? (await asanaCreateWebhook(c, res.external_id, url)).gid : (await mondayCreateWebhook(c, res.external_id, url)).create_webhook.id;
  } catch (err) { throw await appErrorFrom(err, c); }
  await getPool().query(`UPDATE integration_resources SET metadata = metadata || jsonb_build_object('webhook_id', $2::text, 'webhook_at', now()::text), updated_at=now() WHERE id=$1`, [res.id, id]);
  await recordActivity(getPool(), { workspaceId: integ.workspace_id, integrationId: integ.id, kind: 'webhook', outcome: 'ok', code: 'webhook_registered' });
  await audit(getPool(), { workspaceId: integ.workspace_id, brandId: integ.brand_id, actorUserId: ctx.actor.userId, action: 'integration.webhook_registered', resourceType: 'integration', resourceId: integ.id, diff: { resource: res.external_id }, correlationId: ctx.correlationId });
  return { ok: true, webhook_id: id };
}
