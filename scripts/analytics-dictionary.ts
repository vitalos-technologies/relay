// Generate docs/V3_ANALYTICS_DICTIONARY.md from the canonical metric registry (packages/services/src/analytics/registry.ts).
// Usage: npx tsx scripts/analytics-dictionary.ts [--check]   (--check exits 1 when the committed file is out of date)
// The worked examples are COMPUTED with the production semantics functions on synthetic numbers.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROVIDER_LABEL, PROVIDERS } from '@social-lite/core';
import { ENGAGEMENT_FAMILIES, FAMILIES, MEASURES, METRIC_DEFINITIONS, REGISTRY_VERSION_NOTE, definition } from '../packages/services/src/analytics/registry.js';
import { compare, localDayHours, ratioOfSums, resolvePeriod, sumCompatible, IncompatibleMetricsError } from '../packages/services/src/analytics/semantics.js';
import { METRICS_RESEARCHED_ON } from '../packages/providers/src/metrics.js';

const out = fileURLToPath(new URL('../docs/V3_ANALYTICS_DICTIONARY.md', import.meta.url));
const esc = (s: string) => s.replace(/\|/g, '\\|');
const L: string[] = [];
L.push('# Relay V3 — Analytics dictionary', '',
  `> Generated from \`packages/services/src/analytics/registry.ts\` by \`scripts/analytics-dictionary.ts\` — do not edit by hand. Provider facts verified ${METRICS_RESEARCHED_ON} (sources in \`packages/providers/src/<provider>/metrics.ts\`).`, '',
  '## How to read this', '',
  '- **Metric id** `<provider>.<scope>.<native metric>` + **version**. ' + REGISTRY_VERSION_NOTE,
  '- **Time basis** — `lifetime`: cumulative total since publication, observed at a moment (stored as an as-of snapshot, never as “activity that day”); `window`: provider total over a rolling window (Pinterest ≤ 90 days: equals lifetime while the Pin is younger than the window); `snapshot`: point-in-time gauge (followers); `daily`: provider-defined day bucket.',
  '- **Aggregation** — `sum`: additive across posts; `latest`: snapshot gauge, one latest value per account, never summed over dates; `ratio_of_sums`: Σ numerator ÷ Σ denominator; `none`: not aggregated.',
  '- **Family** decides what may be combined: only metrics of the SAME family are ever added; unique families (reach) are never added across accounts or networks; cross-network totals are labelled with their native components.',
  '- **Paid**: `organic`, `mixed` (network total includes boosted/promoted distribution), `paid` (excluded from Relay analytics).',
  '- **Availability**: `available`, `permission_required` (needs an approved scope/role), `in_development` (network marks it so), `not_fetched` (supported by the network, not requested by the current adapter), `excluded`.',
  '- **Delay**: data is complete through `observed_at − delay` (shown as the series “through” date).', '');

L.push('## Families', '', '| Family | Label | Cross-network | Unique people | In “Engagements” |', '|---|---|---|---|---|');
for (const [k, f] of Object.entries(FAMILIES)) L.push(`| \`${k}\` | ${f.label} | ${f.crossNetwork === 'never' ? 'never combined' : 'labelled sum'} | ${f.unique ? 'yes' : 'no'} | ${f.engagement ? 'yes' : 'no'} |`);
L.push('');

L.push('## Measures (what the analytics views can show)', '', '| Measure | Label | Unit | Built from |', '|---|---|---|---|');
for (const [k, m] of Object.entries(MEASURES)) {
  const from = m.kind === 'app' ? 'app records (published deliveries)' : m.kind === 'rate' ? `Σ engagements ÷ Σ ${m.denominator} over posts reporting both`
    : m.kind === 'ratio' ? 'Σ watch time (s) ÷ Σ views over videos reporting both' : m.kind === 'engagements' ? ENGAGEMENT_FAMILIES.join(' + ') : m.kind === 'snapshot' ? 'latest follower snapshot per account' : m.families.join(', ');
  L.push(`| \`${k}\` | ${m.label} | ${m.unit} | ${from} |`);
}
L.push('');

