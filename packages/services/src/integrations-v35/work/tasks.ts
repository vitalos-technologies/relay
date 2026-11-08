// External work items (brief §4): create an Asana task / monday.com item from a post, campaign, conversation, case or
// listening alert; link an existing one; show its external status; push Relay edits; pull external changes.
// Synchronization contract (docs/v3-5/INTEGRATIONS.md):
//  - Default: every field flows Relay → external only. A field syncs back only when an explicit mapping says
//    external_to_relay / two_way (TASK_SYNC_FIELDS: title, due_on, status). Owner/assignee is protected (one-way).
//  - Loop prevention: pulls never enqueue pushes; every push stores the hash of what the provider then reports, so its
//    webhook echo is recognised and dropped; the origin marker (relay:<job id>) identifies Relay-created records.
//  - Conflicts: if Relay has unsynced edits on a field that also changed externally, the mapping's conflict rule applies
//    (manual_review by default) — never last-write-wins.
//  - An external "Done" only changes this work item. It never approves, schedules or publishes content.
//  - Deletion / lost access: the Relay record is kept and the link marked unavailable.
import { createHash, randomUUID } from 'node:crypto';
import { AppError, notFound } from '@social-lite/core';
import type { FieldMapping, SyncOutcome } from '@social-lite/core/contracts/v35-connectors';
import type { ExternalTaskJson, OutboundPreviewJson, TaskPriority, TaskRelayType, TaskStatus } from '@social-lite/core/contracts/v35-integrations';
import { getPool, many, maybeOne, one, withTx, type Queryable } from '@social-lite/db';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { audit } from '../../audit.js';
import { assertUuid, brandAllowed } from '../../tenancy.js';
import { CONNECTORS, enqueueSyncJob, loadIntegration, recordActivity, registerInboundHandler, registerSyncExecutor, upsertExternalLink } from '../../connectors/index.js';
import { appErrorFrom, openConn, outcomeFromError } from '../core/runtime.js';
import { loadRelayObject, safeSummary } from '../core/relay-objects.js';
import { isNotFound, TASK_PROVIDERS, type ColumnMap, type ExtTask } from './providers.js';

type TaskConnector = 'asana' | 'monday';
export interface TaskRow {
  id: string; workspace_id: string; brand_id: string | null; integration_id: string; connector: TaskConnector; relay_type: TaskRelayType; relay_id: string;
  resource_id: string | null; external_id: string | null; external_url: string | null; title: string; description: string | null; due_on: string | null;
  priority: TaskPriority; status: TaskStatus; external_status: string | null; external_assignee: string | null; link_state: ExternalTaskJson['link_state'];
  link_detail: string | null; relay_version: number; synced_relay_version: number; last_pushed_hash: string | null; last_pulled_hash: string | null;
  external_modified_at: Date | null; last_pulled_at: Date | null; conflict: ExternalTaskJson['conflict']; idempotency_key: string; created_at: Date;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const dateStr = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : (d as string | null) ?? null);
const hashOf = (f: { title: string; due_on: string | null; status: TaskStatus }) => createHash('sha256').update(JSON.stringify([f.title, f.due_on, f.status])).digest('hex').slice(0, 32);

function toJson(r: TaskRow & { resource_name?: string | null; is_simulated?: boolean }): ExternalTaskJson {
  return {
    id: r.id, integration_id: r.integration_id, connector: r.connector, relay_type: r.relay_type, relay_id: r.relay_id, resource_id: r.resource_id, resource_name: r.resource_name ?? null,
    external_id: r.external_id, external_url: r.external_url, title: r.title, description: r.description, due_on: dateStr(r.due_on), priority: r.priority, status: r.status,
    external_status: r.external_status, external_assignee: r.external_assignee, link_state: r.link_state, link_detail: r.link_detail,
    in_sync: r.link_state === 'linked' && r.synced_relay_version >= r.relay_version && !r.conflict, conflict: r.conflict, last_pulled_at: iso(r.last_pulled_at), is_simulated: !!r.is_simulated, version: r.relay_version,
  };
}

const SELECT = `SELECT t.*, r.name AS resource_name, i.is_simulated FROM integration_tasks t JOIN integration_connections i ON i.id=t.integration_id LEFT JOIN integration_resources r ON r.id=t.resource_id`;

