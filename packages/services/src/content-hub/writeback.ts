// Opt-in, field-scoped writeback of APP-OWNED facts (Relay status, scheduled time, resulting post URLs) to explicitly
// mapped Notion properties of imported rows.
//  - Only the one mapped property is sent per update (PATCH /v1/pages: omitted properties keep their values).
//  - Conflict detection: before writing, the current external value is compared with the value Relay last saw/wrote;
//    an external edit ⇒ 'conflict' (needs review) — never silently overwritten.
//  - Loop prevention: writeback is driven only by Relay facts (never by imports/refresh/webhooks); each job records an
//    origin run id and fingerprints; echoes of Relay's own writes are ignored; Relay statuses can't select rows for import.
//  - Disconnect / writeback off / mapping change cancels pending jobs; the configuring person's authority is re-checked.
import { randomUUID } from 'node:crypto';
import { AppError, notFound } from '@social-lite/core';
import type { WritebackField, WritebackJobDto } from '@social-lite/core/contracts/content-hub';
import { getPool, many, maybeOne, withTx } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { audit } from '../audit.js';
import { authorize } from '../authz.js';
import { stableStringify } from '../idempotency.js';
import { log } from '../log.js';
import { writeOutbox } from '../outbox.js';
import { assertUuid, brandAllowed, loadAccess, requireAction } from '../tenancy.js';
import { withSource, type ContentConnectionRow } from './connections.js';
import { sha256Hex } from './normalize.js';
import { retrievePage, updatePageProperties, type NotionPropertyValue } from './notion.js';
import { propertyFingerprint, simulatedProperty, writebackPayload } from './notion-parse.js';
import { RELAY_STATUS_VALUES } from './rows.js';
import { SourceAccessError } from './transport.js';

interface JobRow {
  id: string; workspace_id: string; brand_id: string; connection_id: string; source_item_id: string; mapping_id: string; post_id: string | null;
  field: WritebackField; property_id: string; desired_value: { value: string | null; type: string }; desired_fingerprint: string; origin_run_id: string;
  last_seen_fingerprint: string | null; written_fingerprint: string | null; status: WritebackJobDto['status']; conflict_detail: WritebackJobDto['conflict'];
  attempts: number; error_message: string | null; created_at: Date; completed_at: Date | null;
}

export function writebackJson(j: JobRow): WritebackJobDto {
  return { id: j.id, source_item_id: j.source_item_id, post_id: j.post_id, field: j.field, status: j.status, desired_value: j.desired_value.value,
    conflict: j.conflict_detail, error: j.error_message, created_at: j.created_at.toISOString(), completed_at: j.completed_at?.toISOString() ?? null };
}

/** Relay facts for a post (app-owned): status, earliest scheduled time, published URLs. */
async function postFacts(postId: string): Promise<{ status: string; scheduled_time: string | null; post_url: string | null }> {
  const r = await maybeOne<{ pending: boolean; scheduled_at: Date | null; published: number; failed: number; urls: string[] | null }>(getPool(),
    `SELECT EXISTS (SELECT 1 FROM schedules s WHERE s.post_id=$1 AND s.status='pending_approval') AS pending,
            (SELECT min(s.due_at) FROM schedules s WHERE s.post_id=$1 AND s.status='active') AS scheduled_at,
            (SELECT count(*)::int FROM deliveries d WHERE d.post_id=$1 AND d.state='published') AS published,
            (SELECT count(*)::int FROM deliveries d WHERE d.post_id=$1 AND d.state='failed') AS failed,
            (SELECT array_agg(d.provider_url ORDER BY d.published_at) FROM deliveries d WHERE d.post_id=$1 AND d.state='published' AND d.provider_url LIKE 'https://%') AS urls`, [postId]);
  const status = r?.published ? 'Published' : r?.scheduled_at ? 'Scheduled' : r?.pending ? 'In review' : r?.failed ? 'Failed' : 'Draft in Relay';
  return { status, scheduled_time: r?.scheduled_at?.toISOString() ?? null, post_url: r?.urls?.length ? r.urls.join(' ') : null };
}

