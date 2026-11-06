'use client';
import { useEffect, useState } from 'react';
import { toLocalInput } from '@social-lite/core';
import { api, isApiError } from '@/lib/client/api';
import { fmtDateTime, zoneAbbr, postTitle } from '@/lib/client/format';
import type { Delivery, PlannerItem, PostDetail, Schedule } from '@/lib/client/types';
import { Banner, Button, Dialog, ErrorNotice, Spinner } from '@/components/ui';
import { ScheduleTimeField, ambiguityFromError, resolvedInstant, wallTimeReady, type WallTimeValue } from '@/components/schedule/schedule-time-field';

export interface RescheduleResult {
  schedule: Schedule;
  deliveries: Delivery[];
  previous: { local: string; tz: string; generation: number };
}

/**
 * Confirmed reschedule (SC-04): shows the new local time + zone, sends expected_generation
 * so a concurrent change is detected, and handles ambiguous (fold) and nonexistent (gap) times.
 */
export function RescheduleDialog({
  item, initialLocal, open, onOpenChange, onDone, preferredZones,
}: {
  item: PlannerItem | null;
  initialLocal?: string | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: (r: RescheduleResult) => void;
  preferredZones: Array<{ tz: string; label: string }>;
}) {
  const [value, setValue] = useState<WallTimeValue>({ local: '', tz: 'Europe/London', offset: null });
  const [generation, setGeneration] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [serverAmb, setServerAmb] = useState<string[] | null>(null);

  useEffect(() => {
    if (!open || !item) return;
    const original = item.input_local_time ?? toLocalInput(new Date(item.due_at), item.input_timezone);
    setValue({ local: initialLocal ?? original.slice(0, 16), tz: item.input_timezone, offset: null });
    setError(null);
    setServerAmb(null);
    setGeneration(null);
    setLoadError(null);
    // The planner item does not carry the schedule generation; read it from the post.
    let cancelled = false;
    api.get<PostDetail>(`/api/posts/${item.post_id}`).then(
      (p) => {
        if (cancelled) return;
        if (!p.current_schedule || p.current_schedule.id !== item.schedule_id) {
          setLoadError(new Error('This schedule has changed since the planner loaded. Close this dialog and refresh.'));
          return;
        }
        setGeneration(p.current_schedule.generation);
      },
      (e) => !cancelled && setLoadError(e),
    );
    return () => {
      cancelled = true;
    };
  }, [open, item, initialLocal]);

  if (!item) return null;
  const oldDue = new Date(item.due_at);
  const newInstant = resolvedInstant(value);
  const unchanged = newInstant && newInstant.getTime() === oldDue.getTime();

  const submit = async () => {
    if (generation === null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ schedule: Schedule; deliveries: Delivery[] }>(
        `/api/schedules/${item.schedule_id}/reschedule`,
        { input_local_time: value.local, timezone: value.tz, offset: value.offset ?? undefined, expected_generation: generation },
        { idempotent: true },
      );
      onDone({
        ...res,
        previous: { local: (item.input_local_time ?? toLocalInput(oldDue, item.input_timezone)).slice(0, 16), tz: item.input_timezone, generation: res.schedule.generation },
      });
      onOpenChange(false);
    } catch (e) {
      const amb = ambiguityFromError(e, value);
      if (amb) setServerAmb(amb);
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const reason = generation === null ? 'Loading the current schedule…' : !wallTimeReady(value) ? 'Choose a valid future time.' : unchanged ? 'Pick a different time.' : null;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      busy={busy}
      size="md"
      title={`Reschedule “${postTitle(item)}”`}
      description={<>Currently {fmtDateTime(oldDue, item.input_timezone)} {zoneAbbr(oldDue, item.input_timezone)} ({item.input_timezone})</>}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabledReason={reason}>
            {newInstant ? `Move to ${fmtDateTime(newInstant, value.tz)} ${zoneAbbr(newInstant, value.tz)}` : 'Reschedule'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {loadError ? <ErrorNotice error={loadError} /> : generation === null ? <Spinner label="Checking the current schedule" /> : null}
        <ScheduleTimeField value={value} onChange={(v) => { setValue(v); setError(null); }} preferredZones={[{ tz: item.input_timezone, label: `${item.input_timezone} (this schedule)` }, ...preferredZones]} serverAmbiguity={serverAmb} />
        <Banner tone="info">
          Rescheduling creates a new schedule version; the old one can no longer send.
          {item.schedule_status === 'pending_approval' || item.status === 'pending_approval' ? ' The pending approval request will need to be reviewed again.' : ' If this post was approved, it will need approval again before it can publish.'}
        </Banner>
        {error && !(isApiError(error) && ambiguityFromError(error, value)) ? <ErrorNotice error={error} /> : null}
      </div>
    </Dialog>
  );
}