// ------------------------------------------------------------------ inputs
export const createTaskSchema = z.object({
  integration_id: z.string().uuid(), relay_type: z.enum(['post', 'campaign', 'conversation', 'case', 'listening_alert', 'insight']), relay_id: z.string().uuid(),
  resource_id: z.string().uuid(), title: z.string().trim().min(1).max(255), description: z.string().max(4000).optional(), due_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'), assignee_external_id: z.string().max(80).nullable().optional(), group_id: z.string().max(80).nullable().optional(),
  idempotency_key: z.string().min(8).max(120).optional(),
}).strict();

export const linkTaskSchema = z.object({ integration_id: z.string().uuid(), relay_type: createTaskSchema.shape.relay_type, relay_id: z.string().uuid(), resource_id: z.string().uuid(), external_ref: z.string().min(1).max(500) }).strict();
export const updateTaskSchema = z.object({ expected_version: z.number().int(), title: z.string().trim().min(1).max(255).optional(), due_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(), status: z.enum(['open', 'in_progress', 'done']).optional(), resolve_conflict: z.enum(['keep_relay', 'take_external']).optional() }).strict();

async function usableTaskIntegration(ctx: Ctx, integrationId: string, resourceId: string, db: Queryable) {
  const integ = await loadIntegration(ctx, integrationId, 'integrations.read', db);
  if (integ.connector !== 'asana' && integ.connector !== 'monday') throw new AppError('validation_failed', 'Choose an Asana or monday.com integration.');
  if (integ.disconnected_at || integ.status === 'reconnect_required') throw new AppError('invalid_state', 'Reconnect this integration first.');
  const res = await maybeOne<{ id: string; external_id: string; name: string; resource_type: string; selected: boolean; access_state: string }>(db,
    `SELECT id, external_id, name, resource_type, selected, access_state FROM integration_resources WHERE id=$1 AND integration_id=$2`, [resourceId, integrationId]);
  if (!res || !res.selected || !['project', 'board'].includes(res.resource_type)) throw new AppError('validation_failed', 'Choose a project or board selected for this integration.');
  if (res.access_state !== 'ok') throw new AppError('invalid_state', 'That project or board is no longer accessible.');
  return { integ, res };
}

/** What would leave Relay (shown before creating). */
export async function previewTask(ctx: Ctx, input: z.input<typeof createTaskSchema>): Promise<OutboundPreviewJson> {
  const obj = await loadRelayObject(ctx, input.relay_type, input.relay_id);
  const { integ, res } = await usableTaskIntegration(ctx, input.integration_id, input.resource_id, getPool());
  if (integ.brand_id && integ.brand_id !== obj.brandId) throw notFound('Integration');
  const desc = input.description ?? safeSummary(obj);
  return {
    connector: integ.connector, destination: `${CONNECTORS[integ.connector].name} · ${res.name}`,
    fields: [{ label: 'Title', value: input.title }, { label: 'Description', value: desc }, { label: 'Due', value: input.due_on ?? '—' }, { label: 'Priority', value: input.priority ?? 'normal' },
      ...(input.assignee_external_id ? [{ label: 'Assignee', value: input.assignee_external_id }] : [])],
    excluded: input.relay_type === 'conversation' || input.relay_type === 'case' ? ['Customer messages', 'Customer contact details', 'Internal notes'] : ['Internal comments', 'Media files'],
  };
}

