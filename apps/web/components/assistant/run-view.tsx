'use client';
// One assistant run: summary, EVIDENCE (verbatim quotes from cited sources, marked unverified when not found) and
// SUGGESTIONS (generated text, with check results) kept visually apart, the sources with trust + freshness, and the
// proposed actions as previews the person applies or dismisses. Nothing here sends or publishes.
import { useState } from 'react';
import { BookCheck, CircleAlert, FileText, Quote, ShieldAlert, Sparkles } from 'lucide-react';
import type { AssistantRunDto, ProposedActionDto, SourceRefDto } from '@social-lite/core/contracts/v35-ai';
import { api } from '@/lib/client/api';
import { Badge, Banner, Button, useToast } from '@/components/ui';

const TRUST: Record<SourceRefDto['trust'], { label: string; tone: 'success' | 'neutral' | 'warn' }> = {
  approved: { label: 'Approved', tone: 'success' },
  observed: { label: 'Relay data', tone: 'neutral' },
  untrusted: { label: 'Customer content', tone: 'warn' },
};

const SUGGESTION_LABEL: Record<string, string> = {
  reply: 'Reply draft', copy: 'Copy', summary: 'Summary', translation: 'Translation', brief: 'Brief', answer: 'Answer', labels: 'Triage', explanation: 'Explanation',
};

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : null);

