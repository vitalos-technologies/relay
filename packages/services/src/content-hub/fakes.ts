// LABELLED TEST TRANSPORTS (mode 'test') for Google Drive/Docs and Notion. Used by integration tests (recorded
// request assertions) and by non-production 'test' connections (seeded demo data). Never used for live connections;
// sourceTransport() refuses test transports in production.
import { createHash, randomUUID } from 'node:crypto';
import zlib from 'node:zlib';
import { registerDemoTransport, type SourceRequest, type SourceResponse, type SourceTransport } from './transport.js';
import type { GoogleFile } from './google.js';
import type { GoogleDocument } from './docs-parse.js';
import type { NotionBlock, NotionDataSource, NotionPage } from './notion.js';

export interface RecordedRequest { method: string; url: string; op: string; headers: Record<string, string>; body: string | null }

const json = (status: number, body: unknown, headers: Record<string, string> = {}): SourceResponse =>
  ({ status, headers: { 'content-type': 'application/json', ...headers }, body: Buffer.from(JSON.stringify(body)) });
const bytes = (status: number, body: Buffer, contentType: string): SourceResponse => ({ status, headers: { 'content-type': contentType, 'content-length': String(body.length) }, body });

abstract class FakeBase implements SourceTransport {
  readonly mode = 'test' as const;
  readonly requests: RecordedRequest[] = [];
  /** Force the next N responses for an op to a status (e.g. 429/503) to test retries. */
  failures = new Map<string, Array<{ status: number; body?: unknown; headers?: Record<string, string> }>>();
  async send(req: SourceRequest): Promise<SourceResponse> {
    const body = req.body === undefined ? null : typeof req.body === 'string' ? req.body : Buffer.from(req.body).toString('latin1');
    this.requests.push({ method: req.method, url: req.url, op: req.op, headers: { ...(req.headers ?? {}) }, body });
    const f = this.failures.get(req.op)?.shift();
    if (f) return json(f.status, f.body ?? { error: { status: 'FAKE_FAILURE' } }, f.headers);
    const res = await this.route(req, new URL(req.url), body);
    if (req.maxBytes !== undefined && res.body.length > req.maxBytes) {
      const { SourceTooLargeError } = await import('./transport.js');
      throw new SourceTooLargeError(req.maxBytes);
    }
    return res;
  }
  protected abstract route(req: SourceRequest, u: URL, body: string | null): Promise<SourceResponse>;
  ops(): string[] { return this.requests.map((r) => r.op); }
}

// ------------------------------------------------------------------ Google
export interface FakeDriveFile { meta: GoogleFile; content?: Buffer; doc?: GoogleDocument; docInline?: GoogleDocument; docAccepted?: GoogleDocument; granted: boolean }

export class FakeGoogleApi extends FakeBase {
  readonly label = 'TEST: fake Google Drive/Docs API';
  files = new Map<string, FakeDriveFile>();
  accessTokens = new Set<string>(['g-access-1']);
  refreshTokens = new Map<string, boolean>([['g-refresh-1', true]]);
  account = { sub: 'google-sub-1', email: 'creator@example.test' };
  grantedScopes = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file';
  changes: Array<{ fileId: string; removed?: boolean }> = [];
  created: Array<{ meta: Record<string, unknown>; content: string; contentType: string; id: string }> = [];
  channels = new Map<string, { resourceId: string; token: string }>();
  private n = 2;

  addFile(f: Partial<GoogleFile> & { id: string; name: string; mimeType: string }, extra: Partial<Omit<FakeDriveFile, 'meta'>> = {}): FakeDriveFile {
    const meta: GoogleFile = { version: '1', modifiedTime: '2026-11-01T10:00:00.000Z', webViewLink: `https://drive.google.com/file/d/${f.id}/view`, capabilities: { canDownload: true, canAddChildren: f.mimeType === 'application/vnd.google-apps.folder', canEdit: true }, ...f };
    if (extra.content && !meta.size) meta.size = String(extra.content.length);
    if (extra.content && !meta.md5Checksum) meta.md5Checksum = createHash('md5').update(extra.content).digest('hex');
    const rec: FakeDriveFile = { meta, granted: true, ...extra };
    this.files.set(f.id, rec);
    return rec;
  }