export async function createExternalTask(ctx: Ctx, input: z.input<typeof createTaskSchema>): Promise<{ task: ExternalTaskJson; created: boolean }> {
  const obj = await loadRelayObject(ctx, input.relay_type, input.relay_id);
  const out = await withTx(async (tx) => {
    const { integ, res } = await usableTaskIntegration(ctx, input.integration_id, input.resource_id, tx);
    if (integ.brand_id && integ.brand_id !== obj.brandId) throw notFound('Integration');
    const key = input.idempotency_key ?? `${integ.connector}:${obj.type}:${obj.id}:${res.id}`;
    const existing = await maybeOne<TaskRow>(tx, `SELECT * FROM integration_tasks WHERE workspace_id=$1 AND idempotency_key=$2`, [ctx.access.workspaceId, key]);
    if (existing) return { id: existing.id, created: false };
    const id = randomUUID();
    await tx.query(
      `INSERT INTO integration_tasks(id, workspace_id, brand_id, integration_id, connector, relay_type, relay_id, resource_id, title, description, due_on, priority, idempotency_key, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, ctx.access.workspaceId, obj.brandId, integ.id, integ.connector, obj.type, obj.id, res.id, input.title, input.description ?? safeSummary(obj), input.due_on ?? null, input.priority ?? 'normal', key, ctx.actor.userId]);
    await enqueueSyncJob(ctx, { integrationId: integ.id, kind: `${integ.connector}.task`, relayType: obj.type, relayId: obj.id, idempotencyKey: `task:${id}:create`,
      payload: { task_id: id, assignee: input.assignee_external_id ?? null, group: input.group_id ?? null } }, tx);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: obj.brandId, actorUserId: ctx.actor.userId, action: 'integration.task_requested', resourceType: obj.type, resourceId: obj.id,
      diff: { connector: integ.connector, task_id: id, resource: res.name }, correlationId: ctx.correlationId });
    return { id, created: true };
  });
  return { task: await getExternalTask(ctx, out.id), created: out.created };
}

export async function getExternalTask(ctx: Ctx, id: string, db: Queryable = getPool()): Promise<ExternalTaskJson> {
  assertUuid(id, 'Task');
  const r = await maybeOne<TaskRow & { resource_name: string | null; is_simulated: boolean }>(db, `${SELECT} WHERE t.id=$1 AND t.workspace_id=$2`, [id, ctx.access.workspaceId]);
  if (!r || (r.brand_id && !brandAllowed(ctx, r.brand_id))) throw notFound('Task');
  await loadIntegration(ctx, r.integration_id, 'integrations.read', db);
  return toJson(r);
}

export async function listExternalTasks(ctx: Ctx, relayType: string, relayId: string): Promise<{ items: ExternalTaskJson[] }> {
  assertUuid(relayId, 'Item');
  await loadRelayObject(ctx, relayType as TaskRelayType, relayId, 'integrations.read');
  const rows = await many<TaskRow & { resource_name: string | null; is_simulated: boolean }>(getPool(),
    `${SELECT} WHERE t.workspace_id=$1 AND t.relay_type=$2 AND t.relay_id=$3 AND t.link_state <> 'unlinked' ORDER BY t.created_at`, [ctx.access.workspaceId, relayType, relayId]);
  return { items: rows.filter((r) => !r.brand_id || brandAllowed(ctx, r.brand_id)).map(toJson) };
}

async function loadTaskForWrite(ctx: Ctx, id: string, tx: Queryable): Promise<TaskRow> {
  assertUuid(id, 'Task');
  const r = await maybeOne<TaskRow>(tx, `SELECT * FROM integration_tasks WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [id, ctx.access.workspaceId]);
  if (!r || (r.brand_id && !brandAllowed(ctx, r.brand_id))) throw notFound('Task');
  await loadRelayObject(ctx, r.relay_type, r.relay_id, undefined, tx);
  await loadIntegration(ctx, r.integration_id, 'integrations.read', tx);
  return r;
}

/** Relay-side edit → push (only Relay-owned or two-way fields leave Relay; external-owned fields are refused). */
export async function updateExternalTask(ctx: Ctx, id: string, input: z.infer<typeof updateTaskSchema>): Promise<ExternalTaskJson> {
  await withTx(async (tx) => {
    const r = await loadTaskForWrite(ctx, id, tx);
    if (r.relay_version !== input.expected_version) throw new AppError('version_conflict', 'This task changed. Reload and try again.');
    if (r.link_state === 'unlinked') throw new AppError('invalid_state', 'This task is no longer linked.');
    const maps = await mappingsFor(tx, r);
    for (const f of ['title', 'due_on', 'status'] as const) {
      if (input[f] !== undefined && maps[f]?.direction === 'external_to_relay') throw new AppError('validation_failed', `"${f}" is owned by ${CONNECTORS[r.connector].name} for this mapping.`);
    }
    let conflict = r.conflict;
    if (input.resolve_conflict && conflict) {
      if (input.resolve_conflict === 'take_external') {
        const ext = conflict as Record<string, { external: unknown }>;
        await tx.query(`UPDATE integration_tasks SET title=coalesce($2,title), due_on=CASE WHEN $3 THEN $4::date ELSE due_on END, status=coalesce($5,status), conflict=NULL, synced_relay_version=relay_version, updated_at=now() WHERE id=$1`,
          [id, (ext.title?.external as string) ?? null, 'due_on' in ext, (ext.due_on?.external as string | null) ?? null, (ext.status?.external as string) ?? null]);
        return;
      }
      conflict = null;
    }
    const v = await one<{ relay_version: number }>(tx,
      `UPDATE integration_tasks SET title=coalesce($2,title), due_on=CASE WHEN $3 THEN $4::date ELSE due_on END, priority=coalesce($5,priority), status=coalesce($6,status),
              conflict=$7, relay_version=relay_version+1, updated_at=now() WHERE id=$1 RETURNING relay_version`,
      [id, input.title ?? null, input.due_on !== undefined, input.due_on ?? null, input.priority ?? null, input.status ?? null, conflict ? JSON.stringify(conflict) : null]);
    if (r.external_id && r.link_state === 'linked') {
      await enqueueSyncJob(ctx, { integrationId: r.integration_id, kind: `${r.connector}.push_task`, relayType: r.relay_type, relayId: r.relay_id, idempotencyKey: `task:${id}:push:v${v.relay_version}`, payload: { task_id: id } }, tx);
    }
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: r.brand_id, actorUserId: ctx.actor.userId, action: 'integration.task_updated', resourceType: r.relay_type, resourceId: r.relay_id, diff: { task_id: id, fields: Object.keys(input).filter((k) => k !== 'expected_version') }, correlationId: ctx.correlationId });
  });
  return getExternalTask(ctx, id);
}

