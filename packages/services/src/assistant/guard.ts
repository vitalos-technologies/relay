// Prompt-injection resistance + output checks for the assistant (brief §16–17, acceptance test 11). Pure, no IO.
// Defence in depth — none of these relies on the model behaving:
//  1. Authority: only Relay's system prompt and the task definition carry instructions. Customer messages, comments,
//     imported documents and listening results are wrapped as quoted DATA with our delimiters neutralised.
//  2. Capability: the model has no tools, no credentials, no URL fetching, no SQL. It can only return a structured
//     object; actions it may propose are a fixed allow-list per task, built by Relay from Relay's own context ids.
//  3. Output checks: links and numbers must appear in the sources the run was allowed to read; policy / price /
//     refund / commitment wording needs a current approved knowledge source; evidence quotes must exist verbatim.
import type { AssistantIssueCode, SuggestionItem } from '@social-lite/core/contracts/v35-ai';
import { extractFacts, extractUrls, findPromiseLanguage } from '../ai/fidelity.js';
import { cleanText } from '../content-hub/normalize.js';
import { detectInjection } from './classify.js';

/** Tags Relay uses to delimit material in the prompt. Anything resembling them inside data is defanged. */
const TAGS = 'source|untrusted_source|approved_source|customer_message|system|instructions|task|person_request';

/** Quote untrusted (or any) material for the prompt: strip control/bidi characters and neutralise our delimiters. */
export function quoteData(text: string, max = 6000): string {
  const t = cleanText(text.normalize('NFC')).replace(new RegExp(`<(\\/?)\\s*(${TAGS})`, 'gi'), '‹$1$2');
  return t.length > max ? `${t.slice(0, max)}\n[…truncated by Relay]` : t;
}

export function countInjections(texts: string[]): number {
  return texts.reduce((n, t) => n + (detectInjection(t).length ? 1 : 0), 0);
}

const POLICY_TOPIC = /\b(refund\w*|return\w*|money back|price[sd]?|pricing|cost[s]?|discount\w*|stock|in stock|availability|deliver\w*|shipping|warrant\w*|guarantee\w*|policy|policies|compensat\w*|free of charge|for free|within \d+ (days?|hours?|weeks?))\b/i;
const COMMITMENT = /\b(we will|we'll|we can offer|you will (get|receive)|you'll (get|receive)|guarantee\w*|promise\w*|entitled to|eligible for|full refund|free replacement|in stock|available now)\b/i;

export function mentionsPolicyTopic(text: string): boolean {
  return POLICY_TOPIC.test(text);
}

const normWs = (s: string) => s.normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();

/** Evidence must be a verbatim excerpt (whitespace/quote-style insensitive) of the cited source. */
export function verifyQuote(quote: string, sourceText: string): boolean {
  const q = normWs(quote);
  return q.length >= 3 && normWs(sourceText).includes(q);
}

export interface OutputCheckInput {
  text: string;
  kind: SuggestionItem['kind'];
  /** All text the run was allowed to read (sources + the person's own prompt). */
  allowedText: string;
  /** Text links may come from: trusted sources + the person's prompt (customer content can plant links). */
  linkText: string;
  /** Text of CURRENT (non-stale) approved knowledge sources only. */
  approvedText: string;
  hasStaleApproved: boolean;
  maxLength: number;
  /** Customer-facing automatic use: warnings become blocks. */
  strict: boolean;
}

export function checkOutput(i: OutputCheckInput): SuggestionItem['issues'] {
  const issues: SuggestionItem['issues'] = [];
  const add = (code: AssistantIssueCode, severity: 'block' | 'warn', message: string) => issues.push({ code, severity: i.strict ? 'block' : severity, message });
  const text = i.text.trim();
  if (!text) { issues.push({ code: 'empty', severity: 'block', message: 'Nothing was suggested.' }); return issues; }
  if (text.length > i.maxLength) add('too_long', 'warn', `Longer than ${i.maxLength.toLocaleString('en')} characters.`);
  const allowedUrls = new Set(extractUrls(i.kind === 'translation' ? i.allowedText : i.linkText));
  const newUrls = extractUrls(text).filter((u) => !allowedUrls.has(u));
  // A link the sources never contained could point anywhere (including one planted by an injected instruction).
  if (newUrls.length) issues.push({ code: 'unsupported_link', severity: 'block', message: `Contains a link that is not in a trusted source (${newUrls.length}).` });
  if (i.kind !== 'translation') {
    // Automatic customer replies: numbers must come from approved knowledge, not from what the customer wrote.
    const allowedFacts = new Set(extractFacts(i.strict ? i.approvedText : i.allowedText).map((f) => `${f.kind}:${f.value}`));
    const invented = extractFacts(text).filter((f) => !allowedFacts.has(`${f.kind}:${f.value}`));
    if (invented.length) add('unsupported_number', i.kind === 'reply' || i.kind === 'answer' ? 'block' : 'warn', `Contains ${invented.length === 1 ? 'a number' : 'numbers'} not found in the sources: ${invented.slice(0, 3).map((f) => f.raw).join(', ')}.`);
    const committing = COMMITMENT.test(text) || findPromiseLanguage(text).length > 0;
    if ((i.kind === 'reply' || i.kind === 'answer') && (committing || mentionsPolicyTopic(text)) && !i.approvedText.trim()) {
      add('commitment_without_source', 'warn', i.hasStaleApproved
        ? 'Mentions policy, prices or commitments, but the approved source is past its review date. Check before using.'
        : 'Mentions policy, prices or commitments without a current approved source. Check before using.');
    }
  }
  return issues;
}