  /** Simulate an edit: new bytes/doc ⇒ new version/md5/modifiedTime. */
  update(id: string, patch: { content?: Buffer; doc?: GoogleDocument }) {
    const f = this.files.get(id)!;
    if (patch.content) { f.content = patch.content; f.meta.size = String(patch.content.length); f.meta.md5Checksum = createHash('md5').update(patch.content).digest('hex'); }
    if (patch.doc) f.doc = patch.doc;
    f.meta.version = String(Number(f.meta.version ?? '1') + 1);
    f.meta.modifiedTime = new Date(Date.parse(f.meta.modifiedTime ?? '2026-11-01T10:00:00Z') + 60_000).toISOString();
  }

  private authed(req: SourceRequest): boolean {
    const a = req.headers?.authorization ?? '';
    return a.startsWith('Bearer ') && this.accessTokens.has(a.slice(7));
  }

  protected async route(req: SourceRequest, u: URL, body: string | null): Promise<SourceResponse> {
    if (u.hostname === 'oauth2.googleapis.com' && u.pathname === '/token') {
      const p = new URLSearchParams(body ?? '');
      if (p.get('grant_type') === 'authorization_code') {
        if (p.get('code') !== 'good-code' || !p.get('code_verifier')) return json(400, { error: 'invalid_grant' });
        return json(200, { access_token: 'g-access-1', refresh_token: 'g-refresh-1', expires_in: 3599, scope: this.grantedScopes, token_type: 'Bearer' });
      }
      const rt = p.get('refresh_token') ?? '';
      if (!this.refreshTokens.get(rt)) return json(400, { error: 'invalid_grant' });
      const at = `g-access-${this.n++}`;
      this.accessTokens.add(at);
      return json(200, { access_token: at, expires_in: 3599, scope: this.grantedScopes, token_type: 'Bearer' });
    }
    if (u.hostname === 'oauth2.googleapis.com' && u.pathname === '/revoke') {
      const t = new URLSearchParams(body ?? '').get('token') ?? '';
      this.refreshTokens.set(t, false);
      this.accessTokens.clear();
      return json(200, {});
    }
    if (!this.authed(req)) return json(401, { error: { code: 401, status: 'UNAUTHENTICATED' } });
    if (u.hostname === 'openidconnect.googleapis.com') return json(200, { sub: this.account.sub, email: this.account.email, email_verified: true });
    if (u.pathname.includes('/permissions')) return json(403, { error: { errors: [{ reason: 'forbiddenByTest' }] } });
    if (u.hostname === 'docs.googleapis.com') {
      const id = decodeURIComponent(u.pathname.split('/').pop()!);
      const f = this.files.get(id);
      if (!f?.granted || !f.doc) return json(404, { error: { code: 404, status: 'NOT_FOUND' } });
      const view = u.searchParams.get('suggestionsViewMode');
      const doc = view === 'SUGGESTIONS_INLINE' ? (f.docInline ?? f.doc) : view === 'PREVIEW_SUGGESTIONS_ACCEPTED' ? (f.docAccepted ?? f.doc) : f.doc;
      return json(200, { documentId: id, ...doc });
    }
    if (u.pathname === '/upload/drive/v3/files' && req.method === 'POST') {
      const boundary = (req.headers?.['content-type'] ?? '').match(/boundary=([^;]+)/)?.[1] ?? '';
      const parts = (body ?? '').split(`--${boundary}`).slice(1, -1).map((part) => {
        const [head, ...rest] = part.replace(/^\r\n/, '').split('\r\n\r\n');
        return { contentType: (head ?? '').match(/Content-Type: ([^\r\n]+)/i)?.[1]?.trim() ?? '', content: rest.join('\r\n\r\n').replace(/\r\n$/, '') };
      });
      const meta = JSON.parse(parts[0]?.content ?? '{}') as Record<string, unknown>;
      const media = parts[1] ?? { contentType: 'application/octet-stream', content: '' };
      const parents = (meta.parents as string[] | undefined) ?? [];
      if (parents.length && !this.files.get(parents[0]!)?.granted) return json(404, { error: { code: 404, status: 'NOT_FOUND' } });
      const id = `created${this.n++}${'x'.repeat(20)}`;
      this.created.push({ meta, content: Buffer.from(media.content, 'latin1').toString('utf8'), contentType: media.contentType, id });
      const created = this.addFile({ id, name: String(meta.name ?? 'Untitled'), mimeType: String(meta.mimeType ?? media.contentType), parents });
      return json(200, created.meta);
    }
    const m = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)(\/export)?$/);
    if (m) {
      const f = this.files.get(decodeURIComponent(m[1]!));
      if (!f || !f.granted) return json(404, { error: { code: 404, errors: [{ reason: 'notFound' }] } });
      if (m[2]) {
        if (!f.meta.mimeType.startsWith('application/vnd.google-apps.')) return json(403, { error: { errors: [{ reason: 'fileNotExportable' }] } });
        return bytes(200, Buffer.from('exported text'), 'text/plain');
      }
      if (u.searchParams.get('alt') === 'media') {
        if (f.meta.capabilities?.canDownload === false) return json(403, { error: { code: 403, errors: [{ reason: 'cannotDownloadFile' }] } });
        if (f.meta.mimeType.startsWith('application/vnd.google-apps.')) return json(403, { error: { errors: [{ reason: 'fileNotDownloadable' }] } });
        return bytes(200, f.content ?? Buffer.alloc(0), f.meta.mimeType);
      }
      if (f.meta.driveId && u.searchParams.get('supportsAllDrives') !== 'true') return json(404, { error: { code: 404, errors: [{ reason: 'notFound' }] } });
      return json(200, f.meta);
    }
    if (u.pathname === '/drive/v3/changes/startPageToken') return json(200, { startPageToken: '100' });
    if (u.pathname === '/drive/v3/changes') {
      const list = this.changes.splice(0);
      return json(200, { newStartPageToken: String(101 + list.length), changes: list.map((c) => ({ fileId: c.fileId, removed: !!c.removed, file: c.removed ? undefined : this.files.get(c.fileId)?.meta })) });
    }
    if (u.pathname === '/drive/v3/changes/watch') {
      const b = JSON.parse(body ?? '{}') as { id: string; token: string; expiration: string };
      const resourceId = `res-${randomUUID().slice(0, 8)}`;
      this.channels.set(b.id, { resourceId, token: b.token });
      return json(200, { kind: 'api#channel', id: b.id, resourceId, expiration: b.expiration });
    }
    if (u.pathname === '/drive/v3/channels/stop') {
      this.channels.delete((JSON.parse(body ?? '{}') as { id: string }).id);
      return { status: 204, headers: {}, body: Buffer.alloc(0) };
    }
    return json(404, { error: { code: 404, status: 'NOT_FOUND', message: `fake: no route ${req.method} ${u.pathname}` } });
  }
}