export async function linkExistingTask(ctx: Ctx, input: z.infer<typeof linkTaskSchema>): Promise<ExternalTaskJson> {
  const obj = await loadRelayObject(ctx, input.relay_type, input.relay_id);
  const { integ, res } = await usableTaskIntegration(ctx, input.integration_id, input.resource_id, getPool());
  if (integ.brand_id && integ.brand_id !== obj.brandId) throw notFound('Integration');
  const prov = TASK_PROVIDERS[integ.connector as TaskConnector];
  const extId = prov.parseRef(input.external_ref);
  if (!extId) throw new AppError('validation_failed', `Paste a ${CONNECTORS[integ.connector].name} link or id.`, { external_ref: 'Not recognised' });
  const c = await openConn(integ.id);
  let t: ExtTask;
  try { t = await prov.get(c, extId, await columnMapFor(getPool(), integ.id, res.id)); } catch (err) { throw await appErrorFrom(err, c); }
  const id = randomUUID();
  await withTx(async (tx) => {
    const dup = await maybeOne(tx, `SELECT 1 FROM integration_tasks WHERE integration_id=$1 AND external_id=$2 AND link_state <> 'unlinked'`, [integ.id, t.id]);
    if (dup) throw new AppError('conflict', 'That task is already linked to a Relay item.');
    await tx.query(
      `INSERT INTO integration_tasks(id, workspace_id, brand_id, integration_id, connector, relay_type, relay_id, resource_id, external_id, external_url, title, due_on, status, external_status, external_assignee,
              link_state, synced_relay_version, last_pulled_hash, last_pulled_at, external_modified_at, idempotency_key, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'linked',1,$16,now(),$17,$18,$19)`,
      [id, ctx.access.workspaceId, obj.brandId, integ.id, integ.connector, obj.type, obj.id, res.id, t.id, t.url, t.title.slice(0, 255) || 'Untitled', t.due_on, t.status, t.status_label, t.assignee,
        hashOf(t), t.modified_at, `link:${integ.id}:${t.id}:${id}`, ctx.actor.userId]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: obj.brandId, actorUserId: ctx.actor.userId, action: 'integration.task_linked', resourceType: obj.type, resourceId: obj.id, diff: { task_id: id, external_id: t.id }, correlationId: ctx.correlationId });
  });
  return getExternalTask(ctx, id);
}

