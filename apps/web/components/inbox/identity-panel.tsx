'use client';
// Identity linking (stream B): the provider identity of this conversation, the Relay customer it is linked to (only by an
// explicit action, never by name), the customer's other identities and conversations the viewer may read, and the
// link history (who linked/unlinked, when, why). Unlinking is always possible and keeps the history.
import { useState } from 'react';
import { Link2, Link2Off } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useDebouncedValue } from '@/lib/client/hooks';
import { Button, Dialog, Field, Input, Segmented, useToast } from '@/components/ui';
import { CHANNEL_LABEL, STATUS_LABEL, shortAgo } from './labels';
import type { ChannelKind, ConversationStatus, PersonRef } from '@social-lite/core/contracts/v35-inbox';

interface Profile {
  contact: { id: string; name: string | null; handle: string | null; channel: { kind: ChannelKind; display_name: string }; first_seen_at: string } | null;
  customer: { id: string; name: string; brand_id: string | null } | null;
  identities: Array<{ contact_id: string; name: string | null; handle: string | null; channel_kind: ChannelKind; channel_name: string; linked_at: string; linked_by: PersonRef | null }>;
  conversations: Array<{ id: string; channel_kind: ChannelKind; kind: string; preview: string; status: ConversationStatus; last_message_at: string }>;
  history: Array<{ action: 'linked' | 'unlinked'; at: string; by: PersonRef | null; reason: string | null; customer_name: string }>;
  can_link: boolean;
}
const who = (p: PersonRef | null) => (p ? p.name || p.email || 'Teammate' : 'Someone');

export function IdentityPanel({ conversationId, brandId, onOpen }: { conversationId: string; brandId: string; onOpen?: (id: string) => void }) {
  const toast = useToast();
  const { data: p, refetch } = useApi<Profile>(`/api/inbox/conversations/${conversationId}/customer`);
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  if (!p) return null;
  const c = p.contact;
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt className="text-muted">Identity</dt><dd className="min-w-0 break-words">{c ? `${c.name ?? 'Unknown'}${c.handle ? ` · ${c.handle}` : ''}` : '—'}</dd>
        {c ? <><dt className="text-muted">Channel</dt><dd className="min-w-0 break-words">{CHANNEL_LABEL[c.channel.kind]} · {c.channel.display_name}</dd></> : null}
        <dt className="text-muted">Customer</dt><dd className="min-w-0 break-words">{p.customer ? <span className="font-medium">{p.customer.name}</span> : <span className="text-muted">Not linked</span>}</dd>
      </dl>
      {p.identities.length > 1 ? (
        <ul className="flex flex-col gap-1 text-xs text-muted">{p.identities.filter((i) => i.contact_id !== c?.id).map((i) => <li key={i.contact_id}>Also: {CHANNEL_LABEL[i.channel_kind]} · {i.name ?? i.handle ?? 'identity'}</li>)}</ul>
      ) : null}
      {p.conversations.length ? (
        <div>
          <p className="mb-1 text-xs font-medium text-subtle">Other conversations</p>
          <ul className="flex flex-col gap-1">{p.conversations.slice(0, 5).map((x) => (
            <li key={x.id}><button type="button" onClick={() => onOpen?.(x.id)} className="w-full truncate text-left text-xs text-muted hover:text-fg">{CHANNEL_LABEL[x.channel_kind]} · {STATUS_LABEL[x.status]} · {shortAgo(x.last_message_at)} — {x.preview || '—'}</button></li>
          ))}</ul>
        </div>
      ) : null}
      {p.can_link && c ? (
        <div className="flex flex-wrap gap-2">
          {p.customer
            ? <Button size="sm" variant="ghost" icon={<Link2Off aria-hidden className="size-4" />} onClick={() => { setReason(''); setUnlinking(true); }}>Unlink</Button>
            : <Button size="sm" variant="secondary" icon={<Link2 aria-hidden className="size-4" />} onClick={() => setLinking(true)}>Link to customer</Button>}
        </div>
      ) : null}
      {p.history.length ? (
        <details className="text-xs text-muted"><summary className="cursor-pointer">Link history ({p.history.length})</summary>
          <ul className="mt-1 flex flex-col gap-1">{p.history.map((h, i) => <li key={i}>{h.action === 'linked' ? 'Linked to' : 'Unlinked from'} {h.customer_name} · {who(h.by)} · {new Date(h.at).toLocaleDateString()}{h.reason ? ` — ${h.reason}` : ''}</li>)}</ul>
        </details>
      ) : null}
      {linking ? <LinkDialog conversationId={conversationId} brandId={brandId} onClose={() => setLinking(false)} onDone={async () => { setLinking(false); await refetch(); }} /> : null}
      <Dialog open={unlinking} onOpenChange={setUnlinking} title="Unlink identity" description="The link history is kept." footer={<>
        <Button variant="ghost" onClick={() => setUnlinking(false)}>Cancel</Button>
        <Button variant="primary" loading={busy} disabledReason={reason.trim().length < 3 ? 'Add a reason' : null} onClick={async () => {
          setBusy(true);
          try { await api.post(`/api/inbox/conversations/${conversationId}/customer/unlink`, { reason: reason.trim() }); toast.success('Unlinked'); setUnlinking(false); await refetch(); } catch (e) { toast.error(e); } finally { setBusy(false); }
        }}>Unlink</Button>
      </>}>
        <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="e.g. Wrong person" /></Field>
      </Dialog>
    </div>
  );
}

