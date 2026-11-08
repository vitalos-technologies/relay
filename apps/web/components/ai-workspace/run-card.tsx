'use client';
// One workflow run: the person's request, observable progress (steps + short Relay-written events, never model
// reasoning), the outcome explained, a question when Relay needs input, Stop / Retry, and the result cards.
import { useMemo, useState } from 'react';
import { m, useReducedMotion } from 'motion/react';
import { Ban, Check, ChevronDown, Circle, CircleSlash, Loader2, RotateCcw, Square, TriangleAlert, X } from 'lucide-react';
import { WORKFLOW_LABEL, type NeedsInputDto, type StepStatus, type WorkflowRunDto } from '@social-lite/core/contracts/v5-ai';
import { api } from '@/lib/client/api';
import { Badge, Banner, Button, Checkbox, cn, useToast } from '@/components/ui';
import { ResultCard } from './result-card';
import { STATUS_LABEL, STATUS_TONE, isActive, relTime, useRun } from './shared';

const STEP_ICON: Record<StepStatus, { icon: typeof Check; cls: string; label: string }> = {
  pending: { icon: Circle, cls: 'text-subtle', label: 'Not started' },
  running: { icon: Loader2, cls: 'text-accent-text motion-safe:animate-spin', label: 'In progress' },
  succeeded: { icon: Check, cls: 'text-success', label: 'Done' },
  failed: { icon: X, cls: 'text-danger', label: 'Failed' },
  skipped: { icon: CircleSlash, cls: 'text-subtle', label: 'Skipped' },
  cancelled: { icon: Ban, cls: 'text-subtle', label: 'Stopped' },
  not_configured: { icon: TriangleAlert, cls: 'text-warn', label: 'AI is not set up' },
};

