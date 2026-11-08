// Listening coverage registry + provider interface (brief §14). Two layers:
//  - connected: one source per inbox network with a PUBLIC conversation type (comments/mentions/reviews), derived from the
//    inbox capability record, so networks stream B adds flow in automatically. Data comes from inbox ingestion (verified
//    webhooks / polling) — no extra provider calls. DMs are excluded by construction.
//  - broad: approved APIs / licensed providers. Each needs a ListeningProvider implementation AND activation (credentials,
//    licence, approval). None is registered in this build, so all are "awaiting activation" and contribute no data.
// Not offered by policy: logged-in scraping, private groups, "all of social" coverage claims.
import type { ChannelKind } from '@social-lite/core/contracts/v35-inbox';
import {
  PUBLIC_KINDS, type ListeningCoverage, type ListeningSourceDef, type ListeningSourceState, type SourceStatus,
} from '@social-lite/core/contracts/v35-listening';
import { implementedChannelKinds } from '@social-lite/providers';
import { getPool, many, type Queryable } from '@social-lite/db';
import { CHANNEL_CAPABILITIES } from '../inbox/capabilities.js';
import { DEDUPE_METHOD, METHOD_LABELS, SENTIMENT_METHOD } from './classify.js';
import { iso } from './shared.js';

const NETWORK_LABEL: Record<ChannelKind, string> = {
  facebook_page: 'Facebook Page', instagram: 'Instagram', telegram_bot: 'Telegram', whatsapp: 'WhatsApp', google_business_profile: 'Google Business Profile',
  x: 'X', youtube: 'YouTube', linkedin: 'LinkedIn', threads: 'Threads', bluesky: 'Bluesky', tiktok: 'TikTok',
};

/** Connected sources: networks whose inbox capability has a public conversation type. */
export function connectedSources(): ListeningSourceDef[] {
  const impl = new Set(implementedChannelKinds());
  return (Object.values(CHANNEL_CAPABILITIES)).flatMap((cap) => {
    const kinds = PUBLIC_KINDS.filter((k) => cap.conversationTypes[k] && cap.conversationTypes[k]!.visibility === 'public' && cap.conversationTypes[k]!.read !== 'not_available');
    if (!kinds.length) return [];
    return [{
      key: `connected:${cap.kind}`, layer: 'connected' as const, label: NETWORK_LABEL[cap.kind], network: cap.kind,
      covers: kinds.map((k, i) => (i ? `${k}s` : `${k[0]!.toUpperCase()}${k.slice(1)}s`)).join(', ').replace(/, ([^,]*)$/, ' and $1'),
      excludes: 'Private messages; other accounts’ posts; anything the connected account cannot see',
      access: 'connected_account' as const, requires: cap.requires, history: cap.history,
      limitations: ['Only accounts you connect — not the wider network', ...(cap.inbound === 'polling' ? ['Collected by polling: minutes of delay are normal'] : [])],
      implemented: impl.has(cap.kind), verifiedOn: cap.verifiedOn,
    }];
  });
}

