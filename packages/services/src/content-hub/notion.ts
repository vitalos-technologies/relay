// Notion API client for the Content Hub (pinned Notion-Version, plain fetch through SourceTransport).
// Contracts verified 2026-11-07 (docs/V3_CONTENT_INTEGRATIONS.md "Sources"):
//  - Notion-Version 2026-03-11 (`archived` → `in_trash`); databases contain data sources (2025-09-03):
//    GET /v1/databases/{id} lists data_sources; POST /v1/data_sources/{id}/query (≤ 10,000 results, request_status).
//  - GET /v1/blocks/{id}/children returns ONE level, paginated (has_more/next_cursor); `unsupported` blocks carry
//    unsupported.block_type.
//  - PATCH /v1/pages/{id}: only the provided properties change.
//  - OAuth: /v1/oauth/token (HTTP Basic), refresh_token grant rotates both tokens; /v1/oauth/revoke.
//  - Notion-hosted file URLs expire after one hour — never stored; bytes are copied into validated storage.
import { AppError } from '@social-lite/core';
import { NOTION_VERSION, type NotionConfig } from './config.js';
import { jsonBody, SourceAccessError, type SourceResponse, type SourceTransport } from './transport.js';

export const NOTION_API = 'https://api.notion.com/v1';

export interface NotionSession { transport: SourceTransport; accessToken: string }

