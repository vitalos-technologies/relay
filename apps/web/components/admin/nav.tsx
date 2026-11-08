'use client';
// Admin navigation registry (V3.1 Admin §15). Two scopes: Workspace (V2 grants of the active workspace) and Platform
// (platform_operators). `visible` only hides what the viewer can't use; every API re-checks on the server.
// Settings items come from the shared Settings registry so there is one definition of each settings page.
import {
  Activity, BadgeCheck, BookOpen, Building2, Cable, ChartColumn, CheckCheck, Cog, FileStack, Flag, Gauge, HandHelping, HeartPulse, KeyRound,
  LayoutDashboard, LifeBuoy, ListChecks, MessageSquareWarning, Plug, ScrollText, Send, ServerCog, ShieldCheck, Stethoscope, Tag, ToggleRight, UserCog, Users, UsersRound,
  Webhook, Wrench, Workflow, MessagesSquare, UserRoundCog, BellRing, SlidersHorizontal, Radar, Sparkles, CreditCard, Layers, Inbox, MessageSquareText, type LucideIcon,
} from 'lucide-react';
import type { Action, Permission } from '@social-lite/core';
import { SETTINGS, itemAllowed, type Perms } from '@/components/settings-shell/registry';

export interface AdminPerms extends Perms { platform: 'operator' | 'support' | 'billing' | null }
export interface AdminNavItem { href: string; label: string; icon: LucideIcon; keywords?: string; visible?: (p: AdminPerms) => boolean; also?: string[] }
export interface AdminNavGroup { id: string; label: string; icon: LucideIcon; items: AdminNavItem[] }

const v2 = (perm: Permission) => (p: AdminPerms) => p.canV2(perm);
const v1 = (a: Action) => (p: AdminPerms) => p.can(a);
const flagged = (key: string, base?: (p: AdminPerms) => boolean) => (p: AdminPerms) => !!p.flag?.(key) && (!base || base(p));
const settings = (group: string, slug: string, label?: string, icon?: LucideIcon): AdminNavItem => {
  const it = SETTINGS.find((g) => g.id === group)!.items.find((i) => i.slug === slug)!;
  return { href: `/admin/settings/${group}/${slug}`, label: label ?? it.label, icon: icon ?? it.icon, keywords: it.keywords, visible: (p) => itemAllowed(it, p) };
};

