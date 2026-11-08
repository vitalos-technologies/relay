// Google Drive v3 / Docs v1 / OAuth 2.0 client for the Content Hub (plain fetch through SourceTransport).
// Contracts verified 2026-11-07 (docs/V3_CONTENT_INTEGRATIONS.md "Sources"):
//  - files.get ?alt=media downloads blob content only; Docs Editors files need files.export (output ≤ 10 MB).
//  - md5Checksum / headRevisionId only for binary content; `version` is monotonically increasing.
//  - shortcuts: mimeType application/vnd.google-apps.shortcut + shortcutDetails.targetId.
//  - supportsAllDrives=true for Shared Drive items; driveId is set for them.
//  - documents.get includeTabsContent=true puts content in tabs[].documentTab (body otherwise first tab only).
import { AppError } from '@social-lite/core';
import { GOOGLE_CONTENT_SCOPES, type GoogleContentConfig } from './config.js';
import { jsonBody, SourceAccessError, type SourceResponse, type SourceTransport } from './transport.js';

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
export const DOCS_API = 'https://docs.googleapis.com/v1';
export const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';
export const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';

export const MIME = {
  folder: 'application/vnd.google-apps.folder',
  shortcut: 'application/vnd.google-apps.shortcut',
  doc: 'application/vnd.google-apps.document',
  sheet: 'application/vnd.google-apps.spreadsheet',
  slides: 'application/vnd.google-apps.presentation',
} as const;

export const FILE_FIELDS = 'id,name,mimeType,size,md5Checksum,sha256Checksum,modifiedTime,version,headRevisionId,trashed,driveId,webViewLink,'
  + 'shortcutDetails(targetId,targetMimeType),capabilities(canDownload,canAddChildren,canEdit),parents';

export interface GoogleFile {
  id: string; name: string; mimeType: string; size?: string; md5Checksum?: string; sha256Checksum?: string; modifiedTime?: string;
  version?: string; headRevisionId?: string; trashed?: boolean; driveId?: string; webViewLink?: string;
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
  capabilities?: { canDownload?: boolean; canAddChildren?: boolean; canEdit?: boolean };
  parents?: string[];
}

export interface GoogleSession { transport: SourceTransport; accessToken: string }

const FILE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
export const isDriveId = (id: string) => FILE_ID_RE.test(id);

function auth(s: GoogleSession): Record<string, string> {
  return { authorization: `Bearer ${s.accessToken}`, accept: 'application/json' };
}

/** Classify a Google error response (JSON {error:{code,status,errors:[{reason}]}}). */
export function googleError(r: SourceResponse, what: string): SourceAccessError {
  let reason: string | null = null;
  try {
    const j = JSON.parse(r.body.toString('utf8')) as { error?: { status?: string; errors?: Array<{ reason?: string }> } | string };
    if (typeof j.error === 'string') reason = j.error;
    else reason = j.error?.errors?.[0]?.reason ?? j.error?.status ?? null;
  } catch { /* non-JSON */ }
  const retryAfter = Number(r.headers['retry-after'] ?? '') || null;
  if (r.status === 401) return new SourceAccessError(`${what}: authorization is no longer valid`, 'auth', 401, reason);
  if (r.status === 404) return new SourceAccessError(`${what}: not found or not shared with Relay`, 'not_found', 404, reason);
  if (r.status === 429 || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') {
    return new SourceAccessError(`${what}: rate limited`, 'rate_limited', r.status, reason, retryAfter);
  }
  if (r.status === 403) {
    if (reason === 'exportSizeLimitExceeded') return new SourceAccessError(`${what}: the export is larger than Google allows (10 MB)`, 'too_large', 403, reason);
    return new SourceAccessError(`${what}: access denied`, 'forbidden', 403, reason);
  }
  if (r.status === 400) return new SourceAccessError(`${what}: request rejected`, 'invalid', 400, reason);
  return new SourceAccessError(`${what}: Google is unavailable (${r.status})`, 'unavailable', r.status, reason, retryAfter);
}

async function call<T>(s: GoogleSession, req: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string; op: string; body?: string | Uint8Array; headers?: Record<string, string>; maxBytes?: number }): Promise<T> {
  const r = await s.transport.send({ ...req, headers: { ...auth(s), ...(req.headers ?? {}) } });
  if (r.status < 200 || r.status >= 300) throw googleError(r, req.op);
  return r.status === 204 ? (undefined as T) : jsonBody<T>(r);
}

