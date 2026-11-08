// Listening results for the assistant, read through stream D's published services (getSearch / searchMentions) with the
// requester's context — so listening.read on the search's brand, D's private-message exclusion, deletion propagation
// and coverage rules all apply. Mentions are customer content (untrusted); coverage is Relay data. The coverage source
// lets summaries state what the data does not cover (zero matches vs. not collected).
import type { Ctx } from '../context.js';
import type { ListeningSourceProvider, RetrievedSource } from './retrieval.js';

const MAX_MENTIONS = 40;

export const listeningSourceProvider: ListeningSourceProvider = async (ctx: Ctx, searchId: string) => {
  const { getSearch } = await import('../listening/searches.js');
  const { searchMentions } = await import('../listening/query.js');
  const s = await getSearch(ctx, searchId);
  const m = await searchMentions(ctx, searchId, { days: 30, limit: MAX_MENTIONS });
  const rows = m.items.filter((o) => o.text && !o.removed_at_source && !o.excluded);
  const mentions = rows.map((o) => `[${o.occurred_at}] (${o.source.label}; sentiment ${o.sentiment.effective}${o.sentiment.uncertain ? ', uncertain' : ''}${o.topics.length ? `; topics ${o.topics.join(', ')}` : ''}) ${o.author ?? 'Someone'}: ${o.text}`);
  const c = m.coverage;
  const coverage = [
    `Dataset: ${c.dataset}. Window: ${c.window.from} to ${c.window.to}.`,
    `Mentions provided: ${rows.length}${m.next_cursor ? ` (more exist; only the latest ${MAX_MENTIONS} are included)` : ''}.`,
    `Sources: ${c.sources.map((x) => `${x.label} (${x.status}, ${x.channels} channels)`).join('; ') || 'none'}.`,
    c.awaiting.length ? `Not collected (awaiting activation): ${c.awaiting.map((x) => x.label).join(', ')}.` : null,
    c.partial_window ? `Monitoring started ${c.history_from ?? 'recently'}; earlier periods are not collected (not zero).` : null,
    c.incomplete.length ? `Incomplete: ${c.incomplete.map((x) => `${x.channel} (${x.reason})`).join('; ')}.` : null,
    'Private messages are not part of listening.',
  ].filter(Boolean).join('\n');
  const now = new Date().toISOString();
  const sources: RetrievedSource[] = [
    { kind: 'listening', id: searchId, title: `Mentions · ${s.name}`, link: `/listening/searches/${searchId}`, freshness: now, trust: 'untrusted', stale: false, text: mentions.join('\n') || '(no mentions in this window)' },
    { kind: 'listening', id: searchId, title: `Coverage · ${s.name}`, link: `/listening/searches/${searchId}`, freshness: now, trust: 'observed', stale: false, text: coverage },
  ];
  return { brandId: s.brand_id, sources };
};
