'use client';
// Member detail: effective access (actions per brand with source + expiry, policy version), grants and
// restrictions (add/revoke), suspension / removal / scope reduction, handover preview + reassignment,
// ownership transfer. Every button calls the real API; success is shown only after the server commits.
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowLeft, Ban, Crown, Plus, ShieldOff, Trash2, UserMinus } from 'lucide-react';
import { api, apiFetch } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { useApi } from '@/lib/client/use-api';
import { fmtRelative } from '@/lib/client/format';
import {
  Badge, Banner, Button, Card, CardHeader, ConfirmDialog, Dialog, ErrorNotice, ErrorState, Facts, Field, IconButton, Input, PageHeader, Select,
  SkeletonRows, Tooltip, useToast,
} from '@/components/ui';
import { GRANT_ROLES, GrantChip, ROLE_HINT, StatusBadge, TeamNav, V2_ROLE_LABEL, type MemberView } from '@/components/team/shared';

interface Source { grant_id: string; role: string; via: 'direct' | 'team'; team_name: string | null; expires_at: string | null }
interface PermRow { permission: string; allowed: boolean; reason: string; sources: Source[] }
interface Access {
  policy_version: number; workspace: PermRow[];
  brands: Array<{ brand_id: string; name: string; permissions: PermRow[]; connections: Array<{ connection_id: string; name: string; provider: string; permissions: PermRow[] }> }>;
  restrictions: Array<{ id: string; brand_id: string | null; brand_name: string | null; actions: string[]; expires_at: string | null; reason: string | null }>;
}
interface Handover {
  drafts: { count: number; items: Array<{ post_id: string; title: string | null; brand_name: string }> }; pending_approvals: { requested: number; assigned: number };
  scheduled: { count: number; held: number; items: Array<{ schedule_id: string; title: string | null; brand_name: string; due_at: string; status: string }> };
  service_accounts: Array<{ id: string; name: string }>; connections: Array<{ id: string; name: string; provider: string; brand_name: string }>; other_workspaces: number;
  candidates: Array<{ user_id: string; email: string; name: string | null; can_edit: string[]; can_schedule: string[]; can_own_service_accounts: boolean }>;
}

const ACTION_GROUPS: Array<[string, string[]]> = [
  ['Content', ['content.read', 'content.create', 'content.edit', 'content.submit', 'content.archive']],
  ['Review', ['content.approve', 'comments.internal', 'comments.shared']],
  ['Publish', ['content.schedule', 'content.publish', 'publishing.pause', 'publishing.resume', 'publishing.retry']],
  ['Brand', ['brands.read', 'brands.manage', 'connections.read', 'connections.manage', 'assets.read', 'assets.upload', 'assets.manage', 'analytics.read', 'exports.create']],
];