// ------------------------------------------------------------------ Notion
export class FakeNotionApi extends FakeBase {
  readonly label = 'TEST: fake Notion API';
  botId = 'b0b0b0b0-0000-4000-8000-000000000001';
  workspaceId = 'a1a1a1a1-0000-4000-8000-000000000001';
  workspaceName = 'Acme Notion';
  accessTokens = new Set<string>(['n-access-1']);
  refreshTokens = new Map<string, boolean>([['n-refresh-1', true]]);
  pages = new Map<string, NotionPage & { shared: boolean }>();
  children = new Map<string, NotionBlock[]>();
  dataSources = new Map<string, { ds: NotionDataSource; rows: string[]; shared: boolean }>();
  files = new Map<string, { body: Buffer; type: string; expiresAt: number }>();
  /** Fake clock for file URL expiry. */
  now = () => Date.now();
  private n = 1;

  addPage(p: { id: string; title: string; parentDataSource?: string; properties?: Record<string, unknown>; lastEdited?: string; shared?: boolean; url?: string }): NotionPage {
    const page = {
      object: 'page' as const, id: p.id, url: p.url ?? `https://www.notion.so/${p.id.replace(/-/g, '')}`, last_edited_time: p.lastEdited ?? '2026-11-01T10:00:00.000Z', in_trash: false,
      parent: p.parentDataSource ? { type: 'data_source_id', data_source_id: p.parentDataSource } : { type: 'workspace', workspace: true },
      properties: (p.properties ?? { title: { id: 'title', type: 'title', title: [{ plain_text: p.title }] } }) as NotionPage['properties'],
      shared: p.shared ?? true,
    };
    this.pages.set(p.id, page);
    if (p.parentDataSource) this.dataSources.get(p.parentDataSource)?.rows.push(p.id);
    return page;
  }

