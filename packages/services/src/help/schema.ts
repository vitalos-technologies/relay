// Help Centre content schema (queue item 9, stream HC). Single source: content/help/<section>/<slug>.md, rendered in the
// app (/help), exported by scripts/docs-bundle.mjs and validated by scripts/docs-check.mjs. Pure: no IO.
//
// Front matter (YAML subset, see parseFrontMatter):
//   title            required  task-oriented, sentence case, ≤ 90 chars
//   summary          required  one sentence, ≤ 220 chars (search + cards)
//   section          required  one of HELP_SECTIONS ids; must equal the folder name (glossary.md: getting-started)
//   audience         required  public | user | admin | developer
//   roles            optional  role presets (packages/core/src/authz.ts ROLE_PRESETS) + 'platform_staff'
//   status           required  available | needs-setup | needs-provider-approval | not-live-verified | unsupported
//   related          optional  slugs of other articles
//   product_version  required  "YYYY-MM" (Relay release the page describes)
//   reviewed         required  YYYY-MM-DD
//   sources          optional  [{ title, url (https), verified: YYYY-MM-DD }] — provider rules
//   order            optional  integer; sort position inside the section (default 100, then title)
//   keywords         optional  extra search terms (synonyms people type), e.g. [2fa, two-factor]
import { ROLE_PRESETS } from '@social-lite/core';

export const HELP_AUDIENCES = ['public', 'user', 'admin', 'developer'] as const;
export type HelpAudience = (typeof HELP_AUDIENCES)[number];

export const HELP_STATUSES = ['available', 'needs-setup', 'needs-provider-approval', 'not-live-verified', 'unsupported'] as const;
export type HelpStatus = (typeof HELP_STATUSES)[number];

export const HELP_STATUS_LABEL: Record<HelpStatus, string | null> = {
  available: null,
  'needs-setup': 'Needs setup',
  'needs-provider-approval': 'Needs network approval',
  'not-live-verified': 'Not verified with a live account',
  unsupported: 'Not supported',
};

export const HELP_ROLES = [...ROLE_PRESETS, 'platform_staff'] as const;

/** Section folders, in Help Centre order. `icon` is a lucide-react icon name (mapped in the web app). */
export const HELP_SECTIONS = [
  { id: 'getting-started', title: 'Getting started', description: 'Sign in, set up a workspace and find your way around.', icon: 'Rocket' },
  { id: 'publishing', title: 'Publishing and content', description: 'Drafts, channel versions, media, templates and campaigns.', icon: 'SquarePen' },
  { id: 'calendar-and-scheduling', title: 'Calendar and scheduling', description: 'Schedule, reschedule, pause and follow deliveries.', icon: 'CalendarDays' },
  { id: 'analytics', title: 'Analytics and reporting', description: 'What each metric means and how reports are built.', icon: 'ChartColumn' },
  { id: 'teams-and-approvals', title: 'Teams, permissions and approvals', description: 'Roles, invitations, teams, reviews and approvals.', icon: 'Users' },
  { id: 'social-connections', title: 'Social connections', description: 'Connect, reconnect and publish to each network.', icon: 'Plug' },
  { id: 'content-sources', title: 'Google Drive, Docs and Notion', description: 'Import, refresh and write back content.', icon: 'FolderInput' },
  { id: 'business-apps', title: 'Business apps', description: 'Asana, monday.com, HubSpot, Slack, Mailchimp and more.', icon: 'Blocks' },
  { id: 'inbox-and-care', title: 'Inbox and care', description: 'Conversations, cases, SLAs and replies.', icon: 'Inbox' },
  { id: 'listening', title: 'Listening', description: 'Track mentions and topics on connected sources.', icon: 'Radar' },
  { id: 'ai-and-mcp', title: 'AI features and MCP', description: 'Assistant, AI workflows, automation and MCP clients.', icon: 'Sparkles' },
  { id: 'billing-and-plans', title: 'Billing and plans', description: 'Plans, trial, seats, invoices and usage.', icon: 'CreditCard' },
  { id: 'account-security', title: 'Account security', description: 'Two-step verification, sessions and API keys.', icon: 'ShieldCheck' },
  { id: 'support', title: 'Relay support', description: 'Contact Relay and follow your requests.', icon: 'LifeBuoy' },
  { id: 'troubleshooting', title: 'Troubleshooting', description: 'Fix common errors and failed deliveries.', icon: 'Wrench' },
  { id: 'developers', title: 'Developer documentation', description: 'API, MCP, architecture and local setup.', icon: 'Code' },
  { id: 'administration', title: 'Administration and operations', description: 'Workspace administration and the admin console.', icon: 'PanelsTopLeft' },
] as const;
export type HelpSectionId = (typeof HELP_SECTIONS)[number]['id'];
export const HELP_SECTION_IDS = HELP_SECTIONS.map((s) => s.id) as readonly HelpSectionId[];
export const isHelpSection = (s: string): s is HelpSectionId => (HELP_SECTION_IDS as readonly string[]).includes(s);
export const helpSection = (id: string) => HELP_SECTIONS.find((s) => s.id === id);