export default function MemberPage() {
  const { userId } = useParams<{ userId: string }>();
  const router = useRouter();
  const { session, canV2 } = useSession();
  const toast = useToast();
  const member = useApi<MemberView>(`/api/members/${userId}`);
  const access = useApi<Access>(`/api/members/${userId}/access`);
  const manage = canV2('members.manage') && userId !== session.user.id;
  const handover = useApi<Handover>(manage ? `/api/members/${userId}/handover` : null);
  const [grantOpen, setGrantOpen] = useState(false);
  const [denyOpen, setDenyOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | 'suspend' | 'reactivate' | 'remove' | 'transfer'>(null);
  const [reason, setReason] = useState('');
  const [reassignTo, setReassignTo] = useState('');
  const isOwnerMe = session.v2?.permissions?.['workspace.transfer_owner'] === true;
  const reload = () => { void member.refetch(); void access.refetch(); if (manage) void handover.refetch(); };

  if (member.error && !member.data) return <ErrorState error={member.error} onRetry={member.refetch} />;
  if (!member.data) return <SkeletonRows rows={6} />;
  const m = member.data;

  const revoke = async (id: string, url: string, label: string) => {
    try {
      await api.del(url);
      toast.success(`${label} removed`);
      reload();
    } catch (e) {
      toast.error(e, 'Not removed');
    }
    void id;
  };

  const lifecycle = async () => {
    if (confirm === 'suspend') await api.post(`/api/members/${userId}/suspend`, { reason: reason || null });
    if (confirm === 'reactivate') await api.post(`/api/members/${userId}/reactivate`, {});
    if (confirm === 'transfer') await api.post('/api/workspace/ownership-transfers', { to_user_id: userId, keep_previous_owner_as: 'admin' });
    if (confirm === 'remove') {
      await apiFetch(`/api/members/${userId}`, { method: 'DELETE', body: { reassign_to: reassignTo || null, reason: reason || null } });
      toast.success('Removed');
      router.push('/team');
      return;
    }
    toast.success(confirm === 'suspend' ? 'Suspended' : confirm === 'reactivate' ? 'Reactivated' : 'Transfer sent — they must accept');
    setReason('');
    reload();
  };

  const direct = m.grants.filter((g) => g.via === 'direct');
  const viaTeams = m.grants.filter((g) => g.via === 'team');

  return (
    <>
      <PageHeader title={m.name || m.email} eyebrow={<Link href="/team" className="inline-flex items-center gap-1 hover:text-fg"><ArrowLeft aria-hidden className="size-3" /> Team</Link>}
        meta={<StatusBadge status={m.status} />}
        actions={manage ? (
          <>
            {m.status === 'active'
              ? <Button icon={<Ban aria-hidden className="size-4" />} onClick={() => setConfirm('suspend')} disabledReason={m.is_owner && !isOwnerMe ? 'Owners only' : undefined}>Suspend</Button>
              : <Button onClick={() => setConfirm('reactivate')}>Reactivate</Button>}
            <Button variant="danger" icon={<UserMinus aria-hidden className="size-4" />} onClick={() => setConfirm('remove')} disabledReason={m.is_owner && !isOwnerMe ? 'Owners only' : undefined}>Remove</Button>
            {isOwnerMe && !m.is_owner && m.status === 'active' ? <Button icon={<Crown aria-hidden className="size-4" />} onClick={() => setConfirm('transfer')}>Make owner</Button> : null}
          </>
        ) : null} />
      <TeamNav />
      {m.status === 'suspended' ? <Banner tone="warn" className="mb-6" title="Suspended">{m.status_reason}</Banner> : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card aria-labelledby="h-access">
            <CardHeader id="h-access" title={<>Effective access {access.data ? <span className="ml-1 font-normal text-muted">policy v{access.data.policy_version}</span> : null}</>} />
            <div className="px-4 pb-4">
              {access.error ? <ErrorNotice error={access.error} /> : !access.data ? <SkeletonRows rows={3} /> : (
                <AccessMatrix a={access.data} />
              )}
            </div>
          </Card>

          <Card aria-labelledby="h-grants">
            <CardHeader id="h-grants" title="Grants" actions={manage && m.status === 'active' ? <Button size="sm" icon={<Plus aria-hidden className="size-4" />} onClick={() => setGrantOpen(true)}>Add</Button> : null} />
            <ul className="divide-y divide-border px-4 pb-2">
              {direct.map((g) => (
                <li key={g.id} className="flex items-center gap-2 py-2">
                  <GrantChip g={g} />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{g.granted_by_email ? `by ${g.granted_by_email}` : g.source.replace(/_/g, ' ')}</span>
                  {manage && g.role !== 'owner' ? <IconButton label={`Revoke ${V2_ROLE_LABEL[g.role]}`} icon={<Trash2 aria-hidden className="size-4" />} onClick={() => void revoke(g.id, `/api/grants/${g.id}`, 'Grant')} /> : null}
                </li>
              ))}
              {viaTeams.map((g) => (
                <li key={`${g.id}-t`} className="flex items-center gap-2 py-2">
                  <GrantChip g={g} />
                  <Link href={`/team/teams/${g.team_id}`} className="min-w-0 flex-1 truncate text-[12px] text-muted hover:underline">via {g.team_name}</Link>
                </li>
              ))}
              {!m.grants.length ? <li className="py-3 text-[13px] text-muted">No access</li> : null}
            </ul>
          </Card>

          <Card aria-labelledby="h-deny">
            <CardHeader id="h-deny" title="Restrictions" actions={manage ? <Button size="sm" icon={<ShieldOff aria-hidden className="size-4" />} onClick={() => setDenyOpen(true)}>Deny</Button> : null} />
            <ul className="divide-y divide-border px-4 pb-2">
              {access.data?.restrictions.map((r) => (
                <li key={r.id} className="flex items-center gap-2 py-2">
                  <Badge tone="danger">{r.actions.includes('*') ? 'Everything' : r.actions.join(', ')}</Badge>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{r.brand_name ?? 'All brands'}{r.reason ? ` · ${r.reason}` : ''}</span>
                  {manage ? <IconButton label="Lift restriction" icon={<Trash2 aria-hidden className="size-4" />} onClick={() => void revoke(r.id, `/api/restrictions/${r.id}`, 'Restriction')} /> : null}
                </li>
              ))}
              {access.data && !access.data.restrictions.length ? <li className="py-3 text-[13px] text-muted">None</li> : null}
            </ul>
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          <Card className="p-4">
            <Facts items={[
              ['Email', m.email],
              ['Teams', m.teams.length ? m.teams.map((t) => <Link key={t.id} href={`/team/teams/${t.id}`} className="mr-2 hover:underline">{t.name}{t.is_manager ? ' ★' : ''}</Link>) : '—'],
              ['Joined', fmtRelative(m.joined_at)],
              ['Last sign-in', m.last_sign_in_at ? fmtRelative(m.last_sign_in_at) : 'Never'],
              ...(m.access_expires_at ? [['Access ends', new Date(m.access_expires_at).toLocaleString()] as [string, string]] : []),
            ]} />
          </Card>
          {manage ? (
            <Card aria-labelledby="h-handover">
              <CardHeader id="h-handover" title="Handover" />
              <div className="px-4 pb-4 text-[13px]">
                {handover.error ? <ErrorNotice error={handover.error} /> : !handover.data ? <SkeletonRows rows={3} /> : <HandoverPanel h={handover.data} userId={userId} onDone={reload} />}
              </div>
            </Card>
          ) : null}
        </div>
      </div>

      <AddGrantDialog open={grantOpen} onOpenChange={setGrantOpen} userId={userId} onDone={reload} brands={session.brands} />
      <DenyDialog open={denyOpen} onOpenChange={setDenyOpen} userId={userId} onDone={reload} brands={session.brands} />
      <ConfirmDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)} onConfirm={lifecycle}
        title={confirm === 'suspend' ? `Suspend ${m.email}?` : confirm === 'reactivate' ? `Reactivate ${m.email}?` : confirm === 'transfer' ? `Make ${m.email} the owner?` : `Remove ${m.email}?`}
        confirmLabel={confirm === 'suspend' ? 'Suspend' : confirm === 'reactivate' ? 'Reactivate' : confirm === 'transfer' ? 'Send transfer' : 'Remove'}
        confirmVariant={confirm === 'remove' || confirm === 'suspend' ? 'danger' : 'primary'}>
        {confirm === 'suspend' || confirm === 'remove' ? (
          <div className="flex flex-col gap-3 text-[13px]">
            {handover.data && (handover.data.scheduled.count || handover.data.drafts.count) ? (
              <p className="text-muted">{handover.data.scheduled.count} scheduled post(s) will be held for adoption · {handover.data.drafts.count} draft(s)</p>
            ) : null}
            {confirm === 'remove' && handover.data?.candidates.length ? (
              <Field label="Hand over to" optional>
                <Select value={reassignTo} onChange={(e) => setReassignTo(e.target.value)}>
                  <option value="">Nobody (hold)</option>
                  {handover.data.candidates.map((c) => <option key={c.user_id} value={c.user_id}>{c.name || c.email}</option>)}
                </Select>
              </Field>
            ) : null}
            <Field label="Reason" optional><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
          </div>
        ) : confirm === 'transfer' ? <p className="text-[13px] text-muted">Requires fresh sign-in. They must accept; you stay as admin.</p> : null}
      </ConfirmDialog>
    </>
  );
}