// ------------------------------------------------------------------ Drive
export async function getFile(s: GoogleSession, fileId: string): Promise<GoogleFile> {
  if (!isDriveId(fileId)) throw new SourceAccessError('invalid file id', 'not_found', 404);
  return call<GoogleFile>(s, { method: 'GET', op: 'drive.files.get', url: `${DRIVE_API}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=${encodeURIComponent(FILE_FIELDS)}` });
}

/** Resolve a shortcut to its target (one hop; a shortcut to a shortcut is refused). */
export async function getFileResolvingShortcut(s: GoogleSession, fileId: string): Promise<{ file: GoogleFile; resolvedFrom: string | null }> {
  const f = await getFile(s, fileId);
  if (f.mimeType !== MIME.shortcut) return { file: f, resolvedFrom: null };
  const target = f.shortcutDetails?.targetId;
  if (!target) throw new SourceAccessError('shortcut has no target', 'not_found', 404, 'shortcut_without_target');
  const t = await getFile(s, target);
  if (t.mimeType === MIME.shortcut) throw new SourceAccessError('shortcut points to another shortcut', 'invalid', 400, 'nested_shortcut');
  return { file: t, resolvedFrom: f.id };
}

/** Bounded download of blob content (files.get alt=media). */
export async function downloadFile(s: GoogleSession, fileId: string, maxBytes: number): Promise<Buffer> {
  const r = await s.transport.send({ method: 'GET', op: 'drive.files.download', url: `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    headers: { authorization: `Bearer ${s.accessToken}` }, maxBytes, timeoutMs: 120_000 });
  if (r.status < 200 || r.status >= 300) throw googleError(r, 'drive.files.download');
  return r.body;
}

/** Bounded export of a Google Docs Editors file (files.export; Google limits the output to 10 MB). */
export async function exportFile(s: GoogleSession, fileId: string, mimeType: string, maxBytes: number): Promise<Buffer> {
  const r = await s.transport.send({ method: 'GET', op: 'drive.files.export', url: `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(mimeType)}`,
    headers: { authorization: `Bearer ${s.accessToken}` }, maxBytes, timeoutMs: 120_000 });
  if (r.status < 200 || r.status >= 300) throw googleError(r, 'drive.files.export');
  return r.body;
}

/** Multipart upload (≤ 5 MB): creates a NEW file; mimeType of a Google type converts on import (HTML → Doc). */
export async function createFile(s: GoogleSession, p: { name: string; targetMimeType?: string; parentId: string | null; content: Uint8Array; contentType: string }): Promise<GoogleFile> {
  const boundary = `relay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const meta: Record<string, unknown> = { name: p.name };
  if (p.targetMimeType) meta.mimeType = p.targetMimeType;
  if (p.parentId) meta.parents = [p.parentId];
  const head = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${p.contentType}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, Buffer.from(p.content), tail]);
  return call<GoogleFile>(s, {
    method: 'POST', op: 'drive.files.create',
    url: `${DRIVE_UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=${encodeURIComponent(FILE_FIELDS)}`,
    headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body,
  });
}

export async function getStartPageToken(s: GoogleSession): Promise<string> {
  const r = await call<{ startPageToken: string }>(s, { method: 'GET', op: 'drive.changes.getStartPageToken', url: `${DRIVE_API}/changes/startPageToken?supportsAllDrives=true` });
  return r.startPageToken;
}

export interface DriveChange { fileId?: string; removed?: boolean; file?: GoogleFile; time?: string; changeType?: string }

export async function listChanges(s: GoogleSession, pageToken: string): Promise<{ changes: DriveChange[]; nextPageToken?: string; newStartPageToken?: string }> {
  return call(s, { method: 'GET', op: 'drive.changes.list',
    url: `${DRIVE_API}/changes?pageToken=${encodeURIComponent(pageToken)}&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=${encodeURIComponent(`nextPageToken,newStartPageToken,changes(fileId,removed,time,changeType,file(${FILE_FIELDS}))`)}` });
}

