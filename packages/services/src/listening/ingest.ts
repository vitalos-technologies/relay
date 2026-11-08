// Connected-source ingestion (stream D). Inbox → listening, on the bulk pool ('listening-ingest', listening_ingest class):
//  1. fast path: onInboxEvent('inbox.message_received') → outbox 'listening.ingest_requested' (public kinds only) →
//     'listening-ingest' queue → observeMessage(id);
//  2. catch-up sweep: a cursor over inbox_messages (received_at, id) observes anything the fast path missed — including
//     networks that stream B adds later, whatever their event path. Idempotent: UNIQUE(inbox_message_id).
// Only INBOUND messages on PUBLIC conversations are observed (comments, mentions, reviews). DMs never reach these tables.
// Edits/deletions at source propagate through the 031 trigger (same transaction); edited rows are re-classified and
// re-matched here (reprocessEdited). Excluded channels are not observed; re-including one backfills its stored items.
import { compileSearch, matchSearch, prepareText, type CompiledSearch } from '@social-lite/core/contracts/v35-listening';
import type { ChannelKind } from '@social-lite/core/contracts/v35-inbox';
import { getPool, many, maybeOne, withTx, type Queryable } from '@social-lite/db';
import { log } from '../log.js';
import { writeOutbox } from '../outbox.js';
import { onInboxEvent } from '../inbox/hooks.js';
import { detectLanguage, extractTerms, fingerprint, scoreSentiment } from './classify.js';
import { sourceKeyFor } from './sources.js';
import type { ObservationRow, SearchRow } from './shared.js';

const REPEAT_WINDOW_DAYS = 7;

interface SourceMsg {
  id: string; workspace_id: string; brand_id: string; channel_id: string; conversation_id: string; kind: 'dm' | 'comment' | 'mention' | 'review';
  visibility: 'public' | 'private'; direction: 'inbound' | 'outbound'; body: string | null; deleted_at: Date | null; external_id: string | null;
  provider_created_at: Date; is_simulated: boolean; language: string | null; channel_kind: ChannelKind; excluded: boolean | null; received_at: Date;
}

const SOURCE_SELECT = `SELECT m.id, m.workspace_id, c.brand_id, m.channel_id, m.conversation_id, c.kind, c.visibility, m.direction, m.body, m.deleted_at, m.external_id,
       m.provider_created_at, m.is_simulated, c.language, ch.kind AS channel_kind, s.excluded, m.received_at
  FROM inbox_messages m JOIN inbox_conversations c ON c.id = m.conversation_id JOIN inbox_channels ch ON ch.id = m.channel_id
  LEFT JOIN listening_channel_settings s ON s.channel_id = m.channel_id`;

const eligible = (m: SourceMsg) => m.direction === 'inbound' && m.visibility === 'public' && m.kind !== 'dm' && !m.deleted_at && !!m.body && !m.excluded;

// ------------------------------------------------------------------ search cache (compiled per version)
const compiled = new Map<string, { version: number; c: CompiledSearch | null }>();
export function compiledFor(s: Pick<SearchRow, 'id' | 'version' | 'terms' | 'keywords' | 'exclusions' | 'boolean_query'>): CompiledSearch | null {
  const hit = compiled.get(s.id);
  if (hit && hit.version === s.version) return hit.c;
  let c: CompiledSearch | null = null;
  try { c = compileSearch({ terms: s.terms, keywords: s.keywords, exclusions: s.exclusions, boolean: s.boolean_query }); } catch { c = null; }
  compiled.set(s.id, { version: s.version, c });
  return c;
}

export function searchAccepts(s: Pick<SearchRow, 'languages' | 'sources' | 'kinds'>, o: Pick<ObservationRow, 'language' | 'source_key' | 'conversation_kind'>): boolean {
  if (s.languages.length && (!o.language || !s.languages.includes(o.language))) return false;
  if (s.sources.length && !s.sources.includes(o.source_key)) return false;
  if (s.kinds.length && !s.kinds.includes(o.conversation_kind)) return false;
  return true;
}

async function activeSearches(db: Queryable, workspaceId: string, brandId: string): Promise<SearchRow[]> {
  return many<SearchRow>(db, `SELECT * FROM listening_searches WHERE workspace_id=$1 AND brand_id=$2 AND archived_at IS NULL`, [workspaceId, brandId]);
}

