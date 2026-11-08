'use client';
import { useState } from 'react';
import { CalendarX2 } from 'lucide-react';
import { IN_FLIGHT_DELIVERY_STATES, TERMINAL_DELIVERY_STATES, aggregateStatus } from '@social-lite/core';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import type { Delivery, PostDetail, Schedule } from '@/lib/client/types';
import { Banner, Button, Card, CardHeader, ConfirmDialog, ErrorState, Facts, InfoTip, PostStatusBadge, SkeletonRows, TimeWithZone, useToast } from '@/components/ui';
import { DeliveryCard } from '@/components/deliveries/delivery-card';

const SCHEDULE_STATUS: Record<Schedule['status'], string> = {
  pending_approval: 'Awaiting approval', active: 'Active', superseded: 'Superseded',
  cancelled: 'Cancelled', completed: 'Completed', rejected: 'Rejected',
};

/** Per-destination delivery tracking with polling while anything is still in progress (DE-01/DE-02). */
export function DeliveriesPanel({ post, onChanged }: { post: PostDetail; onChanged: () => void }) {
  const toast = useToast();
  const [cancelOpen, setCancelOpen] = useState(false);
  const { data, error, loading, refetch, setData } = useApi<{ items: Delivery[] }>(`/api/posts/${post.id}/deliveries`, {
    poll: (d) => (d?.items.some((x) => !TERMINAL_DELIVERY_STATES.has(x.state)) ? 5_000 : false),
  });
  const s = post.current_schedule;
  const tz = s?.input_timezone ?? post.brand.timezone;
  const items = data?.items ?? post.deliveries;
  const states = items.map((d) => d.state);
  const agg = states.length ? aggregateStatus(states) : post.status;
  const inFlight = items.filter((d) => IN_FLIGHT_DELIVERY_STATES.has(d.state));
  const allMock = items.length > 0 && items.every((d) => d.is_mock);
  const counts = {
    ok: items.filter((d) => d.state === 'published').length,
    bad: items.filter((d) => d.state === 'failed' || d.state === 'expired').length,
    attention: items.filter((d) => d.state === 'unknown' || d.state === 'blocked').length,
  };

  if (!s && !items.length) return null;

  const cancel = async () => {
    if (!s) return;
    const res = await api.post<{ schedule: Schedule; deliveries: Delivery[]; message?: string }>(`/api/schedules/${s.id}/cancel`, {});
    setData({ items: res.deliveries });
    toast.info('Cancellation requested', res.message);
    onChanged();
  };

  return (
    <Card id="deliveries" aria-labelledby="h-deliveries" className="scroll-mt-6">
      <CardHeader
        id="h-deliveries"
        title="Delivery"
        actions={
          <>
            {items.length ? <PostStatusBadge status={agg} simulated={allMock} /> : null}
            {post.can.cancel && s && (s.status === 'active' || s.status === 'pending_approval') ? (
              <Button size="sm" variant="quiet" className="text-danger!" icon={<CalendarX2 aria-hidden className="size-4" />} onClick={() => setCancelOpen(true)}>Cancel<span className="sr-only"> schedule</span></Button>
            ) : null}
          </>
        }
      />
      <div className="flex flex-col gap-4 px-4 pb-4">
        {s ? (
          <Facts
            items={[
              [s.is_immediate ? 'Requested' : 'Scheduled', <TimeWithZone key="d" instant={s.due_at} tz={s.input_timezone} showBrowser />],
              ['Zone', s.input_timezone],
              ...(s.publish_before ? [[<span key="pbl" className="inline-flex items-center gap-1">Deadline<InfoTip label="About the deadline">Not sent after this time — it expires instead of posting late.</InfoTip></span>, <TimeWithZone key="pb" instant={s.publish_before} tz={s.input_timezone} />] as [React.ReactNode, React.ReactNode]] : []),
              ['Status', <span key="st" title={`Revision ${s.revision_number} · version ${s.generation}`}>{SCHEDULE_STATUS[s.status] ?? s.status} · r{s.revision_number}</span>],
              ...(s.created_by_email ? [['By', <span key="by" className="block truncate">{s.created_by_email}</span>] as [string, React.ReactNode]] : []),
            ]}
          />
        ) : null}

        {post.approval?.decision === 'pending' ? <Banner tone="info" title="Awaiting approval — nothing sends until approved" /> : null}
        {post.approval?.decision === 'rejected' ? (
          <Banner tone="danger" title={`Changes requested${post.approval.reviewer_email ? ` by ${post.approval.reviewer_email}` : ''}`}>{post.approval.reason}</Banner>
        ) : null}
        {post.approval?.decision === 'invalidated' ? <Banner tone="warn" title="Approval invalidated — submit again" /> : null}
        {agg === 'partial' ? (
          <Banner tone="warn" title={`${counts.ok} of ${items.length} ${allMock ? 'delivered (simulated)' : 'published'}`}>
            Retry only re-sends the failed ones.
          </Banner>
        ) : null}

        {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading && !items.length ? <SkeletonRows rows={2} /> : (
          <div className="flex flex-col divide-y divide-border">
            {items.map((d) => (
              <DeliveryCard
                key={d.id}
                delivery={d}
                tz={tz}
                onChanged={(nd) => {
                  setData((prev) => ({ items: (prev?.items ?? items).map((x) => (x.id === nd.id ? { ...x, ...nd } : x)) }));
                  void refetch();
                  onChanged();
                }}
              />
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Cancel schedule?"
        confirmLabel="Cancel schedule"
        confirmVariant="danger"
        onConfirm={cancel}
        description="Unstarted destinations won’t send. The draft is kept."
      >
        {inFlight.length ? (
          <Banner tone="warn" title="Already sending">
            {inFlight.map((d) => d.display_name).join(', ')} may still publish — this can’t be stopped.
          </Banner>
        ) : null}
      </ConfirmDialog>
    </Card>
  );
}
