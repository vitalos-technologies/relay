// Deterministic source-fidelity checks for AI suggestions (spec §16). Pure functions, no I/O.
//  - Facts (percentages, scores, dates, times, money, other numbers) are extracted from the source text
//    and from the suggestion; any fact the suggestion alters or invents is a blocking issue, a dropped
//    fact is flagged (blocking when the source demands exact facts, e.g. TipSignal posts).
//  - Links: a new link is blocking (could point anywhere); a dropped source link is flagged.
//  - Brand-voice prohibited phrases are blocking.
//  - Length over a destination limit is flagged — suggestions are never truncated.
import { composeTextWithLink, countHashtags, measure, type ChannelConstraints } from '@social-lite/core';
import type { IssueSeverity, SuggestionIssue } from './types.js';

export type FactKind = 'percent' | 'score' | 'date' | 'time' | 'money' | 'number';
export interface Fact { kind: FactKind; value: string; raw: string }

const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

const num = (s: string): string => {
  const t = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? String(n) : s;
};
const mon = (m: string) => m.slice(0, 3).toLowerCase();

function cleanUrl(u: string): string {
  const t = u.replace(/[.,;:!?)\]}>]+$/, '');
  try {
    const p = new URL(t);
    return `${p.protocol}//${p.host.toLowerCase()}${p.pathname.replace(/\/$/, '')}${p.search}${p.hash}`;
  } catch {
    return t;
  }
}

export function extractUrls(text: string): string[] {
  return [...new Set((text.match(URL_RE) ?? []).map(cleanUrl))];
}

type Rule = { kind: FactKind; re: RegExp; value: (m: RegExpExecArray) => string };

// Order matters: each match is blanked out before the next rule runs, so "2026-11-07" is a date and
// not three numbers, and "62.3%" is a percentage and not a number.
const RULES: Rule[] = [
  { kind: 'date', re: /\b(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g,
    value: (m) => `${Number(m[3])} ${['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'][Number(m[2]) - 1] ?? m[2]}` },
  { kind: 'date', re: /\b(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})\b/g, value: (m) => `${Number(m[1])}/${Number(m[2])}` },
  { kind: 'date', re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b\\.?(?:,?\\s+\\d{4}\\b)?`, 'gi'), value: (m) => `${Number(m[1])} ${mon(m[2]!)}` },
  { kind: 'date', re: new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+\\d{4}\\b)?`, 'gi'), value: (m) => `${Number(m[2])} ${mon(m[1]!)}` },
  { kind: 'time', re: /\b([01]?\d|2[0-3]):([0-5]\d)(?:\s*([ap])\.?m\.?\b)?/gi, value: (m) => {
    let h = Number(m[1]);
    const ap = m[3]?.toLowerCase();
    if (ap === 'p' && h < 12) h += 12;
    if (ap === 'a' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m[2]}`;
  } },
  { kind: 'time', re: /\b(1[0-2]|0?[1-9])\s*([ap])\.?m\.?(?![\p{L}])/giu, value: (m) => {
    let h = Number(m[1]);
    if (m[2]!.toLowerCase() === 'p' && h < 12) h += 12;
    if (m[2]!.toLowerCase() === 'a' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:00`;
  } },
  { kind: 'percent', re: /(\d+(?:[.,]\d+)?)\s?(?:%|per\s?cent\b)/gi, value: (m) => `${num(m[1]!)}%` },
  { kind: 'money', re: /([$€£])\s?(\d+(?:[.,]\d+)*)/g, value: (m) => `${m[1]}${num(m[2]!)}` },
  { kind: 'money', re: /(\d+(?:[.,]\d+)*)\s?(usd|eur|gbp)\b/gi, value: (m) => `${({ usd: '$', eur: '€', gbp: '£' } as Record<string, string>)[m[2]!.toLowerCase()]}${num(m[1]!)}` },
  { kind: 'score', re: /\b(\d{1,3})\s?[-–—]\s?(\d{1,3})\b/g, value: (m) => `${Number(m[1])}-${Number(m[2])}` },
  { kind: 'number', re: /\d+(?:[.,]\d+)*/g, value: (m) => num(m[0]) },
];