export interface HelpSource { title: string; url: string; verified: string }
export interface HelpFrontMatter {
  title: string;
  summary: string;
  section: HelpSectionId;
  audience: HelpAudience;
  roles: string[];
  status: HelpStatus;
  related: string[];
  product_version: string;
  reviewed: string;
  sources: HelpSource[];
  order: number;
  keywords: string[];
}

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VERSION_RE = /^\d{4}-\d{2}$/;
const KNOWN_KEYS = new Set(['title', 'summary', 'section', 'audience', 'roles', 'status', 'related', 'product_version', 'reviewed', 'sources', 'order', 'keywords']);

const validDate = (s: string) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

// ------------------------------------------------------------------ YAML subset parser
// Supports what help front matter needs: `key: scalar`, quoted scalars, inline lists `[a, b]`, inline lists of flow maps
// `[{ title: X, url: Y }]`, block lists of scalars (`- a`) and block lists of one-level maps (`- title: X` / `  url: Y`).
// Anything else is reported as an error rather than guessed.
type Yaml = string | number | boolean | null | Yaml[] | { [k: string]: Yaml };

function unquote(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(["\\nt])/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function scalar(raw: string): Yaml {
  const s = stripComment(raw).trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (/^["']/.test(s)) return unquote(s);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

/** Drop a trailing ` # comment` outside quotes. */
function stripComment(raw: string): string {
  let q: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { if (i === 0 || /\s|[[{,:]/.test(raw[i - 1]!)) q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(raw[i - 1]!))) return raw.slice(0, i);
  }
  return raw;
}

/** Split a flow collection body on top-level commas. */
function splitFlow(body: string): string[] {
  const out: string[] = []; let depth = 0; let q: string | null = null; let cur = '';
  for (const c of body) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

function flow(raw: string): Yaml {
  const s = stripComment(raw).trim();
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new Error(`unclosed list: ${s}`);
    return splitFlow(s.slice(1, -1)).map(flow);
  }
  if (s.startsWith('{')) {
    if (!s.endsWith('}')) throw new Error(`unclosed map: ${s}`);
    const o: Record<string, Yaml> = {};
    for (const part of splitFlow(s.slice(1, -1))) {
      const i = part.indexOf(':');
      if (i < 1) throw new Error(`expected "key: value" in ${s}`);
      o[part.slice(0, i).trim()] = flow(part.slice(i + 1));
    }
    return o;
  }
  return scalar(s);
}

export function parseYamlSubset(text: string): Record<string, Yaml> {
  const lines = text.split(/\r?\n/);
  const out: Record<string, Yaml> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }
    if (/^\s/.test(line)) throw new Error(`line ${i + 1}: unexpected indentation`);
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:(.*)$/.exec(line);
    if (!m) throw new Error(`line ${i + 1}: expected "key: value"`);
    const key = m[1]!; const rest = stripComment(m[2]!).trim();
    if (key in out) throw new Error(`line ${i + 1}: duplicate key "${key}"`);
    i++;
    if (rest !== '') { out[key] = flow(rest); continue; }
    // Block list (or empty value).
    const items: Yaml[] = [];
    while (i < lines.length && (/^\s+/.test(lines[i]!) || /^-\s/.test(lines[i]!) || lines[i]!.trim() === '')) {
      const l = lines[i]!;
      if (!l.trim() || l.trim().startsWith('#')) { i++; continue; }
      const item = /^(\s*)-\s+(.*)$/.exec(l);
      if (!item) throw new Error(`line ${i + 1}: expected "- item"`);
      const indent = item[1]!.length; const body = item[2]!;
      i++;
      const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*:(.*)$/.exec(body);
      if (!kv || body.trim().startsWith('{') || /^["']/.test(body.trim())) { items.push(flow(body)); continue; }
      const obj: Record<string, Yaml> = { [kv[1]!]: flow(kv[2]!) };
      while (i < lines.length) {
        const cont = /^(\s+)([A-Za-z_][A-Za-z0-9_]*)\s*:(.*)$/.exec(lines[i]!);
        if (!cont || cont[1]!.length <= indent) break;
        obj[cont[2]!] = flow(cont[3]!);
        i++;
      }
      items.push(obj);
    }
    out[key] = items.length ? items : null;
  }
  return out;
}

/** Split `---\nyaml\n---\nbody`. */
export function splitFrontMatter(source: string): { yaml: string; body: string; bodyLine: number } | null {
  const text = source.replace(/^\uFEFF/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  return { yaml: m[1]!, body: text.slice(m[0].length), bodyLine: m[0].split('\n').length };
}

const asList = (v: Yaml | undefined): Yaml[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const asStr = (v: Yaml | undefined): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);

/**
 * Validate parsed front matter. Returns the normalised value and every problem found (no early exit, so authors see
 * all of them at once). `expected` carries what the file path implies.
 */
export function validateFrontMatter(raw: Record<string, Yaml>, expected: { section?: string } = {}): { data: HelpFrontMatter | null; errors: string[] } {
  const errors: string[] = [];
  for (const k of Object.keys(raw)) if (!KNOWN_KEYS.has(k)) errors.push(`unknown front-matter key "${k}"`);
  const str = (k: string, required = true): string => {
    const v = asStr(raw[k]);
    if (v === null || v.trim() === '') { if (required) errors.push(`"${k}" is required`); return ''; }
    return v.trim();
  };
  const title = str('title');
  if (title.length > 90) errors.push('"title" is longer than 90 characters');
  if (title && /^[a-z]/.test(title)) errors.push('"title" should start with a capital letter (sentence case)');
  const summary = str('summary');
  if (summary.length > 220) errors.push('"summary" is longer than 220 characters (one sentence)');
  const section = str('section');
  if (section && !isHelpSection(section)) errors.push(`"section" must be one of: ${HELP_SECTION_IDS.join(', ')}`);
  if (section && expected.section && section !== expected.section) errors.push(`"section" is "${section}" but the file is in "${expected.section}/"`);
  const audience = str('audience');
  if (audience && !(HELP_AUDIENCES as readonly string[]).includes(audience)) errors.push(`"audience" must be one of: ${HELP_AUDIENCES.join(', ')}`);
  const status = str('status');
  if (status && !(HELP_STATUSES as readonly string[]).includes(status)) errors.push(`"status" must be one of: ${HELP_STATUSES.join(', ')}`);
  const product_version = str('product_version');
  if (product_version && !VERSION_RE.test(product_version)) errors.push('"product_version" must look like "2026-11"');
  const reviewed = str('reviewed');
  if (reviewed && !validDate(reviewed)) errors.push('"reviewed" must be a date like 2026-11-09');

  const strList = (k: string, check?: (s: string) => string | null): string[] => {
    const out: string[] = [];
    for (const v of asList(raw[k])) {
      const s = asStr(v);
      if (s === null || !s.trim()) { errors.push(`"${k}" entries must be text`); continue; }
      const problem = check?.(s.trim());
      if (problem) errors.push(problem); else out.push(s.trim());
    }
    return out;
  };
  const roles = strList('roles', (r) => ((HELP_ROLES as readonly string[]).includes(r) ? null : `unknown role "${r}" in "roles" (use ${HELP_ROLES.join(', ')})`));
  const related = strList('related', (s) => (SLUG_RE.test(s) ? null : `"related" entry "${s}" is not a slug`));
  const keywords = strList('keywords');
  const sources: HelpSource[] = [];
  for (const v of asList(raw.sources)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push('"sources" entries must be { title, url, verified }'); continue; }
    const t = asStr(v.title); const u = asStr(v.url); const d = asStr(v.verified);
    if (!t) errors.push('a "sources" entry is missing "title"');
    if (!u || !/^https:\/\/[^\s]+$/.test(u)) errors.push(`"sources" url must be an https:// link${u ? ` (got "${u}")` : ''}`);
    if (!d || !validDate(d)) errors.push(`"sources" entry "${t ?? u ?? '?'}" needs "verified: YYYY-MM-DD"`);
    if (t && u && d) sources.push({ title: t, url: u, verified: d });
  }
  let order = 100;
  if (raw.order !== undefined && raw.order !== null) {
    if (typeof raw.order !== 'number') errors.push('"order" must be a whole number'); else order = raw.order;
  }
  if (errors.length) return { data: null, errors };
  return {
    data: { title, summary, section: section as HelpSectionId, audience: audience as HelpAudience, roles, status: status as HelpStatus, related,
      product_version, reviewed, sources, order, keywords },
    errors,
  };
}

export function parseFrontMatter(source: string, expected: { section?: string } = {}): { data: HelpFrontMatter | null; body: string; bodyLine: number; errors: string[] } {
  const split = splitFrontMatter(source);
  if (!split) return { data: null, body: source, bodyLine: 1, errors: ['missing front matter (the file must start with --- … ---)'] };
  let raw: Record<string, Yaml>;
  try { raw = parseYamlSubset(split.yaml); } catch (e) { return { data: null, body: split.body, bodyLine: split.bodyLine, errors: [`front matter: ${(e as Error).message}`] }; }
  const v = validateFrontMatter(raw, expected);
  return { data: v.data, body: split.body, bodyLine: split.bodyLine, errors: v.errors };
}

// ------------------------------------------------------------------ audiences
/** Which audiences a viewer may read. Signed-out: public only. Members: public + user + developer. Admins
 *  (workspace.manage on the active workspace) and platform staff: everything. */
export function audiencesFor(viewer: { signedIn: boolean; admin?: boolean; platformStaff?: boolean; guestOnly?: boolean }): HelpAudience[] {
  if (!viewer.signedIn) return ['public'];
  if (viewer.platformStaff || viewer.admin) return ['public', 'user', 'developer', 'admin'];
  if (viewer.guestOnly) return ['public'];
  return ['public', 'user', 'developer'];
}
export const canRead = (audiences: readonly HelpAudience[], a: HelpAudience) => audiences.includes(a);

/** The Relay release the Help Centre currently describes (articles carry their own product_version). */
export const HELP_PRODUCT_VERSION = '2026-11';
