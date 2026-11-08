'use client';
// Support access, workspace side (V3.1 Admin §13). Relay staff can only see private content after an owner/admin here
// approves a reasoned, time-boxed, read-only request. Approval needs a fresh sign-in; either side can end it any time.
import { duration } from '@/components/admin/ui';
import { useState } from 'react';
import { LifeBuoy } from 'lucide-react';
import type { SupportAccessDto } from '@social-lite/core/contracts/v31-admin';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Facts, Field, PageHeader, SkeletonRows, Textarea, useToast } from '@/components/ui';
import { useAdminTopics } from '@/components/admin/sync';
import { Ago } from '@/components/admin/ui';
import { SUPPORT_TONE } from '@/components/admin/badges';

const mins = (m: number) => duration(m * 60);

export default function WorkspaceSupportAccessPage() {
  const { refresh } = useSession();
  const toast = useToast();
  const { data, error, loading, refetch } = useApi<{ items: SupportAccessDto[]; can_decide: boolean }>('/api/admin/support-access');
  useAdminTopics(['support', 'access'], refetch);
  const [deciding, setDeciding] = useState<{ g: SupportAccessDto; decision: 'approve' | 'decline' } | null>(null);
  const [ending, setEnding] = useState<SupportAccessDto | null>(null);
  const [note, setNote] = useState('');
  const done = async (msg: string) => { toast.success(msg); await refetch(); await refresh(); };
  return (
    <>
      <PageHeader title="Support access" />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <SkeletonRows rows={4} /> : !data.items.length ? (
        <EmptyState icon={<LifeBuoy aria-hidden />} title="No support requests" />
      ) : (
        <ul className="flex flex-col gap-3">
          {data.items.map((g) => (
            <Card as="li" key={g.id} className="p-4">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-[14px] font-medium">{g.operator.name || g.operator.email}<Badge tone={SUPPORT_TONE[g.status]}>{g.status}</Badge><span className="text-xs font-normal text-muted">Read-only · {mins(g.duration_minutes)}</span></p>
                  <p className="mt-1 text-[13px]">{g.reason}</p>
                  <Facts className="mt-3" items={[
                    ['Requested', <Ago key="r" at={g.requested_at} />],
                    ...(g.ticket_ref ? [['Ticket', g.ticket_ref] as [string, string]] : []),
                    ...(g.status === 'active' ? [['Ends', <Ago key="e" at={g.expires_at} />] as [string, React.ReactNode]] : []),
                    ...(g.decided_by ? [['Decided by', g.decided_by] as [string, string]] : []),
                    ...(g.end_reason ? [['Ended', `${g.end_reason.replace(/_/g, ' ')}`] as [string, string]] : []),
                  ]} />
                </div>
                {data.can_decide ? (
                  <div className="flex flex-wrap gap-2">
                    {g.status === 'requested' ? <>
                      <Button size="sm" onClick={() => setDeciding({ g, decision: 'decline' })}>Decline</Button>
                      <Button size="sm" variant="primary" onClick={() => setDeciding({ g, decision: 'approve' })}>Approve</Button>
                    </> : null}
                    {g.status === 'active' ? <Button size="sm" variant="danger" onClick={() => setEnding(g)}>End now</Button> : null}
                  </div>
                ) : null}
              </div>
            </Card>
          ))}
        </ul>
      )}
      <ConfirmDialog open={!!deciding} onOpenChange={(o) => { if (!o) { setDeciding(null); setNote(''); } }}
        title={deciding?.decision === 'approve' ? `Give ${deciding.g.operator.email} read-only access for ${mins(deciding.g.duration_minutes)}?` : 'Decline this request?'}
        description={deciding?.decision === 'approve' ? 'They can read posts, media and settings in this workspace until it ends. They can’t change, approve or publish anything. You can end it any time.' : undefined}
        confirmLabel={deciding?.decision === 'approve' ? 'Approve' : 'Decline'} confirmVariant={deciding?.decision === 'approve' ? 'primary' : 'danger'}
        onConfirm={async () => { if (!deciding) return; await api.post(`/api/admin/support-access/${deciding.g.id}/decision`, { decision: deciding.decision, note: note.trim() || null }); setNote(''); await done(deciding.decision === 'approve' ? 'Access granted' : 'Declined'); }}>
        <Field label="Note" optional><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
      </ConfirmDialog>
      <ConfirmDialog open={!!ending} onOpenChange={(o) => !o && setEnding(null)} title="End support access now?" confirmLabel="End access" confirmVariant="danger"
        description="Their access stops on their next request."
        onConfirm={async () => { if (!ending) return; await api.post(`/api/admin/support-access/${ending.id}/end`, {}); await done('Access ended'); }} />
    </>
  );
}
