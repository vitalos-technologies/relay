// V3.1 GOV pure logic: brand-rule evaluation (mandatory vs advisory), TipSignal fact preservation, promise language,
// time-sensitive reuse signals, UTM building (preserve params, no duplicate keys, URL validation), feature-flag
// evaluation, support-report redaction.
import { beforeAll, describe, expect, it } from 'vitest';
import { resetConfigCache } from '@social-lite/services';
import { evaluateBrandRules, normaliseDomain, splitFindings, type RuleInput, type VariantInput } from '@social-lite/services/gov/rules-engine';
import { buildCampaignUrl, validateDestinationUrl } from '@social-lite/services/gov/links';
import { timeSensitiveReasons, type SignalInput } from '@social-lite/services/gov/reuse';
import { compareVersions, evaluateFlag, redactText, rolloutBucket, safeRoute } from '@social-lite/services/gov/release';
import { safeCorrelationId } from '@social-lite/services/gov/diagnostics';
import { checkSuggestion, findPromiseLanguage } from '@social-lite/services/ai/fidelity';
import { draftText, type TipsignalEvent } from '@social-lite/services/tipsignal';

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgres://unit-test';
  process.env.APP_BASE_URL = 'https://relay.example.com';
  resetConfigCache();
});

const at = new Date('2026-11-10T12:00:00Z');
const now = new Date('2026-11-07T12:00:00Z');
const rule = (r: Partial<RuleInput> & Pick<RuleInput, 'kind' | 'value' | 'severity'>): RuleInput => ({ id: `r-${r.kind}-${r.value}`, replacement: null, providers: [], source: 'brand_rule', ...r });
const v = (text: string, extra: Partial<VariantInput> = {}): VariantInput => ({ connectionId: 'c1', provider: 'x', text, link: null, assetIds: [], ...extra });

describe('brand rules: mandatory vs advisory', () => {
  const rules = [
    rule({ kind: 'prohibited_phrase', value: 'guaranteed win', severity: 'mandatory' }),
    rule({ kind: 'discouraged_phrase', value: 'cheap', severity: 'advisory' }),
    rule({ kind: 'preferred_term', value: 'e-mail', replacement: 'email', severity: 'advisory' }),
    rule({ kind: 'required_footer', value: '18+ only. BeGambleAware.', severity: 'mandatory' }),
    rule({ kind: 'approved_link_domain', value: 'northfield.example', severity: 'mandatory' }),
  ];

  it('keeps severities apart and never mixes them', () => {
    const f = evaluateBrandRules({ rules, variants: [v('A cheap, guaranteed WIN! e-mail us https://evil.example/x')], assets: [], at, now });
    const s = splitFindings(f);
    expect(s.mandatory.map((x) => x.code).sort()).toEqual(['missing_footer', 'prohibited_phrase', 'unapproved_link']);
    expect(s.advisory.map((x) => x.code).sort()).toEqual(['discouraged_phrase', 'preferred_term']);
    expect(s.advisory.find((x) => x.code === 'preferred_term')!.message).toMatch(/Use “email”/);
  });

  it('passes compliant copy; subdomains, www and the app short-link host are approved', () => {
    const text = 'Big match tonight. https://www.northfield.example/a https://shop.northfield.example/b https://relay.example.com/api/l/abcdefghijkl\n18+ only.  BeGambleAware.';
    expect(evaluateBrandRules({ rules, variants: [v(text)], assets: [], at, now, trustedHosts: ['relay.example.com'] })).toEqual([]);
  });

  it('provider-scoped rules apply only to their destinations; identical findings collapse to the base copy', () => {
    const r = [rule({ kind: 'required_disclaimer', value: '#ad', severity: 'mandatory', providers: ['instagram'] }), rule({ kind: 'prohibited_phrase', value: 'free', severity: 'mandatory' })];
    const f = evaluateBrandRules({ rules: r, variants: [v('free stuff', { connectionId: 'a', provider: 'x' }), v('free stuff', { connectionId: 'b', provider: 'instagram' })], assets: [], at, now });
    expect(f.find((x) => x.code === 'prohibited_phrase')!.connection_id).toBeNull();
    expect(f.filter((x) => x.code === 'missing_disclaimer').map((x) => x.connection_id)).toEqual(['b']);
  });

  it('assets: expired (or expiring before publish) is mandatory; superseded/archived advisory', () => {
    const assets = [
      { id: 'a1', name: 'logo.png', expires_at: new Date('2026-11-01T00:00:00Z'), lifecycle: 'active' as const, superseded_by: null },
      { id: 'a2', name: 'hero.png', expires_at: new Date('2026-11-09T00:00:00Z'), lifecycle: 'superseded' as const, superseded_by: 'a3' },
      { id: 'a4', name: 'old.png', expires_at: null, lifecycle: 'archived' as const, superseded_by: null },
    ];
    const f = evaluateBrandRules({ rules: [], variants: [v('x', { assetIds: ['a1', 'a2', 'a4'] })], assets, at, now });
    expect(f.map((x) => `${x.code}:${x.severity}`).sort()).toEqual(['asset_archived:advisory', 'asset_expired:mandatory', 'asset_expires_before_publish:mandatory', 'asset_superseded:advisory']);
    // Unused assets are ignored
    expect(evaluateBrandRules({ rules: [], variants: [v('x')], assets, at, now })).toEqual([]);
  });

  it('normalises approved domains', () => {
    expect(normaliseDomain('https://WWW.Example.com/path?q=1')).toBe('example.com');
    expect(normaliseDomain('*.shop.example.co.uk')).toBe('shop.example.co.uk');
    expect(normaliseDomain('not a domain')).toBeNull();
  });
});

