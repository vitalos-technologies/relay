// V3.5 stream B — polling + reconciliation cursors for channels without (or in addition to) webhooks: YouTube comments,
// Bluesky notifications/chat, Threads replies, Google Business Profile reviews. One cursor row per channel
// (integration_cursors.channel_id, scope 'inbox:poll'); the cursor only advances after the page was ingested, so a crash
// re-reads (ingestion dedupes by provider id). Quota-aware: each adapter sets its own minimum interval; failures back
// off; reconnect-type failures mark the channel and stop polling until the account is fixed. Runs in the worker
// (inbox_ingest class, main pool) — never in a page request.
import { AppError } from '@social-lite/core';
import { getInboxAdapter } from '@social-lite/providers';
import { getPool, many, maybeOne } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { log } from '../log.js';
import { recordActivity } from '../connectors/store.js';
import { ChannelUnavailableError, channelRuntime } from './channels-runtime.js';
import { loadChannelFor, toChannelJson } from './channels.js';
import { ingestItems, type IngestResult } from './ingest.js';
import { loadChannelRow, type ChannelRow } from './shared.js';

const SCOPE = 'inbox:poll';
const MAX_BACKOFF_MS = 60 * 60_000;

export const POLL_KINDS = ['youtube', 'bluesky', 'threads', 'google_business_profile'] as const;

interface CursorRow { id: string; cursor: string | null; last_run_at: Date | null; last_success_at: Date | null; last_error: string | null; checkpoint_at: Date | null }

async function cursorOf(ch: ChannelRow): Promise<CursorRow> {
  const r = await maybeOne<CursorRow>(getPool(), `SELECT id, cursor, last_run_at, last_success_at, last_error, checkpoint_at FROM integration_cursors WHERE channel_id=$1 AND scope=$2`, [ch.id, SCOPE]);
  if (r) return r;
  return (await getPool().query<CursorRow>(
    `INSERT INTO integration_cursors(workspace_id, channel_id, scope) VALUES ($1,$2,$3) ON CONFLICT (coalesce(integration_id, channel_id), scope) DO UPDATE SET updated_at=now()
     RETURNING id, cursor, last_run_at, last_success_at, last_error, checkpoint_at`, [ch.workspace_id, ch.id, SCOPE])).rows[0]!;
}

async function summary(ch: ChannelRow, c: { last_run_at: Date | null; last_success_at: Date | null; last_error: string | null }) {
  await getPool().query(`UPDATE inbox_channels SET settings = settings || jsonb_build_object('poll', $2::jsonb), last_sync_at=coalesce($3, last_sync_at) WHERE id=$1`,
    [ch.id, JSON.stringify({ last_run_at: c.last_run_at?.toISOString() ?? null, last_success_at: c.last_success_at?.toISOString() ?? null, last_error: c.last_error }), c.last_success_at]);
}

export type PollOutcome = { state: 'ok'; result: IngestResult; more: boolean } | { state: 'skipped'; reason: string } | { state: 'error'; code: string; message: string };