const BV = '2026-11-07 (foundation capability matrix; re-verify before building an adapter)';
/** Broader listening sources (none implemented or activated in this build). */
export const BROAD_SOURCES: ListeningSourceDef[] = [
  { key: 'broad:x_recent_search', layer: 'broad', label: 'X search', network: 'x', covers: 'Public posts matching a query (recent window)', excludes: 'Protected accounts, DMs',
    access: 'paid_api', requires: ['X API pay-per-use credits (per-request charges)', 'Owner budget approval'], history: 'Recent search: last 7 days (full archive costs more)',
    limitations: ['Billed per request', 'Rate limits'], implemented: false, verifiedOn: BV },
  { key: 'broad:youtube_search', layer: 'broad', label: 'YouTube search', network: 'youtube', covers: 'Public videos and their comments matching a query', excludes: 'Private/unlisted videos',
    access: 'public_api', requires: ['YouTube Data API key (Google Cloud project)', 'Quota: search costs 100 units of 10,000/day'], history: 'Search results ranked by YouTube; not exhaustive',
    limitations: ['Results are ranked, not complete', 'Daily quota'], implemented: false, verifiedOn: BV },
  { key: 'broad:bluesky_search', layer: 'broad', label: 'Bluesky search', network: 'bluesky', covers: 'Public posts matching a query', excludes: 'DMs',
    access: 'public_api', requires: ['Bluesky account app password (authenticated search)'], history: 'Search index as served by the AppView',
    limitations: ['Search ranking/coverage set by the provider'], implemented: false, verifiedOn: BV },
  { key: 'broad:reddit', layer: 'broad', label: 'Reddit', network: null, covers: 'Public posts and comments in public subreddits', excludes: 'Private/quarantined communities',
    access: 'licensed', requires: ['Reddit Data API commercial terms / agreement'], history: 'Per agreement',
    limitations: ['Commercial use needs an agreement'], implemented: false, verifiedOn: BV },
  { key: 'broad:news_web', layer: 'broad', label: 'News, blogs and forums', network: null, covers: 'Articles, blogs and forums from a licensed data provider', excludes: 'Paywalled or logged-in content',
    access: 'licensed', requires: ['Licensed news/web data provider contract'], history: 'Per provider licence',
    limitations: ['Coverage is the provider’s, not the whole web'], implemented: false, verifiedOn: BV },
];

export const NOT_OFFERED = ['Scraping logged-in pages or bypassing access controls', 'Private groups and private messages', 'Claims of complete coverage of any network'];

// ------------------------------------------------------------------ provider interface (broad layer)
export interface BroadItem { externalId: string; url: string | null; author: string | null; text: string; occurredAt: string; language: string | null }
export interface ListeningProvider {
  key: string;
  /** True only with credentials/licence/approval in place (never inferred from a mock). */
  activated(workspaceId: string): Promise<boolean>;
  /** Public items for the query terms in [since, until). Must not scrape or bypass access controls. */
  search(workspaceId: string, q: { terms: string[]; since: Date; until: Date; cursor: string | null; limit: number }): Promise<{ items: BroadItem[]; next: string | null; note: string | null }>;
}
const PROVIDERS = new Map<string, ListeningProvider>();
export function registerListeningProvider(p: ListeningProvider): void {
  if (!BROAD_SOURCES.some((s) => s.key === p.key)) throw new Error(`unknown listening source ${p.key}`);
  PROVIDERS.set(p.key, p);
}
export function listeningProvider(key: string): ListeningProvider | null { return PROVIDERS.get(key) ?? null; }

export function allSources(): ListeningSourceDef[] { return [...connectedSources(), ...BROAD_SOURCES]; }
export function sourceLabel(key: string): string { return allSources().find((s) => s.key === key)?.label ?? key; }
export const sourceKeyFor = (kind: ChannelKind) => `connected:${kind}`;

// ------------------------------------------------------------------ channel states
interface ChannelScopeRow {
  id: string; brand_id: string; kind: ChannelKind; display_name: string; is_simulated: boolean; status: string; status_detail: string | null;
  enabled_types: string[]; created_at: Date; disconnected_at: Date | null; excluded: boolean | null;
  first_obs: Date | null; last_obs: Date | null; obs: number;
}

