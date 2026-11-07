'use client';
import { useEffect, useState } from 'react';
import { Copy, MailPlus, Trash2, UserMinus, UserPlus } from 'lucide-react';
import { ROLES, canChangeMember, type Role } from '@social-lite/core';
import { api } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { useApi } from '@/lib/client/use-api';
import { ROLE_LABEL, fmtRelative } from '@/lib/client/format';
import type { Invitation, Member, RemovalImpact } from '@/lib/client/types';
import {
  Badge, Banner, Button, Card, CardHeader, Checkbox, ConfirmDialog, Dialog, ErrorNotice, ErrorState, Field, IconButton, Input,
  RadioGroup, Select, SkeletonRows, Spinner, Table, Td, Th, THead, TimeWithZone, Tr, useToast,
} from '@/components/ui';

const ROLE_HELP: Record<Role, string> = {
  owner: 'Everything',
  admin: 'Team, brands, accounts, publish',
  editor: 'Drafts; publish if allowed',
  approver: 'Approve and schedule',
  viewer: 'Read only',
};

export function TeamTab() {
  const { session, can } = useSession();
  const toast = useToast();
  const { data, error, loading, refetch } = useApi<{ members: Member[]; invitations: Invitation[] }>('/api/members');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [lastInvite, setLastInvite] = useState<Invitation | null>(null);
  const [access, setAccess] = useState<Member | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const myRole = session.workspace?.role ?? 'viewer';
  const brandName = (id: string) => session.brands.find((b) => b.id === id)?.name ?? 'Unknown brand';

  if (error && !data) return <ErrorState error={error} onRetry={refetch} />;
  if (loading || !data) return <SkeletonRows rows={4} />;

  const changeRole = async (m: Member, role: Role) => {
    try {
      await api.patch(`/api/members/${m.user_id}`, { role });
      toast.success(`${m.name || m.email} is now ${ROLE_LABEL[role]}`);
      void refetch();
    } catch (e) {
      toast.error(e, 'Couldn’t change role');
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {lastInvite ? <InviteLink inv={lastInvite} onDismiss={() => setLastInvite(null)} /> : null}

      <Card aria-labelledby="h-members">
        <CardHeader
          id="h-members"
          title={<>Members <span className="ml-1 font-normal text-muted tabular">{data.members.length}</span></>}
          actions={can('members.invite') ? <Button variant="primary" icon={<UserPlus aria-hidden className="size-4" />} onClick={() => setInviteOpen(true)}>Invite</Button> : null}
        />
        <div className="mt-4 hidden md:block">
          <Table caption="Workspace members" className="rounded-none border-0">
            <THead><tr><Th>Person</Th><Th>Role</Th><Th>Brand access</Th><Th>Joined</Th><Th className="sr-only">Actions</Th></tr></THead>
            <tbody>
              {data.members.map((m) => {
                const self = m.user_id === session.user.id;
                const mayChange = can('members.change_role') && !self && canChangeMember(myRole, m.role);
                return (
                  <Tr key={m.user_id}>
                    <Td>
                      <span className="block font-medium">{m.name || m.email}{self ? <span className="ml-1.5 text-xs font-normal text-muted">(you)</span> : null}</span>
                      {m.name ? <span className="block text-xs text-muted">{m.email}</span> : null}
                    </Td>
                    <Td className="w-[170px]">
                      {mayChange ? (
                        <>
                          <label htmlFor={`role-${m.user_id}`} className="sr-only">Role for {m.email}</label>
                          <Select id={`role-${m.user_id}`} value={m.role} onChange={(e) => void changeRole(m, e.target.value as Role)}>
                            {ROLES.filter((r) => r !== 'owner' || myRole === 'owner').map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                          </Select>
                        </>
                      ) : <Badge>{ROLE_LABEL[m.role]}</Badge>}
                    </Td>
                    <Td>
                      {m.brand_ids === null ? <span className="text-muted">All brands</span> : m.brand_ids.length ? m.brand_ids.map(brandName).join(', ') : <span className="text-warn">No brands</span>}
                      {mayChange ? <Button size="sm" variant="quiet" className="ml-2" onClick={() => setAccess(m)}>Edit</Button> : null}
                    </Td>
                    <Td className="whitespace-nowrap text-muted">{fmtRelative(m.joined_at)}</Td>
                    <Td className="text-right">
                      {can('members.remove') && !self && canChangeMember(myRole, m.role) ? (
                        <IconButton label={`Remove ${m.email}`} icon={<UserMinus aria-hidden className="size-4" />} onClick={() => setRemoving(m)} />
                      ) : null}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </div>
        <ul className="divide-y divide-border md:hidden">
          {data.members.map((m) => {
            const self = m.user_id === session.user.id;
            const mayChange = can('members.change_role') && !self && canChangeMember(myRole, m.role);
            return (
              <li key={m.user_id} className="flex flex-col gap-2 p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium">{m.name || m.email}{self ? ' (you)' : ''}</p>
                    <p className="truncate text-xs text-muted">{m.email}</p>
                  </div>
                  <Badge>{ROLE_LABEL[m.role]}</Badge>
                </div>
                <p className="text-xs text-muted">{m.brand_ids === null ? 'All brands' : m.brand_ids.map(brandName).join(', ') || 'No brands'}</p>
                {mayChange ? (
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => setAccess(m)}>Access</Button>
                    {can('members.remove') ? <Button size="sm" variant="quiet" className="text-danger!" onClick={() => setRemoving(m)}>Remove</Button> : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Card>

      <Card aria-labelledby="h-invites">
        <CardHeader id="h-invites" title="Invitations" />
        <div className="px-4 pb-4">
          {!data.invitations.length ? <p className="text-[13px] text-muted">None open</p> : (
            <ul className="flex flex-col divide-y divide-border">
              {data.invitations.map((i) => (
                <li key={i.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                  <MailPlus aria-hidden className="size-4 text-muted" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium">{i.email}</p>
                    <p className="truncate text-xs text-muted">
                      {ROLE_LABEL[i.role]} · {i.brand_ids?.length ? i.brand_ids.map(brandName).join(', ') : 'All brands'}
                      {i.invited_by_email ? ` · by ${i.invited_by_email}` : ''}
                    </p>
                  </div>
                  {i.status === 'expired' ? <Badge tone="warn">Expired</Badge> : (
                    <span className="hidden text-xs text-muted sm:inline">Expires <TimeWithZone instant={i.expires_at} tz={session.workspace?.timezone ?? 'UTC'} format="date" /></span>
                  )}
                  {can('members.invite') ? <IconButton label={`Revoke invitation for ${i.email}`} icon={<Trash2 aria-hidden className="size-4" />} onClick={() => setRevoking(i)} /> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} onDone={(inv) => { setLastInvite(inv); void refetch(); }} />
      <AccessDialog member={access} onClose={() => setAccess(null)} onDone={() => void refetch()} />
      <RemoveDialog member={removing} onClose={() => setRemoving(null)} onDone={() => void refetch()} />
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke invitation for ${revoking?.email ?? ''}?`}
        description="The link stops working now."
        confirmLabel="Revoke"
        confirmVariant="danger"
        onConfirm={async () => {
          if (!revoking) return;
          await api.del(`/api/invitations/${revoking.id}`);
          toast.success('Invitation revoked');
          void refetch();
        }}
      />
    </div>
  );
}

function InviteLink({ inv, onDismiss }: { inv: Invitation; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const link = inv.accept_url ?? (inv.token ? `${window.location.origin}/invite/${inv.token}` : null);
  return (
    <Banner
      tone="success"
      role="status"
      title={`Invitation sent to ${inv.email}`}
      actions={<Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button>}
    >
      {link ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label htmlFor="invite-link" className="sr-only">Invitation link</label>
          <Input id="invite-link" readOnly value={link} className="h-8 max-w-[440px] font-mono text-[12px]" onFocus={(e) => e.currentTarget.select()} />
          <Button size="sm" icon={<Copy aria-hidden className="size-4" />} onClick={() => void navigator.clipboard?.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
            {copied ? 'Copied' : 'Copy'}<span className="sr-only"> link</span>
          </Button>
          <p className="w-full text-xs text-muted">
            {inv.email_sent === false ? 'Email not sent — share the link. ' : ''}
            Only {inv.email} can accept. Expires <TimeWithZone instant={inv.expires_at} tz="UTC" />.
          </p>
        </div>
      ) : (
        <p>{inv.email_sent === false ? 'Email not sent. Revoke and retry later.' : 'Only that address can accept.'}</p>
      )}
    </Banner>
  );
}

function BrandAccess({ value, onChange }: { value: string[] | null; onChange: (v: string[] | null) => void }) {
  const { session } = useSession();
  return (
    <div className="flex flex-col gap-3">
      <RadioGroup
        name="brand-access"
        legend="Brand access"
        value={value === null ? 'all' : 'some'}
        onChange={(v) => onChange(v === 'all' ? null : value ?? [])}
        options={[{ value: 'all', label: 'All brands', description: 'Including future brands' }, { value: 'some', label: 'Selected brands' }]}
      />
      {value !== null ? (
        <fieldset className="flex flex-col gap-2 pl-1">
          <legend className="sr-only">Brands</legend>
          {session.brands.map((b) => (
            <Checkbox key={b.id} label={b.name} checked={value.includes(b.id)} onChange={(e) => onChange(e.target.checked ? [...value, b.id] : value.filter((x) => x !== b.id))} />
          ))}
        </fieldset>
      ) : null}
    </div>
  );
}

function InviteDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: (i: Invitation) => void }) {
  const { session } = useSession();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('editor');
  const [brands, setBrands] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!open) {
      setEmail('');
      setRole('editor');
      setBrands(null);
      setError(null);
    }
  }, [open]);
  const emailBad = email.trim() !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const inv = await api.post<Invitation>('/api/invitations', { email: email.trim(), role, brand_ids: brands ?? undefined }, { idempotent: true });
      onDone(inv);
      onOpenChange(false);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const roles = ROLES.filter((r) => r !== 'owner' || session.workspace?.role === 'owner');
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      busy={busy}
      title="Invite"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabledReason={!email.trim() || emailBad ? 'Enter a valid email.' : brands !== null && !brands.length ? 'Pick a brand.' : null}>Send</Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label="Email" error={emailBad ? 'Enter a valid email.' : null}><Input type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <RadioGroup name="role" legend="Role" value={role} onChange={setRole} options={roles.map((r) => ({ value: r, label: ROLE_LABEL[r]!, description: ROLE_HELP[r] }))} />
        <BrandAccess value={brands} onChange={setBrands} />
        {error ? <ErrorNotice error={error} /> : null}
      </div>
    </Dialog>
  );
}

function AccessDialog({ member, onClose, onDone }: { member: Member | null; onClose: () => void; onDone: () => void }) {
  const [brands, setBrands] = useState<string[] | null>(null);
  useEffect(() => setBrands(member?.brand_ids ?? null), [member]);
  return (
    <ConfirmDialog
      open={!!member}
      onOpenChange={(o) => !o && onClose()}
      title={`Brand access for ${member?.name || member?.email || ''}`}
      description="Approved schedules stay in place."
      confirmLabel="Save"
      size="md"
      confirmDisabledReason={brands !== null && !brands.length ? 'Pick a brand.' : null}
      onConfirm={async () => {
        if (!member) return;
        await api.patch(`/api/members/${member.user_id}`, { brand_ids: brands });
        onDone();
      }}
    >
      <BrandAccess value={brands} onChange={setBrands} />
    </ConfirmDialog>
  );
}

function RemoveDialog({ member, onClose, onDone }: { member: Member | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { data, error, loading } = useApi<RemovalImpact>(member ? `/api/members/${member.user_id}/removal-impact` : null);
  return (
    <ConfirmDialog
      open={!!member}
      onOpenChange={(o) => !o && onClose()}
      title={`Remove ${member?.name || member?.email || ''}?`}
      description="Access ends immediately."
      confirmLabel="Remove"
      confirmVariant="danger"
      size="md"
      confirmDisabledReason={loading ? 'Checking…' : null}
      onConfirm={async () => {
        if (!member) return;
        await api.del(`/api/members/${member.user_id}`);
        toast.success('Member removed');
        onDone();
      }}
    >
      {loading ? <Spinner label="Checking" /> : error ? <ErrorNotice error={error} title="Couldn’t load impact" /> : data ? (
        <ul className="flex flex-col gap-1 text-[13px]">
          <li><strong className="tabular">{data.approved_schedules_remaining}</strong> approved schedule{data.approved_schedules_remaining === 1 ? '' : 's'} still publish</li>
          <li><strong className="tabular">{data.drafts_losing_access}</strong> draft{data.drafts_losing_access === 1 ? '' : 's'} no longer accessible</li>
          <li><strong className="tabular">{data.pending_approvals}</strong> pending approval{data.pending_approvals === 1 ? '' : 's'} need someone else</li>
        </ul>
      ) : null}
    </ConfirmDialog>
  );
}
