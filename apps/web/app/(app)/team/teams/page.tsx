'use client';
// Teams directory: members, managers, team grants (publishing teams flagged), delegation ceiling.
import Link from 'next/link';
import { useState } from 'react';
import { Plus, Send, ShieldAlert, Users } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { useApi } from '@/lib/client/use-api';
import { Badge, Button, Card, Dialog, EmptyState, ErrorNotice, ErrorState, Field, Input, PageHeader, SkeletonRows, Tooltip, useToast } from '@/components/ui';
import { TeamNav, V2_ROLE_LABEL, type TeamView } from '@/components/team/shared';


export default function TeamsPage() {
  const { canV2 } = useSession();
  const { data, error, loading, refetch } = useApi<{ items: TeamView[] }>(canV2('teams.read') ? '/api/teams' : null);
  const [open, setOpen] = useState(false);
  if (!canV2('teams.read')) return (<><PageHeader title="Team" /><TeamNav /><EmptyState icon={<ShieldAlert aria-hidden />} title="No access" /></>);
  return (
    <>
      <PageHeader title="Team" actions={canV2('teams.manage') ? <Button variant="primary" icon={<Plus aria-hidden className="size-4" />} onClick={() => setOpen(true)}>New team</Button> : null} />
      <TeamNav />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <SkeletonRows rows={3} /> : !data.items.length ? (
        <EmptyState icon={<Users aria-hidden />} title="No teams yet" />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {data.items.map((t) => (
            <Link key={t.id} href={`/team/teams/${t.id}`} className="block rounded-xl focus-visible:outline-2">
              <Card className="h-full p-4 transition-colors hover:bg-raised">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="min-w-0 truncate text-[15px] font-semibold">{t.name}</h2>
                  {t.publishing ? <Tooltip content="Members can schedule/publish: adding someone is a privilege grant"><span><Badge tone="info" icon={<Send aria-hidden className="size-3" />}>Publishing</Badge></span></Tooltip> : null}
                </div>
                <p className="mt-1 text-[12px] text-muted">{t.member_count} member{t.member_count === 1 ? '' : 's'}{t.managers.length ? ` · ★ ${t.managers.map((m) => m.name || m.email).join(', ')}` : ''}</p>
                <div className="mt-3 flex flex-wrap gap-1">
                  {t.grants.length ? t.grants.map((g) => <Badge key={g.id}>{V2_ROLE_LABEL[g.role]} · {g.brand_name ?? 'All brands'}</Badge>) : <span className="text-[12px] text-muted">No access</span>}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
      <NewTeamDialog open={open} onOpenChange={setOpen} onDone={() => void refetch()} />
    </>
  );
}

function NewTeamDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const t = await api.post<TeamView>('/api/teams', { name: name.trim() });
      toast.success(`${t.name} created`);
      setName('');
      onOpenChange(false);
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New team" busy={busy} size="sm"
      footer={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void submit()} disabledReason={name.trim() ? undefined : 'Enter a name'}>Create</Button></>}>
      <Field label="Name"><Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></Field>
      {err ? <ErrorNotice error={err} className="mt-3" /> : null}
    </Dialog>
  );
}
