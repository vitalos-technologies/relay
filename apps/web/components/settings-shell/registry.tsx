'use client';
// Settings navigation registry: groups → sub-settings, each with a real URL (/settings/<group>/<item>) or a link to the
// page that already owns it (Team, Connections, Activity, Security). `visible` hides what the user cannot use; the
// server still authorizes every request. Search only ever sees visible entries.
import type { ReactNode } from 'react';
import {
  BadgeCheck, Bell, BookText, Building2, Cable, CalendarClock, Clock, FileDown, Fingerprint, FolderInput, Gauge, HardDrive, HeartPulse, KeyRound, Link2, Mail, MessageSquareQuote,
  Palette, Plug, ScrollText, ShieldCheck, ShieldHalf, Stamp, Tag, UserRound, ToggleRight, Users, UsersRound, Webhook, type LucideIcon,
} from 'lucide-react';
import type { Action, Permission } from '@social-lite/core';
import dynamic from 'next/dynamic';
import { Skeleton } from '@/components/ui';

// V3.1 §4: each settings page loads its own code when opened (the nav + search only need this registry).
const loading = () => <Skeleton className="h-64 w-full max-w-3xl rounded-xl" />;
const NotificationPrefs = dynamic(() => import('@/components/collab/notification-prefs').then((m) => m.NotificationPrefs), { loading });
const SlotsSettings = dynamic(() => import('@/components/slots/slots-settings').then((m) => m.SlotsSettings), { loading });
const IntegrationsSettings = dynamic(() => import('@/components/integrations/integrations-settings').then((m) => m.IntegrationsSettings), { loading });
const BudgetsSettings = dynamic(() => import('@/components/integrations/budgets-settings').then((m) => m.BudgetsSettings), { loading });
const ServiceAccountsSettings = dynamic(() => import('@/components/settings/service-accounts').then((m) => m.ServiceAccountsSettings), { loading });
const SecurityPolicySettings = dynamic(() => import('@/components/settings/security-policy').then((m) => m.SecurityPolicySettings), { loading });
const SourceConnectionsSettings = dynamic(() => import('@/components/content-hub/source-connections').then((m) => m.SourceConnectionsSettings), { loading });
const McpDeveloperSettings = dynamic(() => import('@/components/mcp').then((m) => m.McpDeveloperSettings), { loading });
const DraftRecoverySettings = dynamic(() => import('@/components/settings/draft-recovery').then((m) => m.DraftRecoverySettings), { loading });
const BrandRulesSettings = dynamic(() => import('@/components/brand-rules/brand-rules-settings').then((m) => m.BrandRulesSettings), { loading });
const UtmDefaultsSettings = dynamic(() => import('@/components/links/links').then((m) => m.UtmDefaultsSettings), { loading });
const FeatureFlagsSettings = dynamic(() => import('@/components/support/support').then((m) => m.FeatureFlagsSettings), { loading });
import {
  AppearanceSection, ApprovalPoliciesSection, BrandingSection, BrandVoiceSection, DataExportSection, ProfileSection, PublishingDefaultsSection,
  SafetyRulesSection, WorkspaceSection,
} from '@/components/settings/sections';

export interface Perms { can: (a: Action) => boolean; canV2: (p: Permission) => boolean; flag?: (key: string) => boolean }

export interface SettingsItem {
  group: string;
  slug: string;
  label: string;
  icon: LucideIcon;
  /** Extra search terms. */
  keywords?: string;
  /** Lives on its own page outside /settings (opens there). */
  href?: string;
  /** Renders its own page header (e.g. /security). */
  ownHeader?: boolean;
  render?: () => ReactNode;
  visible?: (p: Perms) => boolean;
  /** Workspace feature flag that must be on (V3.1 §16; safe default off). */
  flag?: string;
}

export interface SettingsGroup { id: string; label: string; items: SettingsItem[] }

const G = (id: string, label: string, items: Array<Omit<SettingsItem, 'group'>>): SettingsGroup => ({ id, label, items: items.map((i) => ({ ...i, group: id })) });