describe('TipSignal fact preservation', () => {
  const pick: TipsignalEvent = { schema_version: 1, event_id: 'evt-unit-1', type: 'picks.ready', occurred_at: '2026-11-05T10:00:00Z',
    data: { record_id: 'r1', source_url: 'https://tipsignal.example/r/1', fixture: { home: 'Northfield', away: 'Southport', competition: 'League One', kickoff_at: '2026-11-14T19:45:00Z' }, market: 'Match result', selection: 'Northfield', probability: 0.623 } };
  const result: TipsignalEvent = { schema_version: 1, event_id: 'evt-unit-2', type: 'results.settled', occurred_at: '2026-11-14T22:00:00Z',
    data: { record_id: 'r1', source_url: 'https://tipsignal.example/r/1', fixture: pick.data.fixture, market: 'Match result', selection: 'Northfield', settled: true, settled_at: '2026-11-14T21:40:00Z', result: 'lost', final_score: '1-2' } };
  const ts = (e: TipsignalEvent) => ({ type: e.type, sourceText: draftText(e, 'Europe/London'), kickoffAt: new Date(e.data.fixture.kickoff_at),
    requiredPhrases: ['Northfield', 'Southport', 'League One', 'Match result', ...(e.type === 'results.settled' ? ['Lost'] : [])] });
  const evalText = (e: TipsignalEvent, text: string, when = at) => evaluateBrandRules({ rules: [], variants: [v(text)], assets: [], tipsignal: ts(e), at: when, now, allowedText: '18+ only' });

  it('the untouched deterministic copy passes; a light rewrite that keeps every fact passes', () => {
    expect(evalText(pick, draftText(pick, 'Europe/London'))).toEqual([]);
    const rewrite = `Sat 14 Nov 19:45 GMT — League One: Northfield v Southport.\nPick: Northfield (Match result). Model probability: 62.3% (an estimate, not a promise).\nhttps://tipsignal.example/r/1\n18+ only`;
    expect(evalText(pick, rewrite)).toEqual([]);
  });

  it('altered probability, date, time, score or result are mandatory findings', () => {
    const src = draftText(pick, 'Europe/London');
    expect(evalText(pick, src.replace('62.3%', '72.3%')).map((f) => `${f.code}:${f.severity}`)).toEqual(['tipsignal_fact_altered:mandatory']);
    expect(evalText(pick, src.replace('19:45', '20:00')).map((f) => f.code)).toEqual(['tipsignal_fact_altered']);
    expect(evalText(pick, src.replace('14 Nov', '15 Nov')).map((f) => f.code)).toEqual(['tipsignal_fact_altered']);
    const rs = draftText(result, 'Europe/London');
    expect(evalText(result, rs.replace('1-2', '2-1'), new Date('2026-11-15T10:00:00Z')).map((f) => f.code)).toEqual(['tipsignal_fact_altered']);
    expect(evalText(result, rs.replace('Lost', 'Won'), new Date('2026-11-15T10:00:00Z')).map((f) => f.code)).toContain('tipsignal_fact_dropped');
  });

  it('invented statistics and dropped facts are mandatory', () => {
    const src = draftText(pick, 'Europe/London');
    expect(evalText(pick, `${src}\nNorthfield have won 7 of their last 8.`).map((f) => f.code)).toEqual(['tipsignal_fact_invented', 'tipsignal_fact_invented']);
    expect(evalText(pick, src.replace('Model probability: 62.3%. ', '')).map((f) => f.code)).toEqual(['tipsignal_fact_dropped']);
  });

  it('probabilities never become promises', () => {
    const src = draftText(pick, 'Europe/London');
    const f = evalText(pick, src.replace('Probabilities are estimates, not promises.', 'Northfield will win — guaranteed!'));
    expect(f.filter((x) => x.code === 'tipsignal_promise_language').map((x) => x.severity)).toEqual(['mandatory', 'mandatory']);
  });

  it('a pick that would publish after kick-off is refused', () => {
    expect(evalText(pick, draftText(pick, 'Europe/London'), new Date('2026-11-14T19:46:00Z')).map((f) => f.code)).toEqual(['tipsignal_expired']);
  });

  it('AI suggestions: promise language is blocked when the source has a probability, flagged otherwise', () => {
    const src = draftText(pick, 'Europe/London');
    const i = checkSuggestion({ sourceText: src, text: `${src}\nA sure thing.` });
    expect(i).toEqual([expect.objectContaining({ code: 'promise_language', severity: 'block' })]);
    expect(checkSuggestion({ sourceText: 'New menu out now', text: 'New menu out now, guaranteed to delight' })).toEqual([expect.objectContaining({ code: 'promise_language', severity: 'warn' })]);
    expect(findPromiseLanguage('Probabilities are estimates, not promises.')).toEqual([]);
    expect(findPromiseLanguage("It's a lock of the day and you can’t lose")).toEqual(expect.arrayContaining(['lock of the day', "can't lose"]));
  });
});

