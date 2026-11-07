'use client';
// Composer action: "Queue" — schedules the post into the brand's next free posting slot (normal approval rules apply).
import { useState } from 'react';
import { ListPlus } from 'lucide-react';
import { api, isApiError } from '@/lib/client/api';
import { fmtDateTime, zoneAbbr } from '@/lib/client/format';
import { Button, useToast } from '@/components/ui';

interface QueueResult {
  schedule: { due_at: string; input_timezone: string; status: string };
  queue: { mode: 'scheduled' | 'submitted_for_review'; skipped: Array<{ local: string }>; slot: { connection_ids: string[] } };
}

export function QueueButton({ postId, flush, disabledReason, onDone }: {
  postId: string; flush: () => Promise<number | null>; disabledReason?: string | null; onDone: (title: string, body?: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const version = await flush();
      if (version === null) return;
      const r = await api.post<QueueResult>('/api/queue', { post_id: postId, expected_version: version }, { idempotent: true });
      const when = `${fmtDateTime(r.schedule.due_at, r.schedule.input_timezone)} ${zoneAbbr(r.schedule.due_at, r.schedule.input_timezone)}`;
      const skipped = r.queue.skipped.length ? ` · skipped ${r.queue.skipped.length} (clock change)` : '';
      onDone(r.queue.mode === 'submitted_for_review' ? 'Queued for review' : 'Queued', `${when}${skipped}`);
    } catch (e) {
      if (isApiError(e) && e.details?.reason === 'no_slots') toast.info('No posting slots', 'Add one in Settings → Slots.');
      else toast.error(e, 'Could not queue');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="secondary" icon={<ListPlus aria-hidden className="size-4" />} onClick={run} loading={busy} disabledReason={disabledReason}
      title="Next free slot (uses the slot’s destinations)">
      Queue
    </Button>
  );
}
