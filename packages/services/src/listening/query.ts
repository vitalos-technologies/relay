// Listening reads (brief §15): timelines, mentions, sentiment, topics, share of voice and source-linked summaries.
// All reads come from stored, indexed rows (no provider calls). Every result carries a ListeningCoverage: data source,
// retrieval time, available history, limitations, query version and denominators; "no matches" is distinguished from
// "not collected" / "incomplete". Removed-at-source and excluded mentions never count; repeats count once ("unique").
// Simulated and live data are never mixed: each request is answered from one dataset.
import { AppError } from '@social-lite/core';
import {
  compileSearch, LISTENING_DEFINITIONS, searchVocabulary, type ListeningCoverage, type ObservationDto, type SentimentLabel,
  type SentimentResponse, type ShareOfVoiceResponse, type SummaryResponse, type TimelineResponse, type TopicsResponse,
} from '@social-lite/core/contracts/v35-listening';
import { getPool, many, maybeOne, one, type Queryable } from '@social-lite/db';
import type { Ctx } from '../context.js';
import { METHOD_LABELS } from './classify.js';
import { buildCoverage, defaultDataset, sourceLabel } from './sources.js';
import { datasetOf, listeningBrands, loadSearch, windowOf, type ObservationRow, type SearchRow } from './shared.js';

export interface ReadQuery { days?: unknown; from?: unknown; to?: unknown; dataset?: unknown }

interface Scope { s: SearchRow; dataset: 'live' | 'simulated'; from: Date; to: Date; days: number }

async function scopeOf(ctx: Ctx, searchId: string, q: ReadQuery): Promise<Scope> {
  const s = await loadSearch(ctx, searchId);
  const w = windowOf(q);
  const dataset = datasetOf(q.dataset) ?? await defaultDataset(ctx.access.workspaceId, [s.brand_id]);
  return { s, dataset, ...w };
}

/** Matched, counted mentions of a search in [from, to). $1 search, $2 from, $3 to, $4 simulated. */
const MATCHED = `FROM listening_matches lm JOIN listening_observations o ON o.id = lm.observation_id
  WHERE lm.search_id=$1 AND lm.occurred_at >= $2 AND lm.occurred_at < $3 AND o.is_simulated=$4 AND o.removed_at IS NULL AND o.excluded_at IS NULL`;
/** A repeat counts only when its original is not itself in the same result. */
const UNIQUE = `(o.duplicate_of IS NULL OR NOT EXISTS (SELECT 1 FROM listening_matches lm2 WHERE lm2.search_id = lm.search_id AND lm2.observation_id = o.duplicate_of AND lm2.occurred_at >= $2))`;
const EFFECTIVE = `coalesce(o.corrected_label, o.sentiment_label)`;

async function sampleOf(db: Queryable, sc: Scope): Promise<ListeningCoverage['sample']> {
  const r = await one<{ n: number; u: number }>(db, `SELECT count(*)::int AS n, count(*) FILTER (WHERE ${UNIQUE})::int AS u ${MATCHED}`, [sc.s.id, sc.from, sc.to, sc.dataset === 'simulated']);
  const rm = await one<{ n: number }>(db,
    `SELECT count(*)::int AS n FROM listening_observations WHERE workspace_id=$1 AND brand_id=$2 AND is_simulated=$3 AND removed_at IS NOT NULL AND occurred_at >= $4 AND occurred_at < $5`,
    [sc.s.workspace_id, sc.s.brand_id, sc.dataset === 'simulated', sc.from, sc.to]);
  return { observations: r.n, unique: r.u, duplicates_collapsed: r.n - r.u, removed_at_source: rm.n };
}

async function coverageOf(db: Queryable, sc: Scope, sample?: ListeningCoverage['sample']): Promise<ListeningCoverage> {
  return buildCoverage({
    workspaceId: sc.s.workspace_id, brandIds: [sc.s.brand_id], dataset: sc.dataset, sources: sc.s.sources, kinds: sc.s.kinds, from: sc.from, to: sc.to,
    queryVersion: sc.s.version, sample: sample ?? await sampleOf(db, sc),
  }, db);
}

// ------------------------------------------------------------------ timeline