  setBlocks(parentId: string, blocks: Array<Partial<NotionBlock> & { type: string }>): void {
    this.children.set(parentId, blocks.map((b) => ({ object: 'block', id: b.id ?? `blk-${this.n++}-${randomUUID()}`, has_children: false, ...b } as NotionBlock)));
  }

  addDataSource(id: string, title: string, properties: NotionDataSource['properties']): void {
    this.dataSources.set(id, { ds: { object: 'data_source', id, title: [{ plain_text: title }], properties, last_edited_time: '2026-11-01T10:00:00.000Z' }, rows: [], shared: true });
  }

  /** A Notion-hosted file URL valid for `ttlMs` (Notion: one hour). */
  hostFile(body: Buffer, type: string, ttlMs = 3600_000): { url: string; expiry_time: string } {
    const key = randomUUID();
    const exp = this.now() + ttlMs;
    this.files.set(key, { body, type, expiresAt: exp });
    return { url: `https://prod-files-secure.s3.us-west-2.amazonaws.com/${key}/file?X-Amz-Expires=3600`, expiry_time: new Date(exp).toISOString() };
  }

  private authed(req: SourceRequest): boolean {
    const a = req.headers?.authorization ?? '';
    return a.startsWith('Bearer ') && this.accessTokens.has(a.slice(7));
  }