/**
 * Sweep: enqueue writeback jobs where a mapped Relay fact differs from what Relay last wrote. Bounded; per item+field at
 * most one active job (unique index). Never triggered by source changes.
 */
export async function syncWritebacks(opts: { workspaceId?: string; limit?: number } = {}): Promise<number> {
  const rows = await many<{ item_id: string; workspace_id: string; brand_id: string; connection_id: string; mapping_id: string; writeback: Record<string, string>; post_id: string;
    snapshot_props: Record<string, { type: string; fingerprint: string }> | null }>(getPool(),
    `SELECT i.id AS item_id, i.workspace_id, i.brand_id, i.connection_id, m.id AS mapping_id, m.writeback, l.post_id, s.content->'properties' AS snapshot_props
       FROM source_items i
       JOIN import_mappings m ON m.source_item_id = i.parent_item_id
       JOIN content_connections c ON c.id = i.connection_id AND c.status='active' AND c.writeback_enabled AND c.disconnected_at IS NULL
       JOIN LATERAL (SELECT post_id FROM source_post_links WHERE source_item_id=i.id AND superseded_at IS NULL ORDER BY created_at DESC LIMIT 1) l ON true
       LEFT JOIN source_snapshots s ON s.id = i.last_snapshot_id
      WHERE i.item_kind='notion_row' AND i.state='linked' AND m.writeback <> '{}'::jsonb AND ($1::uuid IS NULL OR i.workspace_id=$1)
      ORDER BY i.updated_at LIMIT $2`, [opts.workspaceId ?? null, opts.limit ?? 200]);
  let queued = 0;
  for (const r of rows) {
    const facts = await postFacts(r.post_id);
    for (const [field, propId] of Object.entries(r.writeback) as Array<[WritebackField, string]>) {
      const type = r.snapshot_props?.[propId]?.type ?? 'rich_text';
      const value = facts[field];
      const desiredFp = propertyFingerprint(simulatedProperty(propId, type, value));
      const last = await maybeOne<{ desired_fingerprint: string; written_fingerprint: string | null; status: string }>(getPool(),
        `SELECT desired_fingerprint, written_fingerprint, status FROM writeback_jobs WHERE source_item_id=$1 AND field=$2 ORDER BY created_at DESC LIMIT 1`, [r.item_id, field]);
      if (last && last.desired_fingerprint === desiredFp && ['written', 'skipped', 'pending', 'running', 'conflict'].includes(last.status)) continue;
      // Nothing to write yet and the row already shows nothing: skip the initial empty write.
      const seen = last?.written_fingerprint ?? r.snapshot_props?.[propId]?.fingerprint ?? null;
      if (!last && seen === desiredFp) continue;
      const ins = await maybeOne<{ id: string }>(getPool(),
        `INSERT INTO writeback_jobs(workspace_id, brand_id, connection_id, source_item_id, mapping_id, post_id, field, property_id, desired_value, desired_fingerprint, origin_run_id, last_seen_fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING RETURNING id`,
        [r.workspace_id, r.brand_id, r.connection_id, r.item_id, r.mapping_id, r.post_id, field, propId, JSON.stringify({ value, type }), desiredFp, randomUUID(), seen]);
      if (ins) {
        queued++;
        await writeOutbox(getPool(), { workspaceId: r.workspace_id, aggregateType: 'writeback', aggregateId: ins.id, eventType: 'writeback.requested', payload: { jobId: ins.id } });
      }
    }
  }
  return queued;
}

/** The configuring person (mapping.updated_by) must still be allowed to manage connections for the brand. */
async function configuredAuthorityOk(workspaceId: string, brandId: string, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const access = await loadAccess(userId, workspaceId);
  if (!access?.authz) return false;
  return authorize({ ...access.authz, subject: { ...access.authz.subject, assurance: null } }, 'connections.manage', { brandId }).allowed;
}