const LABEL: Record<string, string> = {
  'content.read': 'Read', 'content.create': 'Create', 'content.edit': 'Edit', 'content.submit': 'Submit', 'content.archive': 'Archive',
  'content.approve': 'Approve', 'comments.internal': 'Internal notes', 'comments.shared': 'Comment',
  'content.schedule': 'Schedule', 'content.publish': 'Publish', 'publishing.pause': 'Pause', 'publishing.resume': 'Resume', 'publishing.retry': 'Retry',
  'brands.read': 'Brand', 'brands.manage': 'Edit brand', 'connections.read': 'Accounts', 'connections.manage': 'Connect accounts', 'assets.read': 'Library',
  'assets.upload': 'Upload', 'assets.manage': 'Manage library', 'analytics.read': 'Analytics', 'exports.create': 'Export',
};

function PermChip({ p }: { p: PermRow }) {
  const tip = p.allowed
    ? p.sources.map((x) => `${V2_ROLE_LABEL[x.role]}${x.via === 'team' ? ` via ${x.team_name}` : ' (direct)'}${x.expires_at ? ` until ${new Date(x.expires_at).toLocaleDateString()}` : ''}`).join(' · ')
    : 'Denied by an explicit restriction';
  const team = p.allowed && p.sources.every((x) => x.via === 'team');
  const expiring = p.allowed && p.sources.some((x) => x.expires_at);
  return (
    <Tooltip content={tip}>
      <span><Badge tone={!p.allowed ? 'danger' : team ? 'info' : 'success'} className={!p.allowed ? 'line-through' : undefined}>
        {LABEL[p.permission] ?? p.permission}{expiring ? ' ⏱' : ''}
      </Badge></span>
    </Tooltip>
  );
}

