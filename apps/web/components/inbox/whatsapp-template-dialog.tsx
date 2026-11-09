'use client';
// WhatsApp approved-template send (stream B). Outside the 24-hour customer service window only templates can be sent;
// the charge is shown BEFORE sending with the same rules the server applies (core whatsAppChargeFor: marketing and
// authentication always; utility templates too, inside the window as well, since Meta's 2026-10-01 change). The exact
// text that will be sent is previewed; a charged send needs an explicit acknowledgement, which the server re-checks.
// Send-once rules apply as for any reply (idempotency key, thread version).
import { useRef, useState } from 'react';
import { FileText } from 'lucide-react';
import type { ReplyAttemptDto, TemplateInfo } from '@social-lite/core/contracts/v35-inbox';
import { whatsAppChargeFor, type WhatsAppRates, type WhatsAppServiceAllowance } from '@social-lite/core/contracts/whatsapp-charges';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { Badge, Banner, Button, Checkbox, Dialog, EmptyState, Field, Input, Select, SkeletonRows, useToast } from '@/components/ui';
import { newKey } from './labels';

interface Resp { items: TemplateInfo[]; refreshed_at: string | null; rates: WhatsAppRates | null; service_allowance?: WhatsAppServiceAllowance }

export function chargeFor(t: TemplateInfo | null, windowOpen: boolean, rates: Resp['rates'], now = new Date()): { billable: boolean; text: string } {
  if (!t) return { billable: false, text: '' };
  const c = whatsAppChargeFor({ template: { category: t.category }, windowOpen, now, rates });
  const r = c.estimate;
  return { billable: c.billable, text: c.billable ? `${c.note.replace(/\.$/, '')}${r ? ` · about ${new Intl.NumberFormat(undefined, { style: 'currency', currency: r.currency }).format(r.amount)}` : ''}.` : c.note };
}

export function WhatsAppTemplateButton({ channelId, conversationId, baseVersion, windowOpen, disabled, onSent }: { channelId: string; conversationId: string; baseVersion: number; windowOpen: boolean; disabled?: boolean; onSent: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" icon={<FileText aria-hidden className="size-4" />} disabledReason={disabled ? 'You can read but not reply here.' : null} onClick={() => setOpen(true)}>Template</Button>
      {open ? <TemplateDialog channelId={channelId} conversationId={conversationId} baseVersion={baseVersion} windowOpen={windowOpen} onClose={() => setOpen(false)} onSent={() => { setOpen(false); onSent(); }} /> : null}
    </>
  );
}

function TemplateDialog({ channelId, conversationId, baseVersion, windowOpen, onClose, onSent }: { channelId: string; conversationId: string; baseVersion: number; windowOpen: boolean; onClose: () => void; onSent: () => void }) {
  const toast = useToast();
  const { data } = useApi<Resp>(`/api/inbox/channels/${channelId}/templates`);
  const approved = (data?.items ?? []).filter((t) => t.status === 'APPROVED');
  const [sel, setSel] = useState<string>('');
  const t = approved.find((x) => `${x.name}:${x.language}` === sel) ?? approved[0] ?? null;
  const [params, setParams] = useState<string[]>([]);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const key = useRef<string | null>(null);
  const values = Array.from({ length: t?.param_count ?? 0 }, (_, i) => params[i] ?? '');
  const preview = t ? t.body.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => values[Number(n) - 1] || `[Value ${n}]`) : '';
  const charge = chargeFor(t, windowOpen, data?.rates ?? null);
  const missing = values.some((v) => !v.trim());
  return (
    <Dialog open size="lg" onOpenChange={(o) => !o && onClose()} title="Send a WhatsApp template" description={windowOpen ? undefined : 'Over 24 hours since the customer wrote: only an approved template can be sent.'} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" loading={busy} disabledReason={!t ? 'Choose a template' : missing ? 'Fill in every value' : charge.billable && !ack ? 'Confirm the charge' : null} onClick={async () => {
        if (!t) return;
        setBusy(true);
        key.current ??= newKey();
        try {
          const r = await api.post<{ attempt: ReplyAttemptDto }>(`/api/inbox/conversations/${conversationId}/replies`, { mode: 'private_message', body: preview, base_version: baseVersion, idempotency_key: key.current, template: { name: t.name, language: t.language, params: values.map((v) => v.trim()) }, acknowledge_charge: charge.billable ? ack : false });
          toast.info(r.attempt.state === 'queued' ? 'Sending…' : 'Sent');
          key.current = null;
          onSent();
        } catch (e) { key.current = null; toast.error(e, 'Not sent'); } finally { setBusy(false); }
      }}>{charge.billable ? 'Send (charged)' : 'Send'}</Button>
    </>}>
      {!data ? <SkeletonRows rows={3} /> : !approved.length ? <EmptyState compact title="No approved templates" /> : (
        <div className="flex flex-col gap-3">
          <Field label="Template"><Select value={t ? `${t.name}:${t.language}` : ''} onChange={(e) => { setSel(e.target.value); setParams([]); setAck(false); }}>
            {approved.map((x) => <option key={`${x.name}:${x.language}`} value={`${x.name}:${x.language}`}>{x.name} · {x.language} · {x.category ?? 'other'}</option>)}
          </Select></Field>
          {values.map((v, i) => <Field key={i} label={t?.examples?.[i] ? `Value ${i + 1} · e.g. ${t.examples[i]}` : `Value ${i + 1}`}><Input value={v} maxLength={1000} onChange={(e) => { const n = [...values]; n[i] = e.target.value; setParams(n); }} /></Field>)}
          <div className="rounded-lg border border-border bg-raised px-3 py-2 text-[13px]"><p className="mb-1 text-xs font-medium text-subtle">Will be sent exactly as</p><p className="whitespace-pre-wrap break-words">{preview}</p></div>
          {charge.billable ? (
            <Banner tone="warn" title="This message is charged">
              <p className="text-[13px]">{charge.text}</p>
              <div className="mt-2"><Checkbox label="I understand this message is charged" checked={ack} onChange={(e) => setAck(e.target.checked)} /></div>
            </Banner>
          ) : <Badge tone="success">{charge.text}</Badge>}
        </div>
      )}
    </Dialog>
  );
}