/** Reversible + audited: the external task is untouched; Relay stops tracking it. */
export async function unlinkExternalTask(ctx: Ctx, id: string): Promise<void> {
  await withTx(async (tx) => {
    const r = await loadTaskForWrite(ctx, id, tx);
    await loadIntegration(ctx, r.integration_id, 'integrations.manage', tx).catch(() => { throw new AppError('forbidden', 'Only people who manage this integration can unlink tasks.'); });
    await tx.query(`UPDATE integration_tasks SET link_state='unlinked', link_detail='Unlinked in Relay', updated_at=now() WHERE id=$1`, [id]);
    await audit(tx, { workspaceId: ctx.access.workspaceId, brandId: r.brand_id, actorUserId: ctx.actor.userId, action: 'integration.task_unlinked', resourceType: r.relay_type, resourceId: r.relay_id, diff: { task_id: id, external_id: r.external_id }, correlationId: ctx.correlationId });
  });
}

/** Explicit refresh (person-initiated): read the external record now. */
export async function refreshExternalTask(ctx: Ctx, id: string): Promise<ExternalTaskJson> {
  const r = await getExternalTask(ctx, id);
  if (!r.external_id) return r;
  await pullTask(id, 'manual');
  return getExternalTask(ctx, id);
}

// ------------------------------------------------------------------ mappings
type MapRow = Pick<FieldMapping, 'relay_field' | 'external_field' | 'direction' | 'conflict' | 'source_of_truth' | 'on_delete' | 'enabled'>;

async function mappingsFor(db: Queryable, r: Pick<TaskRow, 'integration_id' | 'resource_id'>): Promise<Partial<Record<'title' | 'due_on' | 'status' | 'priority', MapRow>>> {
  const rows = await many<MapRow & { resource_id: string | null }>(db,
    `SELECT relay_field, external_field, direction, conflict, source_of_truth, on_delete, enabled, resource_id FROM integration_field_mappings
      WHERE integration_id=$1 AND relay_object='task' AND enabled AND (resource_id IS NULL OR resource_id=$2) ORDER BY resource_id NULLS FIRST`, [r.integration_id, r.resource_id]);
  const out: Partial<Record<'title' | 'due_on' | 'status' | 'priority', MapRow>> = {};
  for (const m of rows) if (['title', 'due_on', 'status', 'priority'].includes(m.relay_field)) out[m.relay_field as 'title'] = m;   // resource-specific overrides workspace default
  return out;
}

async function columnMapFor(db: Queryable, integrationId: string, resourceId: string | null): Promise<ColumnMap> {
  const m = await mappingsFor(db, { integration_id: integrationId, resource_id: resourceId });
  const cols: ColumnMap = {};
  for (const k of ['title', 'due_on', 'status', 'priority'] as const) if (m[k]) cols[k] = m[k]!.external_field;
  return cols;
}

// ------------------------------------------------------------------ executors (worker)
async function loadTask(id: string): Promise<(TaskRow & { resource_external_id: string | null }) | null> {
  return maybeOne(getPool(), `SELECT t.*, r.external_id AS resource_external_id FROM integration_tasks t LEFT JOIN integration_resources r ON r.id=t.resource_id WHERE t.id=$1`, [id]);
}

async function runCreate(job: { id: string; integrationId: string; payload: Record<string, unknown>; originMarker: string }): Promise<SyncOutcome> {
  const r = await loadTask(String(job.payload.task_id));
  if (!r) return { kind: 'failed', code: 'not_found', message: 'The Relay task request no longer exists.' };
  if (r.external_id) return { kind: 'succeeded', result: { external_id: r.external_id, already: true } };
  if (!r.resource_external_id) return { kind: 'failed', code: 'resource_missing', message: 'The project or board is no longer selected.' };
  const prov = TASK_PROVIDERS[r.connector];
  let c;
  try { c = await openConn(job.integrationId); } catch (err) { return outcomeFromError(err, { integrationId: job.integrationId, workspaceId: r.workspace_id }, false); }
  try {
    const cols = await columnMapFor(getPool(), r.integration_id, r.resource_id);
    const t = await prov.create(c, { resource: r.resource_external_id, group: (job.payload.group as string | null) ?? null, title: r.title, description: r.description ?? '', dueOn: dateStr(r.due_on),
      priority: r.priority, status: r.status, assignee: (job.payload.assignee as string | null) ?? null, marker: job.originMarker, columns: cols });
    await applyLinked(r, t, r.relay_version);
    return { kind: 'succeeded', result: { external_id: t.id, external_url: t.url } };
  } catch (err) {
    const o = await outcomeFromError(err, c, true);
    if (o.kind === 'failed') await getPool().query(`UPDATE integration_tasks SET link_state='failed', link_detail=$2, updated_at=now() WHERE id=$1`, [r.id, o.message]);
    return o;
  }
}

