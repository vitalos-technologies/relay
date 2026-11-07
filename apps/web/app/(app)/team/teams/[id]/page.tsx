'use client';
// Team detail: members (add/remove, managers), team grants (add/revoke) and the managers' delegation
// ceiling. Team managers see "Add" only when the team's access fits their ceiling; the server decides.
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Archive, ArrowLeft, Plus, Star, Trash2, UserPlus } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { useApi } from '@/lib/client/use-api';
import {
  Badge, Banner, Button, Card, CardHeader, Checkbox, ConfirmDialog, Dialog, ErrorNotice, ErrorState, Field, IconButton, PageHeader, Select, SkeletonRows, Tooltip, useToast,
} from '@/components/ui';
import { Avatar, StatusBadge, TEAM_ROLES, TeamNav, V2_ROLE_LABEL, type TeamView, useTeamHref } from '@/components/team/shared';

interface TeamDetail extends TeamView { members: Array<{ user_id: string; email: string; name: string | null; is_manager: boolean; status: string }> }

export default function TeamPage() {
  const th = useTeamHref();
  const { id } = useParams<{ id: string }>();
  const { session } = useSession();
  const toast = useToast();
  const { data, error, refetch, setData } = useApi<TeamDetail>(`/api/teams/${id}`);
  const [adding, setAdding] = useState(false);
  const [granting, setGranting] = useState(false);
  const [archiving, setArchiving] = useState(false);
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />;
  if (!data) return <SkeletonRows rows={5} />;
  const t = data;
  const act = async (fn: () => Promise<TeamDetail | unknown>, ok: string) => {
    try {
      const r = await fn();
      if (r && typeof r === 'object' && 'members' in (r as object)) setData(r as TeamDetail); else void refetch();
      toast.success(ok);
    } catch (e) {
      toast.error(e, 'Not saved');
    }
  };
  const brandName = (b: string) => session.brands.find((x) => x.id === b)?.name ?? 'Brand';
  return (
    <>
      <PageHeader title={t.name} eyebrow={<Link href={th("/team/teams")} className="inline-flex items-center gap-1 hover:text-fg"><ArrowLeft aria-hidden className="size-3" /> Teams</Link>}
        meta={t.publishing ? 'Publishing team' : undefined}
        actions={<>
          {t.can_manage_members ? <Button variant="primary" icon={<UserPlus aria-hidden className="size-4" />} onClick={() => setAdding(true)}>Add member</Button> : null}
          {t.can_edit ? <IconButton label="Archive team" icon={<Archive aria-hidden className="size-4" />} onClick={() => setArchiving(true)} /> : null}
        </>} />
      <TeamNav />
      {t.publishing ? <Banner tone="info" className="mb-6" title="Adding someone here lets them schedule and publish" /> : null}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card aria-labelledby="h-tm">
          <CardHeader id="h-tm" title={<>Members <span className="ml-1 font-normal text-muted">{t.members.length}</span></>} />
          <ul className="divide-y divide-border">
            {t.members.map((m) => (
              <li key={m.user_id} className="flex items-center gap-3 px-4 py-2.5">
                <Avatar m={m} />
                <Link href={th(`/team/members/${m.user_id}`)} className="min-w-0 flex-1 truncate hover:underline">{m.name || m.email}</Link>
                {m.status !== 'active' ? <StatusBadge status={m.status} /> : null}
                {t.can_edit ? (
                  <Tooltip content={m.is_manager ? 'Manager — click to remove' : 'Make manager'}>
                    <span><IconButton label={m.is_manager ? `Remove ${m.email} as manager` : `Make ${m.email} a manager`}
                      icon={<Star aria-hidden className={`size-4 ${m.is_manager ? 'fill-current text-accent-text' : ''}`} />}
                      onClick={() => void act(() => api.patch(`/api/teams/${id}/members/${m.user_id}`, { is_manager: !m.is_manager }), m.is_manager ? 'Manager removed' : 'Manager added')} /></span>
                  </Tooltip>
                ) : m.is_manager ? <Star aria-label="Manager" className="size-4 fill-current text-accent-text" /> : null}
                {t.can_manage_members && (t.can_edit || !m.is_manager) ? (
                  <IconButton label={`Remove ${m.email} from team`} icon={<Trash2 aria-hidden className="size-4" />}
                    onClick={() => void act(() => api.del(`/api/teams/${id}/members/${m.user_id}`), 'Removed from team')} />
                ) : null}
              </li>
            ))}
            {!t.members.length ? <li className="px-4 py-6 text-center text-[13px] text-muted">No members</li> : null}
          </ul>
        </Card>
        <div className="flex flex-col gap-6">
          <Card aria-labelledby="h-tg">
            <CardHeader id="h-tg" title="Team access" actions={t.can_edit ? <Button size="sm" icon={<Plus aria-hidden className="size-4" />} onClick={() => setGranting(true)}>Add</Button> : null} />
            <ul className="divide-y divide-border px-4 pb-2">
              {t.grants.map((g) => (
                <li key={g.id} className="flex items-center gap-2 py-2">
                  <Badge tone="info">{V2_ROLE_LABEL[g.role]} · {g.brand_name ?? 'All brands'}{g.connection_name ? ` · ${g.connection_name}` : ''}</Badge>
                  <span className="flex-1" />
                  {t.can_edit ? <IconButton label={`Revoke ${V2_ROLE_LABEL[g.role]}`} icon={<Trash2 aria-hidden className="size-4" />}
                    onClick={() => void act(() => api.del(`/api/teams/${id}/grants/${g.id}`), 'Access removed')} /> : null}
                </li>
              ))}
              {!t.grants.length ? <li className="py-3 text-[13px] text-muted">None</li> : null}
            </ul>
          </Card>
          <Card aria-labelledby="h-ceil">
            <CardHeader id="h-ceil" title={<Tooltip content="What this team's managers may hand out when adding members"><span>Manager ceiling</span></Tooltip>} />
            <div className="px-4 pb-4">
              {t.can_edit ? <CeilingEditor team={t} onSaved={(x) => setData({ ...t, ...x })} /> : (
                <div className="flex flex-wrap gap-1 text-[13px]">
                  {t.delegation?.grantable_roles.length ? t.delegation.grantable_roles.map((r) => <Badge key={r}>{V2_ROLE_LABEL[r]}</Badge>) : <span className="text-muted">None</span>}
                  {t.delegation?.brand_ids.map((b) => <Badge key={b} tone="neutral">{brandName(b)}</Badge>)}
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>
      <AddMemberDialog open={adding} onOpenChange={setAdding} teamId={id} canAppoint={t.can_edit} onDone={(r) => setData(r)} />
      <TeamGrantDialog open={granting} onOpenChange={setGranting} teamId={id} onDone={() => void refetch()} />
      <ConfirmDialog open={archiving} onOpenChange={setArchiving} title={`Archive ${t.name}?`} confirmLabel="Archive" confirmVariant="danger"
        onConfirm={async () => { await api.patch(`/api/teams/${id}`, { archived: true }); toast.success('Archived'); window.location.assign(th('/team/teams')); }}>
        <p className="text-[13px] text-muted">Members lose this team’s access now. Their scheduled posts are held for adoption.</p>
      </ConfirmDialog>
    </>
  );
}

function CeilingEditor({ team, onSaved }: { team: TeamView; onSaved: (t: TeamView) => void }) {
  const { session } = useSession();
  const toast = useToast();
  const [roles, setRoles] = useState<string[]>(team.delegation?.grantable_roles ?? []);
  const [brands, setBrands] = useState<string[]>(team.delegation?.brand_ids ?? []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => { setRoles(team.delegation?.grantable_roles ?? []); setBrands(team.delegation?.brand_ids ?? []); }, [team.delegation]);
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.put<TeamView>(`/api/teams/${team.id}/delegation`, { grantable_roles: roles, brand_ids: brands });
      onSaved(r);
      toast.success('Ceiling saved');
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">{TEAM_ROLES.map((r) => <Checkbox key={r} label={V2_ROLE_LABEL[r]} checked={roles.includes(r)} onChange={() => setRoles(toggle(roles, r))} />)}</div>
      <div className="flex flex-col gap-2 border-t border-border pt-3">{session.brands.map((b) => <Checkbox key={b.id} label={b.name} checked={brands.includes(b.id)} onChange={() => setBrands(toggle(brands, b.id))} />)}</div>
      {err ? <ErrorNotice error={err} /> : null}
      <Button size="sm" loading={busy} onClick={() => void save()}>Save</Button>
    </div>
  );
}

function AddMemberDialog({ open, onOpenChange, teamId, canAppoint, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; teamId: string; canAppoint: boolean; onDone: (t: TeamDetail) => void }) {
  const toast = useToast();
  const cands = useApi<{ items: Array<{ user_id: string; email: string; name: string | null }> }>(open ? `/api/teams/${teamId}/candidates` : null);
  const [user, setUser] = useState('');
  const [manager, setManager] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<TeamDetail>(`/api/teams/${teamId}/members`, { user_id: user, ...(manager ? { is_manager: true } : {}) });
      onDone(r);
      toast.success('Added');
      setUser(''); setManager(false);
      onOpenChange(false);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Add member" busy={busy} size="sm"
      footer={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void submit()} disabledReason={user ? undefined : 'Choose someone'}>Add</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label="Member">
          <Select value={user} onChange={(e) => setUser(e.target.value)}>
            <option value="">Choose…</option>
            {cands.data?.items.map((c) => <option key={c.user_id} value={c.user_id}>{c.name ? `${c.name} — ${c.email}` : c.email}</option>)}
          </Select>
        </Field>
        {canAppoint ? <Checkbox label="Team manager" checked={manager} onChange={() => setManager(!manager)} /> : null}
        {err ? <ErrorNotice error={err} /> : null}
      </div>
    </Dialog>
  );
}

function TeamGrantDialog({ open, onOpenChange, teamId, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; teamId: string; onDone: () => void }) {
  const { session } = useSession();
  const toast = useToast();
  const [role, setRole] = useState<string>('editor');
  const [brand, setBrand] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/api/teams/${teamId}/grants`, { role, brand_id: brand || null });
      toast.success('Access added');
      onOpenChange(false);
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Team access" busy={busy} size="sm"
      footer={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void submit()}>Add</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label="Role"><Select value={role} onChange={(e) => setRole(e.target.value)}>{TEAM_ROLES.map((r) => <option key={r} value={r}>{V2_ROLE_LABEL[r]}</option>)}</Select></Field>
        <Field label="Brand"><Select value={brand} onChange={(e) => setBrand(e.target.value)}><option value="">All brands</option>{session.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
        {err ? <ErrorNotice error={err} /> : null}
      </div>
    </Dialog>
  );
}
