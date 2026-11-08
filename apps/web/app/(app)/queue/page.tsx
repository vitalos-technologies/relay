'use client';
// V3.1 §13 evergreen content queue (flag v31.content_queue): inspect, pause/resume, remove items, and schedule the next
// eligible item into the next posting slot (Idempotency-Key). An item is used once; slots never repost the same content.
import Link from 'next/link';
import { useState } from 'react';
import { CalendarPlus, CirclePause, CirclePlay, ListOrdered, Trash2, TriangleAlert } from 'lucide-react';
import type { ContentQueueDto, ContentQueueItemDto } from '@social-lite/core/contracts/v31-gov';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { useBrandFilter } from '@/lib/client/hooks';
import { useFlag } from '@/lib/client/flags';
import { fmtDateTime, fmtRelative } from '@/lib/client/format';
import {
  Badge, Banner, Button, Card, ConfirmDialog, EmptyState, ErrorNotice, ErrorState, Field, IconButton, Input, LinkButton, PageHeader, Select, SkeletonRows,
  Tooltip, useToast,
} from '@/components/ui';

export default function QueuePage() {
  const on = useFlag('v31.content_queue');
  const { session } = useSession();
  const [brandFilter] = useBrandFilter();
  const [local, setLocal] = useState(session.brands[0]?.id ?? '');
  const brandId = brandFilter || local;
  if (!on) return <><PageHeader title="Content queue" /><EmptyState icon={<ListOrdered aria-hidden />} title="Not turned on" /></>;
  return (
    <>
      <PageHeader
        title="Content queue"
        actions={!brandFilter && session.brands.length > 1 ? (
          <div className="min-w-[200px]">
            <label htmlFor="q-brand" className="sr-only">Brand</label>
            <Select id="q-brand" value={local} onChange={(e) => setLocal(e.target.value)}>{session.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
          </div>
        ) : null}
      />
      {brandId ? <QueueView key={brandId} brandId={brandId} /> : <EmptyState icon={<ListOrdered aria-hidden />} title="No brands yet" />}
    </>
  );
}

function QueueView({ brandId }: { brandId: string }) {
  const toast = useToast();
  const { session } = useSession();
  const tz = session.brands.find((b) => b.id === brandId)?.timezone ?? 'UTC';
  const { data, error, loading, refetch, setData } = useApi<ContentQueueDto>(`/api/brands/${brandId}/content-queue`);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [removing, setRemoving] = useState<ContentQueueItemDto | null>(null);
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />;
  if (loading || !data) return <Card><SkeletonRows rows={4} className="p-2" /></Card>;
  const queued = data.items.filter((i) => i.status === 'queued');
  const done = data.items.filter((i) => i.status === 'scheduled');
  const run = async (k: string, f: () => Promise<unknown>) => {
    setBusy(k); setErr(null);
    try { await f(); } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  const scheduleNext = () => run('next', async () => {
    const key = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `q-${Date.now()}-${Math.random()}`;
    const r = await api.post<{ post_id: string; schedule_id: string; skipped: unknown[] }>(`/api/brands/${brandId}/content-queue/next`, {}, { idempotent: key });
    toast.success('Scheduled into the next slot', r.skipped.length ? `${r.skipped.length} skipped (not eligible)` : undefined);
    await refetch();
  });
  return (
    <div className="flex flex-col gap-6">
      {data.paused ? (
        <Banner tone="warn" icon={<CirclePause aria-hidden className="size-4 text-warn" />} title="Queue paused"
          actions={data.can.resume ? <Button size="sm" variant="secondary" icon={<CirclePlay aria-hidden className="size-4" />} loading={busy === 'resume'} onClick={() => void run('resume', async () => setData(await api.patch<ContentQueueDto>(`/api/brands/${brandId}/content-queue`, { paused: false })))}>Resume</Button> : null}>
          {data.paused_reason ? <p className="text-muted">{data.paused_reason}</p> : null}
        </Banner>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral">{queued.length} queued</Badge>
        <span className="flex-1" />
        {!data.paused && data.can.pause ? <Button variant="ghost" icon={<CirclePause aria-hidden className="size-4" />} onClick={() => setPauseOpen(true)}>Pause</Button> : null}
        <LinkButton href="/settings/publishing/slots" variant="ghost">Slots</LinkButton>
        {data.can.schedule_next ? (
          <Button variant="primary" icon={<CalendarPlus aria-hidden className="size-4" />} loading={busy === 'next'} onClick={() => void scheduleNext()}
            disabledReason={data.paused ? 'Resume the queue first.' : !queued.some((i) => i.eligibility.eligible) ? 'Nothing eligible.' : null}>Schedule next</Button>
        ) : null}
      </div>
      {err ? <ErrorNotice error={err} /> : null}
      {!queued.length ? (
        <EmptyState icon={<ListOrdered aria-hidden />} title="Queue is empty" />
      ) : (
        <Card>
          <ol aria-label="Queued posts" className="divide-y divide-border">
            {queued.map((i, n) => (
              <li key={i.id} className="flex items-start gap-3 px-4 py-3" data-testid={`queue-${i.post_id}`}>
                <span className="mt-0.5 w-6 shrink-0 text-right text-xs text-subtle tabular">{n + 1}</span>
                <div className="min-w-0 flex-1">
                  <Link href={`/posts/${i.post_id}`} className="block truncate text-[14px] font-medium hover:underline">{i.title?.trim() || 'Untitled post'}</Link>
                  <p className="truncate text-xs text-muted">{i.excerpt}</p>
                  {!i.eligibility.eligible ? (
                    <ul className="mt-1 flex flex-col gap-0.5">
                      {i.eligibility.reasons.map((r) => <li key={r.code} className="flex items-start gap-1.5 text-xs text-warn"><TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />{r.message}</li>)}
                    </ul>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {i.eligibility.eligible ? <Badge tone="success">Eligible</Badge> : <Badge tone="warn">Skipped</Badge>}
                  <span className="hidden text-xs text-subtle sm:inline">Added {fmtRelative(i.added_at)}</span>
                  {data.can.add ? <IconButton size="sm" label={`Remove ${i.title ?? 'post'} from queue`} icon={<Trash2 aria-hidden className="size-4" />} onClick={() => setRemoving(i)} /> : null}
                </div>
              </li>
            ))}
          </ol>
        </Card>
      )}
      {done.length ? (
        <section aria-labelledby="q-used">
          <h2 id="q-used" className="mb-2 text-[13px] font-semibold text-muted">Used</h2>
          <ul className="flex flex-col gap-1 text-[13px]">
            {done.slice(0, 10).map((i) => (
              <li key={i.id} className="flex items-center gap-2">
                <Link href={`/posts/${i.post_id}`} className="truncate hover:underline">{i.title?.trim() || 'Untitled post'}</Link>
                {i.scheduled_at ? <Tooltip content="Scheduled from the queue"><span className="shrink-0 text-xs text-muted">{fmtDateTime(i.scheduled_at, tz)}</span></Tooltip> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <ConfirmDialog
        open={pauseOpen}
        onOpenChange={setPauseOpen}
        title="Pause the queue?"
        description="Nothing is taken from it until you resume."
        confirmLabel="Pause"
        onConfirm={async () => { setData(await api.patch<ContentQueueDto>(`/api/brands/${brandId}/content-queue`, { paused: true, reason: reason.trim() || undefined })); setReason(''); }}
      >
        <Field label="Reason" optional><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} /></Field>
      </ConfirmDialog>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Remove from queue?"
        description="The post itself isn’t changed."
        confirmLabel="Remove"
        onConfirm={async () => { await api.del(`/api/content-queue/items/${removing!.id}`); await refetch(); }}
      />
    </div>
  );
}