async function channelsInScope(db: Queryable, workspaceId: string, brandIds: string[], dataset: 'live' | 'simulated' | null, since: Date | null): Promise<ChannelScopeRow[]> {
  if (!brandIds.length) return [];
  return many<ChannelScopeRow>(db,
    `SELECT ch.id, ch.brand_id, ch.kind, ch.display_name, ch.is_simulated, ch.status, ch.status_detail, ch.enabled_types, ch.created_at, ch.disconnected_at,
            s.excluded, o.first_obs, o.last_obs, coalesce(o.n, 0)::int AS obs
       FROM inbox_channels ch
       LEFT JOIN listening_channel_settings s ON s.channel_id = ch.id
       LEFT JOIN LATERAL (SELECT min(occurred_at) AS first_obs, max(observed_at) AS last_obs, count(*) AS n FROM listening_observations lo WHERE lo.channel_id = ch.id AND lo.removed_at IS NULL) o ON true
      WHERE ch.workspace_id=$1 AND ch.brand_id = ANY($2::uuid[]) AND ($3::boolean IS NULL OR ch.is_simulated=$3)
        AND (ch.disconnected_at IS NULL OR ($4::timestamptz IS NOT NULL AND ch.disconnected_at > $4))
      ORDER BY ch.created_at`,
    [workspaceId, brandIds, dataset === null ? null : dataset === 'simulated', since]);
}

const publicTypes = (r: ChannelScopeRow) => r.enabled_types.filter((t) => t !== 'dm');
/** Monitoring start: the channel's opt-in, or earlier history the provider returned (imported history counts as collected). */
const monitoringSince = (r: ChannelScopeRow) => (r.first_obs && r.first_obs < r.created_at ? r.first_obs : r.created_at);

function channelProblem(r: ChannelScopeRow): string | null {
  if (r.excluded) return 'Excluded from listening';
  if (r.disconnected_at) return `Disconnected ${r.disconnected_at.toISOString().slice(0, 10)}`;
  if (!publicTypes(r).length) return 'Only private messages enabled';
  if (r.status !== 'active') return r.status_detail ?? (r.status === 'needs_permission' ? 'Permission missing' : r.status === 'paused' ? 'Paused in the inbox' : 'Not collecting');
  return null;
}

/** Coverage registry for the Sources screen (all sources, with this workspace's channels). */
export async function sourceStates(workspaceId: string, brandIds: string[], db: Queryable = getPool()): Promise<ListeningSourceState[]> {
  const chans = await channelsInScope(db, workspaceId, brandIds, null, null);
  const out: ListeningSourceState[] = [];
  for (const def of allSources()) {
    if (def.layer === 'broad') {
      const p = listeningProvider(def.key);
      const active = p ? await p.activated(workspaceId) : false;
      out.push({ ...def, status: active ? 'active' : 'awaiting_activation', status_detail: active ? null : def.implemented ? 'Needs credentials or a licence' : 'Awaiting provider access (no adapter yet)', channels: [] });
      continue;
    }
    const mine = chans.filter((c) => c.kind === def.network);
    const collecting = mine.filter((c) => !channelProblem(c));
    const status: SourceStatus = !mine.length ? 'not_connected' : collecting.length === mine.length ? 'active' : collecting.length ? 'needs_attention' : mine.every((c) => c.excluded) ? 'paused' : 'needs_attention';
    out.push({
      ...def, status, status_detail: !mine.length ? 'No channel of this network in the inbox' : mine.filter((c) => channelProblem(c)).map((c) => `${c.display_name}: ${channelProblem(c)}`).join(' · ') || null,
      channels: mine.map((c) => ({
        id: c.id, display_name: c.display_name, brand_id: c.brand_id, is_simulated: c.is_simulated, channel_status: c.status, excluded: !!c.excluded,
        monitoring_since: monitoringSince(c).toISOString(), last_observed_at: iso(c.last_obs), observations: c.obs,
      })),
    });
  }
  return out;
}

/** Does any live (non-simulated) connected channel exist for these brands? Decides the default dataset. */
export async function defaultDataset(workspaceId: string, brandIds: string[], db: Queryable = getPool()): Promise<'live' | 'simulated'> {
  if (!brandIds.length) return 'live';
  const r = await many<{ sim: boolean }>(db, `SELECT DISTINCT is_simulated AS sim FROM inbox_channels WHERE workspace_id=$1 AND brand_id = ANY($2::uuid[]) AND disconnected_at IS NULL`, [workspaceId, brandIds]);
  return r.some((x) => !x.sim) || !r.length ? 'live' : 'simulated';
}

