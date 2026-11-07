'use client';
// Platform → Accounts: find a Relay sign-in and suspend/reactivate it (all sessions end). Workspace memberships stay as
// they are — each workspace decides about its own members.
import { useState } from 'react';
import { Search } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { Badge, Button, Card, EmptyState, ErrorState, Input, PageHeader, SkeletonRows, useToast } from '@/components/ui';
import { Ago, ReasonDialog, RecordList } from '@/components/admin/ui';

interface Acct { id: string; email: string; name: string | null; disabled_at: string | null; last_login_at: string | null; workspaces: number; operator: string | null }

export default function PlatformAccountsPage() {
  const { session } = useSession();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const { data, error, loading, refetch } = useApi<{ items: Acct[] }>(term.length >= 3 ? `/api/platform/accounts?q=${encodeURIComponent(term)}` : null);
  const [target, setTarget] = useState<Acct | null>(null);
  const operator = session.platform_role === 'operator';
  return (
    <>
      <PageHeader title="Accounts" />
      <form role="search" className="relative mb-4 max-w-md" onSubmit={(e) => { e.preventDefault(); setTerm(q.trim()); }}>
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
        <Input aria-label="Find an account" placeholder="Email or name (3+ characters)" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
      </form>
      {term.length < 3 ? <EmptyState icon={<Search aria-hidden />} title="Search to find an account" /> : error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <SkeletonRows rows={4} /> : !data.items.length ? <EmptyState title="No accounts match" /> : (
        <Card className="overflow-hidden">
          <RecordList caption="Accounts" rows={data.items} rowKey={(a) => a.id}
            columns={[
              { key: 'e', label: 'Account', cell: (a) => <span><span className="block font-medium">{a.email}</span>{a.name ? <span className="text-xs text-muted">{a.name}</span> : null}</span> },
              { key: 's', label: 'Status', cell: (a) => <span className="inline-flex gap-1">{a.disabled_at ? <Badge tone="danger">Suspended</Badge> : <Badge tone="success">Active</Badge>}{a.operator ? <Badge tone="info">{a.operator}</Badge> : null}</span> },
              { key: 'w', label: 'Workspaces', cell: (a) => <span className="tabular">{a.workspaces}</span> },
              { key: 'l', label: 'Last sign-in', cell: (a) => <Ago at={a.last_login_at} className="text-muted" /> },
              { key: 'x', label: <span className="sr-only">Action</span>, cell: (a) => <Button size="sm" variant={a.disabled_at ? 'secondary' : 'danger'} disabledReason={!operator ? 'Operators only' : a.id === session.user.id ? 'Not your own account' : null} onClick={() => setTarget(a)}>{a.disabled_at ? 'Reactivate' : 'Suspend'}</Button> },
            ]}
            card={(a) => (
              <span className="flex flex-col gap-2">
                <span className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate font-medium">{a.email}</span>{a.disabled_at ? <Badge tone="danger">Suspended</Badge> : <Badge tone="success">Active</Badge>}</span>
                <span className="text-xs text-muted">{a.workspaces} workspaces · <Ago at={a.last_login_at} /></span>
                <Button size="sm" variant={a.disabled_at ? 'secondary' : 'danger'} className="self-start" disabledReason={!operator ? 'Operators only' : a.id === session.user.id ? 'Not your own account' : null} onClick={() => setTarget(a)}>{a.disabled_at ? 'Reactivate' : 'Suspend'}</Button>
              </span>
            )} />
        </Card>
      )}
      <ReasonDialog open={!!target} onOpenChange={(o) => !o && setTarget(null)} confirmVariant={target?.disabled_at ? 'primary' : 'danger'}
        title={target?.disabled_at ? `Reactivate ${target.email}?` : `Suspend ${target?.email}?`}
        description={target?.disabled_at ? 'They can sign in again.' : 'Sign-in is blocked and every session ends now. Their workspace memberships and scheduled posts are not changed; workspaces decide about those.'}
        confirmLabel={target?.disabled_at ? 'Reactivate' : 'Suspend account'}
        onConfirm={async (reason) => {
          if (!target) return;
          const r = await api.post<{ sessions_revoked?: number }>(`/api/platform/accounts/${target.id}/${target.disabled_at ? 'reactivate' : 'suspend'}`, { reason });
          toast.success(target.disabled_at ? 'Reactivated' : `Suspended · ${r.sessions_revoked ?? 0} sessions ended`); await refetch();
        }} />
    </>
  );
}
