'use client';
// "Send to Relay support" for a workspace-local problem report (V4 SUP, brief §6): review first, then submit. Shows the
// redacted summary and every diagnostic as an opt-in checkbox; the draft excerpt is off unless ticked. Nothing else is sent.
import Link from 'next/link';
import { useState } from 'react';
import { CircleCheck } from 'lucide-react';
import type { CustomerTicketDetail, ProblemReportSharePreview } from '@social-lite/core/contracts/v4-support';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { Button, Checkbox, Dialog, ErrorNotice, Field, Select, Skeleton, Textarea } from '@/components/ui';

type Props = { reportId: string | null; open: boolean; onOpenChange: (o: boolean) => void; onShared?: (t: CustomerTicketDetail) => void };

/** Fresh state every time it opens (keyed), so a previous review never leaks into the next one. */
export function ShareReportDialog(props: Props) {
  return <ShareReportInner key={`${props.reportId ?? ''}:${props.open}`} {...props} />;
}

function ShareReportInner({ reportId, open, onOpenChange, onShared }: Props) {
  const { data, error } = useApi<ProblemReportSharePreview>(open && reportId ? `/api/support/reports/${reportId}/share` : null);
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const picked = chosen ?? new Set((data?.diagnostics ?? []).filter((d) => d.default_selected).map((d) => d.key as string));
  const setPicked = (fn: (p: Set<string>) => Set<string>) => setChosen(fn(picked));
  const [excerpt, setExcerpt] = useState(false);
  const [message, setMessage] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState<CustomerTicketDetail | null>(null);
  const send = async () => {
    setBusy(true); setErr(null);
    try {
      const t = await api.post<CustomerTicketDetail>(`/api/support/reports/${reportId}/share`, {
        diagnostics: [...picked], include_draft_excerpt: excerpt, message: message.trim() || undefined, ticket_id: target || null,
      }, { idempotent: true });
      setDone(t); onShared?.(t);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const shared = done ? { reference: done.reference } : data?.already_shared ?? null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg" busy={busy} title="Send to Relay support"
      footer={shared ? <Button variant="primary" onClick={() => onOpenChange(false)}>Done</Button> : <>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="primary" loading={busy} onClick={() => void send()} disabledReason={!data ? 'Loading' : null}>Send to Relay</Button>
      </>}>
      {error ? <ErrorNotice error={error} /> : !data ? <Skeleton className="h-48 w-full rounded-lg" /> : shared ? (
        <p className="flex flex-wrap items-center gap-2 text-[13px]" data-testid="report-shared">
          <CircleCheck aria-hidden className="size-4 text-success" />Shared as <Link className="font-medium text-accent-text hover:underline" href={`/help/requests/${shared.reference}`}>{shared.reference}</Link>
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="rounded-lg bg-sunken p-3">
            <p className="mb-1 text-xs text-muted">Report{data.report.redactions ? ` · ${data.report.redactions} redacted` : ''}</p>
            <p className="whitespace-pre-wrap break-words text-[13px]">{data.report.summary}</p>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-[13px] font-medium">Include</legend>
            {data.diagnostics.length ? data.diagnostics.map((d) => (
              <Checkbox key={d.key} label={d.label} description={<span className="break-all">{d.value}</span>} checked={picked.has(d.key)}
                onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(d.key); else n.delete(d.key); return n; })} />
            )) : <p className="text-xs text-muted">No technical details were captured.</p>}
            {data.draft_excerpt_available ? <Checkbox label="Draft excerpt" description="The redacted excerpt attached to this report" checked={excerpt} onChange={(e) => setExcerpt(e.target.checked)} /> : null}
          </fieldset>
          {data.open_tickets.length ? (
            <Field label="Send as">
              <Select value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">New request</option>
                {data.open_tickets.map((t) => <option key={t.id} value={t.id}>Add to {t.reference} · {t.subject}</option>)}
              </Select>
            </Field>
          ) : null}
          <Field label="Message" optional><Textarea rows={3} maxLength={4000} value={message} onChange={(e) => setMessage(e.target.value)} /></Field>
          <p className="text-xs text-muted">No cookies, tokens, storage, logs or other drafts are sent.</p>
          {err ? <ErrorNotice error={err} /> : null}
        </div>
      )}
    </Dialog>
  );
}
