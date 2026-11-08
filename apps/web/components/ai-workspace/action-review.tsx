'use client';
// Review a prepared external action (V5 §15): exactly where it goes, what is sent, when, whether approval applies and
// whether you may do it. Confirming sends the hash of what you saw; if anything changed since, the server refuses and
// this dialog reloads the preview for a fresh review. The normal service re-checks permissions at dispatch.
import { useState } from 'react';
import { CalendarClock, CircleAlert, Send, ShieldCheck } from 'lucide-react';
import type { ActionPreviewDto } from '@social-lite/core/contracts/v5-ai';
import { api, isApiError } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { Badge, Banner, Button, Dialog, ErrorNotice, PlatformIcon, SkeletonRows, useToast } from '@/components/ui';

const CONFIRM_LABEL: Record<ActionPreviewDto['kind'], string> = { schedule_post: 'Schedule', submit_for_approval: 'Submit for approval', send_reply: 'Send reply' };
const TITLE: Record<ActionPreviewDto['kind'], string> = { schedule_post: 'Review schedule', submit_for_approval: 'Submit for approval', send_reply: 'Review reply' };

export function ActionReview({ actionId, open, onClose, onDone }: { actionId: string; open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const pv = useApi<ActionPreviewDto>(open ? `/api/assistant/actions/${actionId}/preview` : null);
  const [busy, setBusy] = useState<'confirm' | 'dismiss' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const p = pv.data;
  const label = p ? (p.kind === 'schedule_post' && p.approval_required ? 'Submit for approval' : CONFIRM_LABEL[p.kind]) : 'Confirm';

  const confirm = async () => {
    if (!p) return;
    setBusy('confirm'); setError(null);
    try {
      await api.post(`/api/assistant/actions/${actionId}/apply`, { reviewed_hash: p.hash });
      toast.success(p.kind === 'send_reply' ? 'Reply queued to send' : p.approval_required || p.kind === 'submit_for_approval' ? 'Submitted for approval' : 'Scheduled');
      onDone(); onClose();
    } catch (e) {
      setError(e);
      if (isApiError(e) && e.code === 'conflict') void pv.refetch();
    } finally { setBusy(null); }
  };
  const dismiss = async () => {
    setBusy('dismiss');
    try { await api.post(`/api/assistant/actions/${actionId}/dismiss`); onDone(); onClose(); } catch (e) { setError(e); } finally { setBusy(null); }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }} title={p ? TITLE[p.kind] : 'Review'} size="lg" busy={busy !== null}
      description={p?.effect}
      footer={p ? <>
        <Button variant="ghost" onClick={() => void dismiss()} loading={busy === 'dismiss'} disabledReason={p.action.status !== 'proposed' ? 'Already handled' : null}>Don’t do this</Button>
        <Button variant="primary" icon={p.kind === 'send_reply' ? <Send aria-hidden className="size-4" /> : <CalendarClock aria-hidden className="size-4" />} loading={busy === 'confirm'} onClick={() => void confirm()}
          disabledReason={p.action.status !== 'proposed' ? 'Already handled' : !p.allowed ? p.blocked_reason : null}>{label}</Button>
      </> : null}>
      {pv.error && !p ? <ErrorNotice error={pv.error} /> : !p ? <SkeletonRows rows={4} /> : (
        <div className="flex flex-col gap-4 text-[13px]" data-testid="action-review">
          {error ? <ErrorNotice error={error} title={isApiError(error) && error.code === 'conflict' ? 'Changed since you reviewed it — check the updated preview' : undefined} /> : null}
          {p.changed_since_prepared ? (
            <Banner tone="warn" title={p.kind === 'send_reply' ? 'New messages since this draft' : 'The post changed since this was prepared'}>
              {p.kind === 'send_reply' ? 'Open the conversation to read them before sending.' : 'This preview shows the current version. Check it before confirming.'}
            </Banner>
          ) : null}
          {!p.allowed && p.blocked_reason ? <Banner tone="warn" title="You can’t confirm this">{p.blocked_reason}</Banner> : null}
          <section aria-labelledby="ar-dest">
            <h3 id="ar-dest" className="mb-1.5 text-xs font-medium uppercase tracking-[0.06em] text-subtle">{p.kind === 'send_reply' ? 'Where' : 'Destinations'}</h3>
            <ul className="flex flex-col gap-1.5">
              {p.destinations.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-2">
                  {p.kind !== 'send_reply' ? <PlatformIcon provider={d.provider as never} className="size-4" /> : null}
                  <span className="min-w-0 break-words font-medium">{d.display_name}</span>
                  {!d.ready ? <Badge tone="warn">Needs attention</Badge> : null}
                </li>
              ))}
            </ul>
          </section>
          {p.timing ? (
            <section aria-labelledby="ar-when">
              <h3 id="ar-when" className="mb-1.5 text-xs font-medium uppercase tracking-[0.06em] text-subtle">When</h3>
              <p>{p.timing.mode === 'immediate' ? 'Now, when you confirm' : p.timing.mode === 'on_approval' ? 'When a reviewer approves it' : (
                <>{p.timing.local_time?.replace('T', ' ')} <span className="text-muted">({p.timing.timezone})</span>{p.timing.due_at ? <span className="text-muted"> · {new Date(p.timing.due_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} your time</span> : null}</>
              )}</p>
              {p.approval_required ? <p className="mt-1 flex items-center gap-1.5 text-muted"><ShieldCheck aria-hidden className="size-3.5" />This brand requires approval: it goes to reviewers first.</p> : null}
            </section>
          ) : null}
          <section aria-labelledby="ar-content">
            <h3 id="ar-content" className="mb-1.5 text-xs font-medium uppercase tracking-[0.06em] text-subtle">Exactly what is sent</h3>
            <ul className="flex flex-col gap-2">
              {p.content.map((c, i) => (
                <li key={i} className="rounded-lg border border-border bg-sunken px-3 py-2">
                  {c.destination ? <p className="mb-1 text-xs text-muted">{c.destination}</p> : null}
                  <p className="whitespace-pre-wrap break-words">{c.text || <span className="text-muted">(no text)</span>}</p>
                </li>
              ))}
            </ul>
          </section>
          <p className="flex items-start gap-1.5 text-xs text-subtle"><CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />Relay checks your permissions again when you confirm. <a className="underline" href={p.record.link}>Open the {p.record.type === 'post' ? 'post' : 'conversation'}</a></p>
        </div>
      )}
    </Dialog>
  );
}