function AccessMatrix({ a }: { a: Access }) {
  if (!a.brands.length && !a.workspace.length) return <p className="text-[13px] text-muted">No effective access</p>;
  return (
    <div className="flex flex-col gap-4">
      {a.workspace.length ? (
        <div className="flex flex-wrap gap-1">{a.workspace.map((p) => <Badge key={p.permission} tone={p.allowed ? 'accent' : 'danger'}>{p.permission}</Badge>)}</div>
      ) : null}
      {a.brands.map((b) => (
        <section key={b.brand_id} aria-label={b.name} className="rounded-lg border border-border p-3">
          <h3 className="mb-2 text-[13px] font-semibold">{b.name}</h3>
          <dl className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-2 text-[12px]">
            {ACTION_GROUPS.map(([g, perms]) => {
              const rows = perms.map((p) => b.permissions.find((x) => x.permission === p)).filter((x): x is PermRow => !!x);
              return (
                <div key={g} className="contents">
                  <dt className="pt-1 text-muted">{g}</dt>
                  <dd className="flex flex-wrap gap-1">{rows.length ? rows.map((p) => <PermChip key={p.permission} p={p} />) : <span className="pt-1 text-subtle">—</span>}</dd>
                </div>
              );
            })}
          </dl>
          {b.connections.length ? (
            <p className="mt-2 text-[12px] text-muted">{b.connections.map((c) => `${c.name}: ${c.permissions.map((p) => LABEL[p.permission] ?? p.permission).join(', ')}`).join(' · ')}</p>
          ) : null}
        </section>
      ))}
      <p className="flex gap-3 text-[11px] text-subtle"><span className="text-success">■ direct</span><span className="text-info">■ via team</span><span>⏱ expires</span><span className="text-danger">■ denied</span></p>
    </div>
  );
}