export interface CoverageInput {
  workspaceId: string; brandIds: string[]; dataset: 'live' | 'simulated'; sources: string[]; kinds?: string[]; from: Date; to: Date;
  queryVersion: number | null; sample: ListeningCoverage['sample'];
}

/** Coverage statement attached to every listening result (honest metrics, brief §15). */
export async function buildCoverage(i: CoverageInput, db: Queryable = getPool()): Promise<ListeningCoverage> {
  const chans = (await channelsInScope(db, i.workspaceId, i.brandIds, i.dataset, i.from)).filter((c) => !i.sources.length || i.sources.includes(sourceKeyFor(c.kind)));
  const defs = connectedSources().filter((d) => !i.sources.length || i.sources.includes(d.key));
  const collecting = chans.filter((c) => !channelProblem(c) || (c.disconnected_at && c.disconnected_at > i.from && !c.excluded));
  const since = collecting.map(monitoringSince).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  const incomplete = chans.map((c) => [c, channelProblem(c)] as const).filter(([, p]) => !!p).map(([c, p]) => ({ channel: c.display_name, reason: p! }));
  const retrieved = chans.map((c) => c.last_obs).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const sources = defs.map((d) => {
    const cs = chans.filter((c) => c.kind === d.network);
    const ok = cs.filter((c) => !channelProblem(c));
    return { key: d.key, label: d.label, status: (!cs.length ? 'not_connected' : ok.length === cs.length ? 'active' : ok.length ? 'needs_attention' : cs.every((c) => c.excluded) ? 'paused' : 'needs_attention') as SourceStatus, channels: cs.length };
  }).filter((s) => s.channels > 0 || i.sources.includes(s.key));
  const awaiting = BROAD_SOURCES.filter((b) => !listeningProvider(b.key)).filter((b) => !i.sources.length || i.sources.includes(b.key)).map((b) => ({ key: b.key, label: b.label }));
  // not_collected = no channel in scope at all; incomplete = channels exist but some/all are failing or excluded.
  const state: ListeningCoverage['state'] = !chans.length ? 'not_collected' : i.sample.unique > 0 ? 'matches' : incomplete.length || !collecting.length ? 'incomplete' : 'no_matches';
  const limitations = [
    'Connected accounts only — not the wider network.',
    'Private messages are never included.',
    ...(awaiting.length ? [`Broader sources awaiting activation: ${awaiting.map((a) => a.label).join(', ')}.`] : []),
    ...(i.dataset === 'simulated' ? ['Simulated data — for testing only.'] : []),
    ...(since && since > i.from ? [`Nothing was collected before ${since.toISOString().slice(0, 10)}.`] : []),
  ];
  return {
    dataset: i.dataset, window: { from: i.from.toISOString(), to: i.to.toISOString() }, sources, awaiting, history_from: iso(since),
    partial_window: !!since && since > i.from, incomplete, retrieved_at: iso(retrieved), query_version: i.queryVersion, sample: i.sample, state, limitations,
    methods: {
      dedupe: DEDUPE_METHOD, sentiment: METHOD_LABELS[SENTIMENT_METHOD]!, topics: 'Keyword grouping: co-occurring keywords and pairs (search terms excluded).',
      language: 'The inbox language when set, else a stopword check (en, es, fr, de, it, pt, nl); otherwise “undetermined”.',
    },
  };
}

/** Earliest monitored instant per channel set (spike baselines only count windows after this). */
export async function monitoredSince(workspaceId: string, brandId: string, dataset: 'live' | 'simulated', sources: string[], db: Queryable = getPool()): Promise<Date | null> {
  const chans = (await channelsInScope(db, workspaceId, [brandId], dataset, null)).filter((c) => !c.excluded && publicTypes(c).length && (!sources.length || sources.includes(sourceKeyFor(c.kind))));
  return chans.map(monitoringSince).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
}
