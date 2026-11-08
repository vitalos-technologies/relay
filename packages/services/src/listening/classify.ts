// Transparent listening classifiers (stream D). Pure functions, no network, no model:
//  - language: stopword heuristic for en/es/fr/de/it/pt/nl ('und' when unsure); the inbox's own language wins when set;
//  - sentiment: LEXICON BASELINE ('lexicon_v1') — listed English words/emoji with weights, negation flips, intensifiers.
//    Inferred, never fact: every judgement carries a confidence and the words that produced it; non-English text is
//    'unscored'. No sensitive traits are inferred (the lexicon has no identity/health/politics terms);
//  - terms: salient keywords + bigrams for topic grouping;
//  - fingerprint: sha256 of normalised text (urls, @handles, punctuation and case removed) to collapse repeats.
// Relay's AI service is NOT used here: it currently exposes post-copy suggestions only (services/ai). An AI classifier can
// be registered later through setListeningClassifier (budget-gated) — results would carry method 'ai' and stay correctable.
import { createHash } from 'node:crypto';
import { normaliseText, tokenize, type SentimentJudgement, type SentimentLabel } from '@social-lite/core/contracts/v35-listening';

export const SENTIMENT_METHOD = 'lexicon_v1';
export const METHOD_LABELS: Record<string, string> = {
  lexicon_v1: 'Lexicon baseline (English word list with negation; not a model)',
};

// ------------------------------------------------------------------ language
const STOP: Record<string, string[]> = {
  en: ['the', 'and', 'is', 'are', 'you', 'your', 'for', 'with', 'this', 'that', 'was', 'have', 'not', 'but', 'it', 'my', 'our', 'of', 'to', 'in', 'on', 'so', 'just', 'can', 'do', 'best', 'too', 'i', 'we', 'they', 'what', 'when', 'how', 'be', 'at', 'from', 'still', 'again', 'very', 'love', 'thanks'],
  es: ['el', 'la', 'los', 'las', 'que', 'y', 'es', 'muy', 'por', 'para', 'con', 'una', 'un', 'del', 'pero', 'mi', 'su', 'esta', 'gracias', 'no', 'en', 'lo'],
  fr: ['le', 'la', 'les', 'et', 'est', 'une', 'un', 'des', 'pour', 'avec', 'pas', 'tres', 'mais', 'merci', 'je', 'vous', 'nous', 'du', 'ce', 'cette', 'sur'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'mit', 'fur', 'sehr', 'aber', 'ich', 'sie', 'wir', 'danke', 'auf', 'zu', 'den', 'dem'],
  it: ['il', 'lo', 'gli', 'che', 'e', 'non', 'per', 'con', 'una', 'molto', 'ma', 'grazie', 'sono', 'della', 'di', 'questo', 'questa'],
  pt: ['o', 'os', 'as', 'que', 'nao', 'para', 'com', 'uma', 'um', 'muito', 'mas', 'obrigado', 'obrigada', 'voce', 'esta', 'do', 'da', 'em'],
  nl: ['de', 'het', 'een', 'en', 'is', 'niet', 'van', 'voor', 'met', 'heel', 'maar', 'bedankt', 'ik', 'jij', 'wij', 'dat', 'deze', 'op'],
};
const STOP_SETS = Object.fromEntries(Object.entries(STOP).map(([k, v]) => [k, new Set(v)])) as Record<string, Set<string>>;

