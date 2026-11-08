// V3.5 social listening contracts (stream D, migration 031; brief §14–15). Served by packages/services/src/listening/**
// and /api/listening/**. Pure: the Boolean query parser/evaluator lives here so the browser can validate a query with the
// exact rules the server applies.
//
// Two layers (brief §14):
//  - connected: comments, mentions and reviews from connected inbox channels. PRIVATE MESSAGES ARE NEVER OBSERVED (they
//    stay in the inbox's own permission scope and never reach share of voice, competitor comparisons or reports).
//  - broad: approved APIs / licensed providers (X search, YouTube search, Reddit, news…). Each is a ListeningProvider; a
//    source without an implemented provider AND activation is shown as "awaiting activation" and contributes no data.
// Honest metrics: every aggregate carries a ListeningCoverage (sources, retrieval time, available history, limitations,
// query version, denominators) and distinguishes "no matches" from "nothing collected".
import type { ChannelKind, ConversationKind } from './v35-inbox.js';

// ------------------------------------------------------------------ sources + coverage registry
export type ListeningLayer = 'connected' | 'broad';
export type SourceAccess = 'connected_account' | 'public_api' | 'paid_api' | 'approval' | 'licensed';
/** active = data is being collected now; needs_attention = connected but collection is incomplete (permission/error);
 *  paused = excluded by a manager; not_connected = no channel of that network; awaiting_activation = needs a provider
 *  licence/approval/credentials (or an adapter Relay does not have yet) — never shown as collecting. */
export type SourceStatus = 'active' | 'needs_attention' | 'paused' | 'not_connected' | 'awaiting_activation';

export interface ListeningSourceDef {
  key: string;                    // 'connected:facebook_page', 'broad:x_recent_search', …
  layer: ListeningLayer;
  label: string;
  network: ChannelKind | null;
  covers: string;                 // what is included
  excludes: string;               // what is never included
  access: SourceAccess;
  requires: string[];             // credentials / approvals / licences
  history: string;                // available history
  limitations: string[];          // sampling, rate limits, provider caveats
  /** A provider adapter exists in Relay. Broad sources without one are always awaiting activation. */
  implemented: boolean;
  verifiedOn: string;             // YYYY-MM-DD (docs checked)
}

/** Public conversation kinds per network that connected-source monitoring may observe (DMs excluded by construction). */
export const PUBLIC_KINDS: ReadonlyArray<Exclude<ConversationKind, 'dm'>> = ['comment', 'mention', 'review'];

export interface ListeningSourceState extends Pick<ListeningSourceDef, 'key' | 'layer' | 'label' | 'network' | 'covers' | 'excludes' | 'access' | 'requires' | 'history' | 'limitations' | 'implemented' | 'verifiedOn'> {
  status: SourceStatus;
  status_detail: string | null;
  channels: Array<{
    id: string; display_name: string; brand_id: string; is_simulated: boolean; channel_status: string; excluded: boolean;
    monitoring_since: string; last_observed_at: string | null; observations: number;
  }>;
}

export interface ListeningCoverage {
  dataset: 'live' | 'simulated';
  window: { from: string; to: string };
  /** Sources that contributed (or could have contributed) data to this result. */
  sources: Array<{ key: string; label: string; status: SourceStatus; channels: number }>;
  /** Broad sources not collecting (awaiting licence/approval). */
  awaiting: Array<{ key: string; label: string }>;
  /** Earliest moment any included channel was monitored; null = nothing monitored. */
  history_from: string | null;
  /** The window starts before monitoring began (earlier periods are "not collected", not zero). */
  partial_window: boolean;
  /** Channels in scope that are not collecting completely right now. */
  incomplete: Array<{ channel: string; reason: string }>;
  /** Latest retrieval (ingest) time among included observations. */
  retrieved_at: string | null;
  query_version: number | null;
  sample: { observations: number; unique: number; duplicates_collapsed: number; removed_at_source: number };
  /** 'matches' | 'no_matches' | 'not_collected' — zero matches vs incomplete collection vs no source. */
  state: 'matches' | 'no_matches' | 'not_collected' | 'incomplete';
  limitations: string[];
  methods: { dedupe: string; sentiment: string; topics: string; language: string };
}

// ------------------------------------------------------------------ saved searches
export const SEARCH_ROLES = ['own', 'competitor', 'topic'] as const;
export type SearchRole = (typeof SEARCH_ROLES)[number];

