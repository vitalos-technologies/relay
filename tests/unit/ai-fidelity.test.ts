// Deterministic source-fidelity validator for AI suggestions (spec §16).
import { describe, expect, it } from 'vitest';
import { checkSuggestion, extractFacts, extractUrls, findProhibited } from '@social-lite/services/ai/fidelity';

const TIP = `League One: Northfield v Southport
Kick-off Sat 7 Nov, 19:45 GMT

Pick: Northfield (Match result)
Model probability: 62.3%. Probabilities are estimates, not promises.

https://tipsignal.example/r/1`;

const codes = (issues: Array<{ code: string }>) => issues.map((i) => i.code).sort();

describe('extractFacts', () => {
  it('normalises percentages, scores, dates, times, money and numbers', () => {
    const f = extractFacts('Won 2–1 on 2026-11-07 at 7:45pm; 62.3 % chance, odds 1.85, stake £10, 1,200 fans #Top10 @user99 https://x.example/9');
    const keys = f.map((x) => `${x.kind}:${x.value}`);
    expect(keys).toEqual(expect.arrayContaining(['score:2-1', 'date:7 nov', 'time:19:45', 'percent:62.3%', 'number:1.85', 'money:£10', 'number:1200']));
    // hashtags, mentions and links are not facts
    expect(keys).not.toContain('number:10');
    expect(keys).not.toContain('number:99');
    expect(keys).not.toContain('number:9');
  });

  it('treats equivalent date/time spellings as the same fact', () => {
    const a = extractFacts('Kick-off Sat 7 Nov, 19:45').map((x) => `${x.kind}:${x.value}`).sort();
    const b = extractFacts('Kick-off Saturday November 7th at 7:45 pm').map((x) => `${x.kind}:${x.value}`).sort();
    expect(a).toEqual(b);
  });

  it('extracts and normalises links', () => {
    expect(extractUrls('see https://Example.com/a/, and https://example.com/a.')).toEqual(['https://example.com/a']);
  });
});

describe('checkSuggestion', () => {
  it('accepts a faithful rewrite', () => {
    const issues = checkSuggestion({ sourceText: TIP, text: `Northfield v Southport (League One), Sat 7 Nov 19:45 GMT.\nPick: Northfield — model probability 62.3% (an estimate, not a promise).\nhttps://tipsignal.example/r/1`, strict: true,
      requiredPhrases: ['Northfield', 'Southport', 'League One', 'Match result'] });
    // "Match result" was dropped: strict TipSignal names are blocking
    expect(codes(issues)).toEqual(['fact_dropped']);
    expect(issues[0]!.severity).toBe('block');
  });

  it('blocks altered probabilities and invented numbers', () => {
    const issues = checkSuggestion({ sourceText: TIP, text: TIP.replace('62.3%', '65%') });
    expect(issues).toEqual([expect.objectContaining({ code: 'fact_altered', severity: 'block', message: expect.stringContaining('62.3%') })]);
    const inv = checkSuggestion({ sourceText: TIP, text: `${TIP}\nThey have won 5 in a row.` });
    expect(inv).toEqual([expect.objectContaining({ code: 'fact_invented', severity: 'block' })]);
  });

  it('blocks a changed score or kick-off time', () => {
    const src = 'Result: Northfield 2-1 Southport. https://t.example/1';
    expect(codes(checkSuggestion({ sourceText: src, text: 'Northfield win 3-1! https://t.example/1' }))).toEqual(['fact_altered']);
    expect(codes(checkSuggestion({ sourceText: TIP, text: TIP.replace('19:45', '20:00') }))).toEqual(['fact_altered']);
  });

  it('flags dropped facts (warn normally, block when strict)', () => {
    const text = TIP.replace('Model probability: 62.3%. ', '');
    expect(checkSuggestion({ sourceText: TIP, text })).toEqual([expect.objectContaining({ code: 'fact_dropped', severity: 'warn' })]);
    expect(checkSuggestion({ sourceText: TIP, text, strict: true })).toEqual([expect.objectContaining({ code: 'fact_dropped', severity: 'block' })]);
  });

  it('blocks new links and flags dropped source links', () => {
    const src = 'Big news. https://brand.example/news';
    expect(codes(checkSuggestion({ sourceText: src, text: 'Big news. https://evil.example/x' }))).toEqual(['link_dropped', 'link_invented']);
    const issues = checkSuggestion({ sourceText: src, text: 'Big news. https://evil.example/x' });
    expect(issues.find((i) => i.code === 'link_invented')!.severity).toBe('block');
  });

  it('allows facts and links from brand-approved text (footer/CTA)', () => {
    const allowedText = '18+ only. BeGambleAware.org\nhttps://brand.example/play';
    expect(checkSuggestion({ sourceText: TIP, allowedText, text: `${TIP}\n\n18+ only. https://brand.example/play` })).toEqual([]);
  });

  it('rejects prohibited phrases case-insensitively on word boundaries', () => {
    expect(findProhibited('This is a SURE   thing', ['sure thing', 'lock'])).toEqual(['sure thing']);
    expect(findProhibited('Unlocked potential', ['lock'])).toEqual([]);
    const issues = checkSuggestion({ sourceText: TIP, text: `${TIP}\nA guaranteed win!`, prohibited: ['guaranteed win'] });
    expect(issues).toEqual([expect.objectContaining({ code: 'prohibited_phrase', severity: 'block' })]);
  });

  it('flags text over a destination limit and never truncates it', () => {
    const long = `${'word '.repeat(70)}end`;
    const issues = checkSuggestion({ sourceText: long, text: long, targets: [{ label: 'X · Demo', hasMedia: false, link: null,
      constraints: { maxTextLength: 280, maxCaptionLength: 280, textCounting: 'x_weighted' } }] });
    expect(issues).toEqual([expect.objectContaining({ code: 'over_limit', severity: 'warn', message: expect.stringMatching(/X · Demo: 353 of 280/) })]);
  });

  it('counts the appended link toward the limit and flags too many hashtags', () => {
    const issues = checkSuggestion({ sourceText: 'Hello #a #b #c', text: 'Hello #a #b #c', targets: [{ label: 'Instagram', hasMedia: true, link: 'https://brand.example/very/long/link',
      constraints: { maxTextLength: 30, maxCaptionLength: 30, textCounting: 'codepoints', maxHashtags: 2 } }] });
    expect(codes(issues)).toEqual(['over_limit', 'too_many_hashtags']);
  });

  it('repurpose may summarise (drops not flagged) but still blocks invented or altered facts', () => {
    const src = 'Our study of 1,200 riders found 74% prefer mornings. Full report: https://brand.example/r';
    expect(checkSuggestion({ sourceText: src, text: '74% of riders prefer mornings.', allowDrops: true })).toEqual([]);
    expect(codes(checkSuggestion({ sourceText: src, text: '80% of riders prefer mornings.', allowDrops: true }))).toEqual(['fact_altered']);
  });

  it('blocks empty suggestions', () => {
    expect(codes(checkSuggestion({ sourceText: 'x', text: '   ' }))).toEqual(['empty']);
  });
});
