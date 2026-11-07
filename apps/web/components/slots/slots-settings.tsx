'use client';
// Settings → Slots: per-brand recurring posting slots (weekdays + wall time + zone + destinations) and the upcoming queue.
import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, CalendarRange, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Provider } from '@social-lite/core';
import { useSession } from '@/lib/client/session';
import { useBrandFilter } from '@/lib/client/hooks';
import { useApi } from '@/lib/client/use-api';
import { api } from '@/lib/client/api';
import { allTimeZones } from '@/lib/client/format';
import {
  Badge, Button, Card, CardHeader, Checkbox, ConfirmDialog, Dialog, EmptyState, ErrorNotice, ErrorState, Field, IconButton, InfoTip, Input,
  MetaChip, PlatformIcon, Select, Skeleton, Switch, TimeWithZone, useToast,
} from '@/components/ui';

export interface Slot {
  id: string; brand_id: string; label: string | null; weekdays: number[]; local_time: string; timezone: string; connection_ids: string[]; active: boolean;
  next?: Array<{ kind: 'ok' | 'gap'; local: string; at: string | null; offset: string | null; fold: boolean; message?: string; taken_by: { post_id: string; title: string | null } | null }>;
}
interface QueueItem { slot_id: string; slot_label: string | null; timezone: string; kind: 'ok' | 'gap'; local: string; at: string | null; fold: boolean; message?: string; taken_by: { post_id: string; title: string | null; status: string | null } | null }
interface Conn { id: string; provider: Provider; display_name: string; is_mock: boolean; disconnected_at: string | null }

const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']] as const;
const dayLabel = (ws: number[]) => (ws.length === 7 ? 'Every day' : ws.length === 5 && [1, 2, 3, 4, 5].every((d) => ws.includes(d)) ? 'Weekdays' : DAYS.filter(([d]) => ws.includes(d)).map(([, l]) => l).join(' '));

export function SlotsSettings() {
  const { session } = useSession();
  const [brandFilter] = useBrandFilter();
  const [brandId, setBrandId] = useState(brandFilter || session.brands[0]?.id || '');
  useEffect(() => { if (brandFilter) setBrandId(brandFilter); }, [brandFilter]);
  if (!session.brands.length) return <EmptyState icon={<CalendarClock aria-hidden />} title="No brands yet" />;
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      {session.brands.length > 1 ? (
        <Field label="Brand" labelHidden className="max-w-xs">
          <Select value={brandId} onChange={(e) => setBrandId(e.target.value)}>
            {session.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </Field>
      ) : null}
      {brandId ? <BrandSlots key={brandId} brandId={brandId} /> : null}
    </div>
  );
}

