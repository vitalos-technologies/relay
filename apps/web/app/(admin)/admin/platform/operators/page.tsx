'use client';
// Platform → Operators: who can use the platform scope. Changes need a fresh sign-in; nobody changes their own role.
// Bootstrap and break-glass: `pnpm platform:operator grant <email>` on the server (audited as 'cli').
import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import type { PlatformOperatorDto } from '@social-lite/core/contracts/v31-admin';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { Badge, Button, Card, ErrorState, Field, Input, PageHeader, Select, SkeletonRows, useToast } from '@/components/ui';
import { Ago, ReasonDialog, RecordList } from '@/components/admin/ui';

export default function PlatformOperatorsPage() {
  const { session } = useSession();
  const toast = useToast();
  const { data, error, loading, refetch } = useApi<{ items: PlatformOperatorDto[] }>('/api/platform/operators');
  const [add, setAdd] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'operator' | 'support' | 'billing'>('support');
  const [revoke, setRevoke] = useState<PlatformOperatorDto | null>(null);
  return (
    <>
      <PageHeader title="Operators" actions={<Button size="sm" variant="primary" icon={<UserPlus aria-hidden className="size-4" />} onClick={() => setAdd(true)}>Add</Button>} />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <SkeletonRows rows={3} /> : (
        <Card className="overflow-hidden">
          <RecordList caption="Operators" rows={data.items} rowKey={(o) => o.user_id}
            columns={[
              { key: 'e', label: 'Person', cell: (o) => <span className="font-medium">{o.email}{o.user_id === session.user.id ? <span className="text-muted"> (you)</span> : null}</span> },
              { key: 'r', label: 'Role', cell: (o) => <Badge tone={o.role === 'operator' ? 'info' : 'neutral'}>{o.role}</Badge> },
              { key: 's', label: 'Status', cell: (o) => o.revoked_at ? <Badge>Revoked</Badge> : <Badge tone="success">Active</Badge> },
              { key: 'g', label: 'Since', secondary: true, cell: (o) => <span className="text-muted"><Ago at={o.granted_at} /> · {o.granted_via}</span> },
              { key: 'x', label: <span className="sr-only">Action</span>, cell: (o) => !o.revoked_at ? <Button size="sm" variant="ghost" disabledReason={o.user_id === session.user.id ? 'Not your own role' : null} onClick={() => setRevoke(o)}>Revoke</Button> : null },
            ]}
            card={(o) => <span className="flex flex-col gap-1"><span className="font-medium">{o.email}</span><span className="flex gap-2 text-xs"><Badge>{o.role}</Badge>{o.revoked_at ? <Badge>Revoked</Badge> : null}</span></span>} />
        </Card>
      )}
      <ReasonDialog open={add} onOpenChange={setAdd} title="Add a platform operator" confirmLabel="Add"
        description="They must already have signed in to Relay once. Support staff see platform metadata and can request support access. Billing staff manage billing records, trials and plans — no customer content or support access."
        onConfirm={async (reason) => { await api.post('/api/platform/operators', { email: email.trim(), role, reason }); setEmail(''); toast.success('Added'); await refetch(); }}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Email"><Input type="email" inputMode="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Role"><Select value={role} onChange={(e) => setRole(e.target.value as 'operator' | 'support' | 'billing')}><option value="support">Support</option><option value="billing">Billing</option><option value="operator">Operator</option></Select></Field>
        </div>
      </ReasonDialog>
      <ReasonDialog open={!!revoke} onOpenChange={(o) => !o && setRevoke(null)} title={`Revoke ${revoke?.email}?`} confirmLabel="Revoke" confirmVariant="danger"
        description="Effective on their next request. Their open support access ends too."
        onConfirm={async (reason) => { if (!revoke) return; await api.post(`/api/platform/operators/${revoke.user_id}/revoke`, { reason }); toast.success('Revoked'); await refetch(); }} />
    </>
  );
}
