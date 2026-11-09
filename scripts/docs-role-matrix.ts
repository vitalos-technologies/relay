// Regenerates (or checks) the role/permission matrix in content/help/teams-and-approvals/roles-and-permissions.md from
// packages/core/src/authz.ts so the Help Centre can't drift from the policy (queue item 9, stream UG).
//   npx tsx scripts/docs-role-matrix.ts           → rewrite the two tables in place
//   npx tsx scripts/docs-role-matrix.ts --check   → exit 1 if the article is out of date
import { readFileSync, writeFileSync } from 'node:fs';
import { PERMISSIONS, PRESET_PERMISSIONS, SENSITIVE_PERMISSIONS, WORKSPACE_ONLY, type Permission, type RolePreset } from '../packages/core/src/authz.js';

const FILE = new URL('../content/help/teams-and-approvals/roles-and-permissions.md', import.meta.url);
const LABEL: Record<RolePreset, string> = {
  owner: 'Owner', admin: 'Admin', team_manager: 'Team manager', brand_manager: 'Brand manager', editor: 'Editor', approver: 'Approver',
  publisher: 'Publisher', analyst: 'Analyst', viewer: 'Viewer', exporter: 'Exporter', guest: 'Guest', integration: 'Integration', care_agent: 'Care agent',
};
const WHAT: Record<Permission, string> = {
  'workspace.read': 'See workspace administration', 'workspace.manage': 'Change workspace settings', 'workspace.transfer_owner': 'Transfer ownership, delete workspace',
  'members.read': 'See members', 'members.invite': 'Invite people', 'members.manage': 'Change roles, suspend, remove',
  'teams.read': 'See teams', 'teams.manage': 'Create and change teams', 'brands.read': 'See brands', 'brands.manage': 'Change brand settings',
  'connections.read': 'See connected accounts', 'connections.manage': 'Connect, reconnect, disconnect accounts',
  'content.read': 'Read posts', 'content.create': 'Create posts', 'content.edit': 'Edit drafts', 'content.archive': 'Archive, move to Trash',
  'content.submit': 'Submit for review', 'content.approve': 'Approve or request changes', 'content.schedule': 'Schedule', 'content.publish': 'Publish now',
  'publishing.pause': 'Pause publishing', 'publishing.resume': 'Resume publishing', 'publishing.retry': 'Retry deliveries',
  'assets.read': 'Use the library', 'assets.upload': 'Upload media', 'assets.manage': 'Organise, trash media',
  'analytics.read': 'See analytics', 'exports.create': 'Create exports', 'audit.read': 'Read the audit log',
  'security.manage': 'Workspace security policy', 'service_accounts.manage': 'Service accounts and API keys',
  'comments.shared': 'Client-visible comments', 'comments.internal': 'Internal notes', 'content.create_draft': 'Create drafts only (API)',
  'inbox.read': 'Read the inbox', 'inbox.reply': 'Reply in the inbox', 'inbox.assign': 'Assign conversations', 'inbox.manage': 'Inbox channels and settings',
  'cases.manage': 'Work on cases', 'integrations.read': 'See business apps', 'integrations.manage': 'Install and configure business apps',
  'listening.read': 'See listening', 'listening.manage': 'Manage searches and alerts', 'ai.use': 'Use the assistant and AI', 'automation.manage': 'Manage automation',
  'billing.read': 'See plan and billing', 'billing.manage': 'Change plan, seats, payment', 'support.workspace': 'See the workspace’s support requests',
};
const STAFF: RolePreset[] = ['owner', 'admin', 'brand_manager', 'editor', 'approver', 'publisher', 'care_agent'];
const LIMITED: RolePreset[] = ['analyst', 'viewer', 'team_manager', 'exporter', 'guest', 'integration'];

function table(roles: RolePreset[]): string {
  const rows = [`| Permission | What it allows | ${roles.map((r) => LABEL[r]).join(' | ')} |`, `|---|---|${roles.map(() => ':-:').join('|')}|`];
  for (const p of PERMISSIONS) {
    const tag = (WORKSPACE_ONLY.has(p) ? ' ᵂ' : '') + (SENSITIVE_PERMISSIONS.has(p) ? ' ˢ' : '');
    rows.push(`| \`${p}\`${tag} | ${WHAT[p]} | ${roles.map((r) => (PRESET_PERMISSIONS[r].includes(p) ? '✓' : '—')).join(' | ')} |`);
  }
  return rows.join('\n');
}

const src = readFileSync(FILE, 'utf8');
const replaceAfter = (text: string, heading: string, body: string): string => {
  const start = text.indexOf(heading);
  if (start < 0) throw new Error(`heading not found: ${heading}`);
  const tableStart = text.indexOf('| Permission |', start);
  let end = tableStart;
  while (end < text.length && text.startsWith('|', end)) end = text.indexOf('\n', end) + 1 || text.length;
  return text.slice(0, tableStart) + body + '\n' + text.slice(end);
};
const next = replaceAfter(replaceAfter(src, '### Staff roles', table(STAFF)), '### Limited and special roles', table(LIMITED));
if (process.argv.includes('--check')) {
  if (next !== src) { console.error('✖ roles-and-permissions.md is out of date with packages/core/src/authz.ts — run: npx tsx scripts/docs-role-matrix.ts'); process.exit(1); }
  console.log('✔ role matrix matches authz.ts');
} else {
  writeFileSync(FILE, next);
  console.log(next === src ? 'role matrix already up to date' : 'role matrix regenerated');
}
