// Worker entry points for Content Hub queues (registered in apps/worker/src/main.ts):
//   source-import  — imports, refreshes and Drive change signals
//   report-export  — exports to Google Docs / Drive / Notion
//   writeback      — field-scoped Notion writeback
// Jobs carry only ids; every handler reloads the row and re-checks scope/authority (never trusts queue payloads).
// Per-workspace concurrency: one running job per workload class per workspace (advisory lock); busy ⇒ retried later.
import { getPool } from '@social-lite/db';
import { log } from '../log.js';
import { runExport } from './exports.js';
import { RetryLaterError, runImport } from './imports.js';
import { sweepSnapshotRetention } from './items.js';
import { processDriveChanges, renewDriveChannels } from './webhooks.js';
import { runWriteback, syncWritebacks } from './writeback.js';
import './fakes.js'; // registers the labelled demo transport for 'test' connections (refused in production)

export const QUEUE_SOURCE_IMPORT = 'source-import';
export const QUEUE_REPORT_EXPORT = 'report-export';
export const QUEUE_WRITEBACK = 'writeback';

/** Outbox event type → Content Hub queue. */
export const CONTENT_HUB_EVENT_QUEUES: Record<string, string> = {
  'source.import_requested': QUEUE_SOURCE_IMPORT,
  'source.changes_signal': QUEUE_SOURCE_IMPORT,
  'export.requested': QUEUE_REPORT_EXPORT,
  'writeback.requested': QUEUE_WRITEBACK,
};

async function workspaceOf(sql: string, id: string): Promise<string | null> {
  const r = await getPool().query<{ workspace_id: string }>(sql, [id]);
  return r.rows[0]?.workspace_id ?? null;
}

/** Run fn holding the (queue, workspace) slot; throws RetryLaterError when another job of the class is running. */
export async function withWorkspaceSlot<T>(queue: string, workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  const key = `content-hub:${queue}:${workspaceId}`;
  try {
    const got = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok', [key]);
    if (!got.rows[0]?.ok) throw new RetryLaterError('workspace slot busy', 5);
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

export interface ContentHubJob { eventType: string; aggregateId: string; workspaceId: string | null }

/** Dispatch one queued Content Hub job. Throws for retryable failures (pg-boss retries with backoff). */
export async function handleContentHubJob(job: ContentHubJob): Promise<void> {
  const { eventType, aggregateId } = job;
  switch (eventType) {
    case 'source.import_requested': {
      const ws = await workspaceOf(`SELECT workspace_id FROM imports WHERE id=$1`, aggregateId);
      if (!ws) return;
      await withWorkspaceSlot(QUEUE_SOURCE_IMPORT, ws, () => runImport(aggregateId));
      return;
    }
    case 'source.changes_signal': {
      const ws = await workspaceOf(`SELECT workspace_id FROM sync_checkpoints WHERE id=$1`, aggregateId);
      if (!ws) return;
      await withWorkspaceSlot(QUEUE_SOURCE_IMPORT, ws, () => processDriveChanges(aggregateId));
      return;
    }
    case 'export.requested': {
      const ws = await workspaceOf(`SELECT workspace_id FROM export_jobs WHERE id=$1`, aggregateId);
      if (!ws) return;
      await withWorkspaceSlot(QUEUE_REPORT_EXPORT, ws, () => runExport(aggregateId));
      return;
    }
    case 'writeback.requested': {
      const ws = await workspaceOf(`SELECT workspace_id FROM writeback_jobs WHERE id=$1`, aggregateId);
      if (!ws) return;
      await withWorkspaceSlot(QUEUE_WRITEBACK, ws, () => runWriteback(aggregateId));
      return;
    }
    default:
      log.warn('content_hub_unknown_job', { eventType });
  }
}

/** Periodic maintenance (worker timers): writeback sweep, channel renewal, snapshot retention. */
export async function runContentHubSweeps(): Promise<void> {
  const queued = await syncWritebacks({ limit: 200 });
  const renewed = await renewDriveChannels(25);
  const expired = await sweepSnapshotRetention(getPool(), 200);
  if (queued || renewed || expired) log.info('content_hub_sweep', { writebacks_queued: queued, channels_renewed: renewed, snapshots_expired: expired });
}