for (const p of PROVIDERS) {
  const defs = METRIC_DEFINITIONS.filter((d) => d.provider === p);
  L.push(`## ${PROVIDER_LABEL[p]}`, '');
  if (!defs.length) { L.push('No metrics: the Bot API exposes no post or channel statistics to bots. Shown as **unsupported**, never 0.', ''); continue; }
  L.push('| Metric id | v | Native | Name | Unit | Scope | Family | Aggregation | Basis | Paid | Availability | Fetched | Scopes | Delay h | Retention |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const d of defs) {
    L.push(`| \`${d.id}\` | ${d.version} | \`${d.nativeMetric}\`${d.aliases?.length ? ` (alias ${d.aliases.map((a) => `\`${a}\``).join(', ')})` : ''}${d.dimensionKey ? ` by ${d.dimensionKey}` : ''} | ${esc(d.name)} | ${d.unit} | ${d.scope} | ${d.family} | ${d.aggregation} | ${d.timeBasis} | ${d.paid} | ${d.availability} | ${d.fetched ? 'yes' : 'no'} | ${d.requiredScopes.map((s) => `\`${s}\``).join(' ') || '—'} | ${d.providerDelayHours} | ${d.retentionDays ? `${d.retentionDays} d` : '—'} |`);
  }
  L.push('', ...defs.map((d) => `- **${esc(d.name)}** (\`${d.id}\`): ${esc(d.description)}${d.notes ? ` ${esc(d.notes)}` : ''}${d.minThreshold ? ` Threshold: ${d.minThreshold}.` : ''}`), '');
}

// ------------------------------------------------------------------ worked examples (computed)
const er = ratioOfSums([{ numerator: 10, denominator: 100 }, { numerator: 90, denominator: 300 }, { numerator: 50, denominator: null }]);
const views = sumCompatible([{ def: definition('instagram.post.views')!, value: 1200 }, { def: definition('tiktok.video.view_count')!, value: 5400 }]);
let refused = '';
try { sumCompatible([{ def: definition('instagram.post.views')!, value: 1200 }, { def: definition('x.post.impression_count')!, value: 3000 }]); } catch (e) { if (e instanceof IncompatibleMetricsError) refused = e.message; }
let reachRefused = '';
try { sumCompatible([{ def: definition('instagram.post.reach')!, value: 800 }, { def: definition('facebook.post.post_total_media_view_unique')!, value: 600 }]); } catch (e) { if (e instanceof IncompatibleMetricsError) reachRefused = e.message; }
const avd = ratioOfSums([{ numerator: 50 * 60, denominator: 100 }, { numerator: 50 * 60, denominator: 300 }]);
const cmpNew = compare(42, 0, { previousPeriod: null });
const cmpUp = compare(120, 100, { previousPeriod: null });
const dst = resolvePeriod('2026-10-25', '2026-10-25', 'Europe/London');

