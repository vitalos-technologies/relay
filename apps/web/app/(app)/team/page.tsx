'use client';
// Members directory (V2): search + filters, status, scoped grants with source/expiry, teams, last sign-in.
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ChevronRight, Search, ShieldAlert, UserPlus } from 'lucide-react';
import { useSession } from '@/lib/client/session';
import { useApi } from '@/lib/client/use-api';
import { useQueryState } from '@/lib/client/hooks';
import { fmtRelative } from '@/lib/client/format';
import { api } from '@/lib/client/api';
import {
  Badge, Banner, Button, Card, EmptyState, ErrorState, Input, LinkButton, PageHeader, Select, SkeletonRows, Table, Td, Th, THead, Tooltip, Tr, useToast,
} from '@/components/ui';
import { Avatar, GrantChip, StatusBadge, TeamNav, V2_ROLE_LABEL, type MemberView, useTeamHref } from '@/components/team/shared';

export default function MembersPage() {
  const th = useTeamHref();
  const { canV2, session, refresh } = useSession();
  const toast = useToast();
  const [params, setParams] = useQueryState();
  const [q, setQ] = useState(params.get('q') ?? '');
  const status = params.get('status') ?? '';
  const role = params.get('role') ?? '';
  const team = params.get('team') ?? '';
  const path = canV2('members.read') ? `/api/members?${new URLSearchParams(Object.entries({ q: params.get('q') ?? '', status, role, team_id: team }).filter(([, v]) => v)).toString()}` : null;
  const { data, error, loading, refetch } = useApi<{ members: MemberView[]; policy_version: number }>(path, { keepPrevious: true });
  const teams = useApi<{ items: Array<{ id: string; name: string }> }>(canV2('teams.read') ? '/api/teams' : null);
  const transfer = session.v2?.pending_ownership_transfer;
  const [accepting, setAccepting] = useState(false);

  const counts = useMemo(() => ({
    active: data?.members.filter((m) => m.status === 'active').length ?? 0,
    suspended: data?.members.filter((m) => m.status === 'suspended').length ?? 0,
  }), [data]);

  const acceptTransfer = async () => {
    if (!transfer) return;
    setAccepting(true);
    try {
      await api.post(`/api/workspace/ownership-transfers/${transfer.id}/accept`, {});
      toast.success('You are now the owner');
      await refresh();
    } catch (e) {
      toast.error(e, 'Could not accept');
    } finally {
      setAccepting(false);
    }
  };

  if (!canV2('members.read')) {
    return (<><PageHeader title="Team" /><EmptyState icon={<ShieldAlert aria-hidden />} title="No access" /></>);
  }
  return (
    <>
      <PageHeader title="Team"
        actions={canV2('members.invite') ? <LinkButton href={th("/team/invitations?new=1")} variant="primary" icon={<UserPlus aria-hidden className="size-4" />}>Invite</LinkButton> : null} />
      <TeamNav />
      {transfer ? (
        <Banner tone="warn" className="mb-6" title={`${transfer.from_email} wants you to become the owner`}
          actions={<Button size="sm" variant="primary" loading={accepting} onClick={() => void acceptTransfer()}>Accept ownership</Button>} />
      ) : null}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form className="relative min-w-[200px] flex-1" onSubmit={(e) => { e.preventDefault(); setParams({ q: q.trim() || null }); }}>
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
          <Input aria-label="Search members" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
        </form>
        <Select aria-label="Status" value={status} onChange={(e) => setParams({ status: e.target.value || null })} className="w-auto">
          <option value="">All statuses</option><option value="active">Active</option><option value="suspended">Suspended</option>
        </Select>
        <Select aria-label="Role" value={role} onChange={(e) => setParams({ role: e.target.value || null })} className="w-auto">
          <option value="">All roles</option>
          {Object.entries(V2_ROLE_LABEL).filter(([k]) => k !== 'integration').map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        {teams.data?.items.length ? (
          <Select aria-label="Team" value={team} onChange={(e) => setParams({ team: e.target.value || null })} className="w-auto">
            <option value="">All teams</option>
            {teams.data.items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        ) : null}
      </div>
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <SkeletonRows rows={5} /> : !data.members.length ? (
        <EmptyState title="No members match" />
      ) : (
        <Card>
          <div className="flex gap-3 px-4 pt-3 text-[12px] text-muted"><span>{counts.active} active</span>{counts.suspended ? <span>{counts.suspended} suspended</span> : null}</div>
          <div className="hidden md:block">
            <Table caption="Members" className="rounded-none border-0">
              <THead><tr><Th>Person</Th><Th>Access</Th><Th>Teams</Th><Th>Status</Th><Th>Last sign-in</Th><Th className="sr-only">Open</Th></tr></THead>
              <tbody>
                {data.members.map((m) => (
                  <Tr key={m.user_id}>
                    <Td>
                      <Link href={th(`/team/members/${m.user_id}`)} className="flex items-center gap-3 hover:underline">
                        <Avatar m={m} />
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{m.name || m.email}{m.user_id === session.user.id ? <span className="text-muted"> (you)</span> : null}</span>
                          {m.name ? <span className="block truncate text-[12px] text-muted">{m.email}</span> : null}
                        </span>
                      </Link>
                    </Td>
                    <Td><div className="flex max-w-[420px] flex-wrap gap-1">{m.grants.length ? m.grants.slice(0, 4).map((g) => <GrantChip key={`${g.id}-${g.via}`} g={g} />) : <span className="text-muted">None</span>}
                      {m.grants.length > 4 ? <Badge>+{m.grants.length - 4}</Badge> : null}{m.restrictions ? <Tooltip content="Explicit restrictions"><span><Badge tone="danger">{m.restrictions} deny</Badge></span></Tooltip> : null}</div></Td>
                    <Td><span className="text-[13px] text-muted">{m.teams.map((t) => t.name + (t.is_manager ? ' ★' : '')).join(', ') || '—'}</span></Td>
                    <Td><StatusBadge status={m.status} /></Td>
                    <Td><span className="text-[13px] text-muted">{m.last_sign_in_at ? fmtRelative(m.last_sign_in_at) : 'Never'}</span></Td>
                    <Td><Link href={th(`/team/members/${m.user_id}`)} aria-label={`Open ${m.email}`} className="text-muted hover:text-fg"><ChevronRight aria-hidden className="size-4" /></Link></Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
          <ul className="divide-y divide-border md:hidden">
            {data.members.map((m) => (
              <li key={m.user_id}>
                <Link href={th(`/team/members/${m.user_id}`)} className="flex items-start gap-3 px-4 py-3">
                  <Avatar m={m} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2"><span className="truncate font-medium">{m.name || m.email}</span><StatusBadge status={m.status} /></span>
                    <span className="mt-1 flex flex-wrap gap-1">{m.grants.slice(0, 3).map((g) => <GrantChip key={`${g.id}-${g.via}`} g={g} />)}</span>
                  </span>
                  <ChevronRight aria-hidden className="mt-2 size-4 text-muted" />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
