'use client';
// Invitations v2: scoped grants (role per brand), teams, guest invitations with a required expiry,
// bulk invite with per-row results, resend (rotates the link) and revoke.
import { useEffect, useState } from 'react';
import { Copy, ListPlus, MailPlus, RotateCw, ShieldAlert, Trash2, UserPlus } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { useApi } from '@/lib/client/use-api';
import { useQueryState } from '@/lib/client/hooks';
import { fmtRelative } from '@/lib/client/format';
import {
  Badge, Button, Card, Checkbox, ConfirmDialog, Dialog, EmptyState, ErrorNotice, ErrorState, Field, IconButton, Input, PageHeader, Segmented, Select,
  SkeletonRows, Textarea, Tooltip, useToast,
} from '@/components/ui';
import { StatusBadge, TeamNav, V2_ROLE_LABEL, ROLE_HINT, type InvitationView } from '@/components/team/shared';
import { HelpLink } from '@/components/help/help-link';

const MEMBER_ROLES = ['editor', 'publisher', 'approver', 'brand_manager', 'analyst', 'viewer', 'exporter', 'admin'] as const;

interface BulkResult { row: number; email: string; status: string; message?: string; accept_url?: string }

export default function InvitationsPage() {
  const { canV2 } = useSession();
  const toast = useToast();
  const [params, setParams] = useQueryState();
  const { data, error, loading, refetch } = useApi<{ items: InvitationView[] }>(canV2('members.invite') ? '/api/invitations' : null);
  const [open, setOpen] = useState(params.get('new') === '1');
  const [bulk, setBulk] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<InvitationView | null>(null);
  useEffect(() => { if (params.get('new') === '1') setOpen(true); }, [params]);

  const resend = async (i: InvitationView) => {
    try {
      const r = await api.post<InvitationView>(`/api/invitations/${i.id}/resend`, {});
      setLink(r.accept_url ?? null);
      toast.success(r.email_sent ? 'Resent — old link no longer works' : 'New link created — email not sent');
      void refetch();
    } catch (e) {
      toast.error(e, 'Not resent');
    }
  };

  if (!canV2('members.invite')) return (<><PageHeader title="Team" /><TeamNav /><EmptyState icon={<ShieldAlert aria-hidden />} title="No access" /></>);
  return (
    <>
      <PageHeader title="Team" actions={<>
        <HelpLink slug="invite-people" label="About inviting people" />
        <Button icon={<ListPlus aria-hidden className="size-4" />} onClick={() => setBulk(true)}>Bulk</Button>
        <Button variant="primary" icon={<UserPlus aria-hidden className="size-4" />} onClick={() => setOpen(true)}>Invite</Button>
      </>} />
      <TeamNav />
      {link ? <LinkNotice url={link} onDismiss={() => setLink(null)} /> : null}
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <SkeletonRows rows={3} /> : !data.items.length ? (
        <EmptyState icon={<MailPlus aria-hidden />} title="No open invitations" />
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {data.items.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{i.email}</span>
                    {i.kind === 'guest' ? <Badge tone="warn">Guest</Badge> : null}
                    <StatusBadge status={i.status} />
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {i.grants.map((g, k) => <Badge key={k} tone="info">{V2_ROLE_LABEL[g.role] ?? g.role} · {g.brand_name ?? 'All brands'}</Badge>)}
                    {i.teams.map((t) => <Badge key={t.id}>{t.name}</Badge>)}
                  </div>
                  <div className="mt-1 text-[12px] text-muted">
                    {i.status === 'pending' ? `Expires ${fmtRelative(i.expires_at)}` : `Expired ${fmtRelative(i.expires_at)}`}
                    {i.access_expires_at ? ` · access until ${new Date(i.access_expires_at).toLocaleDateString()}` : ''}
                    {i.resent_count ? ` · resent ${i.resent_count}×` : ''}{i.invited_by_email ? ` · by ${i.invited_by_email}` : ''}
                  </div>
                </div>
                <Tooltip content="Resend (new link)"><span><IconButton label={`Resend to ${i.email}`} icon={<RotateCw aria-hidden className="size-4" />} onClick={() => void resend(i)} /></span></Tooltip>
                <IconButton label={`Revoke invitation for ${i.email}`} icon={<Trash2 aria-hidden className="size-4" />} onClick={() => setRevoking(i)} />
              </li>
            ))}
          </ul>
        </Card>
      )}
      <InviteDialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setParams({ new: null }); }} onCreated={(r) => { setLink(r.accept_url ?? null); void refetch(); }} />
      <BulkDialog open={bulk} onOpenChange={setBulk} onDone={() => void refetch()} />
      <ConfirmDialog open={!!revoking} onOpenChange={(o) => !o && setRevoking(null)} title={`Revoke invitation for ${revoking?.email}?`} confirmLabel="Revoke" confirmVariant="danger"
        onConfirm={async () => { await api.del(`/api/invitations/${revoking!.id}`); toast.success('Revoked'); void refetch(); }} />
    </>
  );
}

function LinkNotice({ url, onDismiss }: { url: string; onDismiss: () => void }) {
  const toast = useToast();
  return (
    <Card className="mb-6 flex flex-wrap items-center gap-2 p-3">
      <Input readOnly value={url} aria-label="Invitation link (shown once)" className="min-w-0 flex-1 font-mono text-[12px]" />
      <Button icon={<Copy aria-hidden className="size-4" />} onClick={() => { void navigator.clipboard?.writeText(url); toast.success('Copied'); }}>Copy</Button>
      <Button variant="quiet" onClick={onDismiss}>Done</Button>
    </Card>
  );
}

function InviteDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (r: InvitationView) => void }) {
  const { session, canV2 } = useSession();
  const toast = useToast();
  const teams = useApi<{ items: Array<{ id: string; name: string; publishing: boolean }> }>(open && canV2('teams.read') ? '/api/teams' : null);
  const [kind, setKind] = useState<'member' | 'guest'>('member');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>('editor');
  const [brands, setBrands] = useState<string[]>([]);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [days, setDays] = useState('30');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const grants = kind === 'guest' ? brands.map((b) => ({ role: 'guest', brand_id: b }))
        : role === 'admin' || !brands.length ? [{ role }] : brands.map((b) => ({ role, brand_id: b }));
      const body = { email: email.trim(), grants, ...(kind === 'member' && teamIds.length ? { team_ids: teamIds } : {}),
        ...(kind === 'guest' ? { access_expires_at: new Date(Date.now() + Number(days) * 86400_000).toISOString() } : {}) };
      const r = await api.post<InvitationView>('/api/invitations', body, { idempotent: true });
      toast.success(r.email_sent ? `Invitation sent to ${r.email}` : 'Invitation created — email not sent');
      onCreated(r);
      setEmail(''); setBrands([]); setTeamIds([]);
      onOpenChange(false);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Invite" busy={busy} size="md"
      footer={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="primary" loading={busy} onClick={() => void submit()} disabledReason={!email.trim() ? 'Enter an email' : kind === 'guest' && !brands.length ? 'Choose a brand' : undefined}>Send</Button></>}>
      <div className="flex flex-col gap-4">
        <Segmented label="Type" value={kind} onChange={setKind} options={[{ value: 'member', label: 'Member' }, { value: 'guest', label: 'Guest reviewer' }]} />
        <Field label="Email"><Input type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        {kind === 'member' ? (
          <Field label="Role" hint={ROLE_HINT[role]}>
            <Select value={role} onChange={(e) => setRole(e.target.value)}>{MEMBER_ROLES.map((r) => <option key={r} value={r}>{V2_ROLE_LABEL[r]}</option>)}</Select>
          </Field>
        ) : (
          <Field label="Access for" hint="Max per workspace policy">
            <Select value={days} onChange={(e) => setDays(e.target.value)}>{['7', '14', '30', '60', '90'].map((d) => <option key={d} value={d}>{d} days</option>)}</Select>
          </Field>
        )}
        {role !== 'admin' || kind === 'guest' ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-[13px] font-medium">Brands {kind === 'member' ? <span className="font-normal text-muted">(none = all)</span> : null}</legend>
            {session.brands.map((b) => <Checkbox key={b.id} label={b.name} checked={brands.includes(b.id)} onChange={() => setBrands(toggle(brands, b.id))} />)}
          </fieldset>
        ) : null}
        {kind === 'member' && teams.data?.items.length ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-[13px] font-medium">Teams</legend>
            {teams.data.items.map((t) => <Checkbox key={t.id} label={<>{t.name}{t.publishing ? <Badge tone="info" className="ml-2">Publishing</Badge> : null}</>} checked={teamIds.includes(t.id)} onChange={() => setTeamIds(toggle(teamIds, t.id))} />)}
          </fieldset>
        ) : null}
        {err ? <ErrorNotice error={err} /> : null}
      </div>
    </Dialog>
  );
}

function BulkDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const { session } = useSession();
  const [text, setText] = useState('');
  const [role, setRole] = useState<string>('viewer');
  const [brand, setBrand] = useState('');
  const [results, setResults] = useState<BulkResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const rows = text.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ results: BulkResult[] }>('/api/invitations/bulk',
        { rows: rows.map((email) => ({ email, grants: [brand ? { role, brand_id: brand } : { role }] })) }, { idempotent: true });
      setResults(r.results);
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) { setResults(null); setText(''); } }} title="Bulk invite" busy={busy} size="lg"
      footer={results ? <Button onClick={() => onOpenChange(false)}>Done</Button> : <><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="primary" loading={busy} onClick={() => void submit()} disabledReason={!rows.length ? 'Add emails' : rows.length > 100 ? 'Max 100' : undefined}>Invite {rows.length || ''}</Button></>}>
      {results ? (
        <ul className="divide-y divide-border text-[13px]">
          {results.map((r) => (
            <li key={r.row} className="flex items-center gap-2 py-2">
              <span className="w-6 text-muted">{r.row}</span>
              <span className="min-w-0 flex-1 truncate">{r.email}</span>
              <Badge tone={r.status === 'invited' ? 'success' : r.status === 'error' ? 'danger' : 'neutral'}>{r.status.replace(/_/g, ' ')}</Badge>
              {r.message && r.status !== 'invited' ? <Tooltip content={r.message}><span className="text-muted">ⓘ</span></Tooltip> : null}
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-col gap-4">
          <Field label="Emails" hint="One per line"><Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Role"><Select value={role} onChange={(e) => setRole(e.target.value)}>{MEMBER_ROLES.filter((r) => r !== 'admin').map((r) => <option key={r} value={r}>{V2_ROLE_LABEL[r]}</option>)}</Select></Field>
            <Field label="Brand"><Select value={brand} onChange={(e) => setBrand(e.target.value)}><option value="">All brands</option>{session.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
          </div>
          {err ? <ErrorNotice error={err} /> : null}
        </div>
      )}
    </Dialog>
  );
}