/** Worker: perform one writeback (re-checks scope, authority, mapping, conflict) — writes ONLY the mapped property. */
export async function runWriteback(jobId: string): Promise<WritebackJobDto | null> {
  const job = await maybeOne<JobRow>(getPool(),
    `UPDATE writeback_jobs SET status='running', attempts=attempts+1, updated_at=now() WHERE id=$1 AND status='pending' RETURNING *`, [jobId]);
  if (!job) return null;
  const end = async (status: WritebackJobDto['status'], patch: { error?: string | null; conflict?: unknown; written?: string | null } = {}) => {
    await getPool().query(
      `UPDATE writeback_jobs SET status=$2, error_message=$3, conflict_detail=coalesce($4::jsonb, conflict_detail), written_fingerprint=coalesce($5, written_fingerprint),
              updated_at=now(), completed_at=CASE WHEN $2 IN ('written','skipped','failed','cancelled') THEN now() ELSE completed_at END WHERE id=$1`,
      [job.id, status, patch.error ?? null, patch.conflict ? JSON.stringify(patch.conflict) : null, patch.written ?? null]);
    return writebackJson((await maybeOne<JobRow>(getPool(), `SELECT * FROM writeback_jobs WHERE id=$1`, [job.id]))!);
  };
  const ctxRow = await maybeOne<{ writeback: Record<string, string>; updated_by: string | null; external_id: string; state: string }>(getPool(),
    `SELECT m.writeback, m.updated_by, i.external_id, i.state
       FROM writeback_jobs j JOIN import_mappings m ON m.id=j.mapping_id JOIN source_items i ON i.id=j.source_item_id
      WHERE j.id=$1 AND i.workspace_id=j.workspace_id AND m.workspace_id=j.workspace_id`, [job.id]);
  const conn = await maybeOne<ContentConnectionRow>(getPool(), `SELECT * FROM content_connections WHERE id=$1 AND workspace_id=$2`, [job.connection_id, job.workspace_id]);
  if (!ctxRow || !conn) return end('cancelled', { error: 'Source removed' });
  if (conn.status !== 'active' || conn.disconnected_at || !conn.writeback_enabled) return end('cancelled', { error: 'Writeback is off or the connection is not active' });
  if (ctxRow.state !== 'linked') return end('cancelled', { error: 'The row is not readable right now' });
  if (ctxRow.writeback[job.field] !== job.property_id) return end('cancelled', { error: 'Mapping changed' });
  if (!(await configuredAuthorityOk(job.workspace_id, job.brand_id, ctxRow.updated_by))) return end('cancelled', { error: 'The person who configured writeback no longer manages this connection' });
  try {
    return await withSource(conn, async (s) => {
      const page = await retrievePage(s.notion!, ctxRow.external_id);
      const current: NotionPropertyValue | undefined = Object.values(page.properties ?? {}).find((v) => v.id === job.property_id);
      if (!current) return end('failed', { error: 'The mapped property no longer exists' });
      const actual = propertyFingerprint(current);
      if (actual === job.desired_fingerprint) return end('skipped', { written: actual });
      if (job.last_seen_fingerprint && actual !== job.last_seen_fingerprint) {
        // Someone edited this field in Notion since Relay last saw it: review instead of overwrite.
        return end('conflict', { conflict: { external_value: current[current.type] ?? null, expected_fingerprint: job.last_seen_fingerprint, actual_fingerprint: actual } });
      }
      const props = { [job.property_id]: writebackPayload(current.type, job.desired_value.value) };
      const updated = await updatePageProperties(s.notion!, ctxRow.external_id, props);
      const after = Object.values(updated.properties ?? {}).find((v) => v.id === job.property_id);
      const written = after ? propertyFingerprint(after) : propertyFingerprint(simulatedProperty(job.property_id, current.type, job.desired_value.value));
      await audit(getPool(), { workspaceId: job.workspace_id, brandId: job.brand_id, actorService: 'content-hub:writeback', action: 'content_writeback.written',
        resourceType: 'writeback_job', resourceId: job.id, diff: { field: job.field, property_id: job.property_id, origin_run_id: job.origin_run_id } });
      return end('written', { written });
    });
  } catch (err) {
    if (err instanceof SourceAccessError && err.retryable && job.attempts < 5) {
      await getPool().query(`UPDATE writeback_jobs SET status='pending', updated_at=now() WHERE id=$1`, [job.id]);
      throw err;
    }
    log.warn('content_writeback_failed', { jobId: job.id, err: { name: (err as Error).name, message: (err as Error).message } });
    return end('failed', { error: err instanceof AppError ? err.message : 'Notion rejected the update' });
  }
}

