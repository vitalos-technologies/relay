'use client';
// Settings navigation registry: groups → sub-settings, each with a real URL (/settings/<group>/<item>) or a link to the
// page that already owns it (Team, Connections, Activity, Security). `visible` hides what the user cannot use; the
// server still authorizes every request. Search only ever sees visible entries.
import type { ReactNode } from 'react';
import {
  BadgeCheck, Bell, BookText, Building2, Cable, CalendarClock, Clock, CreditCard, FileDown, Fingerprint, FolderInput, Gauge, HardDrive, HeartPulse, KeyRound, Link2, Mail, MessageSquareQuote,
  Palette, Plug, Radar, ScrollText, Inbox, Timer, MessageSquareText, ShieldCheck, ShieldHalf, Stamp, Tag, UserRound, ToggleRight, Users, UsersRound, Webhook, type LucideIcon,
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
const InboxChannelsSettings = dynamic(() => import('@/components/inbox/settings').then((m) => m.InboxChannelsSettings), { loading });
const ServiceLevelsSettings = dynamic(() => import('@/components/inbox/settings').then((m) => m.ServiceLevelsSettings), { loading });
const SavedRepliesSettings = dynamic(() => import('@/components/inbox/settings').then((m) => m.SavedRepliesSettings), { loading });
const ListeningSourcesSettings = dynamic(() => import('@/components/listening/sources-settings').then((m) => m.ListeningSourcesSettings), { loading });
const BillingSettings = dynamic(() => import('@/components/billing/billing-settings').then((m) => m.BillingSettings), { loading });
const FeatureFlagsSettings = dynamic(() => import('@/components/support/support').then((m) => m.FeatureFlagsSettings), { loading });
import {
  AppearanceSection, ApprovalPoliciesSection, BrandingSection, BrandVoiceSection, DataExportSection, ProfileSection, PublishingDefaultsSection,
  SafetyRulesSection, WorkspaceSection,
} from '@/components/settings/sections';
import { helpArticleHref } from '@/components/help/help-link';

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
  /** HC: Help Centre article for this setting, built with helpArticleHref and a literal slug (checked by docs-check). */
  help?: string;
}

export interface SettingsGroup { id: string; label: string; items: SettingsItem[] }

const G = (id: string, label: string, items: Array<Omit<SettingsItem, 'group'>>): SettingsGroup => ({ id, label, items: items.map((i) => ({ ...i, group: id })) });