/** Match one observation against the brand's searches; returns the matched search ids. */
async function matchObservation(db: Queryable, o: ObservationRow, searches: SearchRow[]): Promise<string[]> {
  if (!o.body || o.removed_at) return [];
  const t = prepareText(o.body);
  const hit: string[] = [];
  for (const s of searches) {
    const c = compiledFor(s);
    if (!c || !searchAccepts(s, o) || !matchSearch(c, t)) continue;
    await db.query(`INSERT INTO listening_matches(search_id, observation_id, workspace_id, query_version, occurred_at) VALUES ($1,$2,$3,$4,$5)
                    ON CONFLICT (search_id, observation_id) DO UPDATE SET query_version=EXCLUDED.query_version`, [s.id, o.id, o.workspace_id, s.version, o.occurred_at]);
    hit.push(s.id);
  }
  return hit;
}

async function originalFor(db: Queryable, o: { workspace_id: string; brand_id: string; is_simulated: boolean; fingerprint: string | null; occurred_at: Date; id?: string }): Promise<string | null> {
  if (!o.fingerprint) return null;
  const r = await maybeOne<{ id: string }>(db,
    `SELECT id FROM listening_observations WHERE workspace_id=$1 AND brand_id=$2 AND is_simulated=$3 AND fingerprint=$4 AND duplicate_of IS NULL AND removed_at IS NULL
        AND occurred_at BETWEEN $5::timestamptz - make_interval(days => $6) AND $5::timestamptz AND ($7::uuid IS NULL OR id <> $7)
      ORDER BY occurred_at, id LIMIT 1`,
    [o.workspace_id, o.brand_id, o.is_simulated, o.fingerprint, o.occurred_at, REPEAT_WINDOW_DAYS, o.id ?? null]);
  return r?.id ?? null;
}

export interface ObserveResult { state: 'observed' | 'duplicate' | 'skipped'; observationId: string | null; matched: string[] }

/** Observe one inbox message (idempotent). Called by the queue consumer, the sweep and backfills. */
export async function observeMessage(messageId: string): Promise<ObserveResult> {
  const r = await withTx(async (tx) => {
    const m = await maybeOne<SourceMsg>(tx, `${SOURCE_SELECT} WHERE m.id=$1`, [messageId]);
    if (!m || !eligible(m)) return { state: 'skipped' as const, observationId: null, matched: [] as string[], ws: null, brand: null, sim: false };
    const language = m.language ?? detectLanguage(m.body!);
    const s = scoreSentiment(m.body!, language);
    const fp = fingerprint(m.body!);
    const base = { workspace_id: m.workspace_id, brand_id: m.brand_id, is_simulated: m.is_simulated, fingerprint: fp, occurred_at: m.provider_created_at };
    const dup = await originalFor(tx, base);
    const o = await maybeOne<ObservationRow>(tx,
      `INSERT INTO listening_observations(workspace_id, brand_id, layer, source_key, channel_id, inbox_message_id, conversation_id, conversation_kind, external_id, body,
                                          language, fingerprint, duplicate_of, terms, sentiment_label, sentiment_score, sentiment_confidence, sentiment_method, sentiment_evidence,
                                          occurred_at, is_simulated)
       VALUES ($1,$2,'connected',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (inbox_message_id) WHERE inbox_message_id IS NOT NULL DO NOTHING RETURNING *`,
      [m.workspace_id, m.brand_id, sourceKeyFor(m.channel_kind), m.channel_id, m.id, m.conversation_id, m.kind, m.external_id, m.body, language, fp, dup,
        extractTerms(m.body!), s.label, s.score, s.confidence, s.method, s.evidence, m.provider_created_at, m.is_simulated]);
    if (!o) return { state: 'skipped' as const, observationId: null, matched: [] as string[], ws: null, brand: null, sim: false };
    const matched = await matchObservation(tx, o, await activeSearches(tx, m.workspace_id, m.brand_id));
    return { state: dup ? 'duplicate' as const : 'observed' as const, observationId: o.id, matched, ws: m.workspace_id, brand: m.brand_id, sim: m.is_simulated };
  });
  if (r.matched.length && r.ws) {
    const { evaluateRulesForSearches } = await import('./alerts.js');
    await evaluateRulesForSearches(r.ws, r.matched);
  }
  return { state: r.state, observationId: r.observationId, matched: r.matched };
}