export const SETTINGS: SettingsGroup[] = [
  G('personal', 'Personal', [
    { slug: 'profile', label: 'Profile', icon: UserRound, keywords: 'name email account', render: () => <ProfileSection /> },
    { slug: 'appearance', label: 'Appearance', icon: Palette, keywords: 'theme dark light mode', render: () => <AppearanceSection /> },
    { slug: 'notifications', label: 'Notifications', icon: Bell, keywords: 'email alerts digest', render: () => <NotificationPrefs /> },
    { slug: 'security', label: 'Security and sessions', icon: Fingerprint, keywords: 'two-step mfa passkey password sessions devices sign out', href: '/security', ownHeader: true },
  ]),
  G('workspace', 'Workspace', [
    { slug: 'general', label: 'General', icon: Building2, keywords: 'name workspace', render: () => <WorkspaceSection part="general" /> },
    { slug: 'branding', label: 'Brands', icon: Tag, keywords: 'brand create new', render: () => <BrandingSection /> },
    { slug: 'timezone', label: 'Time zone and locale', icon: Clock, keywords: 'timezone date format', render: () => <WorkspaceSection part="timezone" /> },
    { slug: 'drafts', label: 'Draft recovery', icon: HardDrive, keywords: 'autosave offline local browser unsaved recovery', render: () => <DraftRecoverySettings /> },
  ]),
  G('people', 'People and access', [
    { slug: 'members', label: 'Members', icon: Users, keywords: 'roles access people', href: '/team', visible: (p) => p.canV2('members.read') },
    { slug: 'invitations', label: 'Invitations', icon: Mail, keywords: 'invite', href: '/team/invitations', visible: (p) => p.canV2('members.invite') },
    { slug: 'teams', label: 'Teams', icon: UsersRound, href: '/team/teams', visible: (p) => p.canV2('teams.read') },
    { slug: 'security-policy', label: 'Workspace security', icon: ShieldCheck, keywords: 'policy two-step mfa require session length', render: () => <SecurityPolicySettings />, visible: (p) => p.canV2('security.manage') },
  ]),
  G('publishing', 'Publishing', [
    { slug: 'defaults', label: 'Defaults', icon: Stamp, keywords: 'editors can publish deadline pause brand', render: () => <PublishingDefaultsSection /> },
    { slug: 'approvals', label: 'Approval policies', icon: ShieldHalf, keywords: 'review approval stages', render: () => <ApprovalPoliciesSection /> },
    { slug: 'slots', label: 'Posting slots', icon: CalendarClock, keywords: 'queue times', render: () => <SlotsSettings /> },
    { slug: 'safety', label: 'Safety rules', icon: ShieldCheck, keywords: 'duplicate check collision', render: () => <SafetyRulesSection /> },
    { slug: 'brand-rules', label: 'Brand rules', icon: BadgeCheck, keywords: 'prohibited phrases footer disclaimer links logos colours review mandatory advisory licence expiry', render: () => <BrandRulesSettings />, flag: 'v31.brand_rules' },
    { slug: 'links', label: 'Campaign links', icon: Link2, keywords: 'utm tracking short links parameters source medium', render: () => <UtmDefaultsSettings />, flag: 'v31.tracked_links' },
  ]),
  G('connections', 'Connections', [
    { slug: 'social', label: 'Social accounts', icon: Plug, keywords: 'connect instagram facebook x telegram tiktok youtube linkedin threads pinterest bluesky', href: '/accounts' },
    { slug: 'google', label: 'Google Drive and Docs', icon: FolderInput, keywords: 'drive docs import sources export', render: () => <SourceConnectionsSettings source="google" />, visible: (p) => p.canV2('connections.read') },
    { slug: 'notion', label: 'Notion', icon: BookText, keywords: 'notion pages databases import sources writeback', render: () => <SourceConnectionsSettings source="notion" />, visible: (p) => p.canV2('connections.read') },
    { slug: 'health', label: 'Connection health', icon: HeartPulse, keywords: 'reconnect permissions expiring', href: '/accounts/health' },
  ]),
  G('automation', 'AI and automation', [
    { slug: 'voice', label: 'Brand voice', icon: MessageSquareQuote, keywords: 'tone terms hashtags footer cta', render: () => <BrandVoiceSection /> },
    { slug: 'inbound', label: 'Inbound sources', icon: Webhook, keywords: 'tipsignal integrations webhook', render: () => <IntegrationsSettings />, visible: (p) => p.can('setup.manage') },
  ]),
  G('developer', 'Developer', [
    { slug: 'mcp', label: 'MCP', icon: Cable, keywords: 'model context protocol clients ai agents', render: () => <McpDeveloperSettings /> },
    { slug: 'service-accounts', label: 'API and service accounts', icon: KeyRound, keywords: 'api keys bots', render: () => <ServiceAccountsSettings />, visible: (p) => p.canV2('service_accounts.manage') },
  ]),
  G('operations', 'Operations', [
    { slug: 'audit', label: 'Audit log', icon: ScrollText, keywords: 'activity events', href: '/activity', visible: (p) => p.can('workspace.settings') },
    { slug: 'usage', label: 'Usage and limits', icon: Gauge, keywords: 'budgets meters caps exports', render: () => <BudgetsSettings />, visible: (p) => p.can('workspace.settings') },
    { slug: 'features', label: 'Feature flags', icon: ToggleRight, keywords: 'beta rollout enable features flags', render: () => <FeatureFlagsSettings />, visible: (p) => p.can('workspace.settings') },
    { slug: 'export', label: 'Data export', icon: FileDown, keywords: 'handover zip json download', render: () => <DataExportSection /> },
  ]),
];

export const itemHref = (i: SettingsItem) => i.href ?? `/settings/${i.group}/${i.slug}`;

export function visibleSettings(p: Perms): SettingsGroup[] {
  return SETTINGS.map((g) => ({ ...g, items: g.items.filter((i) => itemAllowed(i, p)) })).filter((g) => g.items.length);
}

export function itemAllowed(i: SettingsItem, p: Perms): boolean {
  return (!i.visible || i.visible(p)) && (!i.flag || !!p.flag?.(i.flag));
}

export function findItem(group: string, slug: string): SettingsItem | undefined {
  return SETTINGS.find((g) => g.id === group)?.items.find((i) => i.slug === slug);
}

export { LEGACY_TABS } from './legacy';