async function applyLinked(r: TaskRow, t: ExtTask, pushedVersion: number): Promise<void> {
  const h = hashOf(t);
  await getPool().query(
    `UPDATE integration_tasks SET external_id=$2, external_url=$3, link_state='linked', link_detail=NULL, synced_relay_version=greatest(synced_relay_version,$4), last_pushed_hash=$5, last_pulled_hash=$5,
            external_status=$6, external_assignee=$7, external_modified_at=$8, last_pulled_at=now(), updated_at=now() WHERE id=$1`,
    [r.id, t.id, t.url, pushedVersion, h, t.status_label, t.assignee, t.modified_at]);
}

async function reconcileCreate(job: { id: string; integrationId: string; originMarker: string; payload: Record<string, unknown> }) {
  const r = await loadTask(String(job.payload.task_id));
  if (!r?.resource_external_id) return { found: false as const };
  const c = await openConn(job.integrationId);
  const t = await TASK_PROVIDERS[r.connector].findByMarker(c, r.resource_external_id, job.originMarker, await columnMapFor(getPool(), r.integration_id, r.resource_id));
  if (!t) return { found: false as const };
  await applyLinked(r, t, r.relay_version);
  // The task row is the link record (several tasks may exist per Relay item), so the job is settled here instead of
  // through the generic external_links path (whose one-record-per-type rule fits tickets/campaigns, not tasks).
  await getPool().query(`UPDATE integration_sync_jobs SET state='succeeded', external_id=$2, external_url=$3, result='{"reconciled":true}'::jsonb, finished_at=now(), updated_at=now() WHERE id=$1 AND state='unknown'`, [job.id, t.id, t.url]);
  await recordActivity(getPool(), { workspaceId: r.workspace_id, integrationId: r.integration_id, kind: 'sync', outcome: 'ok', code: 'reconciled', jobId: job.id });
  return { found: false as const };
}

async function runPush(job: { integrationId: string; payload: Record<string, unknown> }): Promise<SyncOutcome> {
  const r = await loadTask(String(job.payload.task_id));
  if (!r || !r.external_id || r.link_state !== 'linked') return { kind: 'failed', code: 'not_linked', message: 'The task is not linked.' };
  if (r.synced_relay_version >= r.relay_version) return { kind: 'succeeded', result: { noop: true } };
  if (r.conflict) return { kind: 'failed', code: 'conflict', message: 'Resolve the conflict in Relay first.' };
  let c;
  try { c = await openConn(job.integrationId); } catch (err) { return outcomeFromError(err, { integrationId: job.integrationId, workspaceId: r.workspace_id }, false); }
  try {
    const maps = await mappingsFor(getPool(), r);
    const fields: Partial<{ title: string; due_on: string | null; status: TaskStatus; priority: TaskPriority }> = {};
    // Relay → external: all fields except those explicitly owned by the provider.
    if (maps.title?.direction !== 'external_to_relay') fields.title = r.title;
    if (maps.due_on?.direction !== 'external_to_relay') fields.due_on = dateStr(r.due_on);
    if (maps.status?.direction !== 'external_to_relay') fields.status = r.status;
    if (maps.priority) fields.priority = r.priority;
    const t = await TASK_PROVIDERS[r.connector].update(c, r.external_id, r.resource_external_id ?? '', fields, await columnMapFor(getPool(), r.integration_id, r.resource_id));
    await applyLinked(r, t, r.relay_version);
    return { kind: 'succeeded', result: { pushed: Object.keys(fields) } };
  } catch (err) {
    if (isNotFound(err)) { await markUnavailable(r, 'The external task was deleted or is no longer accessible.'); return { kind: 'failed', code: 'not_found', message: 'The external task no longer exists.' }; }
    return outcomeFromError(err, c, true);
  }
}