/** inbox hook (registered by the listening worker): public items only, ids only. */
export function registerListeningHooks(): void {
  onInboxEvent('inbox.message_received', 'listening.observe', async (e) => {
    const kind = e.payload.kind as string | undefined;
    const messageId = e.payload.messageId as string | undefined;
    if (!messageId || kind === 'dm') return;
    await writeOutbox(getPool(), { workspaceId: e.workspaceId, aggregateType: 'inbox_message', aggregateId: messageId, eventType: 'listening.ingest_requested', payload: { kind } });
  });
}

/** Catch-up: observe public inbound messages past the cursor (≥ 1 min old, so in-flight transactions have committed). */
export async function sweepIngest(limit = 200): Promise<{ scanned: number; observed: number }> {
  const db = getPool();
  const cur = await maybeOne<{ received_at: Date; message_id: string | null }>(db, `SELECT received_at, message_id FROM listening_cursors WHERE key='inbox'`);
  const rows = await many<{ id: string; received_at: Date; kind: string; visibility: string; direction: string }>(db,
    `SELECT m.id, m.received_at, c.kind, c.visibility, m.direction FROM inbox_messages m JOIN inbox_conversations c ON c.id = m.conversation_id
      WHERE (m.received_at, m.id) > ($1::timestamptz, $2::uuid) AND m.received_at < now() - interval '1 minute'
      ORDER BY m.received_at, m.id LIMIT $3`,
    [cur?.received_at ?? new Date(0), cur?.message_id ?? '00000000-0000-0000-0000-000000000000', limit]);
  let observed = 0;
  for (const r of rows) {
    if (r.direction === 'inbound' && r.visibility === 'public' && r.kind !== 'dm') {
      try {
        if ((await observeMessage(r.id)).observationId) observed++;
      } catch (err) {
        log.error('listening_observe_failed', { messageId: r.id, err: err as Error });
        await db.query(`INSERT INTO listening_ingest_failures(workspace_id, source_key, ref_id, code, message) SELECT workspace_id, 'connected', id::text, 'observe_failed', 'Could not observe this item (logged; the fast path or a re-include backfill can retry it)' FROM inbox_messages WHERE id=$1`, [r.id]);
      }
    }
    await db.query(`INSERT INTO listening_cursors(key, received_at, message_id, updated_at) VALUES ('inbox',$1,$2,now())
                    ON CONFLICT (key) DO UPDATE SET received_at=EXCLUDED.received_at, message_id=EXCLUDED.message_id, updated_at=now()`, [r.received_at, r.id]);
  }
  return { scanned: rows.length, observed };
}

/** Edited at source: re-classify, re-check repeats and re-match (derived counts follow). */
export async function reprocessEdited(limit = 100): Promise<number> {
  const rows = await many<{ id: string }>(getPool(), `SELECT id FROM listening_observations WHERE needs_reprocess ORDER BY id LIMIT $1`, [limit]);
  for (const { id } of rows) {
    await withTx(async (tx) => {
      const o = await maybeOne<ObservationRow & { conv_language: string | null }>(tx,
        `SELECT o.*, c.language AS conv_language FROM listening_observations o LEFT JOIN inbox_conversations c ON c.id = o.conversation_id WHERE o.id=$1 FOR UPDATE OF o`, [id]);
      if (!o || !o.needs_reprocess) return;
      if (!o.body || o.removed_at) { await tx.query(`UPDATE listening_observations SET needs_reprocess=false WHERE id=$1`, [id]); return; }
      const language = o.conv_language ?? detectLanguage(o.body);
      const s = scoreSentiment(o.body, language);
      const fp = fingerprint(o.body);
      const dup = await originalFor(tx, { ...o, fingerprint: fp });
      // A correction made for the old text no longer applies to the edited text.
      const u = await maybeOne<ObservationRow>(tx,
        `UPDATE listening_observations SET language=$2, sentiment_label=$3, sentiment_score=$4, sentiment_confidence=$5, sentiment_method=$6, sentiment_evidence=$7,
                fingerprint=$8, duplicate_of=$9, terms=$10, corrected_label=NULL, corrected_by=NULL, corrected_at=NULL, needs_reprocess=false WHERE id=$1 RETURNING *`,
        [id, language, s.label, s.score, s.confidence, s.method, s.evidence, fp, dup, extractTerms(o.body)]);
      await tx.query(`DELETE FROM listening_matches WHERE observation_id=$1`, [id]);
      if (u) await matchObservation(tx, u, await activeSearches(tx, o.workspace_id, o.brand_id));
    });
  }
  return rows.length;
}

