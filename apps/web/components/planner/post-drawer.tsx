'use client';
// Post side drawer (Overview upcoming, Planner): variants, owner, review and delivery for one scheduled post.
// Reads /api/posts/:id (same authorization as opening the post); actions reuse the existing flows.
import { CalendarClock, Copy, SquareArrowOutUpRight } from 'lucide-react';
import { PROVIDER_LABEL } from '@social-lite/core';
import { useApi } from '@/lib/client/use-api';
import { fmtDateTime, postTitle, zoneAbbr } from '@/lib/client/format';
import type { PlannerItem, PostDetail } from '@/lib/client/types';
import {
  Button, DeliveryStateBadge, DetailDrawer, DrawerSection, ErrorState, Facts, LinkButton, PlatformIcon, PostStatusBadge, SkeletonRows, Thumb,
} from '@/components/ui';

export function PostDrawer({
  item, onOpenChange, brandName, onReschedule, onDuplicate,
}: {
  item: PlannerItem | null; onOpenChange: (o: boolean) => void; brandName?: string;
  onReschedule?: (i: PlannerItem) => void; onDuplicate?: (i: PlannerItem) => void;
}) {
  const { data, error, loading, refetch } = useApi<PostDetail>(item ? `/api/posts/${item.post_id}` : null);
  const allMock = !!item && item.destinations.length > 0 && item.destinations.every((d) => d.is_mock);
  const due = item ? new Date(item.due_at) : null;
  return (
    <DetailDrawer
      open={!!item}
      onOpenChange={onOpenChange}
      title={item ? postTitle(item) : ''}
      meta={item && due ? (
        <>
          <PostStatusBadge status={item.status} simulated={allMock} overdue={item.overdue} size="sm" />
          <span className="tabular">{fmtDateTime(due, item.input_timezone)} {zoneAbbr(due, item.input_timezone)}</span>
          {brandName ? <span className="truncate">{brandName}</span> : null}
        </>
      ) : null}
      footer={item ? (
        <>
          {onDuplicate ? <Button variant="ghost" icon={<Copy aria-hidden className="size-4" />} onClick={() => onDuplicate(item)}>Duplicate</Button> : null}
          {onReschedule ? <Button variant="secondary" icon={<CalendarClock aria-hidden className="size-4" />} onClick={() => onReschedule(item)}>Reschedule</Button> : null}
          <LinkButton href={`/posts/${item.post_id}`} variant="primary" icon={<SquareArrowOutUpRight aria-hidden className="size-4" />}>Open post</LinkButton>
        </>
      ) : null}
    >
      {!item ? null : (
        <>
          {item.thumb_url ? (
            <div className="mb-4"><Thumb src={item.thumb_url} kind={item.media_kind} className="aspect-video w-full rounded-xl" /></div>
          ) : null}
          <DrawerSection title="Owner">
            <Facts items={[
              ['Team', item.team?.name ?? '—'],
              ['Assignee', item.assignee ? (item.assignee.name || item.assignee.email || '—') : '—'],
              ['Campaign', item.campaign?.name ?? '—'],
              ['Review', item.review ? `${item.review.decision === 'pending' ? 'Pending' : item.review.decision}${item.review.stage_count > 1 ? ` · stage ${item.review.stage}/${item.review.stage_count}` : ''}` : '—'],
              ['Scheduled in', item.input_timezone.replace(/_/g, ' ')],
            ]} />
          </DrawerSection>
          {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <SkeletonRows rows={3} /> : (
            <>
              <DrawerSection title={`Destinations · ${item.destinations.length}`}>
                <ul className="flex flex-col divide-y divide-border">
                  {item.destinations.map((d) => {
                    const conn = data.connections.find((c) => c.id === d.connection_id);
                    const variant = data.draft.variants.find((v) => v.connectionId === d.connection_id);
                    const delivery = data.deliveries.find((x) => x.connection_id === d.connection_id);
                    return (
                      <li key={d.connection_id} className="py-3 first:pt-0 last:pb-0">
                        <div className="flex items-center gap-3">
                          <PlatformIcon provider={d.provider} size="sm" />
                          <div className="min-w-0 flex-1">
                            <p className="flex items-center gap-2 truncate text-[13px] font-medium">{conn?.display_name ?? PROVIDER_LABEL[d.provider]}</p>
                            <p className="text-xs text-muted">{variant && !variant.inheritText ? 'Custom text' : 'Base text'}{variant && !variant.inheritMedia ? ' · custom media' : ''}</p>
                          </div>
                          <DeliveryStateBadge state={d.state} isMock={d.is_mock} overdue={d.overdue} size="sm" />
                        </div>
                        {delivery && (delivery.last_error_message || delivery.blocked_reason) ? (
                          <p className="mt-1.5 pl-10 text-xs text-muted">{delivery.blocked_reason ?? delivery.last_error_message}</p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </DrawerSection>
              <DrawerSection title="Base text">
                <p className="line-clamp-6 whitespace-pre-wrap break-words text-[13px]">{data.draft.baseText || <span className="text-muted">Empty</span>}</p>
              </DrawerSection>
            </>
          )}
        </>
      )}
    </DetailDrawer>
  );
}