export interface SearchDefinition {
  /** Brand names + aliases (any matches). */
  terms: string[];
  /** Additional keywords (any matches; union with terms). */
  keywords: string[];
  /** Any of these excludes the item. */
  exclusions: string[];
  /** Optional advanced Boolean query that must ALSO match (see parseQuery). */
  boolean: string | null;
  /** ISO 639-1 codes; [] = any language. */
  languages: string[];
  /** Source keys; [] = every available source. */
  sources: string[];
  /** Public kinds; [] = all public kinds. */
  kinds: Array<Exclude<ConversationKind, 'dm'>>;
}

export interface SavedSearchDto extends SearchDefinition {
  id: string;
  brand_id: string;
  name: string;
  role: SearchRole;
  version: number;
  created_by: { id: string; name: string | null } | null;
  created_at: string;
  updated_at: string;
  /** Re-matching existing observations after a definition change. */
  rematch: { state: 'idle' | 'pending' | 'running'; matched_version: number };
  totals: { last_7d: number; last_24h: number };
  alert_rules: number;
  can_manage: boolean;
}

// ------------------------------------------------------------------ observations
export type SentimentLabel = 'positive' | 'negative' | 'neutral' | 'mixed' | 'unscored';

export interface SentimentJudgement {
  label: SentimentLabel;
  score: number | null;           // -1..1
  confidence: number;             // 0..1 (shown as uncertainty)
  uncertain: boolean;
  method: string;                 // 'lexicon_v1' (transparent baseline)
  evidence: string[];             // words/emoji that produced the score
}

export interface ObservationDto {
  id: string;
  brand_id: string;
  source: { key: string; label: string; channel_id: string | null; channel_name: string | null };
  kind: Exclude<ConversationKind, 'dm'>;
  author: string | null;
  text: string | null;            // null = removed at source
  language: string | null;
  occurred_at: string;
  observed_at: string;
  is_simulated: boolean;
  duplicate_of: string | null;
  duplicates: number;
  sentiment: SentimentJudgement & { corrected: { label: SentimentLabel; by: string | null; at: string } | null; effective: SentimentLabel };
  topics: string[];
  removed_at_source: boolean;
  excluded: { at: string; reason: string | null } | null;
  links: { conversation_id: string | null; case_id: string | null };
}

// ------------------------------------------------------------------ alerts
export type SpikeReason = 'fired' | 'below_minimum_sample' | 'insufficient_baseline' | 'within_baseline' | 'cooldown' | 'already_alerted' | 'not_collected';

export const ALERT_METRICS = ['volume', 'negative'] as const;
export type AlertMetric = (typeof ALERT_METRICS)[number];

export interface AlertRuleDto {
  id: string;
  search_id: string;
  name: string;
  metric: AlertMetric;
  window_minutes: number;
  baseline_days: number;
  min_sample: number;
  multiplier: number;
  min_baseline_windows: number;
  cooldown_minutes: number;
  recipients: Array<{ id: string; name: string | null }>;
  enabled: boolean;
  last_evaluated_at: string | null;
  last_result: { state: SpikeReason; detail: string } | null;
  version: number;
}

export interface AlertDto {
  id: string;
  rule: { id: string; name: string; metric: AlertMetric };
  search: { id: string; name: string; version_at_fire: number };
  brand_id: string;
  window: { from: string; to: string; minutes: number };
  observed: number;
  baseline: { mean: number; stddev: number; windows: number; days: number };
  threshold: number;
  min_sample: number;
  state: 'open' | 'acknowledged' | 'dismissed';
  coverage: ListeningCoverage;
  evidence: { total: number; available: number; removed_at_source: number };
  created_at: string;
  acknowledged: { by: string | null; at: string } | null;
}

// ------------------------------------------------------------------ dashboards
export const WIDGET_TYPES = ['timeline', 'sentiment', 'topics', 'share_of_voice', 'alerts', 'mentions'] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];
export interface DashboardWidget { type: WidgetType; search_ids: string[]; days: number; title?: string | null }
export interface DashboardDto { id: string; brand_id: string; name: string; widgets: DashboardWidget[]; shared: boolean; created_by: string | null; updated_at: string; can_manage: boolean }


// ------------------------------------------------------------------ read responses (served by services/listening/query.ts)
export interface TimelineResponse {
  search: { id: string; name: string; version: number };
  interval: 'hour' | 'day';
  buckets: Array<{ at: string; unique: number | null; positive: number | null; negative: number | null; collected: boolean }>;
  totals: { unique: number; previous: number | null };
  coverage: ListeningCoverage;
}