export async function listWritebacks(ctx: Ctx, brandId: string, q: { status?: string | null } = {}): Promise<WritebackJobDto[]> {
  requireAction(ctx, 'content.read', { brandId });
  if (!brandAllowed(ctx, brandId)) throw notFound('Brand');
  const rows = await many<JobRow>(getPool(), `SELECT * FROM writeback_jobs WHERE workspace_id=$1 AND brand_id=$2 AND ($3::text IS NULL OR status=$3) ORDER BY created_at DESC LIMIT 100`,
    [ctx.access.workspaceId, brandId, q.status ?? null]);
  return rows.map(writebackJson);
}

/** Review a conflict: 'overwrite' re-queues with the external value acknowledged; 'keep_external' drops Relay's write. */
export async function resolveWritebackConflict(ctx: Ctx, jobId: string, decision: 'overwrite' | 'keep_external'): Promise<WritebackJobDto> {
  assertUuid(jobId, 'Writeback');
  return withTx(async (tx) => {
    const j = await maybeOne<JobRow>(tx, `SELECT * FROM writeback_jobs WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [jobId, ctx.access.workspaceId]);
    if (!j || !brandAllowed(ctx, j.brand_id)) throw notFound('Writeback');
    requireAction(ctx, 'connections.manage', { brandId: j.brand_id });
    if (j.status !== 'conflict') throw new AppError('invalid_state', 'This writeback is not waiting for review.');
    const actual = j.conflict_detail?.actual_fingerprint ?? null;
    if (decision === 'overwrite') {
      await tx.query(`UPDATE writeback_jobs SET status='pending', last_seen_fingerprint=$2, conflict_detail=NULL, origin_run_id=$3, updated_at=now() WHERE id=$1`, [j.id, actual, randomUUID()]);
      await writeOutbox(tx, { workspaceId: j.workspace_id, aggregateType: 'writeback', aggregateId: j.id, eventType: 'writeback.requested', payload: { jobId: j.id } });
    } else {
      // Keep Notion's value: remember it as seen so the sweep does not immediately re-propose the same write.
      await tx.query(`UPDATE writeback_jobs SET status='skipped', written_fingerprint=$2, desired_fingerprint=desired_fingerprint, error_message='Kept the Notion value', updated_at=now(), completed_at=now() WHERE id=$1`, [j.id, actual]);
    }
    await audit(tx, { workspaceId: j.workspace_id, brandId: j.brand_id, actorUserId: ctx.actor.userId, action: `content_writeback.${decision}`, resourceType: 'writeback_job', resourceId: j.id, correlationId: ctx.correlationId });
    return writebackJson((await maybeOne<JobRow>(tx, `SELECT * FROM writeback_jobs WHERE id=$1`, [j.id]))!);
  });
}

/** True when a Notion change event was authored only by this connection's own bot (echo of Relay writeback). */
export function isOwnEcho(authors: Array<{ id?: string; type?: string }> | undefined, botId: string): boolean {
  return !!authors?.length && authors.every((a) => a.type === 'bot' && a.id === botId);
}

export const RELAY_WRITEBACK_STATUSES = RELAY_STATUS_VALUES;
export const fingerprintOf = (v: unknown) => sha256Hex(stableStringify(v));
