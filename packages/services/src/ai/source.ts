// Repurpose sources. A URL is fetched ONLY through ssrf.safeFetch (https, public addresses, size and
// time bounded) and reduced to plain text. Its content is untrusted data: it is placed in a delimited
// block in the prompt and never treated as instructions.
import { AppError } from '@social-lite/core';
import { safeFetch } from '../ssrf.js';

export const SOURCE_MAX_BYTES = 512 * 1024;
export const SOURCE_TIMEOUT_MS = 8_000;
/** Characters of source text sent to the model. Longer sources are cut and the user is told. */
export const SOURCE_MAX_CHARS = 12_000;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : ' ';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Plain text from HTML: drops scripts/styles/comments/markup, keeps paragraph breaks. */
export function htmlToText(html: string): string {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe|head|nav|footer|form)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(body)
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const title = titleMatch ? decodeEntities(titleMatch[1]!.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : '';
  return title && !text.startsWith(title) ? `${title}\n\n${text}` : text;
}

/** Remove control characters (other than newline/tab) that could confuse delimiting. */
export function sanitizeText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/g, ' ');
}

export interface FetchedSource { text: string; truncated: boolean; url: string }

export async function fetchSourceUrl(rawUrl: string, fetcher: typeof safeFetch = safeFetch): Promise<FetchedSource> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new AppError('validation_failed', 'Enter a valid https:// address.', { source_url: 'Enter a valid https:// address' }); }
  if (url.protocol !== 'https:') throw new AppError('validation_failed', 'Only https:// sources can be used.', { source_url: 'Use an https:// address' });
  const res = await fetcher(url.toString(), { maxBytes: SOURCE_MAX_BYTES, timeoutMs: SOURCE_TIMEOUT_MS, maxRedirects: 3, headers: { accept: 'text/html,text/plain;q=0.9' } });
  if (res.status < 200 || res.status >= 300) throw new AppError('provider_error', `The source page returned HTTP ${res.status}.`);
  const ct = (res.contentType ?? '').toLowerCase();
  const isHtml = ct.includes('text/html') || ct.includes('application/xhtml');
  if (!isHtml && !ct.startsWith('text/plain')) throw new AppError('unsupported_media', 'The source must be a web page or plain text.');
  const raw = res.body.toString('utf8');
  let text = sanitizeText(isHtml ? htmlToText(raw) : raw).trim();
  if (!text) throw new AppError('validation_failed', 'No readable text was found at that address.', { source_url: 'No readable text found' });
  const truncated = text.length > SOURCE_MAX_CHARS;
  if (truncated) text = text.slice(0, SOURCE_MAX_CHARS);
  return { text, truncated, url: res.url };
}
