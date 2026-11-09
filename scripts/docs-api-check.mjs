#!/usr/bin/env node
// Generated API + MCP reference (queue item 9, stream DV) and its staleness check.
//
//   node scripts/docs-api-check.mjs           check: exit 1 when a generated file is stale, a route/tool changed
//                                             without regenerating, or an environment variable read by the code is
//                                             missing from the environment reference article
//   node scripts/docs-api-check.mjs --write   regenerate the files below from the code
//
// Sources of truth (nothing here is hand-maintained):
//   - HTTP routes: every apps/web/app/**/route.ts — path from the folder, methods from the exported handlers, the
//     access model from the wrapper (route / platformRoute / publicRoute / widgetRoute / machineRoute / custom), the
//     header comment, the zod body/query schema it parses and whether it reads an Idempotency-Key.
//   - MCP: the real server (packages/services/src/mcp/server.ts createMcpServer) listed over an in-memory transport with
//     the official SDK client — the same tools/list, resources/templates/list and prompts/list a client sees — plus
//     scopes and annotations from packages/core/src/contracts/mcp.ts.
//   - Environment: process.env / env.X reads in apps/*/src, apps/web and packages/*/src, plus the setup-page setting
//     keys in packages/services/src/settings.ts, each of which must appear in the environment reference article.
//
// Outputs:
//   docs/api/openapi.json                                OpenAPI 3.1 (all routes, incl. platform-operator routes) — repo only
//   docs/api/routes.md                                   full route table with schema excerpts — repo only
//   docs/api/mcp.json                                    MCP tools/resources/prompts snapshot — repo only
//   content/help/developers/api-route-reference.md       Help Centre (audience developer; platform routes excluded)
//   content/help/developers/mcp-tool-reference.md        Help Centre (audience developer)
// The `reviewed:` date in generated articles is kept while the content is unchanged and set to today when it changes;
// the check ignores that line. No network, database or environment variables are needed.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRITE = process.argv.includes('--write');
const PRODUCT_VERSION = '2026-11';
const TODAY = new Date().toISOString().slice(0, 10);
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const rel = (p) => relative(ROOT, p).split(sep).join('/');

// ------------------------------------------------------------------ file walking

function walk(dir, pred, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist') continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, pred, out);
    else if (pred(p)) out.push(p);
  }
  return out;
}

// ------------------------------------------------------------------ routes

/** Text from `from` to the matching close of the bracket at `from` (handles strings/template literals/comments). */
function balanced(src, from) {
  const open = src[from];
  const close = { '(': ')', '{': '}', '[': ']' }[open];
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) return src.slice(from); continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return src.slice(from, i + 1);
  }
  return src.slice(from);
}
function skipString(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === q) return j;
  }
  return src.length;
}

/** Initializer expression of `const NAME = …;` declared in this file, or null. */
function localConst(src, name) {
  const m = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?const\\s+${name.replace(/[$]/g, '\\$')}\\s*(?::[^=]+)?=\\s*`).exec(src);
  if (!m) return null;
  let i = m.index + m[0].length;
  let out = '';
  // Expression ends at the first top-level ';' or newline that is followed by a new statement.
  while (i < src.length) {
    const c = src[i];
    if (c === '(' || c === '{' || c === '[') { const b = balanced(src, i); out += b; i += b.length; continue; }
    if (c === '"' || c === "'" || c === '`') { const e = skipString(src, i); out += src.slice(i, e + 1); i = e + 1; continue; }
    if (c === ';') break;
    if (c === '\n' && !/^\s*[.?:]/.test(src.slice(i + 1, i + 40))) break;
    out += c; i++;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function imports(src) {
  const map = new Map();
  for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().replace(/^type\s+/, '');
      if (!t) continue;
      const [orig, alias] = t.split(/\s+as\s+/);
      map.set((alias ?? orig).trim(), { name: orig.trim(), from: m[2] });
    }
  }
  return map;
}

function moduleFile(spec) {
  const m = /^@social-lite\/(core|db|providers|services)(?:\/(.*))?$/.exec(spec);
  if (!m) return spec.startsWith('.') || spec.startsWith('@/') ? spec : null;
  const base = `packages/${m[1]}/src/${m[2] ?? 'index'}`;
  return existsSync(join(ROOT, `${base}.ts`)) ? `${base}.ts` : existsSync(join(ROOT, base, 'index.ts')) ? `${base}/index.ts` : `${base}.ts`;
}