  protected async route(req: SourceRequest, u: URL, body: string | null): Promise<SourceResponse> {
    if (u.hostname === 'prod-files-secure.s3.us-west-2.amazonaws.com') {
      if (!req.untrusted) return json(400, { error: 'file urls must use the untrusted path' });
      const f = this.files.get(u.pathname.split('/')[1]!);
      if (!f) return json(404, {});
      if (this.now() > f.expiresAt) return json(403, { Code: 'AccessDenied', Message: 'Request has expired' });
      return bytes(200, f.body, f.type);
    }
    if (u.hostname !== 'api.notion.com') return json(404, {});
    const path = u.pathname.replace(/^\/v1/, '');
    if (!req.headers?.['notion-version']) return json(400, { object: 'error', code: 'missing_version' });
    if (path === '/oauth/token') {
      const b = JSON.parse(body ?? '{}') as { grant_type?: string; code?: string; refresh_token?: string };
      if (!req.headers.authorization?.startsWith('Basic ')) return json(401, { error: 'invalid_client' });
      if (b.grant_type === 'authorization_code') {
        if (b.code !== 'good-code') return json(400, { error: 'invalid_grant' });
        return json(200, { access_token: 'n-access-1', token_type: 'bearer', refresh_token: 'n-refresh-1', bot_id: this.botId, workspace_id: this.workspaceId, workspace_name: this.workspaceName, owner: { type: 'user', user: { id: 'u-1' } }, duplicated_template_id: null });
      }
      if (!this.refreshTokens.get(b.refresh_token ?? '')) return json(400, { error: 'invalid_grant' });
      this.refreshTokens.set(b.refresh_token!, false);
      const at = `n-access-${++this.n}`;
      const rt = `n-refresh-${this.n}`;
      this.accessTokens.add(at);
      this.refreshTokens.set(rt, true);
      return json(200, { access_token: at, refresh_token: rt, bot_id: this.botId, workspace_id: this.workspaceId, workspace_name: this.workspaceName, owner: { type: 'workspace', workspace: true } });
    }
    if (path === '/oauth/revoke') { this.accessTokens.clear(); return json(200, { request_id: randomUUID() }); }
    if (!this.authed(req)) return json(401, { object: 'error', code: 'unauthorized' });
    if (path === '/users/me') return json(200, { object: 'user', id: this.botId, type: 'bot', bot: { workspace_name: this.workspaceName, workspace_id: this.workspaceId } });
    if (path === '/search') {
      const b = JSON.parse(body ?? '{}') as { filter?: { value?: string }; query?: string };
      const results = b.filter?.value === 'data_source'
        ? [...this.dataSources.values()].filter((d) => d.shared).map((d) => d.ds)
        : [...this.pages.values()].filter((p) => p.shared && p.parent?.type !== 'data_source_id').map(({ shared: _s, ...p }) => p);
      return json(200, { object: 'list', results, has_more: false, next_cursor: null });
    }
    let m = path.match(/^\/pages\/([0-9a-f-]+)$/);
    if (m) {
      const p = this.pages.get(m[1]!);
      if (!p || !p.shared) return json(404, { object: 'error', code: 'object_not_found' });
      if (req.method === 'PATCH') {
        const b = JSON.parse(body ?? '{}') as { properties?: Record<string, Record<string, unknown>> };
        for (const [key, val] of Object.entries(b.properties ?? {})) {
          const entry = Object.entries(p.properties).find(([name, v]) => v.id === key || name === key);
          if (!entry) return json(400, { object: 'error', code: 'validation_error' });
          const type = entry[1].type;
          const v = (val as Record<string, unknown>)[type];
          p.properties[entry[0]] = { id: entry[1].id, type, [type]: type === 'rich_text' ? ((v as Array<{ text?: { content?: string } }>) ?? []).map((t) => ({ plain_text: t.text?.content ?? '' })) : v };
        }
        p.last_edited_time = new Date(Date.parse(p.last_edited_time ?? '2026-11-01T10:00:00Z') + 60_000).toISOString();
      }
      const { shared: _s, ...out } = p;
      return json(200, out);
    }
    if (path === '/pages' && req.method === 'POST') {
      const b = JSON.parse(body ?? '{}') as { parent?: { page_id?: string }; properties?: { title?: { title?: Array<{ text?: { content?: string } }> } }; children?: NotionBlock[] };
      const parent = this.pages.get(b.parent?.page_id ?? '');
      if (!parent || !parent.shared) return json(404, { object: 'error', code: 'object_not_found' });
      const id = randomUUID();
      const page = this.addPage({ id, title: b.properties?.title?.title?.[0]?.text?.content ?? 'Untitled' });
      this.children.set(id, (b.children ?? []).map((c) => ({ ...c, id: randomUUID(), object: 'block' }) as NotionBlock));
      return json(200, { ...page, shared: undefined });
    }
    m = path.match(/^\/blocks\/([0-9a-f-]+)\/children$/);
    if (m) {
      const id = m[1]!;
      if (req.method === 'PATCH') {
        const b = JSON.parse(body ?? '{}') as { children?: NotionBlock[] };
        this.children.set(id, [...(this.children.get(id) ?? []), ...(b.children ?? []).map((c) => ({ ...c, id: randomUUID(), object: 'block' }) as NotionBlock)]);
        return json(200, { object: 'list', results: [], has_more: false, next_cursor: null });
      }
      const root = this.pages.get(id);
      if (root && !root.shared) return json(404, { object: 'error', code: 'object_not_found' });
      const all = this.children.get(id) ?? [];
      const size = Math.min(Number(u.searchParams.get('page_size') ?? '100'), 100);
      const start = Number(u.searchParams.get('start_cursor') ?? '0');
      const slice = all.slice(start, start + size);
      const more = start + size < all.length;
      return json(200, { object: 'list', results: slice, has_more: more, next_cursor: more ? String(start + size) : null });
    }
    m = path.match(/^\/data_sources\/([0-9a-f-]+)(\/query)?$/);
    if (m) {
      const d = this.dataSources.get(m[1]!);
      if (!d || !d.shared) return json(404, { object: 'error', code: 'object_not_found' });
      if (!m[2]) return json(200, d.ds);
      const b = JSON.parse(body ?? '{}') as { page_size?: number; start_cursor?: string };
      const size = Math.min(b.page_size ?? 100, 100);
      const start = Number(b.start_cursor ?? '0');
      const rows = d.rows.map((id) => this.pages.get(id)!).filter((p) => !p.in_trash).map(({ shared: _s, ...p }) => p);
      const slice = rows.slice(start, start + size);
      const more = start + size < rows.length;
      return json(200, { object: 'list', type: 'page_or_data_source', results: slice, has_more: more, next_cursor: more ? String(start + size) : null, request_status: { type: 'complete' } });
    }
    return json(404, { object: 'error', code: 'object_not_found', message: `fake: no route ${req.method} ${path}` });
  }
}

