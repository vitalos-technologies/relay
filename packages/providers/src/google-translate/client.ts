// Google Cloud Translation API (Advanced, v3) client (V3.5 stream C). Docs checked 2026-11-08:
//  - projects.locations.translateText (contents, targetLanguageCode, optional sourceLanguageCode, mimeType, glossaryConfig;
//    glossaries live in a regional location such as us-central1), supportedLanguages, glossaries.list.
//  - Auth: service account → OAuth 2.0 JWT bearer grant (scope cloud-translation) at oauth2.googleapis.com/token.
//  - Pricing (cloud.google.com/products/translate/pricing, checked 2026-11-08): NMT USD 20 per million characters after a
//    500,000-character monthly free tier (shared between Basic and Advanced). Relay estimates at the configured list
//    price and does not subtract the free tier (estimates never understate cost).
// Links, @mentions, #hashtags, {placeholders} and brand terms are protected with <span translate="no"> (HTML mode) and
// restored exactly afterwards; the original text is never modified.
import { createSign } from 'node:crypto';
import { apiError, form, parseJson, type BizTransport } from '../biz/transport.js';

export const TRANSLATE_API = 'https://translation.googleapis.com/v3';
export const TRANSLATE_SCOPE = 'https://www.googleapis.com/auth/cloud-translation';
export const TRANSLATE_HOSTS = ['translation.googleapis.com', 'oauth2.googleapis.com'] as const;
export const TRANSLATE_PRICE_CHECKED_ON = '2026-11-08';
export const TRANSLATE_DEFAULT_PRICE_PER_MILLION_USD = 20;

export interface ServiceAccountKey { client_email: string; private_key: string; token_uri?: string; project_id?: string }

export function parseServiceAccount(json: string): ServiceAccountKey | null {
  const j = parseJson<ServiceAccountKey & { type?: string }>(json);
  if (!j || j.type !== 'service_account' || !j.client_email || !j.private_key?.includes('PRIVATE KEY')) return null;
  return j;
}

const b64u = (s: string | Buffer) => Buffer.from(s).toString('base64url');

/** Signed JWT assertion for the OAuth 2.0 JWT bearer grant (RS256). */
export function serviceAccountAssertion(key: ServiceAccountKey, scope: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64u(JSON.stringify({ iss: key.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }));
  const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(key.private_key);
  return `${head}.${claims}.${b64u(sig)}`;
}

export async function serviceAccountToken(t: BizTransport, key: ServiceAccountKey): Promise<{ accessToken: string; expiresAt: string }> {
  const res = await t.send({ method: 'POST', url: 'https://oauth2.googleapis.com/token', op: 'google.oauth.jwt', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: serviceAccountAssertion(key, TRANSLATE_SCOPE) }) });
  const j = parseJson<{ access_token?: string; expires_in?: number }>(res.body);
  if (res.status !== 200 || !j?.access_token) throw apiError(res, 'Google: service account token was refused');
  return { accessToken: j.access_token, expiresAt: new Date(Date.now() + (j.expires_in ?? 3600) * 1000).toISOString() };
}

export interface TranslateCall { t: BizTransport; token: string; project: string; location: string }

const parent = (c: TranslateCall) => {
  if (!/^[a-z][a-z0-9-]{4,29}$/.test(c.project) || !/^[a-z0-9-]{2,30}$/.test(c.location)) throw new Error('invalid project or location');
  return `projects/${c.project}/locations/${c.location}`;
};