export async function searchTimeline(ctx: Ctx, searchId: string, q: ReadQuery & { interval?: unknown }): Promise<TimelineResponse> {
  const sc = await scopeOf(ctx, searchId, q);
  const interval: 'hour' | 'day' = q.interval === 'hour' || (q.interval === undefined && sc.days <= 2) ? 'hour' : 'day';
  if (interval === 'hour' && sc.days > 14) throw new AppError('validation_failed', 'Hourly view covers up to 14 days', { interval: 'Use day' });
  const db = getPool();
  const rows = await many<{ b: Date; u: number; p: number; n: number }>(db,
    `SELECT date_trunc('${interval}', lm.occurred_at, 'UTC') AS b, count(*)::int AS u,
            count(*) FILTER (WHERE ${EFFECTIVE}='positive')::int AS p, count(*) FILTER (WHERE ${EFFECTIVE}='negative')::int AS n
       ${MATCHED} AND ${UNIQUE} GROUP BY 1 ORDER BY 1`, [sc.s.id, sc.from, sc.to, sc.dataset === 'simulated']);
  const sample = await sampleOf(db, sc);
  const coverage = await coverageOf(db, sc, sample);
  const since = coverage.history_from ? new Date(coverage.history_from) : null;
  const step = interval === 'hour' ? 3_600_000 : 86_400_000;
  const start = Math.floor(sc.from.getTime() / step) * step;
  const buckets: TimelineResponse['buckets'] = [];
  for (let t = start; t < sc.to.getTime(); t += step) {
    const r = rows.find((x) => x.b.getTime() === t);
    // A bucket that ended before monitoring began is "not collected" (null), never zero.
    const collected = !!since && t + step > since.getTime();
    buckets.push({ at: new Date(t).toISOString(), unique: collected ? r?.u ?? 0 : null, positive: collected ? r?.p ?? 0 : null, negative: collected ? r?.n ?? 0 : null, collected });
  }
  // Previous period: only when it was fully monitored.
  const prevFrom = new Date(sc.from.getTime() - (sc.to.getTime() - sc.from.getTime()));
  let previous: number | null = null;
  if (since && since <= prevFrom) {
    previous = (await one<{ u: number }>(db, `SELECT count(*)::int AS u ${MATCHED} AND ${UNIQUE}`, [sc.s.id, prevFrom, sc.from, sc.dataset === 'simulated'])).u;
  }
  return { search: { id: sc.s.id, name: sc.s.name, version: sc.s.version }, interval, buckets, totals: { unique: sample.unique, previous }, coverage };
}

// ------------------------------------------------------------------ mentions
interface MentionRow extends ObservationRow { channel_name: string | null; author: string | null; case_id: string | null; dups: number; corrector: string | null }

export function observationDto(r: MentionRow): ObservationDto {
  const effective = (r.corrected_label ?? r.sentiment_label) as SentimentLabel;
  return {
    id: r.id, brand_id: r.brand_id, source: { key: r.source_key, label: sourceLabel(r.source_key), channel_id: r.channel_id, channel_name: r.channel_name },
    kind: r.conversation_kind, author: r.author, text: r.body, language: r.language, occurred_at: r.occurred_at.toISOString(), observed_at: r.observed_at.toISOString(),
    is_simulated: r.is_simulated, duplicate_of: r.duplicate_of, duplicates: r.dups ?? 0,
    sentiment: {
      label: r.sentiment_label as SentimentLabel, score: r.sentiment_score, confidence: r.sentiment_confidence, uncertain: r.sentiment_label === 'unscored' || r.sentiment_confidence < 0.5,
      method: r.sentiment_method, evidence: r.sentiment_evidence,
      corrected: r.corrected_label ? { label: r.corrected_label as SentimentLabel, by: r.corrector, at: r.corrected_at!.toISOString() } : null, effective,
    },
    topics: r.terms.slice(0, 6), removed_at_source: !!r.removed_at,
    excluded: r.excluded_at ? { at: r.excluded_at.toISOString(), reason: r.excluded_reason } : null,
    links: { conversation_id: r.conversation_id, case_id: r.case_id },
  };
}

export const MENTION_SELECT = `o.*, ch.display_name AS channel_name, coalesce(ct.display_name, ct.handle) AS author, cv.case_id, u.name AS corrector,
  (SELECT count(*)::int FROM listening_observations d WHERE d.duplicate_of = o.id AND d.removed_at IS NULL) AS dups`;
export const MENTION_JOINS = `LEFT JOIN inbox_channels ch ON ch.id = o.channel_id LEFT JOIN inbox_conversations cv ON cv.id = o.conversation_id
  LEFT JOIN inbox_messages im ON im.id = o.inbox_message_id LEFT JOIN inbox_contacts ct ON ct.id = im.author_contact_id LEFT JOIN users u ON u.id = o.corrected_by`;