const ID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
export const isNotionId = (id: string) => ID_RE.test(id);
/** Canonical dashed lower-case UUID form (Notion accepts both; we store one form). */
export function normalizeNotionId(id: string): string {
  const hex = id.replace(/-/g, '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function notionError(r: SourceResponse, what: string): SourceAccessError {
  let code: string | null = null;
  try { code = (JSON.parse(r.body.toString('utf8')) as { code?: string }).code ?? null; } catch { /* non-JSON */ }
  const retryAfter = Number(r.headers['retry-after'] ?? '') || null;
  if (r.status === 401) return new SourceAccessError(`${what}: authorization is no longer valid`, 'auth', 401, code);
  if (r.status === 404 || code === 'object_not_found') return new SourceAccessError(`${what}: not found or not shared with the connection`, 'not_found', 404, code);
  if (r.status === 403) return new SourceAccessError(`${what}: the connection lacks the required capability`, 'forbidden', 403, code);
  if (r.status === 429 || r.status === 529) return new SourceAccessError(`${what}: rate limited`, 'rate_limited', r.status, code, retryAfter ?? 1);
  if (r.status === 409) return new SourceAccessError(`${what}: conflict`, 'conflict', 409, code);
  if (r.status === 400) return new SourceAccessError(`${what}: request rejected (${code ?? 'validation_error'})`, 'invalid', 400, code);
  return new SourceAccessError(`${what}: Notion is unavailable (${r.status})`, 'unavailable', r.status, code, retryAfter);
}

async function call<T>(s: NotionSession, req: { method: 'GET' | 'POST' | 'PATCH'; path: string; op: string; body?: unknown }): Promise<T> {
  const r = await s.transport.send({
    method: req.method, url: `${NOTION_API}${req.path}`, op: req.op,
    headers: { authorization: `Bearer ${s.accessToken}`, 'notion-version': NOTION_VERSION, accept: 'application/json', ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
  });
  if (r.status < 200 || r.status >= 300) throw notionError(r, req.op);
  return jsonBody<T>(r);
}

// ------------------------------------------------------------------ objects (subset used by Relay)
export interface RichText { plain_text?: string; href?: string | null; type?: string; text?: { content?: string; link?: { url?: string } | null }; mention?: { type?: string } }
export interface NotionFile { type: 'file' | 'external' | 'file_upload'; file?: { url: string; expiry_time?: string }; external?: { url: string }; name?: string; caption?: RichText[] }
export interface NotionBlock {
  object: 'block'; id: string; type: string; has_children?: boolean; in_trash?: boolean; archived?: boolean; last_edited_time?: string;
  [k: string]: unknown;
}
export interface NotionPage {
  object: 'page'; id: string; url?: string; created_time?: string; last_edited_time?: string; in_trash?: boolean; archived?: boolean;
  parent?: { type: string; page_id?: string; data_source_id?: string; database_id?: string; workspace?: boolean };
  properties: Record<string, NotionPropertyValue>;
  last_edited_by?: { id?: string; object?: string };
}
export interface NotionPropertyValue { id: string; type: string; [k: string]: unknown }
export interface NotionDataSource {
  object: 'data_source'; id: string; title?: RichText[]; url?: string; last_edited_time?: string; in_trash?: boolean;
  properties: Record<string, { id: string; name: string; type: string; [k: string]: unknown }>;
  database_parent?: unknown; parent?: { type: string; database_id?: string };
}
export interface NotionList<T> { object: 'list'; results: T[]; has_more: boolean; next_cursor: string | null; request_status?: { type: 'complete' | 'incomplete'; incomplete_reason?: string } }

// ------------------------------------------------------------------ endpoints
export async function notionSearch(s: NotionSession, p: { query?: string; type: 'page' | 'data_source'; cursor?: string | null }): Promise<NotionList<NotionPage | NotionDataSource>> {
  return call(s, { method: 'POST', path: '/search', op: 'notion.search', body: {
    query: p.query?.slice(0, 200) || undefined, filter: { property: 'object', value: p.type }, page_size: 25, start_cursor: p.cursor || undefined,
    sort: { direction: 'descending', timestamp: 'last_edited_time' },
  } });
}

export async function retrievePage(s: NotionSession, pageId: string): Promise<NotionPage> {
  if (!isNotionId(pageId)) throw new SourceAccessError('invalid page id', 'not_found', 404);
  return call(s, { method: 'GET', path: `/pages/${normalizeNotionId(pageId)}`, op: 'notion.pages.retrieve' });
}

export async function blockChildren(s: NotionSession, blockId: string, cursor: string | null): Promise<NotionList<NotionBlock>> {
  const q = new URLSearchParams({ page_size: '100' });
  if (cursor) q.set('start_cursor', cursor);
  return call(s, { method: 'GET', path: `/blocks/${normalizeNotionId(blockId)}/children?${q}`, op: 'notion.blocks.children' });
}

export async function retrieveDataSource(s: NotionSession, dataSourceId: string): Promise<NotionDataSource> {
  if (!isNotionId(dataSourceId)) throw new SourceAccessError('invalid data source id', 'not_found', 404);
  return call(s, { method: 'GET', path: `/data_sources/${normalizeNotionId(dataSourceId)}`, op: 'notion.data_sources.retrieve' });
}

export async function queryDataSource(s: NotionSession, dataSourceId: string, p: { cursor?: string | null; pageSize?: number; filter?: unknown }): Promise<NotionList<NotionPage>> {
  return call(s, { method: 'POST', path: `/data_sources/${normalizeNotionId(dataSourceId)}/query`, op: 'notion.data_sources.query', body: {
    page_size: Math.min(p.pageSize ?? 50, 100), start_cursor: p.cursor || undefined, filter: p.filter ?? undefined,
  } });
}

/** Field-scoped property update: ONLY the given properties are sent (others are untouched by Notion). */
export async function updatePageProperties(s: NotionSession, pageId: string, properties: Record<string, unknown>): Promise<NotionPage> {
  return call(s, { method: 'PATCH', path: `/pages/${normalizeNotionId(pageId)}`, op: 'notion.pages.update', body: { properties } });
}

export async function createChildPage(s: NotionSession, p: { parentPageId: string; title: string; children: unknown[] }): Promise<NotionPage> {
  return call(s, { method: 'POST', path: '/pages', op: 'notion.pages.create', body: {
    parent: { type: 'page_id', page_id: normalizeNotionId(p.parentPageId) },
    properties: { title: { title: [{ type: 'text', text: { content: p.title.slice(0, 2000) } }] } },
    children: p.children.slice(0, 100),
  } });
}

export async function appendChildren(s: NotionSession, blockId: string, children: unknown[]): Promise<void> {
  await call(s, { method: 'PATCH', path: `/blocks/${normalizeNotionId(blockId)}/children`, op: 'notion.blocks.append', body: { children: children.slice(0, 100) } });
}

// ------------------------------------------------------------------ OAuth
export interface NotionTokens {
  accessToken: string; refreshToken: string | null; botId: string; workspaceId: string; workspaceName: string | null; ownerUserId: string | null;
}

export function notionAuthorizationUrl(cfg: NotionConfig, state: string): string {
  if (!cfg.clientId) throw new AppError('provider_not_configured', 'Notion is not configured yet.');
  const u = new URL(`${NOTION_API}/oauth/authorize`);
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', cfg.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('owner', 'user');
  u.searchParams.set('state', state);
  return u.toString();
}

function basic(cfg: NotionConfig): string {
  if (!cfg.clientId || !cfg.clientSecret) throw new AppError('provider_not_configured', 'Notion is not configured yet.');
  return `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`;
}

async function oauthCall(t: SourceTransport, cfg: NotionConfig, path: string, body: unknown, op: string): Promise<Record<string, unknown>> {
  const r = await t.send({ method: 'POST', url: `${NOTION_API}${path}`, op,
    headers: { authorization: basic(cfg), 'notion-version': NOTION_VERSION, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  if (r.status === 400 || r.status === 401) {
    let err = 'invalid_grant';
    try { err = String((JSON.parse(r.body.toString('utf8')) as { error?: string; code?: string }).error ?? 'invalid_grant'); } catch { /* keep */ }
    throw new SourceAccessError(`${op}: ${err}`, 'auth', r.status, err);
  }
  if (r.status !== 200) throw notionError(r, op);
  return jsonBody<Record<string, unknown>>(r);
}

function tokensFrom(j: Record<string, unknown>, prevRefresh: string | null = null): NotionTokens {
  const owner = j.owner as { type?: string; user?: { id?: string } } | undefined;
  if (typeof j.access_token !== 'string' || typeof j.bot_id !== 'string' || typeof j.workspace_id !== 'string') {
    throw new SourceAccessError('unexpected token response', 'unavailable');
  }
  return {
    accessToken: j.access_token, refreshToken: typeof j.refresh_token === 'string' ? j.refresh_token : prevRefresh,
    botId: j.bot_id, workspaceId: j.workspace_id, workspaceName: typeof j.workspace_name === 'string' ? j.workspace_name : null,
    ownerUserId: owner?.type === 'user' ? owner.user?.id ?? null : null,
  };
}

export async function exchangeNotionCode(t: SourceTransport, cfg: NotionConfig, code: string): Promise<NotionTokens> {
  return tokensFrom(await oauthCall(t, cfg, '/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri }, 'notion.oauth.token'));
}

export async function refreshNotionToken(t: SourceTransport, cfg: NotionConfig, refreshToken: string): Promise<NotionTokens> {
  return tokensFrom(await oauthCall(t, cfg, '/oauth/token', { grant_type: 'refresh_token', refresh_token: refreshToken }, 'notion.oauth.refresh'), refreshToken);
}

export async function revokeNotionToken(t: SourceTransport, cfg: NotionConfig, token: string): Promise<boolean> {
  try {
    await oauthCall(t, cfg, '/oauth/revoke', { token }, 'notion.oauth.revoke');
    return true;
  } catch {
    return false;
  }
}

/** Identity of an internal-token connection (bot user + workspace name). */
export async function notionBotInfo(s: NotionSession): Promise<{ botId: string; workspaceName: string | null; workspaceId: string | null }> {
  const j = await call<{ id?: string; bot?: { workspace_name?: string; workspace_id?: string } }>(s, { method: 'GET', path: '/users/me', op: 'notion.users.me' });
  if (!j.id) throw new SourceAccessError('users/me without id', 'unavailable');
  return { botId: j.id, workspaceName: j.bot?.workspace_name ?? null, workspaceId: j.bot?.workspace_id ?? null };
}