function LinkDialog({ conversationId, brandId, onClose, onDone }: { conversationId: string; brandId: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [q, setQ] = useState('');
  const dq = useDebouncedValue(q, 250);
  const found = useApi<{ items: Array<{ id: string; name: string; identities: number }> }>(mode === 'existing' ? `/api/inbox/customers?brand_id=${brandId}&q=${encodeURIComponent(dq)}` : null);
  const [pick, setPick] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = reason.trim().length >= 3 && (mode === 'existing' ? !!pick : !!name.trim());
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Link to a customer" description="Link only when you have confirmed it is the same person (for example an order number). Names alone are not enough." footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" loading={busy} disabledReason={!ready ? 'Choose a customer and add a reason' : null} onClick={async () => {
        setBusy(true);
        try { await api.post(`/api/inbox/conversations/${conversationId}/customer/link`, mode === 'existing' ? { customer_id: pick, reason: reason.trim() } : { new_customer_name: name.trim(), reason: reason.trim() }); toast.success('Linked'); onDone(); } catch (e) { toast.error(e); } finally { setBusy(false); }
      }}>Link</Button>
    </>}>
      <div className="flex flex-col gap-3">
        <Segmented label="Customer" size="sm" value={mode} onChange={setMode} options={[{ value: 'existing', label: 'Existing' }, { value: 'new', label: 'New customer' }]} />
        {mode === 'existing' ? (
          <>
            <Field label="Search customers"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Customer name in Relay" /></Field>
            <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto" role="listbox" aria-label="Customers">
              {(found.data?.items ?? []).map((cu) => (
                <li key={cu.id} role="option" aria-selected={pick === cu.id}>
                  <button type="button" onClick={() => setPick(cu.id)} className={`w-full rounded-md border px-2 py-1.5 text-left text-[13px] ${pick === cu.id ? 'border-[var(--accent-text)] bg-raised' : 'border-border'}`}>{cu.name} <span className="text-xs text-muted">· {cu.identities} identities</span></button>
                </li>
              ))}
              {found.data && !found.data.items.length ? <li className="text-xs text-muted">No customers found.</li> : null}
            </ul>
          </>
        ) : <Field label="Customer name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>}
        <Field label="How did you confirm it is the same person?"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="e.g. Same order number #1042" /></Field>
      </div>
    </Dialog>
  );
}