/** Rebuild one search's matches for its current version (definition changed or new search). Batched by id. */
export async function rematchSearch(searchId: string, batch = 500): Promise<{ matched: number; version: number } | null> {
  const db = getPool();
  const s = await maybeOne<SearchRow>(db, `UPDATE listening_searches SET rematch_state='running' WHERE id=$1 AND archived_at IS NULL RETURNING *`, [searchId]);
  if (!s) return null;
  const c = compiledFor(s);
  await db.query(`DELETE FROM listening_matches WHERE search_id=$1`, [s.id]);
  let after = '00000000-0000-0000-0000-000000000000';
  let matched = 0;
  for (;;) {
    const rows = await many<ObservationRow>(db,
      `SELECT * FROM listening_observations WHERE workspace_id=$1 AND brand_id=$2 AND removed_at IS NULL AND body IS NOT NULL AND id > $3 ORDER BY id LIMIT $4`, [s.workspace_id, s.brand_id, after, batch]);
    if (!rows.length) break;
    after = rows[rows.length - 1]!.id;
    if (!c) continue;
    const ids: string[] = [];
    const times: Date[] = [];
    for (const o of rows) {
      if (searchAccepts(s, o) && matchSearch(c, prepareText(o.body!))) { ids.push(o.id); times.push(o.occurred_at); }
    }
    if (ids.length) {
      await db.query(`INSERT INTO listening_matches(search_id, observation_id, workspace_id, query_version, occurred_at)
                      SELECT $1, x.id, $2, $3, x.t FROM unnest($4::uuid[], $5::timestamptz[]) AS x(id, t) ON CONFLICT DO NOTHING`, [s.id, s.workspace_id, s.version, ids, times]);
      matched += ids.length;
    }
  }
  // Only mark done if nobody changed the definition meanwhile (a newer version re-runs).
  await db.query(`UPDATE listening_searches SET matched_version=$2, rematch_state=CASE WHEN version=$2 THEN 'idle' ELSE 'pending' END WHERE id=$1`, [s.id, s.version]);
  return { matched, version: s.version };
}

export async function pendingRematches(limit = 5): Promise<string[]> {
  return (await many<{ id: string }>(getPool(), `SELECT id FROM listening_searches WHERE archived_at IS NULL AND (rematch_state='pending' OR (rematch_state='running' AND updated_at < now() - interval '10 minutes')) ORDER BY updated_at LIMIT $1`, [limit])).map((r) => r.id);
}

/** Re-included channels: observe their stored public items again (bounded per tick). */
export async function runBackfills(limit = 300): Promise<number> {
  const db = getPool();
  const chans = await many<{ channel_id: string }>(db, `SELECT channel_id FROM listening_channel_settings WHERE backfill_requested_at IS NOT NULL AND NOT excluded ORDER BY backfill_requested_at LIMIT 3`);
  let n = 0;
  for (const { channel_id } of chans) {
    const rows = await many<{ id: string }>(db,
      `SELECT m.id FROM inbox_messages m JOIN inbox_conversations c ON c.id=m.conversation_id
        WHERE m.channel_id=$1 AND m.direction='inbound' AND c.visibility='public' AND c.kind <> 'dm' AND m.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM listening_observations o WHERE o.inbox_message_id = m.id) ORDER BY m.provider_created_at LIMIT $2`, [channel_id, limit]);
    for (const r of rows) { await observeMessage(r.id); n++; }
    if (rows.length < limit) await db.query(`UPDATE listening_channel_settings SET backfill_requested_at=NULL WHERE channel_id=$1`, [channel_id]);
  }
  return n;
}