export async function searchMentions(ctx: Ctx, searchId: string, q: ReadQuery & { sentiment?: unknown; topic?: unknown; text?: unknown; cursor?: unknown; limit?: unknown; repeats?: unknown; uncertain?: unknown }): Promise<{ items: ObservationDto[]; next_cursor: string | null; coverage: ListeningCoverage }> {
  const sc = await scopeOf(ctx, searchId, q);
  const params: unknown[] = [sc.s.id, sc.from, sc.to, sc.dataset === 'simulated'];
  let where = '';
  if (q.repeats !== 'include') where += ` AND ${UNIQUE}`;
  if (typeof q.sentiment === 'string' && ['positive', 'negative', 'neutral', 'mixed', 'unscored'].includes(q.sentiment)) { params.push(q.sentiment); where += ` AND ${EFFECTIVE} = $${params.length}`; }
  if (q.uncertain === 'true') where += ` AND o.corrected_label IS NULL AND (o.sentiment_confidence < 0.5 OR o.sentiment_label = 'unscored')`;
  if (typeof q.topic === 'string' && q.topic.trim()) { params.push(q.topic.trim().toLowerCase().slice(0, 80)); where += ` AND $${params.length} = ANY(o.terms)`; }
  if (typeof q.text === 'string' && q.text.trim()) { params.push(q.text.trim().slice(0, 200)); where += ` AND o.body_tsv @@ plainto_tsquery('simple', $${params.length})`; }
  if (typeof q.cursor === 'string' && q.cursor) {
    const [at, id] = Buffer.from(q.cursor, 'base64url').toString('utf8').split('|');
    if (!at || !id || Number.isNaN(Date.parse(at)) || !/^[0-9a-f-]{36}$/.test(id)) throw new AppError('validation_failed', 'Invalid cursor');
    params.push(new Date(at), id); where += ` AND (lm.occurred_at, lm.observation_id) < ($${params.length - 1}, $${params.length}::uuid)`;
  }
  const limit = Math.min(100, Math.max(1, Number(q.limit ?? 30) || 30));
  params.push(limit + 1);
  const rows = await many<MentionRow>(getPool(),
    `SELECT ${MENTION_SELECT} FROM listening_matches lm JOIN listening_observations o ON o.id = lm.observation_id ${MENTION_JOINS}
      WHERE lm.search_id=$1 AND lm.occurred_at >= $2 AND lm.occurred_at < $3 AND o.is_simulated=$4 AND o.removed_at IS NULL AND o.excluded_at IS NULL ${where}
      ORDER BY lm.occurred_at DESC, lm.observation_id DESC LIMIT $${params.length}`, params);
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(observationDto),
    next_cursor: more && last ? Buffer.from(`${last.occurred_at.toISOString()}|${last.id}`).toString('base64url') : null,
    coverage: await coverageOf(getPool(), sc),
  };
}

export async function getMention(ctx: Ctx, id: string): Promise<ObservationDto & { matched_searches: Array<{ id: string; name: string; version: number }>; actions: Array<{ action: string; target_id: string; at: string }> }> {
  const brands = await listeningBrands(ctx);
  const r = await maybeOne<MentionRow>(getPool(), `SELECT ${MENTION_SELECT} FROM listening_observations o ${MENTION_JOINS} WHERE o.id=$1 AND o.workspace_id=$2 AND o.brand_id = ANY($3::uuid[])`, [id, ctx.access.workspaceId, brands]);
  if (!r) throw new AppError('not_found', 'Mention not found');
  const searches = await many<{ id: string; name: string; version: number }>(getPool(), `SELECT s.id, s.name, lm.query_version AS version FROM listening_matches lm JOIN listening_searches s ON s.id = lm.search_id WHERE lm.observation_id=$1 AND s.archived_at IS NULL`, [id]);
  const actions = await many<{ action: string; target_id: string; created_at: Date }>(getPool(), `SELECT action, target_id, created_at FROM listening_insight_actions WHERE observation_id=$1 ORDER BY created_at`, [id]);
  return { ...observationDto(r), matched_searches: searches, actions: actions.map((a) => ({ action: a.action, target_id: a.target_id, at: a.created_at.toISOString() })) };
}

// ------------------------------------------------------------------ sentiment

