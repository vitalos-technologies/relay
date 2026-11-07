'use client';
// Shared bits for the Team area (stream B): labels, grant chips, section nav, types.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Clock, Users } from 'lucide-react';
import type { Permission } from '@social-lite/core';
import { useSession } from '@/lib/client/session';
import { Badge, Tooltip, cn } from '@/components/ui';

export const V2_ROLE_LABEL: Record<string, string> = {
  owner: 'Owner', admin: 'Admin', team_manager: 'Team manager', brand_manager: 'Brand manager', editor: 'Editor', approver: 'Approver',
  publisher: 'Publisher', analyst: 'Analyst', viewer: 'Viewer', exporter: 'Exporter', guest: 'Guest', integration: 'Integration',
};
export const ROLE_HINT: Record<string, string> = {
  admin: 'Users, teams, brands, accounts', brand_manager: 'Everything on a brand', editor: 'Draft, upload, submit', approver: 'Approve; no publishing',
  publisher: 'Schedule and publish', analyst: 'Read + analytics', viewer: 'Read only', exporter: 'Exports only', guest: 'Shared reviews only (expires)',
};
/** Roles offered in grant pickers (owner moves only by transfer; team manager via a team). */
export const GRANT_ROLES = ['brand_manager', 'publisher', 'editor', 'approver', 'analyst', 'viewer', 'exporter', 'admin', 'guest'] as const;
export const TEAM_ROLES = ['brand_manager', 'publisher', 'editor', 'approver', 'analyst', 'viewer', 'exporter'] as const;

export interface GrantView {
  id: string; role: string; scope_type: 'workspace' | 'brand' | 'connection'; brand_id: string | null; brand_name: string | null;
  connection_id: string | null; connection_name: string | null; expires_at: string | null; via: 'direct' | 'team'; team_id: string | null;
  team_name: string | null; source: string; granted_by_email: string | null; created_at: string; expired: boolean;
}
export interface MemberView {
  user_id: string; email: string; name: string | null; role: string; brand_ids: string[] | null; joined_at: string;
  status: 'active' | 'suspended'; status_reason: string | null; suspended_at: string | null; last_sign_in_at: string | null;
  is_owner: boolean; is_guest: boolean; access_expires_at: string | null; grants: GrantView[]; teams: Array<{ id: string; name: string; is_manager: boolean }>; restrictions: number;
}
export interface InvitationView {
  id: string; email: string; role: string; expires_at: string; created_at: string; invited_by_email: string | null; status: 'pending' | 'expired';
  kind: 'member' | 'guest'; access_expires_at: string | null; resent_count: number; last_sent_at: string | null;
  grants: Array<{ role: string; brand_id: string | null; brand_name: string | null; connection_name: string | null }>; teams: Array<{ id: string; name: string }>;
  accept_url?: string; email_sent?: boolean;
}

export interface TeamView {
  id: string; name: string; description: string | null; member_count: number; managers: Array<{ user_id: string; email: string; name: string | null }>;
  grants: Array<{ id: string; role: string; scope_type: string; brand_id: string | null; brand_name: string | null; connection_name: string | null }>;
  publishing: boolean; delegation: { grantable_roles: string[]; brand_ids: string[] } | null; can_manage_members: boolean; can_edit: boolean; archived_at: string | null;
}

const scopeName = (g: Pick<GrantView, 'scope_type' | 'brand_name' | 'connection_name'>) =>
  g.scope_type === 'workspace' ? 'All brands' : g.scope_type === 'connection' ? `${g.brand_name ?? 'Brand'} · ${g.connection_name ?? 'account'}` : g.brand_name ?? 'Brand';

const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

export function GrantChip({ g, className }: { g: Pick<GrantView, 'role' | 'scope_type' | 'brand_name' | 'connection_name' | 'expires_at' | 'via' | 'team_name' | 'expired'>; className?: string }) {
  const tone = g.expired ? 'neutral' : g.role === 'owner' || g.role === 'admin' ? 'accent' : g.role === 'guest' ? 'warn' : 'info';
  const tip = [g.via === 'team' ? `Via team ${g.team_name}` : 'Direct', g.expires_at ? `Expires ${new Date(g.expires_at).toLocaleString()}` : null].filter(Boolean).join(' · ');
  return (
    <Tooltip content={tip}>
      <span className={cn('inline-flex', className)}>
        <Badge tone={tone as 'info' | 'warn' | 'accent' | 'neutral'} className={g.expired ? 'line-through opacity-60' : undefined}
          icon={g.via === 'team' ? <Users aria-hidden className="size-3" /> : g.expires_at ? <Clock aria-hidden className="size-3" /> : undefined}>
          {V2_ROLE_LABEL[g.role] ?? g.role} · {scopeName(g)}{g.expires_at ? ` · ${shortDate(g.expires_at)}` : ''}
        </Badge>
      </span>
    </Tooltip>
  );
}

const SECTIONS: Array<{ href: string; label: string; perm?: Permission }> = [
  { href: '/team', label: 'Members', perm: 'members.read' },
  { href: '/team/invitations', label: 'Invitations', perm: 'members.invite' },
  { href: '/team/teams', label: 'Teams', perm: 'teams.read' },
  { href: '/team/held', label: 'Held posts', perm: 'content.read' },
];

export function TeamNav() {
  const pathname = usePathname();
  const { canV2 } = useSession();
  const items = SECTIONS.filter((s) => !s.perm || canV2(s.perm));
  return (
    <nav aria-label="Team sections" className="-mt-4 mb-6 flex gap-1 overflow-x-auto border-b border-border">
      {items.map((s) => {
        const active = s.href === '/team' ? pathname === '/team' || pathname.startsWith('/team/members') : pathname.startsWith(s.href);
        return (
          <Link key={s.href} href={s.href} aria-current={active ? 'page' : undefined}
            className={cn('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium', active ? 'border-fg text-fg' : 'border-transparent text-muted hover:text-fg')}>
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function StatusBadge({ status }: { status: string }) {
  if (status === 'active') return <Badge tone="success">Active</Badge>;
  if (status === 'suspended') return <Badge tone="warn">Suspended</Badge>;
  if (status === 'expired') return <Badge tone="neutral">Expired</Badge>;
  return <Badge>{status}</Badge>;
}

export function initials(m: { name: string | null; email: string }) {
  const s = (m.name || m.email).trim();
  const parts = s.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

export function Avatar({ m }: { m: { name: string | null; email: string } }) {
  return <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sunken text-[11px] font-semibold text-muted">{initials(m)}</span>;
}
