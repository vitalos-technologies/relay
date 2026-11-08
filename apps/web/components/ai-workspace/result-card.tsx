'use client';
// Structured result cards (V5 §15): each links to the real record it created or used, separates AI-written text from
// Relay data, shows checks and evidence, and offers the useful next action — Open draft, Edit, Compare versions,
// Review reply, View report, Submit for approval, Review schedule, Create task.
import Link from 'next/link';
import { useState } from 'react';
import { m, useReducedMotion } from 'motion/react';
import {
  BarChart3, CalendarClock, CheckCircle2, CircleAlert, ClipboardList, ExternalLink, FileText, Flag, GitCompare, Info, ListChecks, MessageSquareReply, Pencil, Quote, Sparkles,
} from 'lucide-react';
import type { ResultCardDto, ResultKind } from '@social-lite/core/contracts/v5-ai';
import { api } from '@/lib/client/api';
import { Badge, Button, Dialog, LinkButton, Textarea, buttonClass, cn, useToast } from '@/components/ui';
import { ActionReview } from './action-review';

const KIND: Record<ResultKind, { label: string; icon: typeof FileText }> = {
  post_draft: { label: 'Draft', icon: FileText }, variant: { label: 'Version', icon: FileText }, campaign: { label: 'Campaign', icon: Flag },
  outline: { label: 'Outline', icon: ClipboardList }, reply_draft: { label: 'Reply draft', icon: MessageSquareReply }, report: { label: 'Report', icon: BarChart3 },
  task: { label: 'Task', icon: ListChecks }, schedule_plan: { label: 'Proposed time', icon: CalendarClock }, summary: { label: 'Summary', icon: Info },
  answer: { label: 'Answer', icon: Sparkles }, notice: { label: 'Checks', icon: ListChecks },
};

