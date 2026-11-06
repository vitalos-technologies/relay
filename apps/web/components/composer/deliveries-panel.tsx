'use client';
import { useState } from 'react';
import { CalendarX2 } from 'lucide-react';
import { IN_FLIGHT_DELIVERY_STATES, TERMINAL_DELIVERY_STATES, aggregateStatus } from '@social-lite/core';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import type { Delivery, PostDetail, Schedule } from '@/lib/client/types';
import { Banner, Button, Card, CardHeader, ConfirmDialog, ErrorState, Facts, PostStatusBadge, SkeletonRows, TimeWithZone, useToast } from '@/components/ui';
import { DeliveryCard } from '@/components/deliveries/delivery-card';

const SCHEDULE_STATUS: Record<Schedule['status'], string> = {
  pending_approval: 'Waiting for approval', active: 'Active', superseded: 'Replaced by a newer schedule',
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
    toast.info('Cancellation requested', res.message ?? 'Destinations that hadn’t started were cancelled.');
    onChanged();
  };

  return (
    <Card id="deliveries" aria-labelledby="h-deliveries" className="scroll-mt-6">
      <CardHeader
        id="h-deliveries"
        title="Delivery"
        description={items.length ? `${items.length} destination${items.length === 1 ? '' : 's'} · ${counts.ok} ${allMock ? 'simulated' : 'published'}${counts.bad ? ` · ${counts.bad} failed or expired` : ''}${counts.attention ? ` · ${counts.attention} need attention` : ''}` : undefined}
        actions={
          <>
            {items.length ? <PostStatusBadge status={agg} simulated={allMock} /> : null}
            {post.can.cancel && s && (s.status === 'active' || s.status === 'pending_approval') ? (
              <Button size="sm" variant="danger" icon={<CalendarX2 aria-hidden className="size-4" />} onClick={() => setCancelOpen(true)}>Cancel schedule</Button>
            ) : null}
          </>
        }
      />
      <div className="flex flex-col gap-4 p-4">
        {s ? (
          <Facts
            items={[
              [s.is_immediate ? 'Requested' : 'Scheduled for', <TimeWithZone key="d" instant={s.due_at} tz={s.input_timezone} showBrowser />],
              ['Time zone', s.input_timezone],
              ...(s.publish_before ? [['Publish before', <TimeWithZone key="pb" instant={s.publish_before} tz={s.input_timezone} />] as [string, React.ReactNode]] : []),
              ['Schedule', `${SCHEDULE_STATUS[s.status] ?? s.status} · revision ${s.revision_number} · version ${s.generation}`],
              ...(s.created_by_email ? [['Scheduled by', s.created_by_email] as [string, string]] : []),
            ]}
          />
        ) : null}

        {post.approval?.decision === 'pending' ? <Banner tone="info" title="Waiting for approval">Requested by {post.approval.requested_by_email ?? 'a teammate'}. Nothing will be sent until it’s approved.</Banner> : null}
        {post.approval?.decision === 'rejected' ? (
          <Banner tone="danger" title={`Changes requested${post.approval.reviewer_email ? ` by ${post.approval.reviewer_email}` : ''}`}>{post.approval.reason}</Banner>
        ) : null}
        {post.approval?.decision === 'invalidated' ? <Banner tone="warn" title="Approval no longer valid">The content or time changed after approval. Submit it again.</Banner> : null}
        {agg === 'partial' ? (
          <Banner tone="warn" title="Partial success">
            {counts.ok} of {items.length} destinations {allMock ? 'completed (simulated)' : 'published'}. Retrying only re-sends the destinations that didn’t succeed.
          </Banner>
        ) : null}

        {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading && !items.length ? <SkeletonRows rows={2} /> : (
          <div className="flex flex-col gap-3">
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
        title="Cancel this schedule?"
        confirmLabel="Cancel schedule"
        confirmVariant="danger"
        onConfirm={cancel}
        description="Destinations that haven’t started are cancelled and won’t be sent. The draft is kept."
      >
        {inFlight.length ? (
          <Banner tone="warn" title="Some destinations are already being sent">
            {inFlight.map((d) => d.display_name).join(', ')} {inFlight.length === 1 ? 'is' : 'are'} in progress. Cancellation is requested, but publication may already be happening and can’t be guaranteed to stop.
          </Banner>
        ) : null}
      </ConfirmDialog>
    </Card>
  );
}