// ------------------------------------------------------------------ demo data for 'test' connections (non-production)
/** A valid solid-colour PNG (passes media validation: ≥ 16 px, real PNG structure). */
export function solidPng(w = 64, h = 64, rgb: [number, number, number] = [253, 103, 1]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const DEMO_PNG = solidPng();

function demoGoogle(): FakeGoogleApi {
  const g = new FakeGoogleApi();
  g.accessTokens.add('test-token');
  g.addFile({ id: 'demoImage0000000000001', name: 'launch-hero.png', mimeType: 'image/png' }, { content: DEMO_PNG });
  g.addFile({ id: 'demoDoc000000000000001', name: 'Q4 launch brief', mimeType: 'application/vnd.google-apps.document' }, { doc: {
    title: 'Q4 launch brief',
    tabs: [{ tabProperties: { tabId: 't.0', title: 'Brief' }, documentTab: { body: { content: [
      { paragraph: { paragraphStyle: { namedStyleType: 'HEADING_1', headingId: 'h.intro' }, elements: [{ textRun: { content: 'Launch week\n' } }] } },
      { paragraph: { elements: [{ textRun: { content: 'Our new app ships on Monday. ' } }, { textRun: { content: 'Read the notes', textStyle: { link: { url: 'https://example.com/notes' } } } }, { textRun: { content: '\n' } }] } },
      { paragraph: { paragraphStyle: { namedStyleType: 'HEADING_2', headingId: 'h.posts' }, elements: [{ textRun: { content: 'Post ideas\n' } }] } },
      { paragraph: { bullet: { listId: 'l1', nestingLevel: 0 }, elements: [{ textRun: { content: 'Behind the scenes video\n' } }] } },
      { paragraph: { bullet: { listId: 'l1', nestingLevel: 0 }, elements: [{ textRun: { content: 'Customer quote\n' } }] } },
    ] }, lists: { l1: { listProperties: { nestingLevels: [{ glyphSymbol: '●' }] } } } } }],
  } });
  g.addFile({ id: 'demoFolder000000000001', name: 'Relay exports', mimeType: 'application/vnd.google-apps.folder' });
  return g;
}

function demoNotion(): FakeNotionApi {
  const n = new FakeNotionApi();
  n.accessTokens.add('test-token');
  n.addPage({ id: '11111111-1111-4111-8111-111111111111', title: 'Weekly newsletter' });
  n.setBlocks('11111111-1111-4111-8111-111111111111', [
    { type: 'heading_1', heading_1: { rich_text: [{ plain_text: 'This week' }] } },
    { type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Three things we shipped.' }] } },
    { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: 'Faster uploads' }] } },
  ]);
  n.addDataSource('22222222-2222-4222-8222-222222222222', 'Content calendar', {
    Name: { id: 'title', name: 'Name', type: 'title' },
    Status: { id: 'st%3A', name: 'Status', type: 'status', status: { options: [{ name: 'Idea' }, { name: 'Ready' }, { name: 'Approved' }, { name: 'Scheduled' }, { name: 'Published' }] } },
    Copy: { id: 'cp%3A', name: 'Copy', type: 'rich_text' },
    Date: { id: 'dt%3A', name: 'Date', type: 'date' },
    'Relay status': { id: 'rs%3A', name: 'Relay status', type: 'rich_text' },
  });
  n.addPage({ id: '33333333-3333-4333-8333-333333333333', title: 'Launch teaser', parentDataSource: '22222222-2222-4222-8222-222222222222', properties: {
    Name: { id: 'title', type: 'title', title: [{ plain_text: 'Launch teaser' }] }, Status: { id: 'st%3A', type: 'status', status: { name: 'Ready' } },
    Copy: { id: 'cp%3A', type: 'rich_text', rich_text: [{ plain_text: 'Something new is coming Monday.' }] }, Date: { id: 'dt%3A', type: 'date', date: { start: '2026-11-16' } },
    'Relay status': { id: 'rs%3A', type: 'rich_text', rich_text: [] },
  } });
  return n;
}

let demo: { google: FakeGoogleApi; notion: FakeNotionApi } | null = null;
registerDemoTransport((source) => {
  demo ??= { google: demoGoogle(), notion: demoNotion() };
  return demo[source];
});