export async function watchChanges(s: GoogleSession, p: { pageToken: string; channelId: string; address: string; token: string; expirationMs: number }): Promise<{ resourceId: string; expiration?: string }> {
  return call(s, { method: 'POST', op: 'drive.changes.watch',
    url: `${DRIVE_API}/changes/watch?pageToken=${encodeURIComponent(p.pageToken)}&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: p.channelId, type: 'web_hook', address: p.address, token: p.token, expiration: String(p.expirationMs) }) });
}

export async function stopChannel(s: GoogleSession, channelId: string, resourceId: string): Promise<void> {
  await call<void>(s, { method: 'POST', op: 'drive.channels.stop', url: `${DRIVE_API}/channels/stop`, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: channelId, resourceId }) });
}

// ------------------------------------------------------------------ Docs
export type DocsSuggestionsView = 'PREVIEW_WITHOUT_SUGGESTIONS' | 'PREVIEW_SUGGESTIONS_ACCEPTED' | 'SUGGESTIONS_INLINE';

/** documents.get with all tabs; comments are never requested (omitted by default). */
export async function getDocument(s: GoogleSession, documentId: string, view: DocsSuggestionsView, maxBytes: number): Promise<unknown> {
  if (!isDriveId(documentId)) throw new SourceAccessError('invalid document id', 'not_found', 404);
  return call<unknown>(s, { method: 'GET', op: 'docs.documents.get', maxBytes,
    url: `${DOCS_API}/documents/${encodeURIComponent(documentId)}?includeTabsContent=true&suggestionsViewMode=${view}` });
}

// ------------------------------------------------------------------ OAuth
export interface GoogleTokens { accessToken: string; refreshToken: string | null; expiresAt: string | null; scopes: string[] }

export function googleAuthorizationUrl(cfg: GoogleContentConfig, p: { state: string; codeChallenge: string; loginHint?: string | null }): string {
  if (!cfg.clientId) throw new AppError('provider_not_configured', 'Google Drive & Docs is not configured yet.');
  const u = new URL(GOOGLE_AUTH);
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', cfg.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', GOOGLE_CONTENT_SCOPES.join(' '));
  u.searchParams.set('access_type', 'offline');
  // A separate grant from sign-in/YouTube: do NOT merge previously granted scopes into this token.
  u.searchParams.set('include_granted_scopes', 'false');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('state', p.state);
  u.searchParams.set('code_challenge', p.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (p.loginHint) u.searchParams.set('login_hint', p.loginHint);
  return u.toString();
}

function tokensFrom(j: { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string }, now: Date, prevRefresh: string | null = null): GoogleTokens {
  if (!j.access_token) throw new SourceAccessError('token response without access_token', 'unavailable');
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? prevRefresh,
    expiresAt: j.expires_in ? new Date(now.getTime() + j.expires_in * 1000).toISOString() : null,
    scopes: (j.scope ?? '').split(/\s+/).filter(Boolean),
  };
}

async function tokenCall(t: SourceTransport, cfg: GoogleContentConfig, params: Record<string, string>, op: string): Promise<Record<string, unknown>> {
  if (!cfg.clientId || !cfg.clientSecret) throw new AppError('provider_not_configured', 'Google Drive & Docs is not configured yet.');
  const body = new URLSearchParams({ ...params, client_id: cfg.clientId, client_secret: cfg.clientSecret }).toString();
  const r = await t.send({ method: 'POST', url: GOOGLE_TOKEN, op, headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  if (r.status === 400 || r.status === 401) {
    let err = 'invalid_grant';
    try { err = String((JSON.parse(r.body.toString('utf8')) as { error?: string }).error ?? err); } catch { /* keep */ }
    throw new SourceAccessError(`${op}: ${err}`, 'auth', r.status, err);
  }
  if (r.status !== 200) throw googleError(r, op);
  return jsonBody<Record<string, unknown>>(r);
}

export async function exchangeGoogleCode(t: SourceTransport, cfg: GoogleContentConfig, p: { code: string; codeVerifier: string }, now = new Date()): Promise<GoogleTokens> {
  const j = await tokenCall(t, cfg, { grant_type: 'authorization_code', code: p.code, code_verifier: p.codeVerifier, redirect_uri: cfg.redirectUri }, 'google.oauth.token');
  return tokensFrom(j as never, now);
}

export async function refreshGoogleToken(t: SourceTransport, cfg: GoogleContentConfig, refreshToken: string, now = new Date()): Promise<GoogleTokens> {
  const j = await tokenCall(t, cfg, { grant_type: 'refresh_token', refresh_token: refreshToken }, 'google.oauth.refresh');
  return tokensFrom(j as never, now, refreshToken);
}

/** Best-effort revocation (refresh token revokes the whole grant). */
export async function revokeGoogleToken(t: SourceTransport, token: string): Promise<boolean> {
  const r = await t.send({ method: 'POST', url: GOOGLE_REVOKE, op: 'google.oauth.revoke', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString() });
  return r.status === 200;
}

export async function googleUserInfo(s: GoogleSession): Promise<{ sub: string; email: string | null }> {
  const j = await call<{ sub?: string; email?: string }>(s, { method: 'GET', op: 'google.userinfo', url: GOOGLE_USERINFO });
  if (!j.sub) throw new SourceAccessError('userinfo without subject', 'unavailable');
  return { sub: j.sub, email: j.email ?? null };
}
