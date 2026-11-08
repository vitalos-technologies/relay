// V3.5 listening (pure): Boolean query parser/evaluator, search compilation, lexicon sentiment (uncertainty, negation,
// non-English unscored), language heuristic, terms, repeat fingerprint, spike decision (minimum sample, baseline), source
// registry (DMs excluded, broad sources awaiting activation), queue/event wiring.
import { describe, expect, it } from 'vitest';
import { PRESET_PERMISSIONS } from '@social-lite/core';
import {
  compileSearch, evaluateQuery, matchSearch, parseQuery, prepareText, QueryError, searchVocabulary, tokenize,
} from '@social-lite/core/contracts/v35-listening';
import { V35_EVENT_QUEUES } from '@social-lite/core/contracts/v35-events';
import { detectLanguage, extractTerms, fingerprint, scoreSentiment } from '@social-lite/services/listening/classify';
import { evaluateSpike, windowStart } from '@social-lite/services/listening/spike';
import { BROAD_SOURCES, connectedSources } from '@social-lite/services/listening/sources';
import { QUEUE_CLASS } from '@social-lite/services/workload/policy';

const m = (q: string, text: string) => evaluateQuery(parseQuery(q), prepareText(text));

describe('Boolean queries', () => {
  it('terms, phrases, AND/OR/NOT, implicit AND, brackets, prefix, hashtags, accents', () => {
    expect(m('vitalos', 'Love VITALOS!')).toBe(true);
    expect(m('vitalos', 'vitalosity')).toBe(false);                    // whole words only
    expect(m('vital*', 'vitalosity')).toBe(true);
    expect(m('"flat white"', 'a flat, white wall')).toBe(true);        // punctuation ignored between words
    expect(m('"flat white"', 'white flat')).toBe(false);
    expect(m('coffee tea', 'coffee and tea')).toBe(true);              // implicit AND
    expect(m('coffee tea', 'coffee only')).toBe(false);
    expect(m('coffee OR tea', 'tea only')).toBe(true);
    expect(m('coffee NOT decaf', 'decaf coffee')).toBe(false);
    expect(m('coffee -decaf', 'coffee')).toBe(true);
    expect(m('(latte OR mocha) AND oat', 'oat mocha please')).toBe(true);
    expect(m('cafe', 'Café Vitalos')).toBe(true);                      // accent-insensitive
    expect(m('#vitalos', 'go #Vitalos')).toBe(true);
    expect(m('#vitalos', 'go vitalos')).toBe(false);                   // a hashtag term needs the hashtag
    expect(m('vitalos', 'go #vitalos')).toBe(true);                    // a word matches its hashtag form
    expect(m('e-mail', 'send an e mail')).toBe(true);
  });

  it('rejects invalid queries with a position', () => {
    for (const bad of ['', '(coffee', 'coffee)', '"open', 'NOT coffee', 'coffee AND', 'co*', 'OR tea', ')(']) {
      expect(() => parseQuery(bad), bad).toThrow(QueryError);
    }
    try { parseQuery('coffee AND (tea'); } catch (e) { expect((e as QueryError).position).toBe(11); }
    expect(() => parseQuery('x'.repeat(501))).toThrow(/500/);
    expect(() => parseQuery(Array.from({ length: 51 }, (_, i) => `t${i}`).join(' OR '))).toThrow(/50 terms/);
    expect(() => parseQuery('('.repeat(12) + 'a' + ')'.repeat(12))).toThrow(/nested/);
    expect(() => parseQuery('and or not')).not.toThrow();              // lower-case operators are plain words
  });

  it('compiled searches: names/keywords any-of, Boolean must also match, exclusions win, vocabulary for topics', () => {
    const c = compileSearch({ terms: ['Vitalos', 'Vitalos Café'], keywords: ['#vitaloscafe'], exclusions: ['job', 'hiring'], boolean: 'NOT spam' });
    expect(matchSearch(c, prepareText('Vitalos rocks'))).toBe(true);
    expect(matchSearch(c, prepareText('#VitalosCafe rocks'))).toBe(true);
    expect(matchSearch(c, prepareText('Vitalos is hiring'))).toBe(false);
    expect(matchSearch(c, prepareText('Vitalos spam'))).toBe(false);
    expect(matchSearch(c, prepareText('other cafe'))).toBe(false);
    expect([...searchVocabulary(c)].sort()).toEqual(['cafe', 'spam', 'vitalos', 'vitaloscafe']);
    expect(() => compileSearch({ terms: [], keywords: [], exclusions: ['x'], boolean: null })).toThrow(QueryError);
    expect(tokenize('Hi @Vitalos — see https://x.y/z #Tart')).toEqual(['hi', '@vitalos', 'see', '#tart']);
  });
});