export interface SentimentResponse {
  counts: Record<SentimentLabel, number>;
  /** Denominator: unique mentions in the window. Shares exclude 'unscored' from their own denominator. */
  denominator: number; scored: number; uncertain: number; corrected: number;
  shares: Record<'positive' | 'negative' | 'neutral' | 'mixed', number | null>;
  method: string; definition: string;
  coverage: ListeningCoverage;
}

export interface TopicsResponse {
  topics: Array<{ label: string; count: number; share: number; negative: number; positive: number; examples: string[] }>;
  denominator: number; method: string; definition: string; coverage: ListeningCoverage;
}

export interface ShareOfVoiceResponse {
  rows: Array<{ search: { id: string; name: string; role: string; version: number }; count: number; share: number | null; negative: number; positive: number }>;
  denominator: number;
  comparable_sources: string[];
  note: string;
  definition: string;
  coverage: ListeningCoverage;
}

export interface SummaryResponse {
  search: { id: string; name: string; version: number; role: string };
  unique: number; previous: number | null;
  sentiment: Record<SentimentLabel, number>;
  uncertain: number;
  topics: TopicsResponse['topics'];
  highlights: Array<{ why: string; mention: ObservationDto }>;
  coverage: ListeningCoverage;
  generated_at: string;
  method: string;
}

// ------------------------------------------------------------------ metric definitions (UI tooltips + docs)
export const LISTENING_DEFINITIONS: Record<string, string> = {
  mention: 'A public comment, mention or review from a monitored source that matches the search. Private messages are never included.',
  unique: 'Mentions after collapsing repeats: identical normalised text from the same brand within 7 days counts once.',
  sentiment: 'Inferred, not fact. Lexicon baseline: scored from listed positive/negative words with negation; only English is scored. Low-confidence results are marked uncertain; a person can correct them.',
  topic: 'Keywords that co-occur across matching mentions (search terms excluded). Groups overlap: one mention can appear in several.',
  share_of_voice: 'Each search’s mentions ÷ the sum across the compared searches, over the same sources and window. Only observed data — not the whole internet.',
  spike: 'Fires when a window’s count reaches the minimum sample AND exceeds both baseline mean × multiplier and mean + 3 standard deviations. Baseline = same-length windows in the previous days while monitoring was active. One alert per window; cooldown afterwards.',
  coverage: 'Which sources were monitored, since when, and whether any were incomplete. Periods before monitoring began are “not collected”, never zero.',
  query_version: 'Saved searches are versioned. Editing the definition creates a new version and re-matches stored mentions.',
};

// ------------------------------------------------------------------ Boolean query (pure)
// Grammar (operators UPPERCASE; implicit AND between adjacent terms):
//   query   := or
//   or      := and ( 'OR' and )*
//   and     := unary ( 'AND'? unary )*
//   unary   := ( 'NOT' | '-' ) unary | primary
//   primary := '(' or ')' | '"phrase words"' | term
//   term    := word | word* (prefix) | #hashtag | @handle
// Matching is case- and accent-insensitive on whole words; a plain word also matches its #hashtag / @handle form.
export type QueryNode =
  | { t: 'term'; value: string; prefix: boolean }
  | { t: 'phrase'; words: string[] }
  | { t: 'and' | 'or'; nodes: QueryNode[] }
  | { t: 'not'; node: QueryNode };

export class QueryError extends Error {
  constructor(message: string, readonly position: number) { super(message); }
}

export const QUERY_LIMITS = { maxLength: 500, maxTerms: 50, maxDepth: 10 } as const;