export function RunCard({ initial, onSettled }: { initial: WorkflowRunDto; onSettled?: () => void }) {
  const toast = useToast();
  const reduce = useReducedMotion();
  const { run, setRun, refresh } = useRun(initial, () => onSettled?.());
  const [busy, setBusy] = useState<'stop' | 'retry' | null>(null);
  const [showLog, setShowLog] = useState(false);
  const active = isActive(run.status);
  const latest = run.events[run.events.length - 1];
  const doneSteps = run.steps.filter((s) => s.status !== 'pending' && s.status !== 'running').length;

  const stop = async () => {
    setBusy('stop');
    try { setRun(await api.post<WorkflowRunDto>(`/api/assistant/workflows/${run.id}/cancel`)); } catch (e) { toast.error(e); } finally { setBusy(null); }
  };
  const retry = async () => {
    setBusy('retry');
    try { setRun(await api.post<WorkflowRunDto>(`/api/assistant/workflows/${run.id}/retry`)); } catch (e) { toast.error(e); } finally { setBusy(null); }
  };
  const changed = () => { void refresh().then(() => onSettled?.()); };

  return (
    <m.article initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }}
      aria-labelledby={`run-${run.id}`} className="flex flex-col gap-4" data-testid="run-card" data-status={run.status}>
      {run.input.prompt || run.input.sources.length ? (
        <div className="ml-auto max-w-[min(100%,560px)] rounded-2xl rounded-br-md bg-raised px-4 py-2.5 text-[14px]">
          {run.input.prompt ? <p className="whitespace-pre-wrap break-words">{run.input.prompt}</p> : null}
          {run.input.sources.length || run.input.attachments.length || run.input.knowledge.length ? (
            <p className="mt-1 flex flex-wrap gap-1 text-xs text-muted">
              {[...run.input.sources.map((s) => s.title), ...run.input.attachments.map((a) => a.filename), ...run.input.knowledge.map((k) => k.title)].slice(0, 6).map((t, i) => (
                <span key={i} className="max-w-full truncate rounded-full border border-border px-2 py-0.5">{t}</span>
              ))}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1 basis-full sm:basis-auto">
            <p className="text-xs text-muted">{WORKFLOW_LABEL[run.workflow]} · {relTime(run.created_at)}</p>
            <h3 id={`run-${run.id}`} className="break-words text-[15px] font-semibold leading-snug">{run.title}</h3>
          </div>
          <Badge tone={STATUS_TONE[run.status]}>{STATUS_LABEL[run.status]}</Badge>
          {run.can_cancel ? <Button size="sm" variant="secondary" icon={<Square aria-hidden className="size-3.5" />} loading={busy === 'stop'} onClick={() => void stop()}>Stop</Button> : null}
          {run.can_retry ? <Button size="sm" variant="secondary" icon={<RotateCcw aria-hidden className="size-3.5" />} loading={busy === 'retry'} onClick={() => void retry()}>Retry</Button> : null}
        </div>

        {/* Progress: the latest observable action, announced politely; steps as a checklist. */}
        <p className="mt-3 min-h-5 text-[13px] text-muted" role="status" aria-live="polite" aria-atomic="true">
          {active && latest ? latest.message : run.cancel_requested && active ? 'Stopping after the current step…' : ''}
        </p>
        <ol className="mt-2 grid gap-1.5 sm:grid-cols-2" aria-label={`Steps, ${doneSteps} of ${run.steps.length} finished`}>
          {run.steps.map((s) => {
            const I = STEP_ICON[s.status];
            return (
              <li key={s.key} className="flex min-w-0 items-start gap-2 text-[13px]">
                <I.icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', I.cls)} />
                <span className={cn('min-w-0', s.status === 'pending' && 'text-muted')}>
                  <span className="break-words">{s.label}</span>
                  <span className="sr-only">: {I.label}</span>
                  {s.detail && s.status !== 'succeeded' ? <span className="block break-words text-xs text-subtle">{s.detail}</span> : null}
                </span>
              </li>
            );
          })}
        </ol>

        {!active && run.status_detail ? (
          <Banner className="mt-4" tone={run.status === 'completed' ? 'success' : run.status === 'failed' ? 'danger' : run.status === 'cancelled' ? 'info' : 'warn'}
            title={run.outcome_code === 'not_configured' && run.status !== 'needs_review' ? 'AI is not set up' : run.status === 'cancelled' ? undefined : STATUS_LABEL[run.status]}>{run.status_detail}</Banner>
        ) : null}

        {run.pending_input ? <InputQuestion runId={run.id} q={run.pending_input} onAnswered={(r) => setRun(r)} /> : null}

        <button type="button" onClick={() => setShowLog((v) => !v)} aria-expanded={showLog} aria-controls={`log-${run.id}`}
          className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-fg">
          <ChevronDown aria-hidden className={cn('size-3.5 transition-transform motion-reduce:transition-none', showLog && 'rotate-180')} />Activity ({run.events.length})
        </button>
        {showLog ? (
          <ol id={`log-${run.id}`} className="mt-2 flex max-h-64 flex-col gap-1 overflow-y-auto rounded-lg bg-sunken px-3 py-2 text-xs">
            {run.events.map((e) => (
              <li key={e.seq} className={cn('flex gap-2', e.level === 'error' ? 'text-danger' : e.level === 'warn' ? 'text-warn' : e.level === 'success' ? 'text-success' : 'text-muted')}>
                <time className="shrink-0 tabular text-subtle" dateTime={e.at}>{new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
                <span className="break-words">{e.message}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>

      {run.results.length ? (
        <ul className="grid gap-3 lg:grid-cols-2" aria-label="Results">
          {run.results.map((r) => <ResultCard key={r.id} r={r} onChanged={changed} />)}
        </ul>
      ) : null}
    </m.article>
  );
}

function InputQuestion({ runId, q, onAnswered }: { runId: string; q: NeedsInputDto; onAnswered: (r: WorkflowRunDto) => void }) {
  const toast = useToast();
  const [picked, setPicked] = useState<string[]>(q.kind === 'choose_many' ? q.options.map((o) => o.value) : []);
  const [busy, setBusy] = useState(false);
  const send = async (value: string | string[]) => {
    setBusy(true);
    try { onAnswered(await api.post<WorkflowRunDto>(`/api/assistant/workflows/${runId}/input`, { field: q.field, value })); } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  const id = useMemo(() => `q-${runId}`, [runId]);
  return (
    <fieldset className="mt-4 rounded-xl border border-[color-mix(in_srgb,var(--accent-text)_40%,var(--border))] bg-accent-soft/40 p-4" aria-labelledby={id}>
      <legend id={id} className="px-1 text-[13px] font-semibold">{q.question}</legend>
      {q.kind === 'choose_many' ? (
        <div className="mt-2 flex flex-col gap-2">
          {q.options.map((o) => (
            <Checkbox key={o.value} label={o.label} description={o.hint} checked={picked.includes(o.value)}
              onChange={(e) => setPicked((p) => (e.target.checked ? [...p, o.value] : p.filter((x) => x !== o.value)))} />
          ))}
          <Button className="self-start" size="sm" variant="primary" loading={busy} disabledReason={!picked.length ? 'Choose at least one' : null} onClick={() => void send(picked)}>Continue</Button>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {q.options.map((o) => <Button key={o.value} size="sm" variant="primary" loading={busy} onClick={() => void send(o.value)}>{o.label}</Button>)}
          <p className="w-full text-xs text-muted">Or press Stop to cancel. Nothing else runs until you answer.</p>
        </div>
      )}
    </fieldset>
  );
}
