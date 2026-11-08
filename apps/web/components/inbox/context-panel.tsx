'use client';
// Customer + case context for the selected conversation: who, channel, priority/labels, and the customer-care case with
// its service-level clocks (definitions live in Help; the panel shows due/at/breached only).
import { useState } from 'react';
import { BriefcaseBusiness, CircleAlert, Clock } from 'lucide-react';
import type { CaseDto, ConversationDetail, Priority } from '@social-lite/core/contracts/v35-inbox';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { Badge, Button, Dialog, Facts, Field, Input, Select, Textarea, useToast } from '@/components/ui';
import { CASE_STATE_LABEL, CHANNEL_LABEL, PRIORITY_LABEL, dueLabel } from './labels';

export function InboxContextPanel({ id, onChanged }: { id: string; onChanged: () => void }) {
  const toast = useToast();
  const { data: c, refetch } = useApi<ConversationDetail>(`/api/inbox/conversations/${id}`, { poll: 15_000 });
  const kase = useApi<CaseDto>(c?.case ? `/api/inbox/cases/${c.case.id}` : null, { poll: 30_000 });
  const [creating, setCreating] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [title, setTitle] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  if (!c) return null;
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast.success(ok); await refetch(); await kase.refetch(); onChanged(); } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  const k = kase.data;
  const patchCase = (body: Record<string, unknown>) => api.patch(`/api/inbox/cases/${k!.id}`, { version: k!.version, ...body });

  return (
    <div className="flex flex-col gap-5 text-[13px]">
      <section aria-labelledby="ctx-customer">
        <h3 id="ctx-customer" className="mb-2 text-xs font-medium uppercase tracking-[0.06em] text-subtle">Customer</h3>
        <Facts items={[
          ['Name', c.contact.name ?? '—'],
          ['Channel', `${CHANNEL_LABEL[c.channel.kind]} · ${c.channel.display_name}`],
          ['Waiting since', c.unanswered_since ? new Date(c.unanswered_since).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Answered'],
        ]} />
        <p className="mt-2 text-xs text-subtle">Provider identity only. Linking to a CRM contact is explicit and never by name.</p>
      </section>

      <section aria-labelledby="ctx-prio">
        <h3 id="ctx-prio" className="mb-2 text-xs font-medium uppercase tracking-[0.06em] text-subtle">Priority</h3>
        <Select aria-label="Priority" value={c.priority} disabled={!c.reply.can_reply || busy}
          onChange={(e) => run(() => api.patch(`/api/inbox/conversations/${id}`, { priority: e.target.value as Priority }), 'Priority updated')}>
          {(Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
        </Select>
      </section>

      <section aria-labelledby="ctx-case">
        <h3 id="ctx-case" className="mb-2 text-xs font-medium uppercase tracking-[0.06em] text-subtle">Case</h3>
        {!c.case ? (
          <Button size="sm" variant="secondary" icon={<BriefcaseBusiness aria-hidden className="size-4" />} disabledReason={!c.reply.can_reply ? 'You can’t manage cases here.' : null}
            onClick={() => { setTitle(c.preview.slice(0, 80) || 'Customer request'); setCreating(true); }}>Create case</Button>
        ) : !k ? <p className="text-muted">Loading…</p> : (
          <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 font-medium"><span className="text-muted">#{k.number}</span> {k.title}</p>
              <Badge tone={k.state === 'resolved' ? 'success' : k.state === 'waiting' ? 'neutral' : 'info'}>{CASE_STATE_LABEL[k.state]}</Badge>
            </div>
            <ul className="flex flex-col gap-1.5">
              <SlaRow label="First response" due={k.first_response.due_at} at={k.first_response.at} breached={k.first_response.breached} paused={k.paused} />
              <SlaRow label="Resolution" due={k.resolution.due_at} at={k.resolution.at} breached={k.resolution.breached} paused={k.paused} />
            </ul>
            {k.reopened_count ? <p className="text-xs text-muted">Reopened {k.reopened_count}×</p> : null}
            <div className="flex flex-wrap gap-2">
              {k.state === 'resolved' ? (
                <Button size="sm" variant="secondary" loading={busy} onClick={() => run(() => patchCase({ state: 'reopened' }), 'Case reopened')}>Reopen</Button>
              ) : (
                <>
                  {k.state !== 'waiting'
                    ? <Button size="sm" variant="ghost" loading={busy} onClick={() => run(() => patchCase({ state: 'waiting' }), 'Clock paused')}>Waiting on customer</Button>
                    : <Button size="sm" variant="ghost" loading={busy} onClick={() => run(() => patchCase({ state: 'open' }), 'Clock resumed')}>Resume</Button>}
                  <Button size="sm" variant="secondary" onClick={() => { setReason(''); setResolving(true); }}>Resolve case</Button>
                </>
              )}
            </div>
          </div>
        )}
      </section>

      <Dialog open={creating} onOpenChange={setCreating} title="Create case" footer={<>
        <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
        <Button variant="primary" loading={busy} disabledReason={!title.trim() ? 'Add a title' : null}
          onClick={() => run(async () => { await api.post('/api/inbox/cases', { conversation_id: id, title: title.trim(), priority: c.priority }); setCreating(false); }, 'Case created')}>Create</Button>
      </>}>
        <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></Field>
      </Dialog>
      <Dialog open={resolving} onOpenChange={setResolving} title="Resolve case" footer={<>
        <Button variant="ghost" onClick={() => setResolving(false)}>Cancel</Button>
        <Button variant="primary" loading={busy} disabledReason={!reason.trim() ? 'Add a reason' : null}
          onClick={() => run(async () => { await patchCase({ state: 'resolved', resolution_reason: reason.trim() }); setResolving(false); }, 'Case resolved')}>Resolve</Button>
      </>}>
        <Field label="Resolution reason"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={200} /></Field>
      </Dialog>
    </div>
  );
}

function SlaRow({ label, due, at, breached, paused }: { label: string; due: string | null; at: string | null; breached: boolean; paused: boolean }) {
  return (
    <li className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 text-muted"><Clock aria-hidden className="size-3.5" />{label}</span>
      {at ? <span className="text-success">Done</span>
        : paused ? <span className="text-muted">Paused</span>
          : breached ? <Badge tone="danger" icon={<CircleAlert aria-hidden className="size-3.5" />}>Missed · {dueLabel(due)}</Badge>
            : <span className="tabular">{due ? dueLabel(due) : 'No target'}</span>}
    </li>
  );
}