async function markUnavailable(r: Pick<TaskRow, 'id' | 'workspace_id' | 'integration_id'>, detail: string): Promise<void> {
  await getPool().query(`UPDATE integration_tasks SET link_state='unavailable', link_detail=$2, updated_at=now() WHERE id=$1 AND link_state <> 'unlinked'`, [r.id, detail]);
  await recordActivity(getPool(), { workspaceId: r.workspace_id, integrationId: r.integration_id, kind: 'sync', outcome: 'error', code: 'external_unavailable', message: detail });
}

/**
 * Pull the external state (webhook, poll or manual refresh). Applies only explicitly mapped external_to_relay /
 * two_way fields; never enqueues a push (loop prevention). Returns what happened.
 */
export async function pullTask(taskId: string, source: 'webhook' | 'poll' | 'manual'): Promise<'echo' | 'unchanged' | 'applied' | 'conflict' | 'unavailable' | 'skipped'> {
  const r = await loadTask(taskId);
  if (!r || !r.external_id || r.link_state === 'unlinked' || r.link_state === 'pending') return 'skipped';
  let c;
  try { c = await openConn(r.integration_id); } catch { return 'skipped'; }
  let t: ExtTask;
  try { t = await TASK_PROVIDERS[r.connector].get(c, r.external_id, await columnMapFor(getPool(), r.integration_id, r.resource_id)); } catch (err) {
    if (isNotFound(err)) { await markUnavailable(r, 'The external task was deleted or is no longer accessible.'); return 'unavailable'; }
    const o = await outcomeFromError(err, c, false);
    await recordActivity(getPool(), { workspaceId: r.workspace_id, integrationId: r.integration_id, kind: 'sync', outcome: o.kind === 'retry' ? 'retry' : 'error', code: o.kind === 'succeeded' ? null : o.code, message: o.kind === 'succeeded' ? null : o.message });
    if (source !== 'manual') throw err;
    throw await appErrorFrom(err, c);
  }
  const h = hashOf(t);
  const display = [t.status_label, t.assignee, t.modified_at, t.url] as const;
  if (h === r.last_pushed_hash || h === r.last_pulled_hash) {
    await getPool().query(`UPDATE integration_tasks SET external_status=$2, external_assignee=$3, external_modified_at=$4, external_url=coalesce($5,external_url), last_pulled_at=now(),
                            link_state='linked', link_detail=NULL WHERE id=$1`, [r.id, ...display]);
    return h === r.last_pushed_hash ? 'echo' : 'unchanged';
  }
  const maps = await mappingsFor(getPool(), r);
  const relayDirty = r.relay_version > r.synced_relay_version;
  const apply: Partial<Record<'title' | 'due_on' | 'status', unknown>> = {};
  const conflicts: Record<string, { relay: unknown; external: unknown }> = { ...(r.conflict ?? {}) };
  const cur = { title: r.title, due_on: dateStr(r.due_on), status: r.status };
  for (const f of ['title', 'due_on', 'status'] as const) {
    const m = maps[f];
    if (!m || (m.direction !== 'external_to_relay' && m.direction !== 'two_way')) continue;
    if (t[f] === cur[f]) continue;
    if (relayDirty) {
      if (m.conflict === 'skip') continue;
      if (m.conflict === 'source_wins') { if (m.source_of_truth === 'external') apply[f] = t[f]; continue; }
      conflicts[f] = { relay: cur[f], external: t[f] };
      continue;
    }
    apply[f] = t[f];
  }
  const hasConflict = Object.keys(conflicts).length > 0;
  await withTx(async (tx) => {
    await tx.query(
      `UPDATE integration_tasks SET title=coalesce($2,title), due_on=CASE WHEN $3 THEN $4::date ELSE due_on END, status=coalesce($5,status), conflict=$6,
              last_pulled_hash=$7, external_status=$8, external_assignee=$9, external_modified_at=$10, external_url=coalesce($11,external_url), last_pulled_at=now(), link_state='linked', link_detail=NULL,
              updated_at=now() WHERE id=$1`,
      [r.id, (apply.title as string | undefined) ?? null, 'due_on' in apply, (apply.due_on as string | null | undefined) ?? null, (apply.status as string | undefined) ?? null,
        hasConflict ? JSON.stringify(conflicts) : null, h, ...display]);
    if (Object.keys(apply).length || hasConflict) {
      await audit(tx, { workspaceId: r.workspace_id, brandId: r.brand_id, actorService: `integration:${r.connector}`, action: hasConflict ? 'integration.task_conflict' : 'integration.task_pulled',
        resourceType: r.relay_type, resourceId: r.relay_id, diff: { task_id: r.id, fields: Object.keys(apply), conflicts: Object.keys(conflicts), source }, correlationId: null });
    }
  });
  return hasConflict ? 'conflict' : Object.keys(apply).length ? 'applied' : 'unchanged';
}