function HandoverPanel({ h, userId, onDone }: { h: Handover; userId: string; onDone: () => void }) {
  const toast = useToast();
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ drafts: number; approvals: number; scheduled: { transferred: number; skipped: number }; service_accounts: number; skipped_unauthorized: number }>(
        `/api/members/${userId}/handover`, { to_user_id: to });
      toast.success('Reassigned', `${r.drafts} drafts · ${r.scheduled.transferred} scheduled · ${r.service_accounts} service accounts${r.scheduled.skipped + r.skipped_unauthorized ? ` · ${r.scheduled.skipped + r.skipped_unauthorized} skipped (not authorised)` : ''}`);
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <Facts items={[
        ['Drafts', h.drafts.count],
        ['Scheduled', <>{h.scheduled.count}{h.scheduled.held ? <Badge tone="warn" className="ml-2">{h.scheduled.held} held</Badge> : null}</>],
        ['Reviews', `${h.pending_approvals.requested} requested · ${h.pending_approvals.assigned} assigned`],
        ['Service accounts', h.service_accounts.length],
        ['Accounts connected', h.connections.length ? <Tooltip content="Flagged for verification on removal"><span>{h.connections.length}</span></Tooltip> : 0],
        ['Other workspaces', <Tooltip key="o" content="Not affected"><span>{h.other_workspaces}</span></Tooltip>],
      ]} />
      {h.candidates.length && (h.drafts.count || h.scheduled.count || h.service_accounts.length) ? (
        <div className="flex items-end gap-2">
          <Field label="Reassign to" className="min-w-0 flex-1">
            <Select value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">Choose…</option>
              {h.candidates.map((c) => <option key={c.user_id} value={c.user_id}>{c.name || c.email}</option>)}
            </Select>
          </Field>
          <Button onClick={() => void run()} loading={busy} disabledReason={to ? undefined : 'Choose someone'}>Reassign</Button>
        </div>
      ) : null}
      {err ? <ErrorNotice error={err} /> : null}
    </div>
  );
}

function AddGrantDialog({ open, onOpenChange, userId, onDone, brands }: { open: boolean; onOpenChange: (o: boolean) => void; userId: string; onDone: () => void; brands: Array<{ id: string; name: string }> }) {
  const toast = useToast();
  const [role, setRole] = useState<string>('editor');
  const [brand, setBrand] = useState('');
  const [expires, setExpires] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const wsOnly = role === 'admin';
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/api/members/${userId}/grants`, { role, brand_id: wsOnly ? null : brand || null, expires_at: expires ? new Date(expires).toISOString() : null });
      toast.success(`${V2_ROLE_LABEL[role]} granted`);
      onOpenChange(false);
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Add access" busy={busy}
      footer={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void submit()}
        disabledReason={role === 'guest' && !brand ? 'Choose a brand' : undefined}>Grant</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label="Role" hint={ROLE_HINT[role]}>
          <Select value={role} onChange={(e) => setRole(e.target.value)}>{GRANT_ROLES.map((r) => <option key={r} value={r}>{V2_ROLE_LABEL[r]}</option>)}</Select>
        </Field>
        {!wsOnly ? (
          <Field label="Brand">
            <Select value={brand} onChange={(e) => setBrand(e.target.value)}>
              {role !== 'guest' ? <option value="">All brands</option> : <option value="">Choose…</option>}
              {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </Field>
        ) : null}
        <Field label="Expires" optional={role !== 'guest'} hint={role === 'guest' ? 'Default 30 days' : undefined}>
          <Input type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </Field>
        {err ? <ErrorNotice error={err} /> : null}
      </div>
    </Dialog>
  );
}

const DENYABLE = ['*', 'content.publish', 'content.schedule', 'content.edit', 'content.approve', 'exports.create', 'connections.manage', 'assets.upload'];

function DenyDialog({ open, onOpenChange, userId, onDone, brands }: { open: boolean; onOpenChange: (o: boolean) => void; userId: string; onDone: () => void; brands: Array<{ id: string; name: string }> }) {
  const toast = useToast();
  const [action, setAction] = useState('content.publish');
  const [brand, setBrand] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/api/members/${userId}/restrictions`, { actions: [action], brand_id: brand || null, reason: reason || null });
      toast.success('Restriction added');
      onOpenChange(false);
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Deny an action" busy={busy}
      footer={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void submit()}>Deny</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label="Action"><Select value={action} onChange={(e) => setAction(e.target.value)}>{DENYABLE.map((a) => <option key={a} value={a}>{a === '*' ? 'Everything' : a}</option>)}</Select></Field>
        <Field label="Brand"><Select value={brand} onChange={(e) => setBrand(e.target.value)}><option value="">All brands</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
        <Field label="Reason" optional><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
        {err ? <ErrorNotice error={err} /> : null}
      </div>
    </Dialog>
  );
}