/** Poll one channel now (worker sweep, or "Check now" by a person with inbox.manage). */
export async function pollChannel(channelId: string): Promise<PollOutcome> {
  const ch = await loadChannelRow(getPool(), channelId);
  if (!ch || ch.disconnected_at) return { state: 'skipped', reason: 'removed' };
  const adapter = getInboxAdapter(ch.kind);
  if (!adapter?.poll) return { state: 'skipped', reason: 'no_polling' };
  if (ch.status !== 'active') return { state: 'skipped', reason: ch.status };
  const cur = await cursorOf(ch);
  const startedAt = new Date();
  try {
    const rt = await channelRuntime(ch);
    const r = await adapter.poll(rt.ctx, rt.creds, rt.conn, { cursor: cur.cursor, types: ch.enabled_types });
    if (!r.ok) {
      const backoff = Math.min(MAX_BACKOFF_MS, r.retryAfterMs ?? 5 * 60_000);
      await getPool().query(`UPDATE integration_cursors SET last_run_at=$2, last_error=$3, checkpoint_at=$4, updated_at=now() WHERE id=$1`, [cur.id, startedAt, `${r.code}: ${r.message}`.slice(0, 300), new Date(Date.now() + backoff)]);
      await recordActivity(getPool(), { workspaceId: ch.workspace_id, channelId: ch.id, kind: 'sync', outcome: r.code === 'rate_limited' ? 'retry' : 'error', code: r.code, message: r.message });
      if (r.reconnect) await getPool().query(`UPDATE inbox_channels SET status='error', status_detail=$2, updated_at=now() WHERE id=$1`, [ch.id, r.message.slice(0, 300)]);
      await summary(ch, { last_run_at: startedAt, last_success_at: cur.last_success_at, last_error: r.message });
      return { state: 'error', code: r.code, message: r.message };
    }
    const res = await ingestItems(ch.kind, r.items, { simulated: ch.is_simulated, channelId: ch.id });
    const now = new Date();
    await getPool().query(`UPDATE integration_cursors SET cursor=$2, last_run_at=$3, last_success_at=$4, last_error=NULL, checkpoint_at=NULL, updated_at=now() WHERE id=$1`, [cur.id, r.cursor, startedAt, now]);
    await summary(ch, { last_run_at: startedAt, last_success_at: now, last_error: null });
    if (res.messages || res.edits) await recordActivity(getPool(), { workspaceId: ch.workspace_id, channelId: ch.id, kind: 'sync', outcome: 'ok', code: 'poll', message: `${res.messages} new, ${res.edits} edited` });
    return { state: 'ok', result: res, more: r.more };
  } catch (err) {
    const msg = err instanceof ChannelUnavailableError ? err.message : 'Polling failed unexpectedly.';
    if (!(err instanceof ChannelUnavailableError)) log.error('inbox_poll_failed', { channelId, err: err as Error });
    await getPool().query(`UPDATE integration_cursors SET last_run_at=$2, last_error=$3, checkpoint_at=$4, updated_at=now() WHERE id=$1`, [cur.id, startedAt, msg.slice(0, 300), new Date(Date.now() + 10 * 60_000)]);
    await summary(ch, { last_run_at: startedAt, last_success_at: cur.last_success_at, last_error: msg });
    return { state: 'error', code: err instanceof ChannelUnavailableError ? err.code : 'internal', message: msg };
  }
}

/** Worker sweep: channels whose interval elapsed and whose backoff (checkpoint_at) passed. Bounded per run. */
export async function sweepPolls(limit = 20): Promise<number> {
  const rows = await many<{ id: string; kind: ChannelRow['kind']; last_run_at: Date | null; checkpoint_at: Date | null }>(getPool(),
    `SELECT ch.id, ch.kind, c.last_run_at, c.checkpoint_at FROM inbox_channels ch LEFT JOIN integration_cursors c ON c.channel_id=ch.id AND c.scope=$1
      WHERE ch.disconnected_at IS NULL AND ch.status='active' AND ch.kind = ANY($2::text[]) AND (c.checkpoint_at IS NULL OR c.checkpoint_at <= now())
      ORDER BY c.last_run_at NULLS FIRST LIMIT 200`, [SCOPE, POLL_KINDS]);
  let n = 0;
  for (const r of rows) {
    const every = getInboxAdapter(r.kind)?.pollIntervalMs ?? 5 * 60_000;
    if (r.last_run_at && Date.now() - r.last_run_at.getTime() < every) continue;
    await pollChannel(r.id);
    if (++n >= limit) break;
  }
  return n;
}

/** "Check now" (inbox.manage): runs one poll immediately for a polling channel. */
export async function pollChannelNow(ctx: Ctx, channelId: string) {
  const ch = await loadChannelFor(ctx, channelId, 'inbox.manage');
  if (!getInboxAdapter(ch.kind)?.poll) throw new AppError('validation_failed', 'This channel receives messages by webhook.');
  const out = await pollChannel(ch.id);
  const row = await loadChannelRow(getPool(), ch.id);
  return { outcome: out, channel: toChannelJson(row!) };
}
