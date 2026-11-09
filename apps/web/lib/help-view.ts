// Help Centre view helpers shared by the /help pages (server only).
import 'server-only';
import { helpLibrary, sectionsFor } from '@social-lite/services/help/library';
import type { HelpAudience } from '@social-lite/services/help/schema';
import type { FrameSection } from '@/components/help/help-frame';

export function frameSections(audiences: readonly HelpAudience[]): FrameSection[] {
  return sectionsFor(helpLibrary(), audiences).filter((s) => s.articles.length > 0)
    .map((s) => ({ id: s.id, title: s.title, icon: s.icon, articles: s.articles.map((a) => ({ slug: a.slug, title: a.title, href: a.href })) }));
}

export const AUDIENCE_LABEL: Record<HelpAudience, string> = { public: 'Everyone', user: 'Members', admin: 'Workspace admins', developer: 'Developers' };
export const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner', admin: 'Admin', team_manager: 'Team manager', brand_manager: 'Brand manager', editor: 'Editor', approver: 'Approver',
  publisher: 'Publisher', analyst: 'Analyst', viewer: 'Viewer', exporter: 'Exporter', guest: 'Guest', integration: 'Integration',
  care_agent: 'Care agent', platform_staff: 'Relay staff',
};
export const fmtHelpDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