/** Lowercase, strip accents, keep letters/digits/#/@/_/' (apostrophes folded) — the same normalisation for text and terms. */
export function normaliseText(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’`]/g, "'");
}

/** Word tokens of a text (#tag and @handle keep their sigil; urls dropped). */
export function tokenize(s: string): string[] {
  const t = normaliseText(s).replace(/https?:\/\/\S+/g, ' ');
  return t.match(/[#@]?[\p{L}\p{N}_]+(?:'[\p{L}]+)?/gu) ?? [];
}

type Tok = { k: 'lp' | 'rp' | 'and' | 'or' | 'not' | 'phrase' | 'word'; v: string; pos: number };

function lex(q: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < q.length) {
    const c = q[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') { out.push({ k: 'lp', v: c, pos: i++ }); continue; }
    if (c === ')') { out.push({ k: 'rp', v: c, pos: i++ }); continue; }
    if (c === '"') {
      const end = q.indexOf('"', i + 1);
      if (end < 0) throw new QueryError('Close the quoted phrase.', i);
      const words = tokenize(q.slice(i + 1, end));
      if (!words.length) throw new QueryError('The quoted phrase is empty.', i);
      out.push({ k: 'phrase', v: words.join(' '), pos: i });
      i = end + 1;
      continue;
    }
    if (c === '-' && (out.length === 0 || ['lp', 'and', 'or', 'not'].includes(out[out.length - 1]!.k) || /\s/.test(q[i - 1] ?? ' ')) && q[i + 1] && !/\s/.test(q[i + 1]!)) {
      out.push({ k: 'not', v: '-', pos: i++ });
      continue;
    }
    let j = i;
    while (j < q.length && !/[\s()"]/.test(q[j]!)) j++;
    const raw = q.slice(i, j);
    if (raw === 'AND') out.push({ k: 'and', v: raw, pos: i });
    else if (raw === 'OR') out.push({ k: 'or', v: raw, pos: i });
    else if (raw === 'NOT') out.push({ k: 'not', v: raw, pos: i });
    else out.push({ k: 'word', v: raw, pos: i });
    i = j;
  }
  return out;
}

export function parseQuery(q: string, opts: { allowOnlyNegative?: boolean } = {}): QueryNode {
  if (q.length > QUERY_LIMITS.maxLength) throw new QueryError(`Keep the query under ${QUERY_LIMITS.maxLength} characters.`, QUERY_LIMITS.maxLength);
  const toks = lex(q);
  if (!toks.length) throw new QueryError('The query is empty.', 0);
  let p = 0;
  let terms = 0;
  const peek = () => toks[p];
  const parseOr = (depth: number): QueryNode => {
    if (depth > QUERY_LIMITS.maxDepth) throw new QueryError('Too many nested brackets.', peek()?.pos ?? q.length);
    const nodes = [parseAnd(depth)];
    while (peek()?.k === 'or') { p++; nodes.push(parseAnd(depth)); }
    return nodes.length === 1 ? nodes[0]! : { t: 'or', nodes };
  };
  const parseAnd = (depth: number): QueryNode => {
    const nodes = [parseUnary(depth)];
    for (;;) {
      const t = peek();
      if (!t || t.k === 'or' || t.k === 'rp') break;
      if (t.k === 'and') p++;
      nodes.push(parseUnary(depth));
    }
    return nodes.length === 1 ? nodes[0]! : { t: 'and', nodes };
  };
  const parseUnary = (depth: number): QueryNode => {
    const t = peek();
    if (t?.k === 'not') { p++; return { t: 'not', node: parseUnary(depth + 1) }; }
    return parsePrimary(depth);
  };
  const parsePrimary = (depth: number): QueryNode => {
    const t = peek();
    if (!t) throw new QueryError('The query ends too early.', q.length);
    if (t.k === 'lp') {
      p++;
      const n = parseOr(depth + 1);
      if (peek()?.k !== 'rp') throw new QueryError('Close the bracket.', t.pos);
      p++;
      return n;
    }
    if (t.k === 'phrase') {
      p++;
      if (++terms > QUERY_LIMITS.maxTerms) throw new QueryError(`Use at most ${QUERY_LIMITS.maxTerms} terms.`, t.pos);
      return { t: 'phrase', words: t.v.split(' ') };
    }
    if (t.k === 'word') {
      p++;
      if (++terms > QUERY_LIMITS.maxTerms) throw new QueryError(`Use at most ${QUERY_LIMITS.maxTerms} terms.`, t.pos);
      const prefix = t.v.endsWith('*');
      const base = prefix ? t.v.slice(0, -1) : t.v;
      const words = tokenize(base);
      if (words.length === 0) throw new QueryError(`“${t.v}” has no letters or digits.`, t.pos);
      if (prefix && (words.length > 1 || words[0]!.replace(/^[#@]/, '').length < 3)) throw new QueryError('A wildcard needs at least 3 letters before *.', t.pos);
      if (words.length > 1) return { t: 'phrase', words }; // e.g. o'neill-style splits, "e-mail"
      return { t: 'term', value: words[0]!, prefix };
    }
    if (t.k === 'rp') throw new QueryError('Unexpected closing bracket.', t.pos);
    throw new QueryError(`“${t.v}” needs a term after it.`, t.pos);
  };
  const node = parseOr(0);
  if (p < toks.length) throw new QueryError(`Unexpected “${toks[p]!.v}”.`, toks[p]!.pos);
  if (!opts.allowOnlyNegative && onlyNegative(node)) throw new QueryError('Add at least one term to include (a query cannot be only NOT).', 0);
  return node;
}

function onlyNegative(n: QueryNode): boolean {
  if (n.t === 'not') return true;
  if (n.t === 'and') return n.nodes.every(onlyNegative);
  if (n.t === 'or') return n.nodes.some(onlyNegative);
  return false;
}

/** Prepared text for repeated matching. */
export interface PreparedText { tokens: string[]; bare: string[]; set: Set<string> }

export function prepareText(text: string): PreparedText {
  const tokens = tokenize(text);
  const bare = tokens.map((w) => w.replace(/^[#@]/, ''));
  return { tokens, bare, set: new Set([...tokens, ...bare]) };
}

function termMatches(t: PreparedText, value: string, prefix: boolean): boolean {
  const sigil = /^[#@]/.test(value);
  const list = sigil ? t.tokens : t.bare;
  if (!prefix) return t.set.has(value) && (sigil ? t.tokens.includes(value) : true);
  return list.some((w) => w.startsWith(value));
}

function phraseMatches(t: PreparedText, words: string[]): boolean {
  const list = t.bare;
  const ws = words.map((w) => w.replace(/^[#@]/, ''));
  outer: for (let i = 0; i + ws.length <= list.length; i++) {
    for (let j = 0; j < ws.length; j++) if (list[i + j] !== ws[j]) continue outer;
    return true;
  }
  return false;
}

export function evaluateQuery(n: QueryNode, t: PreparedText): boolean {
  switch (n.t) {
    case 'term': return termMatches(t, n.value, n.prefix);
    case 'phrase': return phraseMatches(t, n.words);
    case 'and': return n.nodes.every((x) => evaluateQuery(x, t));
    case 'or': return n.nodes.some((x) => evaluateQuery(x, t));
    case 'not': return !evaluateQuery(n.node, t);
  }
}

/** A plain list entry ("Vitalos Café", "#vitalos") as a node: multi-word = phrase. */
export function entryNode(entry: string): QueryNode | null {
  const words = tokenize(entry.replace(/\*$/, ''));
  if (!words.length) return null;
  if (words.length > 1) return { t: 'phrase', words };
  return { t: 'term', value: words[0]!, prefix: entry.trim().endsWith('*') && words[0]!.length >= 3 };
}

export interface CompiledSearch { include: QueryNode[]; boolean: QueryNode | null; exclude: QueryNode[] }

/** Throws QueryError when the definition cannot match anything or the Boolean query is invalid. */
export function compileSearch(d: Pick<SearchDefinition, 'terms' | 'keywords' | 'exclusions' | 'boolean'>): CompiledSearch {
  const include = [...d.terms, ...d.keywords].map(entryNode).filter((x): x is QueryNode => !!x);
  const exclude = d.exclusions.map(entryNode).filter((x): x is QueryNode => !!x);
  const boolean = d.boolean && d.boolean.trim() ? parseQuery(d.boolean.trim(), { allowOnlyNegative: include.length > 0 }) : null;
  if (!include.length && !boolean) throw new QueryError('Add a name, keyword or query to match.', 0);
  return { include, boolean, exclude };
}

export function matchSearch(c: CompiledSearch, t: PreparedText): boolean {
  if (c.include.length && !c.include.some((n) => evaluateQuery(n, t))) return false;
  if (c.boolean && !evaluateQuery(c.boolean, t)) return false;
  return !c.exclude.some((n) => evaluateQuery(n, t));
}

/** Terms a search is built from (excluded from topic grouping — they appear in every match). */
export function searchVocabulary(c: CompiledSearch): Set<string> {
  const out = new Set<string>();
  const walk = (n: QueryNode) => {
    if (n.t === 'term') out.add(n.value.replace(/^[#@]/, ''));
    else if (n.t === 'phrase') n.words.forEach((w) => out.add(w.replace(/^[#@]/, '')));
    else if (n.t === 'not') walk(n.node);
    else n.nodes.forEach(walk);
  };
  [...c.include, ...(c.boolean ? [c.boolean] : [])].forEach(walk);
  return out;
}