export async function searchSentiment(ctx: Ctx, searchId: string, q: ReadQuery): Promise<SentimentResponse> {
  const sc = await scopeOf(ctx, searchId, q);
  const rows = await many<{ l: SentimentLabel; n: number; unc: number; cor: number }>(getPool(),
    `SELECT ${EFFECTIVE} AS l, count(*)::int AS n,
            count(*) FILTER (WHERE o.corrected_label IS NULL AND o.sentiment_confidence < 0.5)::int AS unc, count(*) FILTER (WHERE o.corrected_label IS NOT NULL)::int AS cor
       ${MATCHED} AND ${UNIQUE} GROUP BY 1`, [sc.s.id, sc.from, sc.to, sc.dataset === 'simulated']);
  const counts = { positive: 0, negative: 0, neutral: 0, mixed: 0, unscored: 0 } as Record<SentimentLabel, number>;
  for (const r of rows) counts[r.l] = r.n;
  const denominator = Object.values(counts).reduce((a, b) => a + b, 0);
  const scored = denominator - counts.unscored;
  const share = (n: number) => (scored ? Math.round((n / scored) * 1000) / 1000 : null);
  return {
    counts, denominator, scored, uncertain: rows.reduce((a, r) => a + (r.l === 'unscored' ? 0 : r.unc), 0), corrected: rows.reduce((a, r) => a + r.cor, 0),
    shares: { positive: share(counts.positive), negative: share(counts.negative), neutral: share(counts.neutral), mixed: share(counts.mixed) },
    method: METHOD_LABELS.lexicon_v1!, definition: LISTENING_DEFINITIONS.sentiment!, coverage: await coverageOf(getPool(), sc),
  };
}

// ------------------------------------------------------------------ topics

export async function searchTopics(ctx: Ctx, searchId: string, q: ReadQuery & { limit?: unknown }): Promise<TopicsResponse> {
  const sc = await scopeOf(ctx, searchId, q);
  const vocab = (() => { try { return searchVocabulary(compileSearch({ terms: sc.s.terms, keywords: sc.s.keywords, exclusions: sc.s.exclusions, boolean: sc.s.boolean_query })); } catch { return new Set<string>(); } })();
  const rows = await many<{ id: string; terms: string[]; l: SentimentLabel }>(getPool(),
    `SELECT o.id, o.terms, ${EFFECTIVE} AS l ${MATCHED} AND ${UNIQUE} ORDER BY lm.occurred_at DESC LIMIT 5000`, [sc.s.id, sc.from, sc.to, sc.dataset === 'simulated']);
  const df = new Map<string, string[]>();
  for (const r of rows) {
    for (const t of new Set(r.terms)) {
      if (t.split(' ').some((w) => vocab.has(w))) continue;
      const list = df.get(t) ?? [];
      list.push(r.id);
      df.set(t, list);
    }
  }
  const min = rows.length >= 20 ? 3 : 2;
  let cands = [...df.entries()].filter(([, ids]) => ids.length >= min).sort((a, b) => b[1].length - a[1].length || (b[0].includes(' ') ? 1 : 0) - (a[0].includes(' ') ? 1 : 0) || a[0].localeCompare(b[0]));
  // Prefer a pair ("flat white") over its single words when it explains most of their mentions.
  const pairs = cands.filter(([t]) => t.includes(' '));
  cands = cands.filter(([t, ids]) => t.includes(' ') || !pairs.some(([p, pids]) => p.split(' ').includes(t) && pids.length >= 0.6 * ids.length));
  const limit = Math.min(12, Math.max(1, Number(q.limit ?? 8) || 8));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const topics = cands.slice(0, limit).map(([label, ids]) => ({
    label, count: ids.length, share: rows.length ? Math.round((ids.length / rows.length) * 1000) / 1000 : 0,
    negative: ids.filter((i) => byId.get(i)?.l === 'negative').length, positive: ids.filter((i) => byId.get(i)?.l === 'positive').length, examples: ids.slice(0, 3),
  }));
  return { topics, denominator: rows.length, method: 'Keyword grouping (co-occurring keywords and pairs; search terms excluded)', definition: LISTENING_DEFINITIONS.topic!, coverage: await coverageOf(getPool(), sc) };
}

// ------------------------------------------------------------------ share of voice