export const WORKSPACE_NAV: AdminNavGroup[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, items: [
    { href: '/admin', label: 'Overview', icon: LayoutDashboard, visible: v2('workspace.read'), keywords: 'health dashboard attention' },
  ] },
  { id: 'people', label: 'People and teams', icon: Users, items: [
    { href: '/admin/people', label: 'Members', icon: Users, visible: v2('members.read'), also: ['/admin/people/members'], keywords: 'roles access suspend offboard remove' },
    { href: '/admin/people/invitations', label: 'Invitations', icon: Send, visible: v2('members.invite'), keywords: 'invite resend revoke guest' },
    { href: '/admin/people/teams', label: 'Teams', icon: UsersRound, visible: v2('teams.read'), keywords: 'delegation' },
    { href: '/admin/people/held', label: 'Held publications', icon: HandHelping, visible: v2('content.schedule'), keywords: 'authority adopt handover' },
  ] },
  { id: 'brands', label: 'Brands', icon: Tag, items: [
    settings('workspace', 'branding', 'Brands', Tag),
    settings('publishing', 'brand-rules'),
    settings('automation', 'voice'),
  ] },
  { id: 'publishing', label: 'Publishing', icon: Workflow, items: [
    { href: '/admin/publishing', label: 'Deliveries', icon: Workflow, visible: v2('content.read'), keywords: 'failed retry unknown cancel reschedule pause queue' },
    settings('publishing', 'defaults'),
    settings('publishing', 'slots'),
    settings('publishing', 'safety'),
    settings('publishing', 'links'),
  ] },
  { id: 'approvals', label: 'Approvals', icon: CheckCheck, items: [
    { href: '/admin/approvals', label: 'Backlog', icon: CheckCheck, visible: v2('content.read'), keywords: 'review pending decide' },
    settings('publishing', 'approvals'),
  ] },
  { id: 'collaboration', label: 'Collaboration', icon: MessagesSquare, items: [
    { href: '/admin/collaboration', label: 'Overview', icon: MessagesSquare, visible: v2('content.read'), keywords: 'tasks overdue deadlines backlog discussions' },
    { href: '/admin/collaboration/reassign', label: 'Reassign work', icon: UserRoundCog, visible: v2('members.manage'), keywords: 'offboarding leaver tasks reviews handover' },
    { href: '/admin/collaboration/notifications', label: 'Notification delivery', icon: BellRing, visible: v2('workspace.manage'), keywords: 'email failed smtp digest diagnose' },
    { href: '/admin/collaboration/settings', label: 'Collaboration settings', icon: SlidersHorizontal, visible: v2('workspace.manage'), keywords: 'client comments reminders presence defaults reviewers permissions' },
  ] },
  // V3.5 (stream F): one area for inbox, integrations, listening, AI and automation — counts and states only.
  { id: 'inbox', label: 'Inbox, listening and AI', icon: MessagesSquare, items: [
    { href: '/admin/care', label: 'Overview', icon: LayoutDashboard, visible: v1('diagnostics.read'), keywords: 'v3.5 care inbox listening ai automation health summary' },
    { href: '/admin/inbox', label: 'Inbox health', icon: HeartPulse, visible: v1('diagnostics.read'), keywords: 'backlog replies failed unknown sla breaches channels webhooks' },
    { href: '/admin/integrations', label: 'Integrations and sync', icon: Cable, visible: v1('diagnostics.read'), keywords: 'connector health sync lag jobs webhooks slack translation asana monday hubspot mailchimp' },
    { href: '/admin/listening', label: 'Listening coverage', icon: Radar, visible: v2('workspace.read'), keywords: 'sources coverage ingestion failures alerts mentions' },
    { href: '/admin/ai', label: 'AI and automation', icon: Sparkles, visible: v1('diagnostics.read'), keywords: 'ai usage budget tokens runs automation policies rules emergency stop' },
    settings('inbox', 'channels', 'Inbox channels'),
    settings('inbox', 'service-levels'),
    settings('listening', 'sources', 'Listening sources'),
  ] },
  { id: 'content', label: 'Content and media', icon: FileStack, items: [
    { href: '/admin/content', label: 'Jobs and storage', icon: FileStack, visible: v2('content.read'), keywords: 'imports exports writeback media trash storage' },
  ] },
  { id: 'connections', label: 'Connections', icon: Plug, items: [
    { href: '/admin/connections', label: 'Social accounts', icon: Plug, visible: v2('connections.read'), keywords: 'reconnect token expiry health' },
    { href: '/admin/connections/diagnostics', label: 'Diagnostics', icon: Stethoscope, visible: flagged('v31.integration_diagnostics', v2('connections.read')), keywords: 'test centre checks' },
    settings('connections', 'google'),
    settings('connections', 'notion'),
  ] },
  { id: 'analytics', label: 'Analytics', icon: ChartColumn, items: [
    { href: '/admin/analytics', label: 'Ingestion', icon: ChartColumn, visible: v2('analytics.read'), keywords: 'sync freshness coverage backfill reports metrics' },
  ] },
  { id: 'automations', label: 'Automations', icon: Cog, items: [
    settings('automation', 'inbound'),
  ] },
  { id: 'developer', label: 'Developer tools', icon: KeyRound, items: [
    settings('developer', 'service-accounts'),
    settings('developer', 'mcp'),
    { href: '/admin/developer/webhooks', label: 'Webhooks', icon: Webhook, visible: v2('workspace.manage'), keywords: 'inbound receipts outbound' },
  ] },
  { id: 'security', label: 'Security and audit', icon: ShieldCheck, items: [
    { href: '/admin/security/audit', label: 'Audit log', icon: ScrollText, visible: v1('workspace.settings'), keywords: 'activity events export' },
    { href: '/admin/security/support', label: 'Support access', icon: LifeBuoy, visible: v2('members.read'), keywords: 'operator support grant' },
    { href: '/admin/security/reports', label: 'Problem reports', icon: MessageSquareWarning, visible: v2('audit.read'), keywords: 'report a problem bug feedback' },
    settings('people', 'security-policy'),
  ] },
  { id: 'operations', label: 'Operations', icon: Activity, items: [
    { href: '/admin/operations', label: 'Queues and workers', icon: Activity, visible: v1('diagnostics.read'), keywords: 'workload dead letter outbox dispatch pause' },
    { href: '/admin/usage', label: 'Usage and limits', icon: Gauge, visible: v1('workspace.settings'), keywords: 'budgets caps billing seats storage' },
    settings('workspace', 'billing'),
    settings('operations', 'features', 'Feature flags', ToggleRight),
    settings('operations', 'export'),
  ] },
  { id: 'settings', label: 'Settings', icon: Cog, items: [
    settings('workspace', 'general'),
    settings('workspace', 'timezone'),
    settings('workspace', 'drafts'),
    settings('personal', 'profile'),
    settings('personal', 'appearance'),
    settings('personal', 'notifications'),
    { href: '/admin/setup', label: 'Instance setup', icon: Wrench, visible: v1('setup.manage'), keywords: 'keys providers oidc smtp storage' },
  ] },
  { id: 'help', label: 'Help', icon: BookOpen, items: [
    { href: '/admin/help', label: 'Admin guide', icon: BookOpen, keywords: 'help docs how' },
  ] },
];