describe('reuse: time-sensitive content is never recycled', () => {
  const base: SignalInput = { sourceKind: null, derivedFromTimeSensitive: false, text: 'Our story: how we roast coffee.', tags: [], campaignEndsOn: null, contentExpiresAt: null, assetExpired: false, now };
  it('flags picks/results, dates, scores, probabilities, ended campaigns, expired promotions and assets', () => {
    expect(timeSensitiveReasons(base)).toEqual([]);
    const codes = (o: Partial<SignalInput>) => timeSensitiveReasons({ ...base, ...o }).map((r) => r.code);
    expect(codes({ sourceKind: 'tipsignal' })).toContain('tipsignal_source');
    expect(codes({ tags: ['Picks'] })).toContain('tipsignal_source');
    expect(codes({ derivedFromTimeSensitive: true })).toEqual(['derived_from_time_sensitive']);
    expect(codes({ text: 'Kick-off Sat 14 Nov at 19:45' })).toEqual(['contains_date_or_time']);
    expect(codes({ text: 'Final score 2-1' })).toEqual(['contains_score']);
    expect(codes({ text: 'A 62% chance' })).toEqual(['contains_probability']);
    expect(codes({ campaignEndsOn: '2026-11-01' })).toEqual(['campaign_ended']);
    expect(codes({ tags: ['promo'] })).toEqual(['promotion_tag']);
    expect(codes({ tags: ['promo'], contentExpiresAt: new Date('2026-12-01T00:00:00Z') })).toEqual([]);
    expect(codes({ contentExpiresAt: new Date('2026-11-01T00:00:00Z') })).toEqual(['content_expired']);
    expect(codes({ assetExpired: true })).toEqual(['asset_expired']);
  });
});