export function ResultCard({ r, onChanged }: { r: ResultCardDto; onChanged: () => void }) {
  const toast = useToast();
  const reduce = useReducedMotion();
  const [review, setReview] = useState<string | null>(null);
  const [compare, setCompare] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const K = KIND[r.kind];
  const lines = r.kind === 'report' && r.body ? r.body.split('\n') : null;

  const apply = async (actionId: string) => {
    setBusy(actionId);
    try { await api.post(`/api/assistant/actions/${actionId}/apply`, {}); toast.success('Task created'); onChanged(); } catch (e) { toast.error(e); } finally { setBusy(null); }
  };

  return (
    <m.li initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-4" data-testid={`result-${r.kind}`}>
      <div className="flex flex-wrap items-start gap-2">
        <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text"><K.icon aria-hidden className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted">{K.label}</p>
          <h4 className="break-words text-[14px] font-semibold leading-snug">{r.title}</h4>
        </div>
        {r.generated ? <Badge tone="accent" icon={<Sparkles aria-hidden className="size-3" />}>AI-written · review</Badge> : r.kind !== 'notice' ? <Badge tone="neutral">Relay data</Badge> : null}
      </div>

      {r.facts.length ? (
        <dl className="grid grid-cols-1 gap-y-1 text-[13px]">
          {r.facts.map((f, i) => <div key={i} className="flex min-w-0 gap-2"><dt className="shrink-0 text-muted">{f.label}</dt><dd className="min-w-0 break-words">{f.value}</dd></div>)}
        </dl>
      ) : null}

      {editing && r.record?.type === 'post' && r.record.id ? (
        <InlineEdit postId={r.record.id} initial={r.body ?? ''} onDone={(saved) => { setEditing(false); if (saved) { toast.success('Draft saved'); onChanged(); } }} />
      ) : lines ? (
        <ul className="flex flex-col gap-1 text-[13px]">{lines.map((l, i) => <li key={i} className="break-words">{l}</li>)}</ul>
      ) : r.body ? (
        <p className={cn('whitespace-pre-wrap break-words text-[13px] leading-relaxed', r.generated && 'rounded-lg border border-dashed border-[color-mix(in_srgb,var(--accent-text)_35%,var(--border))] px-3 py-2')}>{r.body}</p>
      ) : r.generated ? <p className="text-[13px] text-muted">The text was removed after 30 days. The record it created is kept.</p> : null}

      {r.issues.length ? (
        <ul className="flex flex-col gap-1">
          {r.issues.map((x, i) => <li key={i} className={cn('flex items-start gap-1.5 text-xs', x.severity === 'block' ? 'text-danger' : 'text-warn')}><CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" /><span className="break-words">{x.message}</span></li>)}
        </ul>
      ) : null}

      {r.evidence.length ? (
        <details className="group text-[13px]">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted hover:text-fg"><Quote aria-hidden className="size-3.5" />Evidence ({r.evidence.length})</summary>
          <ul className="mt-2 flex flex-col gap-1.5">
            {r.evidence.map((e, i) => <li key={i} className="rounded-lg bg-sunken px-3 py-1.5"><span className="break-words">{e.text}</span>{e.source ? <span className="block text-xs text-subtle">{e.source}</span> : null}</li>)}
          </ul>
        </details>
      ) : null}

      {r.actions.length ? (
        <div className="flex flex-wrap gap-2">
          {r.actions.map((a, i) => {
            if (a.href) {
              const icon = a.kind === 'view_report' ? <BarChart3 aria-hidden className="size-4" /> : <ExternalLink aria-hidden className="size-4" />;
              return <LinkButton key={i} href={a.href} size="sm" variant="secondary" icon={icon}>{a.label}</LinkButton>;
            }
            if (a.kind === 'edit') return <Button key={i} size="sm" variant="ghost" icon={<Pencil aria-hidden className="size-4" />} onClick={() => setEditing(true)} disabledReason={editing ? 'Editing' : null}>{a.label}</Button>;
            if (a.kind === 'compare_versions') return <Button key={i} size="sm" variant="ghost" icon={<GitCompare aria-hidden className="size-4" />} onClick={() => setCompare(true)}>{a.label}</Button>;
            if (a.kind === 'create_task' && a.action_id) return <Button key={i} size="sm" variant="secondary" icon={<CheckCircle2 aria-hidden className="size-4" />} loading={busy === a.action_id} onClick={() => void apply(a.action_id!)}>{a.label}</Button>;
            if (a.action_id) return <Button key={i} size="sm" variant={a.kind === 'submit_for_approval' ? 'secondary' : 'primary'} icon={a.kind === 'review_reply' ? <MessageSquareReply aria-hidden className="size-4" /> : <CalendarClock aria-hidden className="size-4" />} onClick={() => setReview(a.action_id!)}>{a.label}</Button>;
            return null;
          })}
        </div>
      ) : null}

      {review ? <ActionReview actionId={review} open onClose={() => setReview(null)} onDone={onChanged} /> : null}
      {compare && r.compare_with ? (
        <Dialog open onOpenChange={(v) => { if (!v) setCompare(false); }} title="Compare versions" size="xl">
          <div className="grid gap-4 text-[13px] md:grid-cols-2">
            <section aria-labelledby={`cmp-a-${r.id}`} className="min-w-0">
              <h3 id={`cmp-a-${r.id}`} className="mb-1.5 text-xs font-medium uppercase tracking-[0.06em] text-subtle">{r.compare_with.title}</h3>
              <p className="whitespace-pre-wrap break-words rounded-lg bg-sunken px-3 py-2">{r.compare_with.text}</p>
            </section>
            <section aria-labelledby={`cmp-b-${r.id}`} className="min-w-0">
              <h3 id={`cmp-b-${r.id}`} className="mb-1.5 text-xs font-medium uppercase tracking-[0.06em] text-subtle">{r.title} (new draft)</h3>
              <p className="whitespace-pre-wrap break-words rounded-lg border border-dashed border-border px-3 py-2">{r.body}</p>
            </section>
          </div>
          {r.record ? <p className="mt-4 text-xs text-muted">The original is unchanged. <Link className="underline" href={r.record.link}>Open the new draft</Link></p> : null}
        </Dialog>
      ) : null}
    </m.li>
  );
}

/** Edit the draft's text in place through the normal versioned save (a conflicting edit elsewhere is kept in History). */
function InlineEdit({ postId, initial, onDone }: { postId: string; initial: string; onDone: (saved: boolean) => void }) {
  const toast = useToast();
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const post = await api.get<{ version: number; draft: Record<string, unknown> }>(`/api/posts/${postId}`);
      await api.patch(`/api/posts/${postId}`, { expected_version: post.version, draft: { ...post.draft, baseText: text } });
      onDone(true);
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-col gap-2">
      <label className="sr-only" htmlFor={`edit-${postId}`}>Draft text</label>
      <Textarea id={`edit-${postId}`} value={text} onChange={(e) => setText(e.target.value)} rows={5} />
      <div className="flex justify-end gap-2">
        <button type="button" className={buttonClass('ghost', 'sm')} onClick={() => onDone(false)}>Cancel</button>
        <Button size="sm" variant="primary" loading={busy} onClick={() => void save()} disabledReason={!text.trim() ? 'Write something' : null}>Save draft</Button>
      </div>
    </div>
  );
}