const operator = (p: AdminPerms) => p.platform === 'operator';
const anyStaff = (p: AdminPerms) => !!p.platform;
// V4: support access reaches customer content (never billing staff); billing records never reach support staff.
const supportStaff = (p: AdminPerms) => p.platform === 'operator' || p.platform === 'support';
const billingStaff = (p: AdminPerms) => p.platform === 'operator' || p.platform === 'billing';

export const PLATFORM_NAV: AdminNavGroup[] = [
  { id: 'p-overview', label: 'Directory', icon: ServerCog, items: [
    { href: '/admin/platform', label: 'Health', icon: HeartPulse, visible: anyStaff, keywords: 'workers queues circuits dispatch' },
    { href: '/admin/platform/workspaces', label: 'Workspaces', icon: Building2, visible: anyStaff, also: ['/admin/platform/workspaces/'], keywords: 'suspend tenants lifecycle' },
    { href: '/admin/platform/accounts', label: 'Accounts', icon: UserCog, visible: anyStaff, keywords: 'users suspend sign-in' },
  ] },
  // V4 Relay support (SUP): the staff inbox for customer ↔ Relay conversations (never the social inbox).
  { id: 'p-support', label: 'Support', icon: LifeBuoy, items: [
    { href: '/admin/platform/support', label: 'Support inbox', icon: Inbox, visible: supportStaff, also: ['/admin/platform/support/RLY-'], keywords: 'tickets requests customers help queue reply' },
    { href: '/admin/platform/support/saved-replies', label: 'Saved replies', icon: MessageSquareText, visible: supportStaff, keywords: 'templates canned answers knowledge' },
  ] },
  { id: 'p-billing', label: 'Billing', icon: CreditCard, items: [
    { href: '/admin/platform/billing', label: 'Subscriptions', icon: CreditCard, visible: billingStaff, keywords: 'billing trials past due payment failed invoices stripe' },
    { href: '/admin/platform/plans', label: 'Plans', icon: Layers, visible: anyStaff, keywords: 'catalogue prices versions standard professional legacy' },
  ] },
  { id: 'p-ops', label: 'Operations', icon: Activity, items: [
    { href: '/admin/platform/rollouts', label: 'Rollouts', icon: Flag, visible: anyStaff, keywords: 'feature flags kill switch percent' },
    { href: '/admin/platform/integrations', label: 'Integrations', icon: ListChecks, visible: anyStaff, keywords: 'providers apps configured matrix' },
    { href: '/admin/platform/collaboration', label: 'Collaboration pipeline', icon: MessagesSquare, visible: anyStaff, keywords: 'notifications email reminders outbox' },
    { href: '/admin/platform/care', label: 'Inbox and AI pipeline', icon: HeartPulse, visible: anyStaff, keywords: 'inbox replies sync listening ai automation counts' },
  ] },
  { id: 'p-security', label: 'Security', icon: ShieldCheck, items: [
    { href: '/admin/platform/support/access', label: 'Support access', icon: KeyRound, visible: supportStaff, keywords: 'request time-boxed' },
    { href: '/admin/platform/audit', label: 'Platform audit', icon: ScrollText, visible: anyStaff },
    { href: '/admin/platform/operators', label: 'Operators', icon: BadgeCheck, visible: operator, keywords: 'staff roles' },
  ] },
];

export function visibleNav(groups: AdminNavGroup[], p: AdminPerms): AdminNavGroup[] {
  return groups.map((g) => ({ ...g, items: g.items.filter((i) => !i.visible || i.visible(p)) })).filter((g) => g.items.length);
}

export function isActiveItem(pathname: string, item: AdminNavItem): boolean {
  if (item.href === '/admin' || item.href === '/admin/platform' || item.href === '/admin/collaboration') return pathname === item.href;
  if (pathname === item.href || pathname.startsWith(`${item.href}/`)) return true;
  return (item.also ?? []).some((a) => pathname.startsWith(a));
}

/** Best match (longest href) so nested pages light the right item. */
export function activeItem(groups: AdminNavGroup[], pathname: string): { group: AdminNavGroup; item: AdminNavItem } | null {
  let best: { group: AdminNavGroup; item: AdminNavItem } | null = null;
  for (const g of groups) for (const i of g.items) {
    if (isActiveItem(pathname, i) && (!best || i.href.length > best.item.href.length)) best = { group: g, item: i };
  }
  return best;
}
