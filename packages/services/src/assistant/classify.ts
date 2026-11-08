// Deterministic message classification (brief §17: "automatic classification and routing before automatic customer
// replies"). Pure, no IO, no model: category, sentiment, language guess, urgency, sensitive + injection signals.
// It never authorizes a reply on its own — it narrows what automation may do and escalates the rest to a person.
// The output carries signal NAMES only (e.g. 'kw:refund'), never message text.
import type { ClassificationDto, MessageCategory } from '@social-lite/core/contracts/v35-ai';

type Lex = Array<[MessageCategory, RegExp, string]>;

// Ordered by precedence: sensitive/complaint/refund win over generic question words.
const CATEGORY_LEX: Lex = [
  ['sensitive', /\b(lawyer|solicitor|lawsuit|sue|legal action|court|police|gdpr|data (breach|leak)|subject access|harass\w*|threat\w*|suicid\w*|self[- ]harm|abuse\w*|discriminat\w*|injur\w*|allerg\w*|hospital|anwalt|klage|datenschutz|avocat|plainte|abogado|denuncia)\b/i, 'sensitive'],
  ['refund', /\b(refund\w*|money back|charged twice|double[- ]charged|overcharged|money (was )?taken|chargeback|reimburs\w*|cancel (my|the) order|return label|erstattung|rückerstattung|remboursement|reembolso|rimborso)\b/i, 'refund'],
  ['complaint', /\b(complain\w*|terrible|awful|worst|unacceptable|disgust\w*|furious|scam|rip[- ]?off|broken|never arrived|still waiting|failed|disappoint\w*|beschwerde|réclamation|queja|reclamo)\b/i, 'complaint'],
  ['spam', /\b(crypto giveaway|free followers|click here to claim|earn \$?\d+ (a|per) day|onlyfans|promo code for followers)\b/i, 'spam'],
  ['order_status', /\b(where is my (order|parcel|package)|order (number|#|no\.?)|tracking|track my|shipp?(ed|ing)|deliver(y|ed)|dispatch\w*|lieferung|bestellung|commande|livraison|pedido|envío)\b/i, 'order'],
  ['pricing', /\b(price|pricing|how much|cost|discount|coupon|voucher|quote|preis|kosten|prix|tarif|precio|cuánto)\b/i, 'price'],
  ['sales', /\b(buy|purchase|wholesale|bulk order|partnership|collab(oration)?|sponsor\w*|in stock|availability|kaufen|acheter|comprar)\b/i, 'sales'],
  ['support', /\b(help|not working|doesn'?t work|error|issue|problem|bug|can'?t log ?in|password|account|login|hilfe|aide|ayuda)\b/i, 'support'],
  ['praise', /\b(love (it|this|you)|amazing|awesome|great (job|service)|thank(s| you)|brilliant|fantastic|danke|merci|gracias)\b/i, 'praise'],
  ['feedback', /\b(suggest\w*|feedback|would be (nice|great)|feature request|idea)\b/i, 'feedback'],
  ['question', /\?|\b(how|what|when|where|why|which|can i|do you|is there|are you)\b/i, 'question'],
];

const NEG = /\b(bad|terrible|awful|worst|hate|angry|furious|unacceptable|disappoint\w*|broken|scam|never|annoy\w*|useless|rude|slow|wrong|horrible)\b/gi;
const POS = /\b(good|great|love|amazing|awesome|excellent|thanks?|thank you|happy|brilliant|perfect|fantastic|wonderful|helpful)\b/gi;
const URGENT = /\b(urgent\w*|asap|immediately|right now|emergency|today!|dringend|urgente)\b|!!+/i;

/**
 * Instruction-like text inside customer/imported content. It is DATA: it never changes what Relay does; the flag only
 * informs people and keeps automation from auto-replying.
 */
const INJECTION = [
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|all|earlier|system|your)\b[^.\n]{0,30}\b(instructions?|rules?|prompts?|guidelines?)\b/i,
  /\b(system prompt|developer mode|jailbreak|you are now|act as (an?|the) |pretend (to be|you are)|new instructions?:)/i,
  /<\/?\s*(system|assistant|instructions?|untrusted_source|source|customer_message)\b/i,
  /\b(reveal|print|show|send)\b[^.\n]{0,30}\b(api key|secret|password|token|credentials?)\b/i,
  /\b(assistant|system)\s*:\s/i,
];

export function detectInjection(text: string): string[] {
  return INJECTION.flatMap((re, i) => (re.test(text) ? [`injection:${i + 1}`] : []));
}

const STOP: Array<[string, RegExp]> = [
  ['en', /\b(the|and|is|are|my|you|your|what|with|for|this|have|not)\b/gi],
  ['de', /\b(der|die|das|und|ist|nicht|ich|mein|meine|sie|bitte|wo|mit|für)\b/gi],
  ['fr', /\b(le|la|les|et|est|je|mon|ma|vous|pas|pour|avec|où|une)\b/gi],
  ['es', /\b(el|la|los|las|y|es|mi|usted|no|para|con|dónde|una|que)\b/gi],
  ['it', /\b(il|lo|gli|e|è|mio|mia|non|per|con|dove|una|che)\b/gi],
  ['nl', /\b(de|het|een|en|is|mijn|niet|voor|met|waar|u|jij)\b/gi],
  ['pt', /\b(o|a|os|as|e|é|meu|minha|não|para|com|onde|uma|você)\b/gi],
];

/** Best-effort language guess for short texts; null when unsure (shown as unknown, never asserted). */
export function guessLanguage(text: string): string | null {
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < 3) return null;
  const scores = STOP.map(([lang, re]) => [lang, (text.match(re) ?? []).length] as const).sort((a, b) => b[1] - a[1]);
  const [top, second] = scores;
  if (!top || top[1] < 2 || (second && top[1] - second[1] < 1)) return null;
  return top[0];
}

export interface ClassifyResult extends Omit<ClassificationDto, 'conversation_id' | 'message_id' | 'created_at'> {}

export function classifyText(text: string): ClassifyResult {
  const t = text.normalize('NFKC');
  const signals: string[] = [];
  const hits = CATEGORY_LEX.filter(([, re]) => re.test(t));
  for (const [, , s] of hits) signals.push(`kw:${s}`);
  let category: MessageCategory = hits[0]?.[0] ?? 'other';
  const neg = (t.match(NEG) ?? []).length;
  const pos = (t.match(POS) ?? []).length;
  const sentiment = neg > pos ? 'negative' : pos > neg ? 'positive' : 'neutral';
  if (sentiment !== 'neutral') signals.push(`sentiment:${sentiment}`);
  // A strongly negative message with no specific category is a complaint for routing purposes.
  if (category === 'question' && neg >= 2) category = 'complaint';
  const urgent = URGENT.test(t);
  if (urgent) signals.push('urgent');
  const injection = detectInjection(t);
  signals.push(...injection);
  const urgency = category === 'sensitive' || (urgent && sentiment === 'negative') ? 'high' : urgent ? 'high' : category === 'praise' || category === 'spam' ? 'low' : 'normal';
  // Uncertain when nothing specific matched, or two different non-question categories compete.
  const specific = new Set(hits.map(([c]) => c).filter((c) => c !== 'question'));
  const uncertain = category === 'other' || specific.size > 1;
  if (uncertain) signals.push('uncertain');
  return { category, sentiment, language: guessLanguage(t), urgency, signals: [...new Set(signals)].slice(0, 20), injection_suspected: injection.length > 0, uncertain, method: 'rules' };
}