export function detectLanguage(text: string): string {
  const words = tokenize(text).filter((w) => !/^[#@]/.test(w));
  if (words.length < 2) return 'und';
  const scores = Object.entries(STOP_SETS).map(([lang, set]) => [lang, words.filter((w) => set.has(w)).length] as const).sort((a, b) => b[1] - a[1]);
  const [best, second] = scores;
  if (!best || best[1] < 1) return 'und';
  if (words.length >= 4 && best[1] < 2) return 'und';
  if (second && best[1] === second[1]) return 'und';
  return best[0];
}

// ------------------------------------------------------------------ sentiment (lexicon baseline)
const POS: Record<string, number> = {
  love: 3, loved: 3, loving: 2.5, lovely: 2.5, amazing: 3, awesome: 3, excellent: 3, fantastic: 3, perfect: 3, brilliant: 3, outstanding: 3,
  great: 2.5, good: 2, nice: 2, best: 2.5, better: 1.5, delicious: 3, tasty: 2.5, yummy: 2.5, fresh: 1.5, friendly: 2, helpful: 2, kind: 1.5,
  happy: 2.5, glad: 2, pleased: 2, enjoy: 2, enjoyed: 2, recommend: 2.5, recommended: 2.5, fast: 1.5, quick: 1.5, easy: 1.5, beautiful: 2.5,
  wonderful: 3, superb: 3, impressed: 2.5, thanks: 1.5, thank: 1.5, thankyou: 1.5, cheers: 1, favourite: 2.5, favorite: 2.5, worth: 1.5,
  smooth: 1.5, clean: 1.5, cosy: 1.5, cozy: 1.5, polite: 1.5, reliable: 2, fixed: 1, resolved: 1.5, solved: 1.5, appreciate: 2, appreciated: 2,
  wow: 2, gorgeous: 2.5, incredible: 3, quality: 1, fun: 2, '❤️': 3, '❤': 3, '😍': 3, '👍': 2, '😊': 2, '🙂': 1.5, '😀': 2, '🥰': 3, '👏': 2, '🔥': 1.5, '☕️': 0,
};
const NEG: Record<string, number> = {
  bad: 2.5, awful: 3, terrible: 3, horrible: 3, worst: 3, worse: 2, poor: 2.5, disappointing: 2.5, disappointed: 2.5, disappointment: 2.5,
  rude: 3, slow: 1.5, late: 1.5, cold: 1, stale: 2, broken: 2.5, wrong: 2, missing: 2, lost: 1.5, never: 0, refund: 2, refunded: 1,
  charged: 1.5, overcharged: 3, scam: 3, dirty: 2.5, sick: 2.5, angry: 3, annoyed: 2.5, upset: 2.5, unhappy: 2.5, complaint: 2.5, complain: 2,
  problem: 2, issue: 1.5, issues: 1.5, error: 2, fail: 2, failed: 2, failing: 2, useless: 3, waste: 2.5, expensive: 1.5, overpriced: 2.5,
  cancelled: 1.5, canceled: 1.5, crashed: 2, crash: 2, crashes: 2, crashing: 2, glitch: 1.5, buggy: 2, delay: 1.5, delayed: 2, unacceptable: 3, ignored: 2.5, mess: 2, hate: 3, hated: 3, gross: 2.5, avoid: 2.5,
  '😡': 3, '😠': 3, '👎': 2.5, '😞': 2.5, '😢': 2, '🤢': 3, '💩': 2.5,
};
const NEGATORS = new Set(['not', 'no', 'never', 'none', 'nobody', 'nothing', 'hardly', 'barely', 'without', "isn't", "wasn't", "aren't", "weren't", "don't", "doesn't", "didn't", "can't", "couldn't", "won't", "wouldn't", 'isnt', 'wasnt', 'dont', 'doesnt', 'didnt', 'cant', 'wont']);
const INTENS: Record<string, number> = { very: 1.4, really: 1.3, so: 1.3, extremely: 1.6, super: 1.4, absolutely: 1.5, totally: 1.3, incredibly: 1.5, quite: 1.1, bit: 0.7, slightly: 0.7, somewhat: 0.8 };
const EMOJI_RE = /\p{Extended_Pictographic}️?/gu;

/**
 * Lexicon baseline. score = Σw / √(Σw² + 4) (−1..1). Confidence grows with the number of sentiment hits and falls when
 * positive and negative hits disagree; < 0.5 ⇒ uncertain. Non-English (detected) ⇒ 'unscored'.
 */
export function scoreSentiment(text: string, language: string | null): SentimentJudgement {
  const lang = language ?? detectLanguage(text);
  if (lang !== 'en' && lang !== 'und') return { label: 'unscored', score: null, confidence: 0, uncertain: true, method: SENTIMENT_METHOD, evidence: [] };
  const words = tokenize(text).map((w) => w.replace(/^[#@]/, ''));
  const emoji = text.match(EMOJI_RE) ?? [];
  let sum = 0;
  let pos = 0;
  let neg = 0;
  const evidence: string[] = [];
  // Negation never crosses a clause boundary (punctuation or "but"): "nobody replied. Terrible." stays negative.
  for (const clause of text.split(/[.!?;:,\n]+|\bbut\b/i)) {
    const cw = tokenize(clause).map((w) => w.replace(/^[#@]/, ''));
    for (let i = 0; i < cw.length; i++) {
      const w = cw[i]!;
      const p = POS[w];
      const n = NEG[w];
      if (!p && !n) continue;
      let v = p ? p : -(n ?? 0);
      const negated = [cw[i - 1], cw[i - 2], cw[i - 3]].some((x) => x && NEGATORS.has(x));
      v *= INTENS[cw[i - 1] ?? ''] ?? 1;
      if (negated) v *= -0.75;
      sum += v;
      if (v > 0) pos++; else if (v < 0) neg++;
      evidence.push(negated ? `not ${w}` : w);
    }
  }
  // "charged twice", "still waiting", "no reply" style complaints (multi-word cues).
  const joined = ` ${words.join(' ')} `;
  for (const [cue, v] of [[' charged twice ', -2.5], [' still waiting ', -2], [' no reply ', -2], [' no response ', -2], [' never arrived ', -2.5], [' not happy ', 0], [' five stars ', 2.5], [' 5 stars ', 2.5], [' 1 star ', -2.5], [' one star ', -2.5]] as const) {
    if (v !== 0 && joined.includes(cue)) { sum += v; if (v > 0) pos++; else neg++; evidence.push(cue.trim()); }
  }
  for (const e of emoji) {
    const base = e.replace(/️/g, '');
    const p = POS[e] ?? POS[base];
    const n = NEG[e] ?? NEG[base];
    if (p) { sum += p; pos++; evidence.push(e); } else if (n) { sum -= n; neg++; evidence.push(e); }
  }
  const hits = pos + neg;
  if (!hits) return { label: 'neutral', score: 0, confidence: words.length >= 4 ? 0.4 : 0.3, uncertain: true, method: SENTIMENT_METHOD, evidence: [] };
  const score = Math.max(-1, Math.min(1, sum / Math.sqrt(sum * sum + 4)));
  const agreement = Math.abs(pos - neg) / hits;
  let label: SentimentLabel = score >= 0.25 ? 'positive' : score <= -0.25 ? 'negative' : 'neutral';
  if (pos && neg && agreement < 0.5) label = 'mixed';
  const confidence = Math.round(Math.min(0.9, 0.35 + 0.15 * Math.min(hits, 4)) * (0.5 + 0.5 * agreement) * 100) / 100;
  return { label, score: Math.round(score * 1000) / 1000, confidence, uncertain: confidence < 0.5, method: SENTIMENT_METHOD, evidence: [...new Set(evidence)].slice(0, 10) };
}

// ------------------------------------------------------------------ terms (topic grouping)
const TOPIC_STOP = new Set([
  ...Object.values(STOP).flat(),
  'a', 'an', 'or', 'if', 'as', 'be', 'by', 'me', 'us', 'he', 'she', 'his', 'her', 'its', 'their', 'them', 'there', 'here', 'will', 'would', 'could',
  'should', 'did', 'does', 'had', 'has', 'been', 'were', 'am', 'any', 'all', 'some', 'more', 'most', 'other', 'than', 'then', 'also', 'only', 'about',
  'into', 'out', 'up', 'down', 'over', 'again', 'yes', 'no', 'ok', 'okay', 'hi', 'hello', 'hey', 'please', 'get', 'got', 'one', 'two', 'like', 'really',
  'much', 'many', 'every', 'which', 'who', 'why', 'where', 'today', 'yesterday', 'tomorrow', 'im', "i'm", "it's", 'its', 'dont', "don't", 'cant', "can't",
  'there', "there's", 'theres', 'thats', "that's", 'youre', "you're", 'ive', "i've", 'via', 'amp', 'lol', 'omg',
  'bit', 'tbh', 'lot', 'lots', 'thing', 'things', 'anyone', 'everyone', 'someone', 'else', 'always', 'never', 'today', 'tonight', 'morning', 'finally', 'instead',
]);

/** Salient keywords (≥3 chars, not stopwords/numbers) + adjacent bigrams; at most 20, order of first appearance. */
export function extractTerms(text: string): string[] {
  const out: string[] = [];
  const add = (t: string) => { if (!out.includes(t) && out.length < 20) out.push(t); };
  // Pairs only from truly adjacent words inside one clause ("latte at Vitalos" makes no "latte vitalos").
  for (const clause of text.split(/[.!?;:,\n—–]+/)) {
    const words = tokenize(clause).map((w) => w.replace(/^[#@]/, ''));
    const keep = words.map((w) => w.length >= 3 && !/^\d+$/.test(w) && !TOPIC_STOP.has(w) && !w.includes("'"));
    for (let i = 0; i < words.length; i++) {
      if (!keep[i]) continue;
      add(words[i]!);
      if (keep[i + 1]) add(`${words[i]} ${words[i + 1]}`);
    }
  }
  return out;
}

// ------------------------------------------------------------------ repeat detection
export const DEDUPE_METHOD = 'Repeats: identical text after removing links, @handles, punctuation, case and accents, for the same brand within 7 days, count once.';

export function fingerprint(text: string): string | null {
  const norm = normaliseText(text).replace(/https?:\/\/\S+/g, ' ').replace(/@[\p{L}\p{N}_.]+/gu, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (norm.length < 12) return null; // very short texts ("love it") repeat naturally; never collapsed
  return createHash('sha256').update(norm).digest('hex');
}
