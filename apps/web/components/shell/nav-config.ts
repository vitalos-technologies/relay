// Main app navigation model (pure; no React state). D28: grouped nav; D29: role-based phone bottom bar.
// The server re-checks every request; this only decides what is shown.
import {
  Activity, CalendarDays, PanelsTopLeft, ChartColumn, CheckCheck, Flag, FolderOpen, LayoutDashboard, Plug, Settings, ShieldCheck, SquarePen, Users, Wrench,
  type LucideIcon, ListTodo, Inbox, Radar, Sparkles, LifeBuoy } from 'lucide-react';
import type { Action, Permission } from '@social-lite/core';

export interface NavItem {
  href: string; label: string; icon: LucideIcon; perm?: Action; badge?: 'approvals';
  /** V2: shown if any held */ v2?: Permission[];
  /** Extra path prefixes that mark this item active. */ also?: string[];
}
export interface NavGroup { id: string; label: string; items: NavItem[] }

// D28: the main nav is grouped. Items the user can't access are hidden, and so is a group left empty.
export const NAV_GROUPS: NavGroup[] = [
  { id: 'publish', label: 'Publish', items: [
    { href: '/overview', label: 'Overview', icon: LayoutDashboard }, // V5 (D23): app home moved from `/`
    { href: '/planner', label: 'Planner', icon: CalendarDays, also: ['/history'] },
    { href: '/compose', label: 'Create', icon: SquarePen, perm: 'drafts.edit', also: ['/posts/'] },
    { href: '/library', label: 'Content library', icon: FolderOpen },
    { href: '/campaigns', label: 'Campaigns', icon: Flag },
    { href: '/approvals', label: 'Approvals', icon: CheckCheck, badge: 'approvals' },
  ] },
  { id: 'engage', label: 'Engage', items: [
    // V3.5: customer conversations (shown only with inbox access on some brand).
    { href: '/inbox', label: 'Inbox', icon: Inbox, v2: ['inbox.read'] },
    // V3.5 stream D: listening (connected-source monitoring), shown with listening.read on some brand.
    { href: '/listening', label: 'Listening', icon: Radar, v2: ['listening.read'] },
    // V3.5 stream E: AI assistant (+ automation under it), shown with ai.use or automation.manage.
    { href: '/assistant', label: 'Assistant', icon: Sparkles, v2: ['ai.use', 'automation.manage'], also: ['/automation'] },
  ] },
  { id: 'insights', label: 'Insights', items: [
    { href: '/analytics', label: 'Analytics', icon: ChartColumn, perm: 'history.read' },
  ] },
  { id: 'workspace', label: 'Workspace', items: [
    { href: '/tasks', label: 'Tasks', icon: ListTodo },
    { href: '/team', label: 'Team', icon: Users, v2: ['members.read', 'teams.read'] },
    // D28: one item for social accounts (/accounts) and business apps (/integrations, integrations.read); the page shows
    // both as tabs (components/shell/connections-tabs.tsx).
    { href: '/accounts', label: 'Connections', icon: Plug, also: ['/integrations'] },
    { href: '/settings', label: 'Settings', icon: Settings, also: ['/security', '/mcp/settings'] },
    // V4: Relay support (Help → Contact support / My requests). Every member; never gated by billing restrictions.
    { href: '/help', label: 'Help', icon: LifeBuoy },
  ] },
];
export const NAV: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

// D29: the phone bottom bar depends on what the person does. Publishers/approvers: Overview · Planner · Create ·
// Approvals; inbox readers without approval rights: Inbox in place of Approvals; inbox readers who can't publish
// (e.g. care agents): Overview · Inbox. Everything else is under More.
const PUBLISHING: Permission[] = ['content.create', 'content.edit', 'content.submit', 'content.schedule', 'content.publish', 'content.approve'];
export function bottomBarHrefs(canV2: (p: Permission) => boolean): string[] {
  const inbox = canV2('inbox.read');
  if (inbox && !PUBLISHING.some((p) => canV2(p))) return ['/overview', '/inbox'];
  if (inbox && !canV2('content.approve')) return ['/overview', '/planner', '/compose', '/inbox'];
  return ['/overview', '/planner', '/compose', '/approvals'];
}

export const ADMIN_NAV: NavItem[] = [
  { href: '/admin', label: 'Admin console', icon: PanelsTopLeft, v2: ['workspace.read'] },
  { href: '/setup', label: 'Setup', icon: Wrench, perm: 'setup.manage' },
  { href: '/operations', label: 'Operations', icon: Activity, perm: 'diagnostics.read' },
  { href: '/activity', label: 'Audit log', icon: ShieldCheck, perm: 'workspace.settings' },
];

export function isActive(pathname: string, item: NavItem) {
  if (pathname === item.href || pathname.startsWith(`${item.href}/`)) return true;
  return (item.also ?? []).some((p) => (p.endsWith('/') ? pathname.startsWith(p) : pathname === p || pathname.startsWith(`${p}/`)));
}

export interface NavAccess { can: (a: Action) => boolean; canV2: (p: Permission) => boolean }

/** What one person sees: groups with only the items they can open (empty groups dropped), admin items, and the phone
 *  bottom bar split into its primary items and the grouped rest under More. */
export function navFor({ can, canV2 }: NavAccess) {
  const allowed = (n: NavItem) => (!n.perm || can(n.perm)) && (!n.v2 || n.v2.some((p) => canV2(p)));
  const groups = NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter(allowed) })).filter((g) => g.items.length > 0);
  const visible = groups.flatMap((g) => g.items);
  const admin = ADMIN_NAV.filter(allowed);
  const bottom = bottomBarHrefs(canV2).map((h) => visible.find((n) => n.href === h)).filter((n): n is NavItem => !!n);
  const more = groups.map((g) => ({ ...g, items: g.items.filter((n) => !bottom.includes(n)) })).filter((g) => g.items.length > 0);
  return { groups, admin, bottom, more };
}