/** Polling fallback (Asana webhooks are at-most-once; monday webhooks may be absent): oldest-first, bounded. */
export async function pollLinkedTasks(limit = 20): Promise<number> {
  const rows = await many<{ id: string }>(getPool(),
    `SELECT t.id FROM integration_tasks t JOIN integration_connections i ON i.id=t.integration_id
      WHERE t.link_state IN ('linked','unavailable') AND t.external_id IS NOT NULL AND NOT i.paused AND i.disconnected_at IS NULL AND i.status NOT IN ('reconnect_required')
        AND (t.last_pulled_at IS NULL OR t.last_pulled_at < now() - interval '15 minutes') ORDER BY t.last_pulled_at NULLS FIRST LIMIT $1`, [limit]);
  let n = 0;
  for (const r of rows) { try { await pullTask(r.id, 'poll'); n++; } catch { /* recorded in activity */ } }
  return n;
}

// ------------------------------------------------------------------ registration
export function registerTaskSync(): void {
  for (const connector of ['asana', 'monday'] as const) {
    registerSyncExecutor({ kind: `${connector}.task`, run: runCreate, reconcile: reconcileCreate });
    registerSyncExecutor({ kind: `${connector}.push_task`, run: runPush });
  }
  registerInboundHandler({
    connector: 'asana',
    async handle(e) {
      if (e.origin === 'relay_echo' || !e.integrationId) return { outcome: 'ignored', detail: 'echo or unknown installation' };
      const events = ((e.body as { events?: Array<{ resource?: { gid?: string; resource_type?: string } }> })?.events ?? []).filter((x) => x.resource?.resource_type !== 'story');
      const gids = [...new Set(events.map((x) => x.resource?.gid).filter((g): g is string => !!g))];
      if (!gids.length) return { outcome: 'ignored', detail: 'heartbeat' };
      const tasks = await many<{ id: string }>(getPool(), `SELECT id FROM integration_tasks WHERE integration_id=$1 AND external_id = ANY($2::text[]) AND link_state <> 'unlinked'`, [e.integrationId, gids]);
      for (const t of tasks) await pullTask(t.id, 'webhook');
      return { outcome: tasks.length ? 'processed' : 'ignored', detail: `${tasks.length} linked task(s)` };
    },
  });
  registerInboundHandler({
    connector: 'monday',
    async handle(e) {
      if (e.origin === 'relay_echo' || !e.integrationId) return { outcome: 'ignored', detail: 'echo or unknown installation' };
      const ev = (e.body as { event?: { pulseId?: number | string } })?.event;
      if (!ev?.pulseId) return { outcome: 'ignored' };
      const tasks = await many<{ id: string }>(getPool(), `SELECT id FROM integration_tasks WHERE integration_id=$1 AND external_id=$2 AND link_state <> 'unlinked'`, [e.integrationId, String(ev.pulseId)]);
      for (const t of tasks) await pullTask(t.id, 'webhook');
      return { outcome: tasks.length ? 'processed' : 'ignored' };
    },
  });
}

/** Foundation link helper re-exported for HubSpot/Mailchimp/GBP modules that link one record per Relay object. */
export { upsertExternalLink };
