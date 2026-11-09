'use client';
// Adoption queue: queued publications held because the person who scheduled them (or a required
// approver) lost rights. An authorised publisher adopts → revalidated and re-queued. Nothing is
// auto-released when access is restored.
import Link from 'next/link';
import { useState } from 'react';
import { PauseCircle } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { fmtRelative } from '@/lib/client/format';
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, SkeletonRows, Tooltip, useToast } from '@/components/ui';
import { TeamNav } from '@/components/team/shared';
import { HelpLink } from '@/components/help/help-link';

interface Held {
  schedule_id: string; post_id: string; title: string | null; brand_name: string; due_at: string; publish_before: string; hold_code: string | null;
  message: string; held_at: string | null; scheduled_by_email: string | null; destinations: number; held_deliveries: number; can_adopt: boolean; adoptable: boolean;
}

export default function HeldPage() {
  const toast = useToast();
  const { data, error, loading, refetch } = useApi<{ items: Held[] }>('/api/publication-holds', { poll: 30_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const adopt = async (h: Held) => {
    setBusy(h.schedule_id);
    try {
      const r = await api.post<{ requeued: number; expired: number }>(`/api/schedules/${h.schedule_id}/adopt`, {});
      toast.success('Adopted', `${r.requeued} re-queued${r.expired ? ` · ${r.expired} missed their deadline` : ''}`);
      void refetch();
    } catch (e) {
      toast.error(e, 'Not adopted');
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <PageHeader title="Team" actions={<HelpLink slug="reassign-work-and-held-posts" label="About held posts" />} />
      <TeamNav />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <SkeletonRows rows={3} /> : !data.items.length ? (
        <EmptyState icon={<PauseCircle aria-hidden />} title="Nothing held" />
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {data.items.map((h) => (
              <li key={h.schedule_id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <Link href={`/posts/${h.post_id}`} className="block truncate font-medium hover:underline">{h.title || 'Untitled post'}</Link>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-muted">
                    <span>{h.brand_name}</span><span>·</span>
                    <span>due {new Date(h.due_at).toLocaleString()}</span><span>·</span>
                    <span>{h.held_deliveries}/{h.destinations} held</span>
                    {h.scheduled_by_email ? <><span>·</span><span>by {h.scheduled_by_email}</span></> : null}
                    {h.held_at ? <><span>·</span><span>held {fmtRelative(h.held_at)}</span></> : null}
                  </div>
                </div>
                <Tooltip content={h.message}><span><Badge tone="warn">{h.adoptable ? 'Needs publisher' : 'Needs new review'}</Badge></span></Tooltip>
                {h.can_adopt ? <Button variant="primary" size="sm" loading={busy === h.schedule_id} onClick={() => void adopt(h)}>Adopt</Button> : null}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