/** Extract normalized facts. URLs, #hashtags and @mentions are not facts (links are checked separately). */
export function extractFacts(text: string): Fact[] {
  let s = text.normalize('NFKC').replace(URL_RE, ' ').replace(/(^|\s)[#@][\p{L}\p{N}_.]+/gu, '$1 ');
  const out: Fact[] = [];
  const seen = new Set<string>();
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    s = s.replace(rule.re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray;
      const raw = String(args[0]);
      const value = rule.value(m);
      const key = `${rule.kind}:${value}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ kind: rule.kind, value, raw: raw.trim() });
      }
      return ' '.repeat(raw.length);
    });
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function findProhibited(text: string, phrases: string[]): string[] {
  const hay = text.normalize('NFKC');
  return phrases.filter((p) => {
    const phrase = p.trim();
    if (!phrase) return false;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(phrase.normalize('NFKC')).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'iu');
    return re.test(hay);
  });
}

export interface LimitTarget {
  label: string;
  constraints: Pick<ChannelConstraints, 'maxTextLength' | 'maxCaptionLength' | 'textCounting' | 'maxHashtags'>;
  hasMedia: boolean;
  /** Link appended to the outgoing text (null when the provider sends it separately). */
  link: string | null;
}

export interface CheckInput {
  /** The text whose facts must be preserved (current copy, validated source, or both). */
  sourceText: string;
  /** Brand-approved text (footer, CTA, hashtags, terminology) whose facts/links may be added. */
  allowedText?: string;
  text: string;
  prohibited?: string[];
  /** When true (e.g. TipSignal), dropping a fact or the source link is blocking. */
  strict?: boolean;
  /** For tasks that summarise a long source (repurpose), dropping facts is expected — not flagged. */
  allowDrops?: boolean;
  /** Exact names/terms from validated input (e.g. team names, market) that must survive when present in the source. */
  requiredPhrases?: string[];
  targets?: LimitTarget[];
}

export function checkSuggestion(input: CheckInput): SuggestionIssue[] {
  const issues: SuggestionIssue[] = [];
  const add = (code: SuggestionIssue['code'], severity: IssueSeverity, message: string) => issues.push({ code, severity, message });
  const text = input.text ?? '';
  if (!text.trim()) {
    add('empty', 'block', 'The suggestion is empty.');
    return issues;
  }

  // --- facts
  const src = extractFacts(input.sourceText);
  const allowed = new Set(extractFacts(input.allowedText ?? '').map((f) => `${f.kind}:${f.value}`));
  const sug = extractFacts(text);
  const key = (f: Fact) => `${f.kind}:${f.value}`;
  const sugKeys = new Set(sug.map(key));
  const srcKeys = new Set(src.map(key));
  const dropped = src.filter((f) => !sugKeys.has(key(f)) && !allowed.has(key(f)));
  const invented = sug.filter((f) => !srcKeys.has(key(f)) && !allowed.has(key(f)));
  for (const kind of new Set([...dropped, ...invented].map((f) => f.kind))) {
    const d = dropped.filter((f) => f.kind === kind);
    const i = invented.filter((f) => f.kind === kind);
    const pairs = Math.min(d.length, i.length);
    for (let n = 0; n < pairs; n++) add('fact_altered', 'block', `Changes “${d[n]!.raw}” to “${i[n]!.raw}”.`);
    for (const f of d.slice(pairs)) {
      if (!input.allowDrops || input.strict) add('fact_dropped', input.strict ? 'block' : 'warn', `Drops “${f.raw}”.`);
    }
    for (const f of i.slice(pairs)) add('fact_invented', 'block', `Adds “${f.raw}”, which is not in the source.`);
  }

  // --- required exact phrases (validated names/terms)
  const lower = (x: string) => x.normalize('NFKC').toLowerCase();
  for (const ph of input.requiredPhrases ?? []) {
    if (!ph.trim() || !lower(input.sourceText).includes(lower(ph))) continue;
    if (!text.normalize('NFKC').includes(ph.normalize('NFKC'))) add('fact_dropped', input.strict ? 'block' : 'warn', `Drops or changes “${ph}”.`);
  }

  // --- links
  const srcUrls = extractUrls(input.sourceText);
  const okUrls = new Set([...srcUrls, ...extractUrls(input.allowedText ?? '')]);
  const sugUrls = extractUrls(text);
  for (const u of sugUrls) if (!okUrls.has(u)) add('link_invented', 'block', `Adds a link that is not in the source: ${u}`);
  if (!input.allowDrops || input.strict) {
    for (const u of srcUrls) if (!sugUrls.includes(u)) add('link_dropped', input.strict ? 'block' : 'warn', `Drops the source link ${u}`);
  }

  // --- brand voice
  for (const p of findProhibited(text, input.prohibited ?? [])) add('prohibited_phrase', 'block', `Uses the prohibited phrase “${p}”.`);

  // --- destination limits (flag, never truncate)
  for (const t of input.targets ?? []) {
    const limit = t.hasMedia ? t.constraints.maxCaptionLength : t.constraints.maxTextLength;
    const n = measure(composeTextWithLink(text, t.link), t.constraints.textCounting);
    if (n > limit) add('over_limit', 'warn', `${t.label}: ${n.toLocaleString('en')} of ${limit.toLocaleString('en')} characters — ${(n - limit).toLocaleString('en')} over.`);
    const tags = countHashtags(text);
    if (t.constraints.maxHashtags !== undefined && tags > t.constraints.maxHashtags) {
      add('too_many_hashtags', 'warn', `${t.label}: ${tags} hashtags, limit ${t.constraints.maxHashtags}.`);
    }
  }
  return issues;
}