describe('lexicon baseline', () => {
  it('scores English with evidence, negation within a clause, intensifiers, emoji; uncertain when weak', () => {
    const pos = scoreSentiment('I love the flat white, really delicious ❤️', null);
    expect(pos).toMatchObject({ label: 'positive', method: 'lexicon_v1', uncertain: false });
    expect(pos.evidence).toEqual(expect.arrayContaining(['love', 'delicious', '❤️']));
    expect(scoreSentiment('The cake was not good', 'en')).toMatchObject({ label: 'negative', evidence: ['not good'] });
    expect(scoreSentiment('Nobody replied. Terrible service.', 'en').label).toBe('negative');
    expect(scoreSentiment('Charged twice for one order', 'en').label).toBe('negative');
    const mixed = scoreSentiment('Great coffee but rude staff', 'en');
    expect(mixed.label).toBe('mixed');
    expect(mixed.uncertain).toBe(true);
    const flat = scoreSentiment('Opening hours on Sunday?', 'en');
    expect(flat).toMatchObject({ label: 'neutral', uncertain: true, evidence: [] });
    expect(scoreSentiment('El café es muy bueno y la tarta también', null)).toMatchObject({ label: 'unscored', score: null });
  });

  it('language heuristic, terms, fingerprints', () => {
    expect(detectLanguage('The coffee is great and the staff are friendly')).toBe('en');
    expect(detectLanguage('El café es muy bueno y la tarta')).toBe('es');
    expect(detectLanguage('Merci pour le café, très bon')).toBe('fr');
    expect(detectLanguage('ok')).toBe('und');
    expect(extractTerms('The oat latte at Vitalos — oat latte forever!')).toEqual(['oat', 'oat latte', 'latte', 'vitalos', 'latte forever', 'forever']);
    expect(fingerprint('Stale tart today @vitalos https://x.y/1')).toBe(fingerprint('stale  TART today!!'));
    expect(fingerprint('love it')).toBeNull();                         // short texts never collapsed
  });
});

describe('spike decision', () => {
  it('needs minimum sample, enough baseline windows and a clear excess over the baseline', () => {
    const base = Array(24).fill(2);
    expect(evaluateSpike({ observed: 9, baseline: base, minSample: 10, multiplier: 2, minBaselineWindows: 24 })).toMatchObject({ fire: false, reason: 'below_minimum_sample' });
    expect(evaluateSpike({ observed: 30, baseline: base.slice(0, 5), minSample: 10, multiplier: 2, minBaselineWindows: 24 })).toMatchObject({ fire: false, reason: 'insufficient_baseline' });
    expect(evaluateSpike({ observed: 12, baseline: base, minSample: 10, multiplier: 2, minBaselineWindows: 24 })).toMatchObject({ fire: true, reason: 'fired', mean: 2, threshold: 10 });
    const noisy = [0, 20, 0, 20, 0, 20, 0, 20, 0, 20, 0, 20, 0, 20, 0, 20, 0, 20, 0, 20, 0, 20, 0, 20];
    const r = evaluateSpike({ observed: 25, baseline: noisy, minSample: 10, multiplier: 2, minBaselineWindows: 24 });
    expect(r).toMatchObject({ fire: false, reason: 'within_baseline' });  // mean + 3σ guards noisy baselines
    expect(r.threshold).toBeGreaterThan(25);
    expect(windowStart(new Date('2026-11-08T10:47:12Z'), 60).toISOString()).toBe('2026-11-08T10:00:00.000Z');
    expect(windowStart(new Date('2026-11-08T10:47:12Z'), 15).toISOString()).toBe('2026-11-08T10:45:00.000Z');
  });
});

describe('sources + wiring', () => {
  it('connected sources come from public inbox types (never WhatsApp/DMs); broad sources are not implemented', () => {
    const keys = connectedSources().map((s) => s.key);
    expect(keys).toContain('connected:facebook_page');
    expect(keys).not.toContain('connected:whatsapp');
    expect(connectedSources().find((s) => s.key === 'connected:facebook_page')).toMatchObject({ implemented: true, layer: 'connected' });
    expect(BROAD_SOURCES.every((s) => !s.implemented && s.layer === 'broad' && s.requires.length > 0)).toBe(true);
    expect(V35_EVENT_QUEUES['listening.ingest_requested']).toBe('listening-ingest');
    expect(V35_EVENT_QUEUES['listening.alert_fired']).toBe('inbox-events');
    expect(QUEUE_CLASS['listening-ingest']).toBe('listening_ingest');
    expect(PRESET_PERMISSIONS.analyst).toContain('listening.read');
    expect(PRESET_PERMISSIONS.care_agent).not.toContain('listening.read');
    expect(PRESET_PERMISSIONS.admin).toContain('listening.manage');
    expect(PRESET_PERMISSIONS.editor).not.toContain('listening.manage');
  });
});
