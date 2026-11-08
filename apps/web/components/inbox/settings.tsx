'use client';
// Settings → Inbox: Channels (use a connected account in the inbox; status + missing permissions; honest capability
// record per network), Service levels (business hours, holidays, targets) and Saved replies.
import { useMemo, useState } from 'react';
import { CircleAlert, CircleCheck, FlaskConical, MessageSquarePlus, Plus } from 'lucide-react';
import type { ChannelCapability, InboxChannelJson, SlaPolicyDto, Support } from '@social-lite/core/contracts/v35-inbox';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import type { Connection } from '@/lib/client/types';
import {
  Badge, Button, Card, CardHeader, Checkbox, Dialog, EmptyState, ErrorState, Field, Input, Select, SimulatedBadge, SkeletonRows, Switch, Table, THead, Th, Tr, Td, Textarea, useToast,
} from '@/components/ui';
import { CHANNEL_LABEL } from './labels';

const SUPPORT: Record<Support, { label: string; tone: 'success' | 'warn' | 'neutral' | 'info' }> = {
  supported: { label: 'Supported', tone: 'success' }, needs_approval: { label: 'Needs approval', tone: 'warn' },
  not_available: { label: 'Not available', tone: 'neutral' }, not_implemented: { label: 'Not built yet', tone: 'info' },
};

export function InboxChannelsSettings() {
  const toast = useToast();
  const { session, canV2 } = useSession();
  const channels = useApi<{ items: InboxChannelJson[] }>('/api/inbox/channels');
  const caps = useApi<{ items: Array<ChannelCapability & { implemented: boolean }> }>('/api/inbox/capabilities');
  const [brand, setBrand] = useState(session.brands[0]?.id ?? '');
  const conns = useApi<{ items: Connection[] }>(brand ? `/api/brands/${brand}/connections` : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sim, setSim] = useState<InboxChannelJson | null>(null);
  const manage = canV2('inbox.manage');
  const enabled = new Set((channels.data?.items ?? []).map((c) => c.connection_id));
  const candidates = (conns.data?.items ?? []).filter((c) => c.provider === 'facebook' && !c.disconnected_at && !enabled.has(c.id));

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try { await fn(); toast.success(ok); await channels.refetch(); } catch (e) { toast.error(e); } finally { setBusy(null); }
  };

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <Card aria-labelledby="h-ch">
        <CardHeader id="h-ch" title="In the inbox" />
        {channels.error ? <ErrorState error={channels.error} onRetry={channels.refetch} /> : !channels.data ? <SkeletonRows rows={2} className="p-4" /> : !channels.data.items.length ? (
          <EmptyState compact title="No channels in the inbox yet" />
        ) : (
          <ul className="divide-y divide-border">
            {channels.data.items.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-[14px] font-medium">{c.display_name}{c.is_simulated ? <SimulatedBadge /> : null}</p>
                  <p className="text-xs text-muted">{CHANNEL_LABEL[c.kind]} · {c.enabled_types.map((t) => (t === 'dm' ? 'messages' : `${t}s`)).join(', ')}</p>
                  {c.missing_permissions.length ? <p className="mt-1 text-xs text-warn">Missing: {c.missing_permissions.join(', ')}</p> : null}
                </div>
                <Badge tone={c.status === 'active' ? 'success' : c.status === 'paused' ? 'neutral' : 'warn'} icon={c.status === 'active' ? <CircleCheck aria-hidden className="size-3.5" /> : <CircleAlert aria-hidden className="size-3.5" />}>
                  {c.status === 'active' ? 'Receiving' : c.status === 'paused' ? 'Paused' : c.status === 'needs_permission' ? 'Permission missing' : 'Needs attention'}
                </Badge>
                {manage ? (
                  <div className="flex gap-2">
                    {c.is_simulated ? <Button size="sm" variant="ghost" icon={<FlaskConical aria-hidden className="size-4" />} onClick={() => setSim(c)}>Simulate</Button> : null}
                    <Button size="sm" variant="ghost" loading={busy === c.id} onClick={() => run(c.id, () => api.patch(`/api/inbox/channels/${c.id}`, { paused: c.status !== 'paused' }), c.status === 'paused' ? 'Resumed' : 'Paused')}>{c.status === 'paused' ? 'Resume' : 'Pause'}</Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {manage ? (
          <div className="flex flex-wrap items-end gap-3 border-t border-border px-4 py-3">
            {session.brands.length > 1 ? (
              <Field label="Brand" className="w-full sm:w-64"><Select value={brand} onChange={(e) => setBrand(e.target.value)}>{session.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
            ) : null}
            {candidates.length ? candidates.map((c) => (
              <Button key={c.id} variant="secondary" icon={<Plus aria-hidden className="size-4" />} loading={busy === c.id}
                onClick={() => run(c.id, () => api.post('/api/inbox/channels', { connection_id: c.id }), 'Channel added')}>Add {c.display_name}</Button>
            )) : <p className="text-[13px] text-muted">{conns.data ? 'Connect a Facebook Page in Connections to add it here.' : ''}</p>}
          </div>
        ) : null}
      </Card>

      <Card aria-labelledby="h-cap">
        <CardHeader id="h-cap" title="What each network allows" />
        {!caps.data ? <SkeletonRows rows={4} className="p-4" /> : (
          <div className="overflow-x-auto px-1 pb-2">
            <Table caption="Inbox capabilities by network">
              <THead><Tr><Th>Network</Th><Th>Messages</Th><Th>Comments</Th><Th>Reviews / mentions</Th><Th>In Relay</Th></Tr></THead>
              <tbody>
                {caps.data.items.map((c) => {
                  const cell = (k: 'dm' | 'comment' | 'review' | 'mention') => { const v = c.conversationTypes[k]; return v ? <Badge tone={SUPPORT[v.reply].tone}>{SUPPORT[v.reply].label}</Badge> : <span className="text-subtle">—</span>; };
                  return (
                    <Tr key={c.kind}>
                      <Td className="font-medium">{CHANNEL_LABEL[c.kind]}</Td>
                      <Td>{cell('dm')}</Td><Td>{cell('comment')}</Td><Td>{c.conversationTypes.review ? cell('review') : cell('mention')}</Td>
                      <Td>{c.implemented ? <Badge tone="success">Available</Badge> : <span className="text-xs text-muted">Not yet</span>}</Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        )}
      </Card>
      {sim ? <SimulateDialog channel={sim} onClose={() => setSim(null)} /> : null}
    </div>
  );
}

function SimulateDialog({ channel, onClose }: { channel: InboxChannelJson; onClose: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<'dm' | 'comment'>('dm');
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Simulate a customer message" description="Simulated channel only. Nothing is received from Facebook." footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" loading={busy} disabledReason={!text.trim() ? 'Write a message' : null} onClick={async () => {
        setBusy(true);
        try { await api.post(`/api/inbox/channels/${channel.id}/simulate`, { kind, text: text.trim(), ...(name.trim() ? { name: name.trim() } : {}) }); toast.success('Simulated message received'); onClose(); } catch (e) { toast.error(e); } finally { setBusy(false); }
      }}>Receive</Button>
    </>}>
      <div className="flex flex-col gap-3">
        <Field label="Type"><Select value={kind} onChange={(e) => setKind(e.target.value as 'dm' | 'comment')}><option value="dm">Private message</option><option value="comment">Comment on a post</option></Select></Field>
        <Field label="Customer name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Simulated customer" /></Field>
        <Field label="Message"><Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={2000} /></Field>
      </div>
    </Dialog>
  );
}

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
              toast.success('Service levels saved'); setForm(null); await refetch();
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