describe('campaign links / UTM', () => {
  const defaults = { utm_source: '{provider}', utm_medium: 'social', utm_campaign: 'autumn_launch' };
  it('preserves existing params (order + repeats), fills only missing UTM keys, never duplicates a key', () => {
    const p = buildCampaignUrl({ url: 'https://shop.example/p?id=7&tag=a&tag=b&utm_medium=email#top', defaults, tokens: { provider: 'instagram' } });
    expect(p.ok).toBe(true);
    const u = new URL(p.url!);
    expect(u.searchParams.getAll('tag')).toEqual(['a', 'b']);
    expect(u.searchParams.get('id')).toBe('7');
    expect(u.searchParams.getAll('utm_medium')).toEqual(['email']); // existing kept, not duplicated
    expect(u.searchParams.get('utm_source')).toBe('instagram');
    expect(u.hash).toBe('#top');
    expect(p.preserved).toEqual(['id', 'tag']);
    expect(p.params.find((x) => x.key === 'utm_medium')!.origin).toBe('existing');
    expect(p.params.find((x) => x.key === 'utm_source')!.origin).toBe('derived');
    for (const k of new Set(u.searchParams.keys())) if (k.startsWith('utm_')) expect(u.searchParams.getAll(k)).toHaveLength(1);
  });

  it('override replaces (collapsing duplicates); null removes; invalid values are rejected', () => {
    const p = buildCampaignUrl({ url: 'https://shop.example/?utm_source=a&utm_source=b&utm_term=x', defaults, overrides: { utm_source: 'newsletter', utm_term: null }, tokens: {} });
    const u = new URL(p.url!);
    expect(u.searchParams.getAll('utm_source')).toEqual(['newsletter']);
    expect(u.searchParams.has('utm_term')).toBe(false);
    expect(p.warnings.join(' ')).toMatch(/utm_source appeared 2 times/);
    expect(buildCampaignUrl({ url: 'https://shop.example/', defaults, overrides: { utm_content: '<script>' } }).ok).toBe(false);
  });

  it('validates destinations', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://x.example/', 'https://user:pw@x.example/', 'https://localhost/x', 'https://intranet/x', 'https://a b.example/', '', `https://x.example/${'a'.repeat(2100)}`]) {
      expect(validateDestinationUrl(bad).ok, bad).toBe(false);
    }
    const ok = validateDestinationUrl('http://shop.example/a');
    expect(ok.ok && ok.warnings).toEqual(['The link is not https.']);
  });
});

describe('release controls', () => {
  const row = (o: Partial<{ default_enabled: boolean; rollout_percent: number; killed: boolean }> = {}) => ({ key: 'v31.content_queue', description: '', default_enabled: false, rollout_percent: 0, killed: false, ...o });
  it('flags: safe default off; override wins; kill switch wins over everything; unknown keys off', () => {
    expect(evaluateFlag('v31.content_queue', 'ws-1', row(), null)).toMatchObject({ enabled: false, source: 'default' });
    expect(evaluateFlag('v31.content_queue', 'ws-1', null, null)).toMatchObject({ enabled: false, source: 'default' });
    expect(evaluateFlag('v31.content_queue', 'ws-1', row(), true)).toMatchObject({ enabled: true, source: 'workspace_override' });
    expect(evaluateFlag('v31.content_queue', 'ws-1', row({ killed: true, default_enabled: true }), true)).toMatchObject({ enabled: false, source: 'killed' });
    expect(evaluateFlag('nope.unknown', 'ws-1', null, true)).toMatchObject({ enabled: false, source: 'unknown' });
    expect(evaluateFlag('v31.content_queue', 'ws-1', row({ rollout_percent: 100 }), null)).toMatchObject({ enabled: true, source: 'rollout' });
  });

  it('rollout buckets are stable per workspace and roughly uniform', () => {
    expect(rolloutBucket('k', 'ws-a')).toBe(rolloutBucket('k', 'ws-a'));
    const n = Array.from({ length: 2000 }, (_, i) => rolloutBucket('v31.x', `ws-${i}`)).filter((b) => b < 25).length;
    expect(n).toBeGreaterThan(400);
    expect(n).toBeLessThan(600);
  });

  it('redacts credentials, tokens, emails and long secrets from free text', () => {
    const r = redactText('Failed with Authorization: Bearer abcdefghijklmnop12345 token=sk-live-123456789012345 for ops@vitalos.example; jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXZhbHVl bot 123456789:AAEhBP0av18_xkF2qz5xLm7nO8pQrStUvWx and password: hunter2');
    expect(r.text).not.toMatch(/abcdefghijklmnop12345|sk-live|ops@vitalos|eyJhbGci|AAEhBP0av|hunter2/);
    expect(r.count).toBeGreaterThanOrEqual(5);
  });

  it('routes keep only the path; correlation ids must be safe', () => {
    expect(safeRoute('https://relay.example.com/posts/123?access_token=abc#x')).toBe('/posts/123');
    expect(safeRoute('/compose?draft=secret')).toBe('/compose');
    expect(safeCorrelationId('3f2a-11ee:abc.1')).toBe('3f2a-11ee:abc.1');
    expect(safeCorrelationId('Bearer abc def')).toBeNull();
    expect(safeCorrelationId('x'.repeat(65))).toBeNull();
    expect(compareVersions('3.1.0', '3.0.9')).toBeGreaterThan(0);
  });
});