export function RunView({ run, onUseText, onChanged }: { run: AssistantRunDto; onUseText?: (text: string, kind: string) => void; onChanged?: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const o = run.output;
  const srcByRef = new Map(run.sources.map((s) => [s.ref, s]));

  if (run.status === 'queued' || run.status === 'running') {
    return <p className="flex items-center gap-2 text-[13px] text-muted" role="status"><Sparkles aria-hidden className="size-4 animate-pulse" />Working on it…</p>;
  }
  if (run.status !== 'succeeded' || !o) {
    const title = run.status === 'not_configured' ? 'AI is not set up' : run.status === 'blocked' ? 'Stopped' : run.status === 'budget_exhausted' ? 'AI budget used up' : run.status === 'refused' ? 'Declined' : 'No result';
    return <Banner tone={run.status === 'blocked' ? 'warn' : 'danger'} title={title}>{run.status_detail ?? 'Try again.'}</Banner>;
  }

  const act = async (a: ProposedActionDto, kind: 'apply' | 'dismiss') => {
    setBusy(a.id);
    try {
      const r = await api.post<{ action: ProposedActionDto; text: string | null } | ProposedActionDto>(`/api/assistant/actions/${a.id}/${kind}`);
      if (kind === 'apply') {
        const text = 'text' in r ? r.text : null;
        if (text && onUseText) onUseText(text, a.kind);
        toast.success(a.kind === 'use_reply_draft' ? 'Added to the reply box. Review it, then send.' : 'Done');
      }
      onChanged?.();
    } catch (e) { toast.error(e); } finally { setBusy(null); }
  };

  return (
    <div className="flex flex-col gap-5 text-[13px]">
      {o.summary ? <p className="leading-relaxed">{o.summary}</p> : null}
      {o.uncertain ? (
        <Banner tone="warn" title="Not fully supported by the sources">{o.uncertainty_reason ?? 'Check before using.'}</Banner>
      ) : null}
      {o.notices.map((n) => <p key={n} className="flex items-start gap-1.5 text-xs text-warn"><ShieldAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />{n}</p>)}

      <section aria-labelledby={`ev-${run.id}`}>
        <h3 id={`ev-${run.id}`} className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.06em] text-subtle"><Quote aria-hidden className="size-3.5" />Evidence</h3>
        {o.evidence.length ? (
          <ul className="flex flex-col gap-2">
            {o.evidence.map((e, i) => (
              <li key={i} className="rounded-lg border border-border bg-sunken px-3 py-2">
                <blockquote className="break-words italic">“{e.quote}”</blockquote>
                <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                  <span>{srcByRef.get(e.source)?.title ?? e.source}</span>
                  {!e.verified ? <Badge tone="danger" className="h-5 px-1.5 text-[11px]">Not found in source</Badge> : null}
                </p>
              </li>
            ))}
          </ul>
        ) : <p className="text-muted">No quotes.</p>}
      </section>

      <section aria-labelledby={`sg-${run.id}`}>
        <h3 id={`sg-${run.id}`} className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.06em] text-subtle"><Sparkles aria-hidden className="size-3.5" />Suggestions · generated, review before use</h3>
        {o.suggestions.length ? (
          <ul className="flex flex-col gap-3">
            {o.suggestions.map((s, i) => {
              const blocked = s.issues.some((x) => x.severity === 'block');
              return (
                <li key={i} className="rounded-lg border border-dashed border-[color-mix(in_srgb,var(--accent-text)_40%,var(--border))] px-3 py-2.5">
                  <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    <Badge tone="accent" className="h-5 px-1.5 text-[11px]">{SUGGESTION_LABEL[s.kind] ?? s.kind}</Badge>
                    {s.language ? <span className="uppercase">{s.language}</span> : null}
                    {s.based_on.length ? <span>· from {s.based_on.map((r) => srcByRef.get(r)?.title ?? r).join(', ')}</span> : null}
                  </div>
                  <p className="whitespace-pre-wrap break-words">{s.text}</p>
                  {s.issues.length ? (
                    <ul className="mt-2 flex flex-col gap-1">
                      {s.issues.map((x, j) => <li key={j} className={`flex items-start gap-1.5 text-xs ${x.severity === 'block' ? 'text-danger' : 'text-warn'}`}><CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />{x.message}</li>)}
                    </ul>
                  ) : null}
                  {onUseText && !blocked && (s.kind === 'copy' || s.kind === 'translation' || s.kind === 'brief') ? (
                    <Button size="sm" variant="ghost" className="mt-2" onClick={() => onUseText(s.text, s.kind)}>Use text</Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : <p className="text-muted">No suggestion — the sources did not cover this.</p>}
      </section>

      {run.actions.length ? (
        <section aria-labelledby={`ac-${run.id}`}>
          <h3 id={`ac-${run.id}`} className="mb-2 text-xs font-medium uppercase tracking-[0.06em] text-subtle">Proposed actions</h3>
          <ul className="flex flex-col gap-2">
            {run.actions.map((a) => (
              <li key={a.id} className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2.5 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{a.preview.title}</p>
                  <p className="line-clamp-3 break-words text-xs text-muted">{a.preview.detail}</p>
                </div>
                {a.status === 'proposed' ? (
                  <div className="flex shrink-0 gap-1.5">
                    <Button size="sm" variant="ghost" loading={busy === a.id} onClick={() => act(a, 'dismiss')}>Dismiss</Button>
                    <Button size="sm" variant="secondary" loading={busy === a.id} onClick={() => act(a, 'apply')}>{a.kind === 'use_reply_draft' ? 'Use draft' : 'Apply'}</Button>
                  </div>
                ) : <Badge tone={a.status === 'applied' ? 'success' : 'neutral'}>{a.status === 'applied' ? 'Applied' : a.status === 'dismissed' ? 'Dismissed' : a.status === 'expired' ? 'Expired' : 'Failed'}</Badge>}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby={`so-${run.id}`}>
        <h3 id={`so-${run.id}`} className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.06em] text-subtle"><BookCheck aria-hidden className="size-3.5" />Sources</h3>
        <ul className="flex flex-col gap-1.5">
          {run.sources.map((s) => (
            <li key={s.ref} className="flex flex-wrap items-center gap-1.5">
              <FileText aria-hidden className="size-3.5 text-subtle" />
              {s.link ? <a href={s.link} className="min-w-0 truncate underline-offset-2 hover:underline">{s.title}</a> : <span className="min-w-0 truncate">{s.title}</span>}
              <Badge tone={TRUST[s.trust].tone} className="h-5 px-1.5 text-[11px]">{TRUST[s.trust].label}</Badge>
              {s.stale ? <Badge tone="danger" className="h-5 px-1.5 text-[11px]">Review overdue</Badge> : null}
              {s.freshness ? <span className="text-xs text-subtle">{when(s.freshness)}</span> : null}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-subtle">{run.provider === 'anthropic' ? 'Anthropic' : run.provider} · {run.latency_ms ? `${(run.latency_ms / 1000).toFixed(1)} s` : '—'}{run.usage ? ` · ${(run.usage.input_tokens + run.usage.output_tokens).toLocaleString()} tokens` : ''}</p>
      </section>
    </div>
  );
}
