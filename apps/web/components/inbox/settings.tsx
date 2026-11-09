'use client';
// Settings → Inbox: Channels (use a connected account in the inbox; status + missing permissions; honest capability
// record per network), Service levels (business hours, holidays, targets) and Saved replies.
import { useMemo, useState } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import type { SlaPolicyDto } from '@social-lite/core/contracts/v35-inbox';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import {
  Button, Card, CardHeader, Checkbox, Dialog, EmptyState, ErrorState, Field, Input, SkeletonRows, Switch, Textarea, useToast,
} from '@/components/ui';

// Channels moved to channels-settings.tsx (stream B: all networks, Add channel per network, ownership/templates dialogs).
export { InboxChannelsSettings } from './channels-settings';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function ServiceLevelsSettings() {
  const toast = useToast();
  const { canV2 } = useSession();
  const { data, error, refetch } = useApi<{ items: SlaPolicyDto[]; definitions: Record<string, string> }>('/api/inbox/sla-policies');
  const current = data?.items.find((p) => p.is_default && !p.brand_id) ?? null;
  const [form, setForm] = useState<SlaPolicyDto | null>(null);
  const f = form ?? current ?? { id: '', brand_id: null, name: 'Default', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', business_hours: [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '17:00' })), holidays: [], first_response_minutes: 60, resolution_minutes: 1440, count_automated: false, is_default: true };
  const set = (patch: Partial<SlaPolicyDto>) => setForm({ ...f, ...patch });
  const allDay = f.business_hours === null;
  const days = useMemo(() => new Set((f.business_hours ?? []).map((h) => h.day)), [f.business_hours]);
  const hours = f.business_hours?.[0] ?? { start: '09:00', end: '17:00' };
  const [saving, setSaving] = useState(false);
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  if (!data) return <SkeletonRows rows={4} />;
  const manage = canV2('inbox.manage');
  return (
    <Card aria-labelledby="h-sla" className="max-w-2xl">
      <CardHeader id="h-sla" title="Default service levels" />
      <div className="flex flex-col gap-4 px-4 pb-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="First response target (minutes)"><Input type="number" min={1} value={f.first_response_minutes ?? ''} disabled={!manage} onChange={(e) => set({ first_response_minutes: e.target.value ? Number(e.target.value) : null })} /></Field>
          <Field label="Resolution target (minutes)"><Input type="number" min={1} value={f.resolution_minutes ?? ''} disabled={!manage} onChange={(e) => set({ resolution_minutes: e.target.value ? Number(e.target.value) : null })} /></Field>
          <Field label="Time zone"><Input value={f.timezone} disabled={!manage} onChange={(e) => set({ timezone: e.target.value })} /></Field>
          <Field label="Holidays (YYYY-MM-DD, comma separated)"><Input value={f.holidays.join(', ')} disabled={!manage} onChange={(e) => set({ holidays: e.target.value.split(',').map((x) => x.trim()).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)) })} /></Field>
        </div>
        <Switch checked={allDay} disabled={!manage} onCheckedChange={(v) => set({ business_hours: v ? null : [1, 2, 3, 4, 5].map((day) => ({ day, ...hours })) })} label="Around the clock (24/7)" />
        {!allDay ? (
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Business days">
              {DAYS.map((d, i) => (
                <Checkbox key={d} label={d} checked={days.has(i)} disabled={!manage}
                  onChange={(e) => set({ business_hours: e.target.checked ? [...(f.business_hours ?? []), { day: i, ...hours }] : (f.business_hours ?? []).filter((h) => h.day !== i) })} />
              ))}
            </div>
            <Field label="Opens" className="w-28"><Input type="time" value={hours.start} disabled={!manage} onChange={(e) => set({ business_hours: (f.business_hours ?? []).map((h) => ({ ...h, start: e.target.value })) })} /></Field>
            <Field label="Closes" className="w-28"><Input type="time" value={hours.end} disabled={!manage} onChange={(e) => set({ business_hours: (f.business_hours ?? []).map((h) => ({ ...h, end: e.target.value })) })} /></Field>
          </div>
        ) : null}
        <Switch checked={f.count_automated} disabled={!manage} onCheckedChange={(v) => set({ count_automated: v })} label="Automated acknowledgements count as a first response" />
        {manage ? (
          <div><Button variant="primary" loading={saving} onClick={async () => {
            setSaving(true);
            try {
              const { id, ...rest } = f;
              await api.post('/api/inbox/sla-policies', { ...(id ? { id } : {}), ...rest, brand_id: null, is_default: true });
              toast.success('Saved'); setForm(null); await refetch();
            } catch (e) { toast.error(e); } finally { setSaving(false); }
          }}>Save</Button></div>
        ) : null}
      </div>
    </Card>
  );
}

export function SavedRepliesSettings() {
  const toast = useToast();
  const { canV2 } = useSession();
  const { data, error, refetch } = useApi<{ items: Array<{ id: string; title: string; body: string }> }>('/api/inbox/saved-replies');
  const [edit, setEdit] = useState<{ id?: string; title: string; body: string } | null>(null);
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  if (!data) return <SkeletonRows rows={3} />;
  const manage = canV2('inbox.manage');
  return (
    <Card aria-labelledby="h-sr" className="max-w-3xl">
      <CardHeader id="h-sr" title="Saved replies" actions={manage ? <Button size="sm" variant="secondary" icon={<MessageSquarePlus aria-hidden className="size-4" />} onClick={() => setEdit({ title: '', body: '' })}>New</Button> : undefined} />
      {!data.items.length ? <EmptyState compact title="No saved replies yet" /> : (
        <ul className="divide-y divide-border">
          {data.items.map((r) => (
            <li key={r.id} className="flex items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1"><p className="text-[14px] font-medium">{r.title}</p><p className="line-clamp-2 text-[13px] text-muted">{r.body}</p></div>
              {manage ? <Button size="sm" variant="ghost" onClick={() => setEdit(r)}>Edit</Button> : null}
            </li>
          ))}
        </ul>
      )}
      {edit ? (
        <Dialog open onOpenChange={(o) => !o && setEdit(null)} title={edit.id ? 'Edit saved reply' : 'New saved reply'} footer={<>
          <Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
          <Button variant="primary" disabledReason={!edit.title.trim() || !edit.body.trim() ? 'Add a title and text' : null} onClick={async () => {
            try { if (edit.id) await api.patch(`/api/inbox/saved-replies/${edit.id}`, { title: edit.title, body: edit.body }); else await api.post('/api/inbox/saved-replies', { title: edit.title, body: edit.body }); toast.success('Saved'); setEdit(null); await refetch(); } catch (e) { toast.error(e); }
          }}>Save</Button>
        </>}>
          <div className="flex flex-col gap-3">
            <Field label="Title"><Input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} maxLength={80} /></Field>
            <Field label="Text"><Textarea value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} rows={4} maxLength={2000} /></Field>
          </div>
        </Dialog>
      ) : null}
    </Card>
  );
}