function headerComment(src) {
  const lines = src.split('\n');
  const out = [];
  let inBlock = false;
  for (const raw of lines) {
    const l = raw.trim();
    if (inBlock) { out.push(l.replace(/\*\/$/, '').replace(/^\*\s?/, '')); if (l.endsWith('*/')) inBlock = false; continue; }
    if (!l && !out.length) continue;
    if (l.startsWith('//')) { out.push(l.replace(/^\/\/\s?/, '')); continue; }
    if (l.startsWith('/*')) { inBlock = !l.endsWith('*/'); out.push(l.replace(/^\/\*+\s?/, '').replace(/\*\/$/, '')); continue; }
    break;
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

function routePath(file) {
  const dir = rel(dirname(file)).replace(/^apps\/web\/app/, '');
  const segs = dir.split('/').filter(Boolean).filter((s) => !/^\(.*\)$/.test(s)).map((s) => {
    let m;
    if ((m = /^\[\[\.\.\.(.+)\]\]$/.exec(s))) return `{${m[1]}}`;
    if ((m = /^\[\.\.\.(.+)\]$/.exec(s))) return `{${m[1]}}`;
    if ((m = /^\[(.+)\]$/.exec(s))) return `{${m[1]}}`;
    return s;
  });
  return `/${segs.join('/')}`;
}

const ACCESS = {
  session: { label: 'Session', note: 'Signed-in session cookie and an active workspace membership; mutations also need a same-origin `Origin` and the `X-CSRF-Token` from `GET /api/session`.' },
  session_no_ws: { label: 'Session (no workspace)', note: 'Signed-in session cookie; works without an active workspace. Mutations need `Origin` + `X-CSRF-Token`.' },
  platform: { label: 'Platform operator', note: 'Signed-in Relay staff with a platform operator role (re-read from the database per request); everyone else gets 404. Mutations need `Origin` + `X-CSRF-Token`.' },
  public: { label: 'Public', note: 'No session. Webhooks and callbacks verify their own signature, token or OAuth state.' },
  widget: { label: 'Widget', note: 'Support widget: a signed-in member session or the widget visitor session cookie; Origin checked.' },
  api_key: { label: 'API key', note: '`Authorization: Bearer sl_live_…` service-account key; no cookies, no CSRF.' },
  mcp: { label: 'MCP bearer', note: 'OAuth access token for the MCP resource or a service-account API key (see the MCP reference).' },
};

function classify(wrapper, stmt, path) {
  if (path === '/mcp') return 'mcp';
  switch (wrapper) {
    case 'route': return /workspace:\s*false/.test(stmt) ? 'session_no_ws' : 'session';
    case 'platformRoute': return 'platform';
    case 'publicRoute': return 'public';
    case 'widgetRoute': return 'widget';
    case 'machineRoute': return 'api_key';
    default: return 'public';
  }
}

function scanRoutes() {
  const files = walk(join(ROOT, 'apps/web/app'), (p) => p.endsWith(`${sep}route.ts`)).sort();
  const routes = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const imp = imports(src);
    const path = routePath(file);
    const header = headerComment(src);
    const ops = [];
    const re = /export\s+(?:const\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*=\s*([A-Za-z_$][\w$]*)|(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b)/g;
    const found = [...src.matchAll(re)];
    found.forEach((m, idx) => {
      const method = m[1] ?? m[3];
      const wrapper = m[2] ?? 'function';
      const end = idx + 1 < found.length ? found[idx + 1].index : src.length;
      let stmt = src.slice(m.index, end);
      // `export const GET = handler` where handler is a local const: inspect its body too.
      if (m[2] && !['route', 'platformRoute', 'publicRoute', 'widgetRoute', 'machineRoute'].includes(m[2])) stmt += ` ${localConst(src, m[2]) ?? ''}`;
      const access = classify(wrapper, stmt, path);
      let body = null;
      const pj = /parseJson\(\s*req\s*,\s*([A-Za-z_$][\w$.]*|z\.)/.exec(stmt);
      if (pj) body = schemaRef(pj[1] === 'z.' ? null : pj[1], src, imp, pj[1] === 'z.' ? inlineAfter(stmt, pj.index) : null);
      else if (/widgetJson\(req\)/.test(stmt)) body = { name: 'service-validated JSON', source: null, file: 'packages/services/src/support/widget.ts' };
      else if (/req\.formData\(\)/.test(stmt)) body = { name: 'multipart/form-data', source: null, file: null };
      else if (/req\.(json|text)\(\)/.test(stmt) && MUTATING.has(method)) body = { name: 'raw body (verified/parsed by the service)', source: null, file: null };
      let query = null;
      const q = /([A-Za-z_$][\w$.]*)\.parse\(\s*queryOf\(req\)\s*\)/.exec(stmt) ?? /([A-Za-z_$][\w$.]*)\.parse\(\s*Object\.fromEntries\(req\.nextUrl\.searchParams/.exec(stmt);
      if (q) query = schemaRef(q[1], src, imp, null);
      const params = [...new Set([...stmt.matchAll(/searchParams\.get\(\s*'([^']+)'\s*\)/g)].map((x) => x[1]))].sort();
      const fileIdem = /idempotencyKey\(req\)|get\(\s*'idempotency-key'\s*\)/i.test(src);
      const idem = /idempotencyKey\(req\)|get\(\s*'idempotency-key'\s*\)/i.test(stmt) || (fileIdem && MUTATING.has(method) && found.filter((f) => MUTATING.has(f[1] ?? f[3])).length === 1);
      ops.push({ method, wrapper, access, body, query, params, idempotency: idem });
    });
    ops.sort((a, b) => METHODS.indexOf(a.method) - METHODS.indexOf(b.method));
    routes.push({ path, file: rel(file), header, ops });
  }
  routes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return routes;
}

function inlineAfter(stmt, at) {
  const i = stmt.indexOf('z.', at);
  let j = i;
  while (j < stmt.length && /[\w.$]/.test(stmt[j])) j++;
  if (stmt[j] !== '(') return stmt.slice(i, j);
  let expr = stmt.slice(i, j) + balanced(stmt, j);
  let k = i + expr.length;
  while (stmt[k] === '.') { let e = k + 1; while (/[\w$]/.test(stmt[e] ?? '')) e++; if (stmt[e] === '(') { const b = balanced(stmt, e); expr += stmt.slice(k, e) + b; k = e + b.length; } else break; }
  return expr.replace(/\s+/g, ' ');
}

function schemaRef(name, src, imp, inline) {
  if (inline) return { name: 'inline', source: inline, file: null };
  const root = name.split('.')[0];
  const local = localConst(src, root);
  if (local) return { name, source: local, file: null };
  const i = imp.get(root);
  if (i) return { name: i.name + name.slice(root.length), source: null, file: moduleFile(i.from) };
  return { name, source: null, file: null };
}

// ------------------------------------------------------------------ MCP (real server, in-memory transport)

function linkedPair() {
  const mk = () => ({ onmessage: undefined, onclose: undefined, onerror: undefined, peer: null,
    async start() {}, async close() { this.onclose?.(); },
    async send(msg) { const p = this.peer; queueMicrotask(() => p.onmessage?.(structuredClone(msg))); } });
  const a = mk(); const b = mk(); a.peer = b; b.peer = a;
  return [a, b];
}

async function loadMcp() {
  const { tsImport } = await import('tsx/esm/api');
  const server = await tsImport(pathToFileURL(join(ROOT, 'packages/services/src/mcp/server.ts')).href, import.meta.url);
  const sdk = await tsImport(pathToFileURL(join(ROOT, 'packages/services/src/mcp/sdk-client.ts')).href, import.meta.url);
  const contracts = await tsImport(pathToFileURL(join(ROOT, 'packages/core/src/contracts/mcp.ts')).href, import.meta.url);
  const srv = server.createMcpServer();
  const [a, b] = linkedPair();
  await srv.connect(a);
  const client = new sdk.Client({ name: 'relay-docs-api-check', version: '1.0.0' });
  await client.connect(b);
  const tools = (await client.listTools()).tools;
  const templates = (await client.listResourceTemplates()).resourceTemplates;
  const prompts = (await client.listPrompts()).prompts;
  const info = client.getServerVersion();
  const instructions = client.getInstructions?.() ?? null;
  await client.close().catch(() => undefined);
  await srv.close().catch(() => undefined);
  // Static resources are listed per principal (resources/list needs authentication); read their registrations instead.
  const resSrc = readFileSync(join(ROOT, 'packages/services/src/mcp/resources.ts'), 'utf8');
  const staticResources = [...resSrc.matchAll(/registerResource\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*\{\s*title:\s*'([^']+)'\s*,\s*description:\s*'([^']+)'/g)]
    .map((m) => ({ name: m[1], uri: m[2], title: m[3], description: m[4] }));
  return {
    protocol: contracts.MCP_PROTOCOL_VERSION, sdk: contracts.MCP_SDK_VERSION, server: info, instructions,
    scopes: contracts.MCP_SCOPES.map((s) => ({ scope: s, label: contracts.MCP_SCOPE_LABEL[s], permissions: [...contracts.MCP_SCOPE_PERMISSIONS[s]],
      default: contracts.MCP_DEFAULT_SCOPES.includes(s), customer_data: contracts.MCP_CUSTOMER_DATA_SCOPES.includes(s) })),
    errorCodes: [...contracts.MCP_ERROR_CODES],
    meta: Object.fromEntries(contracts.MCP_TOOLS.map((t) => [t.name, t])),
    tools: tools.map((t) => ({ name: t.name, title: t.title ?? t.annotations?.title ?? t.name, description: t.description ?? '', inputSchema: t.inputSchema, outputSchema: t.outputSchema ?? null, annotations: t.annotations ?? {} })),
    templates, staticResources, prompts,
  };
}

// ------------------------------------------------------------------ rendering helpers

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
const code = (s) => '`' + String(s).replace(/`/g, "'") + '`';
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
function firstSentence(s) {
  const m = /^(.{20,}?[.;])(\s|$)/.exec(s);
  return m ? m[1] : s;
}
function frontMatter(fm) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) lines.push(`${k}: [${v.join(', ')}]`);
    else lines.push(`${k}: ${typeof v === 'string' && /[:#"']/.test(v) ? JSON.stringify(v) : v}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

function jsonType(s) {
  if (!s || typeof s !== 'object') return 'any';
  if (s.anyOf) return s.anyOf.map(jsonType).filter((x, i, a) => a.indexOf(x) === i).join(' or ');
  if (s.enum) return s.enum.map((e) => JSON.stringify(e)).join(' / ');
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.type === 'array') return `array of ${jsonType(s.items)}`;
  if (Array.isArray(s.type)) return s.type.join(' or ');
  if (s.type === 'object' && s.properties) return `object {${Object.keys(s.properties).join(', ')}}`;
  return s.format ? `${s.type} (${s.format})` : (s.type ?? 'any');
}
function constraints(s) {
  if (!s || typeof s !== 'object') return '';
  const c = [];
  const t = s.anyOf ? s.anyOf.find((x) => x.type !== 'null') ?? s : s;
  if (t.minLength !== undefined) c.push(`min length ${t.minLength}`);
  if (t.maxLength !== undefined) c.push(`max length ${t.maxLength}`);
  if (t.minimum !== undefined) c.push(`≥ ${t.minimum}`);
  if (t.exclusiveMinimum !== undefined) c.push(`> ${t.exclusiveMinimum}`);
  if (t.maximum !== undefined && t.maximum < 9e15) c.push(`≤ ${t.maximum}`);
  if (t.minItems !== undefined) c.push(`min ${t.minItems} items`);
  if (t.maxItems !== undefined) c.push(`max ${t.maxItems} items`);
  if (t.pattern && t.format !== 'uuid') c.push(`pattern ${code(t.pattern)}`);
  if (t.default !== undefined) c.push(`default ${JSON.stringify(t.default)}`);
  return c.join(', ');
}

// ------------------------------------------------------------------ outputs: routes

function areaOf(path) {
  const segs = path.split('/').filter(Boolean);
  if (segs[0] === 'api') return segs[1] ?? 'api';
  return segs[0] ?? '/';
}

function openapi(routes) {
  const paths = {};
  for (const r of routes) {
    const item = {};
    const pathParams = [...r.path.matchAll(/\{([^}]+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    for (const op of r.ops) {
      const acc = ACCESS[op.access];
      const parameters = [...pathParams];
      for (const p of op.params) parameters.push({ name: p, in: 'query', required: false, schema: { type: 'string' } });
      if (op.idempotency) parameters.push({ name: 'Idempotency-Key', in: 'header', required: false, description: 'Unique key per intended action (8-200 characters). Same key + same body returns the stored response for 24 h; same key + different body returns 409 idempotency_conflict. Endpoints whose service reserves the key reject a missing key with 422.', schema: { type: 'string', minLength: 8, maxLength: 200 } });
      const o = {
        operationId: `${op.method.toLowerCase()}${r.path.replace(/[{}]/g, '').replace(/[^A-Za-z0-9]+/g, '_')}`.replace(/_+$/, ''),
        tags: [areaOf(r.path)],
        summary: clip(firstSentence(r.header || `${op.method} ${r.path}`), 120),
        description: [r.header, `Access: ${acc.label}. ${acc.note}`, op.query ? `Query schema: ${op.query.name}${op.query.file ? ` (${op.query.file})` : ''}${op.query.source ? ` = ${clip(op.query.source, 800)}` : ''}` : '']
          .filter(Boolean).join('\n\n'),
        parameters: parameters.length ? parameters : undefined,
        security: op.access === 'session' || op.access === 'session_no_ws' || op.access === 'platform'
          ? [MUTATING.has(op.method) ? { session: [], csrf: [] } : { session: [] }]
          : op.access === 'api_key' ? [{ apiKey: [] }] : op.access === 'widget' ? [{ widgetSession: [] }, { session: [] }] : op.access === 'mcp' ? [{ bearer: [] }] : [],
        requestBody: op.body ? {
          required: true,
          content: { [op.body.name === 'multipart/form-data' ? 'multipart/form-data' : 'application/json']: {
            schema: { type: 'object', description: `${op.body.name === 'inline' ? 'zod schema' : `zod schema ${op.body.name}`}${op.body.file ? ` (${op.body.file})` : ''}${op.body.source ? `: ${clip(op.body.source, 800)}` : ''}` } } },
        } : undefined,
        responses: {
          200: { description: 'Success. JSON body returned by the service (or a redirect/stream where the description says so).' },
          default: { description: 'Error envelope', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } },
        },
        'x-relay-access': op.access,
        'x-relay-source': r.file,
      };
      item[op.method.toLowerCase()] = JSON.parse(JSON.stringify(o));
    }
    paths[r.path] = item;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Relay HTTP API',
      version: PRODUCT_VERSION,
      description: 'Generated from apps/web/app/**/route.ts by scripts/docs-api-check.mjs --write. Do not edit by hand. ' +
        'Only /api/v1/* (API keys) and /mcp are intended for integrations; the other session routes are the web app\'s own API ' +
        '(cookie session + CSRF) and may change between releases. Request schemas are zod schemas, quoted as source excerpts.',
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        session: { type: 'apiKey', in: 'cookie', name: 'sl_session', description: 'Opaque session cookie (__Host-sl_session in production). 30 min idle, 12 h absolute.' },
        csrf: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token', description: 'csrf_token from GET /api/session; required on POST/PUT/PATCH/DELETE together with a same-origin Origin header.' },
        apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'sl_live_<prefix>_<secret>', description: 'Service-account API key.' },
        widgetSession: { type: 'apiKey', in: 'cookie', name: 'relay_widget', description: 'Support widget visitor session (__Host-relay_widget in production).' },
        bearer: { type: 'http', scheme: 'bearer', description: 'MCP: OAuth 2.1 access token whose audience is the MCP resource, or a service-account API key.' },
      },
      schemas: {
        ErrorEnvelope: {
          type: 'object', required: ['error', 'correlation_id'],
          properties: {
            error: { type: 'object', required: ['code', 'message'], properties: {
              code: { type: 'string', enum: ['unauthenticated', 'forbidden', 'not_found', 'validation_failed', 'conflict', 'version_conflict', 'idempotency_conflict', 'rate_limited', 'csrf_failed', 'provider_not_configured', 'provider_error', 'invalid_state', 'payload_too_large', 'unsupported_media', 'budget_exhausted', 'dispatch_disabled', 'mfa_required', 'step_up_required', 'entitlement_required', 'internal'] },
              message: { type: 'string' }, fieldErrors: { type: 'object', additionalProperties: { type: 'string' } }, details: { type: 'object' } } },
            correlation_id: { type: 'string' },
          },
        },
      },
    },
    paths,
  };
}

function accessCounts(routes, filter = () => true) {
  const c = {};
  for (const r of routes) for (const op of r.ops) if (filter(r, op)) c[op.access] = (c[op.access] ?? 0) + 1;
  return c;
}

function routesMd(routes) {
  const ops = routes.reduce((n, r) => n + r.ops.length, 0);
  const counts = accessCounts(routes);
  const out = [
    '# Relay HTTP routes (generated)', '',
    '> Generated by `node scripts/docs-api-check.mjs --write` from `apps/web/app/**/route.ts`. Do not edit by hand.',
    '> Repository-only reference: includes platform-operator routes. The Help Centre article',
    '> `content/help/developers/api-route-reference.md` is the member-facing subset. OpenAPI: `docs/api/openapi.json`.', '',
    `Route files: ${routes.length} · handlers: ${ops} · ${Object.entries(counts).map(([k, v]) => `${ACCESS[k].label}: ${v}`).join(' · ')}`, '',
    '## Access models', '', '| Access | Meaning |', '|---|---|',
    ...Object.values(ACCESS).map((a) => `| ${a.label} | ${cell(a.note)} |`), '',
  ];
  const missing = routes.filter((r) => !r.header);
  if (missing.length) out.push('## Route files without a header comment', '', ...missing.map((r) => `- ${code(r.path)} (${code(r.file)})`), '');
  const areas = [...new Set(routes.map((r) => areaOf(r.path)))].sort();
  for (const area of areas) {
    out.push(`## ${area}`, '');
    for (const r of routes.filter((x) => areaOf(x.path) === area)) {
      out.push(`### ${code(r.path)}`, '', r.header ? cell(r.header) : '_No header comment._', '', `Source: ${code(r.file)}`, '', '| Method | Access | Body | Query | Idempotency-Key |', '|---|---|---|---|---|');
      for (const op of r.ops) {
        const body = op.body ? `${op.body.name === 'inline' ? '' : code(op.body.name)}${op.body.file ? ` (${code(op.body.file)})` : ''}${op.body.source ? ` ${code(clip(op.body.source, 400))}` : ''}` : '';
        const query = op.query ? `${code(op.query.name)}${op.query.file ? ` (${code(op.query.file)})` : ''}${op.query.source ? ` ${code(clip(op.query.source, 300))}` : ''}` : op.params.map(code).join(', ');
        out.push(`| ${op.method} | ${ACCESS[op.access].label} | ${cell(body)} | ${cell(query)} | ${op.idempotency ? 'accepted' : ''} |`);
      }
      out.push('');
    }
  }
  return out.join('\n');
}

function routeArticle(routes, reviewed) {
  const visible = routes.filter((r) => r.ops.some((op) => op.access !== 'platform'));
  const platformOps = routes.reduce((n, r) => n + r.ops.filter((op) => op.access === 'platform').length, 0);
  const ops = visible.reduce((n, r) => n + r.ops.filter((op) => op.access !== 'platform').length, 0);
  const counts = accessCounts(visible, (_r, op) => op.access !== 'platform');
  const areas = [...new Set(visible.map((r) => areaOf(r.path)))].sort();
  const out = [frontMatter({
    title: 'API route reference',
    summary: 'Every HTTP route in Relay with its methods, access model, idempotency support and purpose, generated from the code.',
    section: 'developers', audience: 'developer', status: 'available',
    related: ['api-conventions', 'mcp-tool-reference', 'authentication-and-authorization'],
    product_version: PRODUCT_VERSION, reviewed, order: 41, keywords: ['api', 'endpoints', 'routes', 'openapi', 'rest'],
  }),
  '> **Note:** This page is generated from the route handlers by `node scripts/docs-api-check.mjs --write`; CI fails when it is out of date. Do not edit it by hand.', '',
  '## What is stable', '',
  'Only two interfaces are meant for integrations: the machine API under `/api/v1` (service-account API keys) and the MCP endpoint `/mcp`. ' +
  'Every other route is the web app\'s own API: it needs a browser session cookie plus CSRF protection and can change between releases. ' +
  'Conventions shared by all routes (error envelope, pagination, idempotency, rate limits) are in [API conventions](/help/developers/api-conventions).', '',
  `This page lists ${visible.length} route files with ${ops} handlers (${Object.entries(counts).map(([k, v]) => `${ACCESS[k].label}: ${v}`).join(', ')}). ` +
  `${platformOps} handlers used only by Relay staff in the admin console are not listed here.`, '',
  '## Access models', '', '| Access | What the caller needs |', '|---|---|',
  ...Object.entries(ACCESS).filter(([k]) => k !== 'platform').map(([, a]) => `| ${a.label} | ${cell(a.note)} |`), '',
  '"Idempotency-Key" marks handlers that read the header. Request bodies are validated with zod; unknown fields are rejected (`422 validation_failed`) wherever a schema is `.strict()`.', '',
  '## Routes by area', ''];
  for (const area of areas) {
    out.push(`### ${area}`, '', '| Methods | Path | Access | Idempotency-Key | Purpose |', '|---|---|---|---|---|');
    for (const r of visible.filter((x) => areaOf(x.path) === area)) {
      const ops2 = r.ops.filter((op) => op.access !== 'platform');
      const access = [...new Set(ops2.map((op) => ACCESS[op.access].label))].join(', ');
      const idem = ops2.filter((op) => op.idempotency).map((op) => op.method).join(', ');
      out.push(`| ${ops2.map((op) => op.method).join(', ')} | ${code(r.path)} | ${access} | ${idem} | ${cell(clip(r.header || '(no description in code)', 220))} |`);
    }
    out.push('');
  }
  out.push('## Related', '', '- [API conventions](/help/developers/api-conventions)', '- [MCP tool reference](/help/developers/mcp-tool-reference)', '- [Authentication and authorization](/help/developers/authentication-and-authorization)', '');
  return out.join('\n');
}

// ------------------------------------------------------------------ outputs: MCP

function mcpArticle(m, reviewed) {
  const groups = ['discover', 'find', 'draft', 'review', 'publish', 'recover', 'analyse', 'reports', 'inbox', 'cases', 'listening', 'assist'];
  const groupTitle = { discover: 'Discover', find: 'Find content', draft: 'Drafts and sources', review: 'Validation and review', publish: 'Publishing', recover: 'Recovery', analyse: 'Analytics', reports: 'Reports and jobs', inbox: 'Inbox', cases: 'Cases', listening: 'Listening', assist: 'AI preparation' };
  const out = [frontMatter({
    title: 'MCP tool reference',
    summary: 'Every tool, resource and prompt the Relay MCP server exposes, with scopes, arguments, outputs and annotations, generated from the server.',
    section: 'developers', audience: 'developer', status: 'available',
    related: ['mcp-server', 'mcp-worked-examples', 'api-conventions'],
    product_version: PRODUCT_VERSION, reviewed, order: 51, keywords: ['mcp', 'tools', 'model context protocol', 'agents', 'scopes'],
  }),
  '> **Note:** Generated from the running MCP server definition by `node scripts/docs-api-check.mjs --write`; CI fails when it is out of date. Do not edit by hand.', '',
  '## Server', '',
  '| Item | Value |', '|---|---|',
  `| Endpoint | ${code('<your Relay address>/mcp')} (Streamable HTTP) |`,
  `| Protocol revision | ${m.protocol} |`,
  `| SDK | ${code('@modelcontextprotocol/sdk')} ${m.sdk} |`,
  `| Server name / version | ${code(m.server?.name)} / ${m.server?.version} |`,
  `| Tools / resource templates / static resources / prompts | ${m.tools.length} / ${m.templates.length} / ${m.staticResources.length} / ${m.prompts.length} |`, '',
  'Setup, authentication, consent and limits are explained in [Connect an MCP client](/help/developers/mcp-server).', '',
  '## Scopes', '', 'A tool call is admitted when the token carries any one of the tool\'s scopes **and** the person granted that scope to the client in Relay. The effective permission is also limited by the person\'s own role and the brands they approved.', '',
  '| Scope | Allows | Relay permissions it can use | Default | Customer data |', '|---|---|---|---|---|',
  ...m.scopes.map((s) => `| ${code(s.scope)} | ${cell(s.label)} | ${s.permissions.map(code).join(', ')} | ${s.default ? 'yes' : ''} | ${s.customer_data ? 'yes' : ''} |`), '',
  '## Errors', '',
  'Tool failures return `isError: true` with a JSON text body `{ "error": { "code", "message", "details"? } }`. Stable codes:', '',
  m.errorCodes.map(code).join(', '), '',
  'Protocol-level problems use JSON-RPC errors instead: unknown tool or invalid arguments `-32602`, resource not found (also for resources you may not read) `-32002`. HTTP-level failures (`401` with `WWW-Authenticate`, `403 insufficient_scope`, `404` unknown session, `413`, `429` with `Retry-After`) are described in [Connect an MCP client](/help/developers/mcp-server#errors-and-limits).', '',
  '## Tools', ''];
  for (const g of groups) {
    const tools = m.tools.filter((t) => m.meta[t.name]?.group === g);
    if (!tools.length) continue;
    out.push(`### ${groupTitle[g]}`, '');
    for (const t of tools) {
      const meta = m.meta[t.name];
      out.push(`#### ${t.name}`, '', cell(t.description), '',
        `Scopes (any one): ${meta.scopes.length === m.scopes.length ? 'any granted scope' : meta.scopes.map(code).join(', ')} · ${meta.readOnly ? 'read-only' : 'writes'}${meta.destructive ? ' · destructive' : ''} · ${meta.idempotent ? 'idempotent' : 'not idempotent'}`, '');
      const props = t.inputSchema?.properties ?? {};
      const req = new Set(t.inputSchema?.required ?? []);
      if (Object.keys(props).length) {
        out.push('| Argument | Type | Required | Constraints | Description |', '|---|---|---|---|---|');
        for (const [k, v] of Object.entries(props)) {
          out.push(`| ${code(k)} | ${cell(jsonType(v))} | ${req.has(k) ? 'yes' : ''} | ${cell(constraints(v))} | ${cell(v.description ?? '')} |`);
          const nested = v.type === 'object' ? v : v.anyOf?.find((x) => x.type === 'object');
          const nreq = new Set(nested?.required ?? []);
          for (const [nk, nv] of Object.entries(nested?.properties ?? {})) out.push(`| ${code(`${k}.${nk}`)} | ${cell(jsonType(nv))} | ${nreq.has(nk) ? 'yes' : ''} | ${cell(constraints(nv))} | ${cell(nv.description ?? '')} |`);
        }
        out.push('');
      } else out.push('No arguments.', '');
      const outProps = t.outputSchema?.properties ?? {};
      if (Object.keys(outProps).length) out.push(`Returns (structuredContent): ${Object.entries(outProps).map(([k, v]) => `${code(k)} (${cell(jsonType(v))})`).join(', ')}.`, '');
    }
  }
  out.push('## Resources', '', '| URI | Name | Description |', '|---|---|---|',
    ...m.staticResources.map((r) => `| ${code(r.uri)} | ${cell(r.title)} | ${cell(r.description)} |`),
    ...m.templates.map((r) => `| ${code(r.uriTemplate)} | ${cell(r.title ?? r.name)} | ${cell(r.description ?? '')} |`), '',
    'Resource templates are read with `resources/read`; a URI for another workspace, a brand the client was not approved for, or something your role cannot read returns "Resource not found" (`-32002`).', '',
    '## Prompts', '', '| Prompt | Arguments | Description |', '|---|---|---|',
    ...m.prompts.map((p) => `| ${code(p.name)} | ${(p.arguments ?? []).map((a) => `${code(a.name)}${a.required ? ' (required)' : ''}`).join(', ')} | ${cell(p.description ?? '')} |`), '',
    'Prompts only compose suggested tool calls; they carry no authority and read no data.', '',
    '## Related', '', '- [Connect an MCP client](/help/developers/mcp-server)', '- [MCP worked examples](/help/developers/mcp-worked-examples)', '- [API conventions](/help/developers/api-conventions)', '');
  return out.join('\n');
}

// ------------------------------------------------------------------ environment drift

function envCheck() {
  const files = [
    ...walk(join(ROOT, 'apps/web'), (p) => /\.(ts|tsx|mjs)$/.test(p) && !p.includes(`${sep}public${sep}`)),
    ...walk(join(ROOT, 'apps/worker/src'), (p) => /\.(ts|mjs)$/.test(p)),
    ...['core', 'db', 'providers', 'services'].flatMap((pkg) => walk(join(ROOT, 'packages', pkg, 'src'), (p) => /\.ts$/.test(p))),
  ];
  const used = new Map();
  for (const f of files) {
    let src;
    try { src = readFileSync(f, 'utf8'); } catch { continue; } // moved while scanning (parallel edits)
    for (const m of src.matchAll(/(?:process\.env|\benv)(?:\.([A-Z][A-Z0-9_]{2,})|\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\])/g)) {
      const k = m[1] ?? m[2];
      if (!used.has(k)) used.set(k, new Set());
      used.get(k).add(rel(f));
    }
    // Dynamic reads (process.env[name]) through small helpers, e.g. days('ANALYTICS_RAW_RETENTION_DAYS', 400).
    if (/process\.env\[|\benv\[/.test(src)) {
      for (const m of src.matchAll(/\(\s*'([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)'/g)) {
        if (!used.has(m[1])) used.set(m[1], new Set());
        used.get(m[1]).add(rel(f));
      }
    }
  }
  const settingsSrc = readFileSync(join(ROOT, 'packages/services/src/settings.ts'), 'utf8');
  for (const m of settingsSrc.matchAll(/^\s+([A-Z][A-Z0-9_]+):\s*\{\s*key:\s*'([A-Z0-9_]+)'/gm)) {
    if (!used.has(m[2])) used.set(m[2], new Set());
    used.get(m[2]).add('packages/services/src/settings.ts (setup page)');
  }
  const configSrc = readFileSync(join(ROOT, 'packages/services/src/config.ts'), 'utf8');
  for (const m of configSrc.matchAll(/^\s+([A-Z][A-Z0-9_]+):\s*(?:z\.|bool)/gm)) {
    if (!used.has(m[1])) used.set(m[1], new Set());
    used.get(m[1]).add('packages/services/src/config.ts');
  }
  const IGNORE = new Set(['NODE_ENV', 'NEXT_RUNTIME']); // set by Node/Next, not by operators
  const docPath = join(ROOT, 'content/help/developers/environment-variables.md');
  const doc = existsSync(docPath) ? readFileSync(docPath, 'utf8') : '';
  const missing = [...used.keys()].filter((k) => !IGNORE.has(k) && !new RegExp(`\\b${k}\\b`).test(doc)).sort();
  const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
  const notInExample = [...used.keys()].filter((k) => !IGNORE.has(k) && !new RegExp(`^${k}=`, 'm').test(example)).sort();
  return { used, missing, notInExample, docExists: !!doc };
}

// ------------------------------------------------------------------ main

function keepReviewed(path, content) {
  if (!existsSync(path)) return content.replace(/^reviewed: .*$/m, `reviewed: ${TODAY}`);
  const old = readFileSync(path, 'utf8');
  const oldDate = /^reviewed: (.*)$/m.exec(old)?.[1] ?? TODAY;
  const strip = (s) => s.replace(/^reviewed: .*$/m, '');
  return content.replace(/^reviewed: .*$/m, `reviewed: ${strip(old) === strip(content.replace(/^reviewed: .*$/m, 'reviewed: X')) ? oldDate : TODAY}`);
}

async function main() {
  const routes = scanRoutes();
  const mcp = await loadMcp();
  const registered = new Set(mcp.tools.map((t) => t.name));
  const contractOnly = Object.keys(mcp.meta).filter((n) => !registered.has(n));
  const outputs = {
    'docs/api/openapi.json': `${JSON.stringify(openapi(routes), null, 1)}\n`,
    'docs/api/routes.md': `${routesMd(routes)}\n`,
    'docs/api/mcp.json': `${JSON.stringify({ protocol: mcp.protocol, sdk: mcp.sdk, server: mcp.server, scopes: mcp.scopes, error_codes: mcp.errorCodes, tools: mcp.tools.map((t) => ({ ...t, relay: mcp.meta[t.name] })), static_resources: mcp.staticResources, resource_templates: mcp.templates, prompts: mcp.prompts }, null, 2)}\n`,
    'content/help/developers/api-route-reference.md': `${routeArticle(routes, 'X')}`,
    'content/help/developers/mcp-tool-reference.md': `${mcpArticle(mcp, 'X')}`,
  };
  const problems = [];
  if (contractOnly.length) problems.push(`MCP_TOOLS lists tools the server does not register: ${contractOnly.join(', ')}`);
  for (const [file, raw] of Object.entries(outputs)) {
    const abs = join(ROOT, file);
    const content = file.endsWith('.md') && file.startsWith('content/') ? keepReviewed(abs, raw) : raw;
    if (WRITE) {
      mkdirSync(dirname(abs), { recursive: true });
      if (!existsSync(abs) || readFileSync(abs, 'utf8') !== content) { writeFileSync(abs, content); console.log(`wrote ${file}`); }
    } else {
      const cur = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
      const norm = (s) => s?.replace(/^reviewed: .*$/m, 'reviewed: X');
      if (norm(cur) !== norm(content)) problems.push(`${file} is stale — run: node scripts/docs-api-check.mjs --write`);
    }
  }
  const env = envCheck();
  if (!env.docExists) problems.push('content/help/developers/environment-variables.md is missing');
  for (const k of env.missing) problems.push(`environment variable ${k} (read in ${[...env.used.get(k)].join(', ')}) is not documented in content/help/developers/environment-variables.md`);
  const handlers = routes.reduce((n, r) => n + r.ops.length, 0);
  const noHeader = routes.filter((r) => !r.header).length;
  console.log(`routes: ${routes.length} files, ${handlers} handlers (${noHeader} files without a header comment) · MCP: ${mcp.tools.length} tools, ${mcp.templates.length} resource templates, ${mcp.staticResources.length} static resources, ${mcp.prompts.length} prompts · env vars read by code: ${env.used.size} (${env.notInExample.length} not in .env.example)`);
  if (problems.length) {
    for (const p of problems) console.error(`docs-api-check: ${p}`);
    process.exit(1);
  }
  console.log(WRITE ? 'docs-api-check: generated files are up to date' : 'docs-api-check: ok');
}

main().catch((err) => { console.error(err); process.exit(1); });