export const SETTINGS: SettingsGroup[] = [
  G('personal', 'Personal', [
    { slug: 'profile', label: 'Profile', icon: UserRound, keywords: 'name email account', render: () => <ProfileSection /> },
    { slug: 'appearance', label: 'Appearance', icon: Palette, keywords: 'theme dark light mode', render: () => <AppearanceSection /> },
    { slug: 'notifications', label: 'Notifications', icon: Bell, keywords: 'email alerts digest', render: () => <NotificationPrefs />, help: helpArticleHref('notifications-and-preferences') },
    { slug: 'security', label: 'Security and sessions', icon: Fingerprint, keywords: 'two-step mfa passkey password sessions devices sign out', href: '/security', ownHeader: true },
  ]),
  G('workspace', 'Workspace', [
    { slug: 'general', label: 'General', icon: Building2, keywords: 'name workspace', render: () => <WorkspaceSection part="general" />, help: helpArticleHref('workspace-and-brand-settings') },
    { slug: 'branding', label: 'Brands', icon: Tag, keywords: 'brand create new', render: () => <BrandingSection />, help: helpArticleHref('workspace-and-brand-settings') },
    { slug: 'timezone', label: 'Time zone and locale', icon: Clock, keywords: 'timezone date format', render: () => <WorkspaceSection part="timezone" />, help: helpArticleHref('time-zones-and-dst') },
    { slug: 'billing', label: 'Plan and billing', icon: CreditCard, keywords: 'plan subscription trial invoices payment card seats upgrade downgrade cancel', render: () => <BillingSettings />, visible: (p) => p.canV2('billing.read'), help: helpArticleHref('plans-and-features') },
    { slug: 'drafts', label: 'Draft recovery', icon: HardDrive, keywords: 'autosave offline local browser unsaved recovery', render: () => <DraftRecoverySettings />, help: helpArticleHref('recover-unsaved-changes') },
  ]),
  G('people', 'People and access', [
    { slug: 'members', label: 'Members', icon: Users, keywords: 'roles access people', href: '/team', visible: (p) => p.canV2('members.read') },
    { slug: 'invitations', label: 'Invitations', icon: Mail, keywords: 'invite', href: '/team/invitations', visible: (p) => p.canV2('members.invite') },
    { slug: 'teams', label: 'Teams', icon: UsersRound, href: '/team/teams', visible: (p) => p.canV2('teams.read') },
    { slug: 'security-policy', label: 'Workspace security', icon: ShieldCheck, keywords: 'policy two-step mfa require session length', render: () => <SecurityPolicySettings />, visible: (p) => p.canV2('security.manage'), help: helpArticleHref('workspace-security-policy') },
  ]),
  G('publishing', 'Publishing', [
    { slug: 'defaults', label: 'Defaults', icon: Stamp, keywords: 'editors can publish deadline pause brand', render: () => <PublishingDefaultsSection /> },
    { slug: 'approvals', label: 'Approval policies', icon: ShieldHalf, keywords: 'review approval stages', render: () => <ApprovalPoliciesSection />, help: helpArticleHref('approval-policies-and-stages') },
    { slug: 'slots', label: 'Posting slots', icon: CalendarClock, keywords: 'queue times', render: () => <SlotsSettings />, help: helpArticleHref('posting-slots-and-queue') },
    { slug: 'safety', label: 'Safety rules', icon: ShieldCheck, keywords: 'duplicate check collision', render: () => <SafetyRulesSection /> },
    { slug: 'brand-rules', label: 'Brand rules', icon: BadgeCheck, keywords: 'prohibited phrases footer disclaimer links logos colours review mandatory advisory licence expiry', render: () => <BrandRulesSettings />, flag: 'v31.brand_rules', help: helpArticleHref('brand-rules') },
    { slug: 'links', label: 'Campaign links', icon: Link2, keywords: 'utm tracking short links parameters source medium', render: () => <UtmDefaultsSettings />, flag: 'v31.tracked_links', help: helpArticleHref('campaign-links-and-utm') },
  ]),
  G('connections', 'Connections', [
    { slug: 'social', label: 'Social accounts', icon: Plug, keywords: 'connect instagram facebook x telegram tiktok youtube linkedin threads pinterest bluesky', href: '/accounts' },
    { slug: 'google', label: 'Google Drive and Docs', icon: FolderInput, keywords: 'drive docs import sources export', render: () => <SourceConnectionsSettings source="google" />, visible: (p) => p.canV2('connections.read'), help: helpArticleHref('google-drive-and-docs') },
    { slug: 'notion', label: 'Notion', icon: BookText, keywords: 'notion pages databases import sources writeback', render: () => <SourceConnectionsSettings source="notion" />, visible: (p) => p.canV2('connections.read'), help: helpArticleHref('notion') },
    { slug: 'health', label: 'Connection health', icon: HeartPulse, keywords: 'reconnect permissions expiring', href: '/accounts/health' },
    { slug: 'business', label: 'Business apps', icon: Cable, keywords: 'integrations asana monday hubspot google business profile translation slack mailchimp crm tasks', href: '/integrations', visible: (p) => p.canV2('integrations.read') },
  ]),
  G('inbox', 'Inbox', [
    { slug: 'channels', label: 'Channels', icon: Inbox, keywords: 'inbox messages comments messenger facebook page reply permissions capabilities', render: () => <InboxChannelsSettings />, visible: (p) => p.canV2('inbox.read'), help: helpArticleHref('inbox-channels-by-network') },
    { slug: 'service-levels', label: 'Service levels', icon: Timer, keywords: 'sla first response resolution business hours holidays cases', render: () => <ServiceLevelsSettings />, visible: (p) => p.canV2('inbox.read'), help: helpArticleHref('cases-and-service-levels') },
    { slug: 'saved-replies', label: 'Saved replies', icon: MessageSquareText, keywords: 'canned templates responses', render: () => <SavedRepliesSettings />, visible: (p) => p.canV2('inbox.read'), help: helpArticleHref('saved-replies-and-views') },
  ]),
  G('listening', 'Listening', [
    { slug: 'sources', label: 'Sources', icon: Radar, keywords: 'listening coverage monitoring mentions sources licensed providers awaiting activation', render: () => <ListeningSourcesSettings />, visible: (p) => p.canV2('listening.read'), help: helpArticleHref('set-up-listening') },
  ]),
  G('automation', 'AI and automation', [
    { slug: 'voice', label: 'Brand voice', icon: MessageSquareQuote, keywords: 'tone terms hashtags footer cta', render: () => <BrandVoiceSection />, help: helpArticleHref('approved-knowledge-and-brand-voice') },
    { slug: 'inbound', label: 'Inbound sources', icon: Webhook, keywords: 'tipsignal integrations webhook', render: () => <IntegrationsSettings />, visible: (p) => p.can('setup.manage'), help: helpArticleHref('inbound-sources') },
  ]),
  G('developer', 'Developer', [
    { slug: 'mcp', label: 'MCP', icon: Cable, keywords: 'model context protocol clients ai agents', render: () => <McpDeveloperSettings />, help: helpArticleHref('mcp-server') },
    { slug: 'service-accounts', label: 'API and service accounts', icon: KeyRound, keywords: 'api keys bots', render: () => <ServiceAccountsSettings />, visible: (p) => p.canV2('service_accounts.manage'), help: helpArticleHref('service-accounts-and-api-keys') },
  ]),
  G('operations', 'Operations', [
    { slug: 'audit', label: 'Audit log', icon: ScrollText, keywords: 'activity events', href: '/activity', visible: (p) => p.can('workspace.settings') },
    { slug: 'usage', label: 'Usage and limits', icon: Gauge, keywords: 'budgets meters caps exports', render: () => <BudgetsSettings />, visible: (p) => p.can('workspace.settings'), help: helpArticleHref('usage-and-limits') },
    { slug: 'features', label: 'Feature flags', icon: ToggleRight, keywords: 'beta rollout enable features flags', render: () => <FeatureFlagsSettings />, visible: (p) => p.can('workspace.settings'), help: helpArticleHref('feature-flags') },
    { slug: 'export', label: 'Data export', icon: FileDown, keywords: 'handover zip json download', render: () => <DataExportSection />, help: helpArticleHref('export-workspace-data') },
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
