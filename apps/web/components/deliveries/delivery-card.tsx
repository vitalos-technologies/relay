'use client';
import { useState } from 'react';
import { ChevronDown, ExternalLink, RotateCcw, SearchCheck } from 'lucide-react';
import { PROVIDER_LABEL } from '@social-lite/core';
import { api } from '@/lib/client/api';
import type { Delivery } from '@/lib/client/types';
import {
  Banner, Button, Checkbox, cn, ConfirmDialog, DeliveryStateBadge, Dialog, ErrorNotice, Field, Input, PlatformIcon,
  RadioGroup, SimulatedBadge, Textarea, TimeWithZone, useToast,
} from '@/components/ui';

const ATTEMPT_OUTCOME: Record<string, string> = {
  success: 'Succeeded', published: 'Published', failed: 'Failed', retryable: 'Temporary error', transient: 'Temporary error',
  unknown: 'No confirmation received', blocked: 'Blocked', processing: 'Processing', aborted: 'Not sent',
};

/** One destination's delivery: state, timing, attempts and the safe actions available. */
export function DeliveryCard({ delivery: d, tz, onChanged, canAct = true, expandAttempts = false }: { delivery: Delivery; tz: string; onChanged?: (d: Delivery) => void; canAct?: boolean; expandAttempts?: boolean }) {
  const [retryOpen, setRetryOpen] = useState(false);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [showAttempts, setShowAttempts] = useState(expandAttempts);
  const attempts = d.attempts ?? [];

  return (
    <article className="rounded-xl border border-border bg-surface" aria-label={`${PROVIDER_LABEL[d.provider]} — ${d.display_name}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3.5">
        <PlatformIcon provider={d.provider} size="md" />
        <div className="min-w-0 flex-1 basis-[55%]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{d.display_name}</span>
            {d.is_mock ? <SimulatedBadge /> : null}
          </div>
          <p className="text-xs text-muted tabular">
            {d.state === 'published' && d.published_at ? (
              <>{d.is_mock ? 'Simulated delivery' : 'Published'} <TimeWithZone instant={d.published_at} tz={tz} /></>
            ) : (
              <>Due <TimeWithZone instant={d.due_at} tz={tz} /></>
            )}
            {d.attempt_count ? <> · Attempt {d.attempt_count} of {d.max_attempts}</> : null}
          </p>
        </div>
        <DeliveryStateBadge state={d.state} isMock={d.is_mock} />
      </div>

      <DeliveryExplanation d={d} tz={tz} />

      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
        {d.provider_url ? (
          <a
            href={d.provider_url}
            target="_blank"
            rel="noopener noreferrer"
            className="touch-target inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-accent-text hover:bg-raised"
          >
            {d.is_mock ? 'Open simulated result' : `View on ${PROVIDER_LABEL[d.provider]}`}
            <ExternalLink aria-hidden className="size-3.5" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        ) : null}
        {d.provider_ids.length ? (
          <span className="text-xs text-muted">
            ID <code className="font-mono text-[11px] text-fg">{d.provider_ids.join(', ')}</code>
          </span>
        ) : null}
        <span className="flex-1" />
        {attempts.length ? (
          <Button size="sm" variant="quiet" aria-expanded={showAttempts} onClick={() => setShowAttempts((s) => !s)}>
            {showAttempts ? 'Hide' : 'Show'} {attempts.length} attempt{attempts.length === 1 ? '' : 's'}
            <ChevronDown aria-hidden className={cn('size-4 transition-transform', showAttempts && 'rotate-180')} />
          </Button>
        ) : null}
        {canAct && d.state === 'unknown' ? (
          <Button size="sm" variant="secondary" icon={<SearchCheck aria-hidden className="size-4" />} onClick={() => setResolveOpen(true)}>
            Resolve
          </Button>
        ) : null}
        {canAct && d.can_retry ? (
          <Button size="sm" variant="secondary" icon={<RotateCcw aria-hidden className="size-4" />} onClick={() => setRetryOpen(true)}>
            Retry
          </Button>
        ) : null}
      </div>

      {showAttempts && attempts.length ? <AttemptList attempts={attempts} tz={tz} /> : null}

      <RetryDialog open={retryOpen} onOpenChange={setRetryOpen} delivery={d} onDone={onChanged} />
      <ResolveDialog open={resolveOpen} onOpenChange={setResolveOpen} delivery={d} onDone={onChanged} />
    </article>
  );
}

function DeliveryExplanation({ d, tz }: { d: Delivery; tz: string }) {
  let tone: 'danger' | 'warn' | 'info' | null = null;
  let title: string | null = null;
  let body: string | null = null;
  switch (d.state) {
    case 'unknown':
      tone = 'warn';
      title = 'We sent this but didn’t get a confirmation';
      body = `It may or may not have been posted${d.unknown_since ? '' : ''}. Check ${d.display_name} on ${PROVIDER_LABEL[d.provider]}, then use Resolve to record what happened. Retrying without checking could create a duplicate.`;
      break;
    case 'failed':
      tone = 'danger';
      title = 'Not published';
      body = d.last_error_message ?? 'The network rejected this post.';
      break;
    case 'expired':
      tone = 'danger';
      title = 'Missed its publish-before deadline';
      body = 'It was not sent, to avoid posting late. Retry to send it now, or reschedule.';
      break;
    case 'blocked':
      tone = 'warn';
      title = 'Blocked';
      body = d.blocked_reason ?? d.last_error_message ?? 'This destination needs attention before it can publish.';
      break;
    case 'retry_wait':
      tone = 'info';
      title = 'Temporary problem — retrying automatically';
      body = d.last_error_message ?? null;
      break;
    case 'paused':
      tone = 'info';
      title = 'Paused';
      body = 'Publishing is paused for this workspace, brand or account. It will send when resumed if still before its deadline.';
      break;
    default:
      return null;
  }
  return (
    <div className="px-4 pb-3.5">
      <Banner tone={tone} title={title}>
        {body ? <p>{body}</p> : null}
        {d.last_error_code && (d.state === 'failed' || d.state === 'blocked') ? <p className="mt-1 font-mono text-[11px] text-subtle">Code: {d.last_error_code}</p> : null}
        {d.state === 'retry_wait' && d.next_attempt_at ? <p className="mt-1 text-xs text-muted">Next attempt <TimeWithZone instant={d.next_attempt_at} tz={tz} format="time" /></p> : null}
        {d.state === 'unknown' && d.unknown_since ? <p className="mt-1 text-xs text-muted">Since <TimeWithZone instant={d.unknown_since} tz={tz} /></p> : null}
        {d.publish_before && (d.state === 'paused' || d.state === 'blocked') ? <p className="mt-1 text-xs text-muted">Publish-before deadline <TimeWithZone instant={d.publish_before} tz={tz} /></p> : null}
      </Banner>
    </div>
  );
}

export function AttemptList({ attempts, tz }: { attempts: NonNullable<Delivery['attempts']>; tz: string }) {
  return (
    <ol className="border-t border-border px-4 py-3" aria-label="Attempts">
      {attempts.map((a) => (
        <li key={a.attempt_number} className="relative border-l border-border py-2 pl-4 text-[13px]">
          <span aria-hidden className="absolute -left-[4.5px] top-3.5 size-2 rounded-full bg-[var(--border-strong)]" />
          <div className="flex flex-wrap items-center gap-x-2">
            <span className="font-medium">#{a.attempt_number}</span>
            <span className="text-muted">{a.kind === 'manual' ? 'Manual retry' : a.kind === 'reconcile' ? 'Reconciliation' : 'Automatic'}</span>
            <span>· {a.outcome ? ATTEMPT_OUTCOME[a.outcome] ?? a.outcome : 'In progress'}</span>
          </div>
          <p className="text-xs text-muted">
            <TimeWithZone instant={a.started_at} tz={tz} />
            {a.actor_email ? <> · by {a.actor_email}</> : null}
            {a.duplicate_risk_acknowledged ? <> · duplicate risk acknowledged</> : null}
          </p>
          {a.safe_message ? <p className="mt-0.5 text-xs">{a.safe_message}{a.safe_code ? <span className="ml-1 font-mono text-[11px] text-subtle">({a.safe_code})</span> : null}</p> : null}
        </li>
      ))}
    </ol>
  );
}

export function RetryDialog({ open, onOpenChange, delivery: d, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; delivery: Delivery; onDone?: (d: Delivery) => void }) {
  const toast = useToast();
  const [ack, setAck] = useState(false);
  const needsAck = d.retry_requires_ack || d.state === 'unknown';
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => { if (!o) setAck(false); onOpenChange(o); }}
      title={`Retry ${PROVIDER_LABEL[d.provider]} — ${d.display_name}?`}
      description={needsAck
        ? 'We don’t know whether the previous attempt was posted. Retrying may publish this a second time.'
        : 'Only this destination is retried. Destinations that already succeeded are never re-sent.'}
      confirmLabel={d.is_mock ? 'Retry (simulated)' : 'Retry now'}
      confirmVariant={needsAck ? 'danger' : 'primary'}
      confirmDisabledReason={needsAck && !ack ? 'Confirm you understand the duplicate risk first.' : null}
      onConfirm={async () => {
        const res = await api.post<Delivery>(`/api/deliveries/${d.id}/retry`, needsAck ? { acknowledge_duplicate_risk: true } : {});
        toast.success('Retry queued', `${d.display_name} will be attempted again shortly.`);
        onDone?.(res);
      }}
    >
      {needsAck ? (
        <div className="flex flex-col gap-3">
          <Banner tone="warn">Check {d.display_name} on {PROVIDER_LABEL[d.provider]} first. If the post is there, use Resolve instead of retrying.</Banner>
          <Checkbox checked={ack} onChange={(e) => setAck(e.target.checked)} label="I understand this may create a duplicate post" description="This manual attempt is recorded in the audit log with your name." />
        </div>
      ) : null}
    </ConfirmDialog>
  );
}

export function ResolveDialog({ open, onOpenChange, delivery: d, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; delivery: Delivery; onDone?: (d: Delivery) => void }) {
  const toast = useToast();
  const [outcome, setOutcome] = useState<'published' | 'not_published' | ''>('');
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const urlInvalid = url.trim() !== '' && !/^https:\/\/\S+$/i.test(url.trim());

  const submit = async () => {
    if (!outcome) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<Delivery>(`/api/deliveries/${d.id}/resolve`, {
        outcome,
        provider_url: outcome === 'published' && url.trim() ? url.trim() : undefined,
        note: note.trim() || undefined,
      });
      toast.success('Outcome recorded');
      onDone?.(res);
      onOpenChange(false);
      setOutcome('');
      setUrl('');
      setNote('');
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
      title={`Resolve unknown result — ${d.display_name}`}
      description={`Look for this post on ${PROVIDER_LABEL[d.provider]}${d.is_mock ? ' (simulated destination)' : ''}, then record what you found.`}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabledReason={!outcome ? 'Choose what you found.' : urlInvalid ? 'Fix the post link.' : null}>
            Record outcome
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <RadioGroup
          name="outcome"
          legend="What did you find?"
          value={outcome}
          onChange={setOutcome}
          options={[
            { value: 'published', label: 'It was posted', description: 'Mark as published. It will not be sent again.' },
            { value: 'not_published', label: 'It was not posted', description: 'Mark as not published. You can then retry safely.' },
          ]}
        />
        {outcome === 'published' ? (
          <Field label="Link to the post" optional error={urlInvalid ? 'Use a full https:// link.' : null}>
            <Input type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
          </Field>
        ) : null}
        <Field label="Note" optional hint="Saved to the audit log.">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} className="min-h-16" />
        </Field>
        {error ? <ErrorNotice error={error} /> : null}
      </div>
    </Dialog>
  );
}