export async function shareOfVoice(ctx: Ctx, q: ReadQuery & { brand_id?: unknown; search_ids?: unknown }): Promise<ShareOfVoiceResponse> {
  const ids = (typeof q.search_ids === 'string' ? q.search_ids.split(',') : Array.isArray(q.search_ids) ? q.search_ids : []).map(String).filter(Boolean).slice(0, 8);
  if (ids.length < 2) throw new AppError('validation_failed', 'Pick at least two searches to compare', { search_ids: 'Two or more' });
  const searches = await Promise.all(ids.map((id) => loadSearch(ctx, id)));
  const brand = searches[0]!.brand_id;
  if (searches.some((s) => s.brand_id !== brand)) throw new AppError('validation_failed', 'Compare searches of one brand (same monitored sources)', { search_ids: 'Same brand' });
  const w = windowOf(q);
  const dataset = datasetOf(q.dataset) ?? await defaultDataset(ctx.access.workspaceId, [brand]);
  // Comparable sources: only sources every compared search includes ([] = all sources).
  const restricted = searches.filter((s) => s.sources.length);
  const comparable = restricted.length ? restricted.map((s) => s.sources).reduce((a, b) => a.filter((x) => b.includes(x))) : [];
  if (restricted.length && !comparable.length) throw new AppError('validation_failed', 'These searches share no source, so they cannot be compared', { search_ids: 'No common source' });
  const rows = await many<{ search_id: string; n: number; neg: number; pos: number }>(getPool(),
    `SELECT lm.search_id, count(*)::int AS n, count(*) FILTER (WHERE ${EFFECTIVE}='negative')::int AS neg, count(*) FILTER (WHERE ${EFFECTIVE}='positive')::int AS pos
       FROM listening_matches lm JOIN listening_observations o ON o.id = lm.observation_id
      WHERE lm.search_id = ANY($1::uuid[]) AND lm.occurred_at >= $2 AND lm.occurred_at < $3 AND o.is_simulated=$4 AND o.removed_at IS NULL AND o.excluded_at IS NULL
        AND o.duplicate_of IS NULL AND ($5::text[] = '{}' OR o.source_key = ANY($5::text[]))
      GROUP BY lm.search_id`, [ids, w.from, w.to, dataset === 'simulated', comparable]);
  const denominator = rows.reduce((a, r) => a + r.n, 0);
  const coverage = await buildCoverage({ workspaceId: ctx.access.workspaceId, brandIds: [brand], dataset, sources: comparable, from: w.from, to: w.to, queryVersion: null,
    sample: { observations: denominator, unique: denominator, duplicates_collapsed: 0, removed_at_source: 0 } });
  return {
    rows: searches.map((s) => {
      const r = rows.find((x) => x.search_id === s.id);
      return { search: { id: s.id, name: s.name, role: s.role, version: s.version }, count: r?.n ?? 0, share: denominator ? Math.round(((r?.n ?? 0) / denominator) * 1000) / 1000 : null, negative: r?.neg ?? 0, positive: r?.pos ?? 0 };
    }),
    denominator, comparable_sources: comparable,
    note: 'Within observed data only. A mention naming two compared searches counts for each, so the denominator is the sum of the counts.',
    definition: LISTENING_DEFINITIONS.share_of_voice!, coverage,
  };
}

// ------------------------------------------------------------------ source-linked summary

/** Deterministic summary with links to the exact mentions it cites (no generated text, no invented figures). */
export async function searchSummary(ctx: Ctx, searchId: string, q: ReadQuery): Promise<SummaryResponse> {
  const tl = await searchTimeline(ctx, searchId, { ...q, interval: 'day' });
  const sen = await searchSentiment(ctx, searchId, q);
  const top = await searchTopics(ctx, searchId, { ...q, limit: 5 });
  const sc = await scopeOf(ctx, searchId, q);
  const pick = async (label: string, why: string) => {
    const r = await maybeOne<MentionRow>(getPool(),
      `SELECT ${MENTION_SELECT} FROM listening_matches lm JOIN listening_observations o ON o.id = lm.observation_id ${MENTION_JOINS}
        WHERE lm.search_id=$1 AND lm.occurred_at >= $2 AND lm.occurred_at < $3 AND o.is_simulated=$4 AND o.removed_at IS NULL AND o.excluded_at IS NULL AND ${UNIQUE} AND ${EFFECTIVE}=$5
        ORDER BY (o.corrected_label IS NOT NULL) DESC, o.sentiment_confidence DESC, lm.occurred_at DESC LIMIT 1`, [sc.s.id, sc.from, sc.to, sc.dataset === 'simulated', label]);
    return r ? { why, mention: observationDto(r) } : null;
  };
  const highlights = [await pick('negative', 'Most clearly negative'), await pick('positive', 'Most clearly positive')].filter((x): x is NonNullable<typeof x> => !!x);
  return {
    search: { id: sc.s.id, name: sc.s.name, version: sc.s.version, role: sc.s.role }, unique: tl.totals.unique, previous: tl.totals.previous,
    sentiment: sen.counts, uncertain: sen.uncertain, topics: top.topics, highlights, coverage: tl.coverage, generated_at: new Date().toISOString(),
    method: 'Counts and examples from stored mentions; no generated text.',
  };
}