L.push('## Query and aggregation examples (synthetic numbers, computed by the production functions)', '',
  '### 1. Engagement rate is a ratio of sums', '',
  'Posts: A = 10 engagements / 100 views, B = 90 / 300, C (Bluesky) = 50 engagements and no views.', '',
  `Result: **${(er.value! * 100).toFixed(1)}%** = ${er.numerator} ÷ ${er.denominator} over ${er.included} posts (C excluded: no compatible denominator). The average of per-post rates (20%) is never used.`, '',
  '### 2. Cross-network totals only within a family, always labelled', '',
  `Instagram views 1,200 + TikTok video views 5,400 ⇒ **${views.total.toLocaleString('en-GB')}** labelled “${views.label}”.`, '',
  `Instagram views + X impressions ⇒ refused: “${refused}”`, '',
  `Instagram reach + Facebook viewers ⇒ refused: “${reachRefused}”`, '',
  '### 3. Average view duration (YouTube)', '',
  `Video 1: 50 min / 100 views; video 2: 50 min / 300 views ⇒ **${avd.value} s** (Σ 6,000 s ÷ Σ 400 views), not the mean of 30 s and 10 s.`, '',
  '### 4. Comparisons', '',
  `Current 42 vs previous 0 ⇒ state **${cmpNew.state}** (no percentage). Current 120 vs previous 100 ⇒ **${cmpUp.state} ${Math.round(cmpUp.change_pct! * 100)}%**. Missing/insufficient previous coverage (< 50 % of eligible posts with data) ⇒ **insufficient**.`, '',
  '### 5. Day boundaries', '',
  `\`from=2026-10-25&to=2026-10-25&tz=Europe/London\` ⇒ ${dst.start_utc} … ${dst.end_utc} (a ${localDayHours('2026-10-25', 'Europe/London')}-hour day). Posts are bucketed by their publish instant in the selected timezone; cached rollups use 15-minute buckets, exact for every real UTC offset.`, '',
  '### 6. Lifetime counters vs daily activity', '',
  'A post observed with 100 impressions on 2 Sep and 160 on 3 Sep is stored as two **as-of snapshots** (`metric_cumulative_facts`). The post’s value is **160** (latest), labelled “Lifetime performance of posts published in this period”. The difference (+60) is stored separately as an **observed change** (`metric_daily_facts.fact_kind = observed_change`) — it may include corrections and is not an event-time count. A single snapshot never produces a history.', '',
  '### 7. API examples', '',
  '```http',
  'GET /api/analytics/overview?brand=<uuid>&from=2026-10-01&to=2026-10-28&tz=Europe/London&measure=engagements',
  'GET /api/analytics/content?network=instagram,tiktok&from=2026-10-01&to=2026-10-28&sort=engagement_rate&dir=desc&page=1&page_size=25',
  'GET /api/analytics/content/<delivery-id>?tz=Europe/London',
  'GET /api/analytics/channels?account=<uuid>,<uuid>&from=2026-10-01&to=2026-10-28&measure=views',
  'GET /api/analytics/video | /audience | /workflow | /best-time ?{same filters}',
  'GET /api/analytics/metrics                       # this dictionary as JSON',
  'POST /api/analytics/reports {"name":"Weekly","view":"overview","query_string":"brand=<uuid>&from=…&to=…&tz=Europe/London","visibility":"workspace"}',
  'POST /api/analytics/exports {"view":"content","format":"csv","query_string":"…"}   → poll GET /api/analytics/exports/<id> → GET …/download',
  '```', '',
  'Filter keys: `brand`, `account`, `network`, `campaign`, `team`, `format` (comma-separated), `from`, `to` (YYYY-MM-DD, inclusive local dates), `tz`, `compare` (`previous_period`|`none`), `dataset` (`live`|`simulated`|`demo`). Responses: `packages/core/src/contracts/analytics.ts`.', '',
  '## Pipeline and storage', '',
  '1. **Sync** (worker queue `analytics-sync`, `services/analytics/sync.ts`): one cursor per account (`sync_cursors`), keyset checkpoint after every post, bounded backfill (≤ 90 days; Pinterest 89; X 30), cadence by post age (6 h → 24 h → weekly → final at the horizon; X billable reads are rarer and budget-metered), exponential back-off, per-workspace concurrency, yields while publishing work is due. Authority re-checked when the job runs and before every item: disconnected / reconnect-required accounts, archived brands and suspended workspaces stop the cursor. Every run is a `sync_runs` row with an idempotent job key.',
  '2. **Raw observations** (`metric_observations`): validated (registry-mapped, finite, non-negative) and deduplicated on the fact key (workspace, account, resource, metric, period, dimension, definition version). A re-read with the same value changes nothing; a different value bumps `revision` and keeps `previous_value` (late correction); an older observation never overwrites a newer one.',
  '3. **Facts**: `metric_cumulative_facts` (lifetime / snapshot / window values as of a UTC date) are separate from `metric_daily_facts` (provider-reported day buckets, and labelled `observed_change` deltas).',
  '4. **Cached aggregates**: `metric_resource_latest` (latest value per post and metric) and `metric_rollups` (15-minute publish buckets, recomputed per touched bucket; derived per-post pairings for engagements and ratio measures). Filters the rollups cannot answer (campaign/team/format) use the identical per-post computation.',
  '5. **Coverage** (`data_coverage`): fetch outcome per post and metric (ok / unsupported / permission missing / delayed / failed / not found / …) — the source of the series states below.',
  '6. **Report API** (`services/analytics/query.ts`, `/api/analytics/**`): authorized per brand with `analytics.read` (exports also `exports.create`), dataset-isolated (`live` = network data of real accounts; `simulated` = mock destinations; `demo` = synthetic fixtures in demo workspaces only).',
  '',
  'Legacy V1.1 `metric_snapshots` / `metric_fetch_state` are backfilled idempotently by the worker (`services/analytics/backfill.ts`); unsupported or permission-missing states become coverage rows, never zero values. Retention: raw observations 400 days; facts of an account whose access ended are kept 90 days after disconnection, then purged; facts of posts deleted in Relay are removed; posts deleted on the network keep their last values and stop refreshing.', '',
  '## Series states', '',
  '| State | Meaning |', '|---|---|',
  '| `ok` | Observed values for every eligible item. |',
  '| `zero` | Observed, and the value is 0. |',
  '| `unsupported` | The network does not provide this metric (for this content type). |',
  '| `permission_missing` | The connection lacks the scope/role (or access was revoked / reconnect needed). |',
  '| `not_fetched` | Never attempted yet, or the adapter does not request it. |',
  '| `stale` | The account has not synced successfully for 48 h while posts are still in their refresh window. |',
  '| `provider_delayed` | The network reports with a delay; recent items have no data yet. |',
  '| `partial_coverage` | Only some eligible items have data (coverage shows how many). |',
  '| `fetch_failed` | The last attempts failed (errors, rate limits, budget). |', '',
  'Missing values are `null` in the API and blank in exports — never 0 — and charts must not connect them.', '');

const text = L.join('\n');
if (process.argv.includes('--check')) {
  let cur = ''; try { cur = readFileSync(out, 'utf8'); } catch { /* missing */ }
  if (cur !== text) { console.error('docs/V3_ANALYTICS_DICTIONARY.md is out of date: run npx tsx scripts/analytics-dictionary.ts'); process.exit(1); }
  console.log('dictionary up to date');
} else {
  writeFileSync(out, text);
  console.log(`wrote ${out} (${METRIC_DEFINITIONS.length} definitions)`);
}