async function call<T>(c: TranslateCall, method: 'GET' | 'POST', path: string, op: string, body?: unknown): Promise<T> {
  const res = await c.t.send({ method, url: `${TRANSLATE_API}/${path}`, op, headers: { authorization: `Bearer ${c.token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = parseJson<T & { error?: { message?: string; status?: string } }>(res.body);
  if (res.status === 200 && j) return j;
  throw apiError(res, `Cloud Translation: ${(j?.error?.message ?? `HTTP ${res.status}`).slice(0, 160)}`, j?.error?.status ?? null);
}

export const supportedLanguages = (c: TranslateCall) =>
  call<{ languages?: Array<{ languageCode: string; displayName?: string }> }>(c, 'GET', `${parent(c)}/supportedLanguages?displayLanguageCode=en`, 'translate.languages').then((r) => r.languages ?? []);

export const listGlossaries = (c: TranslateCall) =>
  call<{ glossaries?: Array<{ name: string; entryCount?: number }> }>(c, 'GET', `${parent(c)}/glossaries?pageSize=50`, 'translate.glossaries.list').then((r) => r.glossaries ?? []);

// ------------------------------------------------------------------ protection of links, mentions, placeholders
const PROTECT = /(https?:\/\/[^\s<>"]+|www\.[^\s<>"]+|[@#][\p{L}\p{N}_.]{1,60}|\{\{?[^{}\s]{1,40}\}?\}|%[a-z_]{1,30}%)/gu;
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescapeHtml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** Wrap protected tokens (and brand terms) in translate="no" spans; returns the HTML and the token list. */
export function protectText(text: string, terms: readonly string[] = []): { html: string; tokens: string[] } {
  const tokens: string[] = [];
  const termRe = terms.filter((t) => t.trim().length >= 2).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = termRe.length ? new RegExp(`${PROTECT.source}|(${termRe.join('|')})`, 'gu') : PROTECT;
  let out = ''; let last = 0;
  for (const m of text.matchAll(re)) {
    out += escapeHtml(text.slice(last, m.index));
    tokens.push(m[0]);
    out += `<span translate="no" data-k="${tokens.length - 1}">${escapeHtml(m[0])}</span>`;
    last = m.index! + m[0].length;
  }
  out += escapeHtml(text.slice(last));
  return { html: out.replace(/\n/g, '<br>'), tokens };
}

/** Restore the exact protected tokens and turn the HTML back into text. */
export function restoreText(html: string, tokens: readonly string[]): string {
  const withTokens = html.replace(/<span translate="no" data-k="(\d+)">[\s\S]*?<\/span>/g, (_m, k: string) => `\u0000${k}\u0000`);
  const text = unescapeHtml(withTokens.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));
  return text.replace(/\u0000(\d+)\u0000/g, (_m, k: string) => tokens[Number(k)] ?? '');
}

export interface TranslateResult { text: string; detectedSourceLang: string | null; glossaryApplied: boolean; characters: number }

export async function translateText(c: TranslateCall, p: { text: string; target: string; source?: string | null; glossary?: string | null; protectTerms?: readonly string[] }): Promise<TranslateResult> {
  if (!/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(p.target)) throw new Error('invalid target language');
  const { html, tokens } = protectText(p.text, p.protectTerms);
  const body = {
    contents: [html], targetLanguageCode: p.target, mimeType: 'text/html', ...(p.source ? { sourceLanguageCode: p.source } : {}),
    ...(p.glossary ? { glossaryConfig: { glossary: `${parent(c)}/glossaries/${p.glossary}` } } : {}),
  };
  const r = await call<{ translations?: Array<{ translatedText: string; detectedLanguageCode?: string }>; glossaryTranslations?: Array<{ translatedText: string; detectedLanguageCode?: string }> }>(c, 'POST', `${parent(c)}:translateText`, 'translate.text', body);
  const g = r.glossaryTranslations?.[0];
  const x = g ?? r.translations?.[0];
  if (!x) throw new Error('Cloud Translation returned no translation');
  // Billing counts the characters sent (the HTML markup Relay adds is included, so the estimate counts it too).
  return { text: restoreText(x.translatedText, tokens), detectedSourceLang: x.detectedLanguageCode ?? p.source ?? null, glossaryApplied: !!g, characters: [...html].length };
}