function BrandSlots({ brandId }: { brandId: string }) {
  const { can, session } = useSession();
  const toast = useToast();
  const editable = can('brands.manage');
  const slots = useApi<{ items: Slot[] }>(`/api/brands/${brandId}/slots?preview=3`);
  const queue = useApi<{ items: QueueItem[] }>(`/api/queue?brand_id=${brandId}&days=14`);
  const conns = useApi<{ items: Conn[] }>(`/api/brands/${brandId}/connections`);
  const [editing, setEditing] = useState<Slot | 'new' | null>(null);
  const [removing, setRemoving] = useState<Slot | null>(null);
  const brandTz = session.brands.find((b) => b.id === brandId)?.timezone ?? 'Europe/London';
  const byId = new Map((conns.data?.items ?? []).map((c) => [c.id, c]));
  const reload = async () => { await Promise.all([slots.refetch(), queue.refetch()]); };

  if (slots.error && !slots.data) return <ErrorState error={slots.error} onRetry={slots.refetch} />;
  return (
    <>
      <Card>
        <CardHeader
          title={<span className="flex items-center gap-1">Posting slots <InfoTip>Recurring times. “Queue” on a post fills the next free one. Editing a slot never moves queued posts.</InfoTip></span>}
          actions={editable ? <Button size="sm" variant="primary" icon={<Plus aria-hidden className="size-4" />} onClick={() => setEditing('new')}>Add slot</Button> : <MetaChip>View only</MetaChip>}
        />
        {slots.loading || !slots.data ? <Skeleton className="m-4 h-24" /> : !slots.data.items.length ? (
          <EmptyState compact icon={<CalendarClock aria-hidden />} title="No slots" />
        ) : (
          <ul className="divide-y divide-border" aria-label="Posting slots">
            {slots.data.items.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <span className="tabular">{s.local_time}</span>
                    <span className="text-muted">{dayLabel(s.weekdays)}</span>
                    {s.label ? <span className="truncate">· {s.label}</span> : null}
                    {!s.active ? <Badge>Paused</Badge> : null}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    <span>{s.timezone.replace(/_/g, ' ')}</span>
                    <span aria-hidden>·</span>
                    {s.connection_ids.map((id) => {
                      const c = byId.get(id);
                      return c ? <span key={id} className="inline-flex items-center gap-1"><PlatformIcon provider={c.provider} size="xs" decorative />{c.display_name}</span> : null;
                    })}
                  </p>
                </div>
                {editable ? (
                  <div className="flex gap-1">
                    <IconButton label={`Edit slot ${s.local_time}`} icon={<Pencil aria-hidden className="size-4" />} onClick={() => setEditing(s)} />
                    <IconButton label={`Delete slot ${s.local_time}`} icon={<Trash2 aria-hidden className="size-4" />} onClick={() => setRemoving(s)} />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title={<span className="flex items-center gap-1">Next 14 days <InfoTip>Times use each slot’s own zone. A time skipped by a clock change is shown; a repeated hour uses the first one.</InfoTip></span>} />
        {queue.loading || !queue.data ? <Skeleton className="m-4 h-24" /> : !queue.data.items.length ? (
          <EmptyState compact icon={<CalendarRange aria-hidden />} title="Nothing upcoming" />
        ) : (
          <ol className="divide-y divide-border" aria-label="Upcoming slot times">
            {queue.data.items.slice(0, 30).map((q) => (
              <li key={`${q.slot_id}-${q.local}`} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className="w-40 shrink-0 tabular sm:w-60 sm:whitespace-nowrap">
                  {q.at ? <TimeWithZone instant={q.at} tz={q.timezone} /> : <span>{q.local.replace('T', ' ')}</span>}
                </span>
                {q.kind === 'gap' ? <Badge tone="warn" title={q.message}>Skipped · clock change</Badge>
                  : q.taken_by ? <a className="min-w-0 truncate hover:underline" href={`/posts/${q.taken_by.post_id}`}>{q.taken_by.title || 'Untitled post'}</a>
                    : <span className="text-subtle">Free</span>}
                {q.fold ? <Badge title="This time happens twice; the first is used.">First of two</Badge> : null}
              </li>
            ))}
          </ol>
        )}
      </Card>

      <SlotDialog
        key={editing === 'new' ? 'new' : editing?.id ?? 'none'}
        open={editing !== null}
        slot={editing === 'new' ? null : editing}
        brandId={brandId}
        defaultTz={brandTz}
        connections={(conns.data?.items ?? []).filter((c) => !c.disconnected_at)}
        onOpenChange={(o) => { if (!o) setEditing(null); }}
        onSaved={async () => { setEditing(null); toast.success('Slot saved'); await reload(); }}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => { if (!o) setRemoving(null); }}
        title="Delete slot?"
        description="Posts already queued keep their time."
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={async () => { await api.del(`/api/slots/${removing!.id}`); toast.success('Slot deleted'); await reload(); }}
      />
    </>
  );
}

function SlotDialog({ open, slot, brandId, defaultTz, connections, onOpenChange, onSaved }: {
  open: boolean; slot: Slot | null; brandId: string; defaultTz: string; connections: Conn[]; onOpenChange: (o: boolean) => void; onSaved: () => Promise<void>;
}) {
  const zones = useMemo(() => allTimeZones(), []);
  const [label, setLabel] = useState(slot?.label ?? '');
  const [days, setDays] = useState<number[]>(slot?.weekdays ?? [1, 2, 3, 4, 5]);
  const [time, setTime] = useState(slot?.local_time ?? '09:00');
  const [tz, setTz] = useState(slot?.timezone ?? defaultTz);
  const [ids, setIds] = useState<string[]>(slot?.connection_ids ?? []);
  const [active, setActive] = useState(slot?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const timeOk = /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  const reason = !days.length ? 'Pick at least one day.' : !timeOk ? 'Enter a time.' : !ids.length ? 'Pick a destination.' : null;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { label: label.trim() || null, weekdays: days, local_time: time, timezone: tz, connection_ids: ids, active };
      if (slot) await api.patch(`/api/slots/${slot.id}`, body); else await api.post(`/api/brands/${brandId}/slots`, body);
      await onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      busy={busy}
      title={slot ? 'Edit slot' : 'New slot'}
      footer={<>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
        <Button variant="primary" onClick={save} loading={busy} disabledReason={reason}>Save</Button>
      </>}
    >
      <div className="flex flex-col gap-4">
        <fieldset>
          <legend className="mb-2 text-[13px] font-medium">Days</legend>
          <div className="flex flex-wrap gap-1.5">
            {DAYS.map(([d, l]) => {
              const on = days.includes(d);
              return (
                <button key={d} type="button" aria-pressed={on}
                  onClick={() => setDays(on ? days.filter((x) => x !== d) : [...days, d].sort())}
                  className={`h-9 min-w-11 rounded-lg border px-2 text-sm ${on ? 'border-border-strong bg-raised font-medium' : 'border-border text-muted hover:text-fg'}`}>
                  {l}
                </button>
              );
            })}
          </div>
        </fieldset>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Time" error={!timeOk ? 'HH:MM, 24-hour' : null}>
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value.slice(0, 5))} step={60} />
          </Field>
          <Field label="Time zone" info="Stored on the slot. Changing the brand zone later doesn’t move it.">
            <Select value={tz} onChange={(e) => setTz(e.target.value)}>
              {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
            </Select>
          </Field>
        </div>
        <fieldset>
          <legend className="mb-2 text-[13px] font-medium">Destinations</legend>
          {!connections.length ? <p className="text-[13px] text-muted">No connected accounts</p> : (
            <div className="flex flex-col gap-2">
              {connections.map((c) => (
                <Checkbox key={c.id} checked={ids.includes(c.id)} onChange={(e) => setIds(e.target.checked ? [...ids, c.id] : ids.filter((x) => x !== c.id))}
                  label={<span className="inline-flex items-center gap-2"><PlatformIcon provider={c.provider} size="xs" decorative />{c.display_name}{c.is_mock ? <span className="text-xs text-muted">Simulated</span> : null}</span>} />
              ))}
            </div>
          )}
        </fieldset>
        <Field label="Label" optional><Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="Morning" /></Field>
        {slot ? <Switch checked={active} onCheckedChange={setActive} label="Active" /> : null}
        {error ? <ErrorNotice error={error} /> : null}
      </div>
    </Dialog>
  );
}
