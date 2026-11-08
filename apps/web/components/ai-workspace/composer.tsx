'use client';
// The AI composer (V5 §11): brand context, attach files, choose authorized knowledge sources, the task text, a task
// type (guessed from the text by a fixed rule, never a model; the person can change it), a short task-specific input
// panel, Submit and Stop. Selected context is always visible as chips.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, BookCheck, Paperclip, Square, X } from 'lucide-react';
import { AI_WORKFLOWS, ATTACHMENT_MAX_BYTES, WORKFLOW_FEATURE, WORKFLOW_LABEL, guessWorkflow, type AiWorkflow, type AiWorkspaceDto } from '@social-lite/core/contracts/v5-ai';
import { api } from '@/lib/client/api';
import { Badge, Button, Checkbox, IconButton, Input, Popover, PopoverContent, PopoverTrigger, Segmented, Select, cn, useToast } from '@/components/ui';
import { WORKFLOW_HINT } from './shared';

export interface DraftTask {
  workflow: AiWorkflow;
  /** The person picked the task type (stop auto-guessing from the text). */
  chosen: boolean;
  prompt: string;
  inputs: Record<string, unknown>;
  attachments: Array<{ id: string; filename: string }>;
  knowledge: string[];
}

export const EMPTY_TASK: DraftTask = { workflow: 'ask', chosen: false, prompt: '', inputs: {}, attachments: [], knowledge: [] };

function mondays(): Array<{ value: string; label: string }> {
  const d = new Date(); d.setHours(12, 0, 0, 0);
  const wd = d.getDay() === 0 ? 7 : d.getDay();
  d.setDate(d.getDate() - (wd - 1));
  return [0, 1, 2].map((i) => {
    const x = new Date(d); x.setDate(d.getDate() + i * 7);
    const v = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    return { value: v, label: i === 0 ? `This week (${x.toLocaleDateString([], { day: 'numeric', month: 'short' })})` : i === 1 ? `Next week (${x.toLocaleDateString([], { day: 'numeric', month: 'short' })})` : `Week of ${x.toLocaleDateString([], { day: 'numeric', month: 'short' })}` };
  });
}

/** Sensible defaults for a task's inputs (shown in the details panel, editable). */
export function withDefaults(t: DraftTask): DraftTask {
  const i = { ...t.inputs };
  if (t.workflow === 'performance_analysis' && !i.range_days) i.range_days = 28;
  if (t.workflow === 'weekly_planning' && !i.week_start) {
    const wd = new Date().getDay() || 7;
    i.week_start = mondays()[wd >= 5 ? 1 : 0]!.value;
  }
  return { ...t, inputs: i };
}

/** Why the task cannot be submitted yet (null = ready). */
export function missingFor(raw: DraftTask, ctx: AiWorkspaceDto): string | null {
  const t = withDefaults(raw);
  if (!ctx.brand_id) return 'Choose a brand';
  if (WORKFLOW_FEATURE[t.workflow] === 'ai_workflows' && !ctx.features.ai_workflows) return 'Multi-step tasks need the Professional plan';
  const i = t.inputs;
  switch (t.workflow) {
    case 'ask': return !ctx.status.configured ? 'Choose a task type — free questions need AI to be set up' : !t.prompt.trim() ? 'Write a question or task' : null;
    case 'campaign_from_brief': return !i.source ? 'Choose a brief' : null;
    case 'content_adaptation': return !i.source ? 'Choose the source' : !(i.connection_ids as string[] | undefined)?.length ? 'Choose at least one account' : null;
    case 'inbox_assistance': return !(i.conversation_ids as string[] | undefined)?.length ? 'Choose conversations' : null;
    case 'performance_analysis': return !i.range_days ? 'Choose a period' : null;
    case 'weekly_planning': return !i.week_start ? 'Choose a week' : null;
  }
}

export function Composer({ ctx, task, onTask, onBrand, onSubmit, submitting, activeRunId, onStop, autoFocus, compact }: {
  ctx: AiWorkspaceDto; task: DraftTask; onTask: (t: DraftTask) => void; onBrand: (id: string) => void; onSubmit: () => void; submitting: boolean;
  activeRunId: string | null; onStop: () => void; autoFocus?: boolean; compact?: boolean;
}) {
  const toast = useToast();
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const id = useId();
  const brand = ctx.brands.find((b) => b.id === ctx.brand_id);
  const set = (patch: Partial<DraftTask>) => onTask({ ...task, ...patch });
  const setInput = (k: string, v: unknown) => onTask({ ...task, inputs: { ...task.inputs, [k]: v } });
  const missing = missingFor(task, ctx);
  const available = AI_WORKFLOWS.filter((w) => (WORKFLOW_FEATURE[w] === 'ai_workflows' ? ctx.features.ai_workflows : ctx.features.ai_drafting && (w !== 'ask' || ctx.status.configured)));

  useEffect(() => { if (autoFocus) ref.current?.focus({ preventScroll: true }); }, [autoFocus]);
  // Auto-grow the text box (kept light: no re-render of the page while typing).
  useEffect(() => { const el = ref.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 280)}px`; }, [task.prompt]);

  const onText = (v: string) => {
    if (task.chosen || !v.trim()) { set({ prompt: v }); return; }
    const g = guessWorkflow(v);
    onTask({ ...task, prompt: v, workflow: available.includes(g) ? g : task.workflow });
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter submits on devices with a fine pointer; on touch keyboards Enter inserts a new line (use the button).
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia('(pointer: fine)').matches) {
      e.preventDefault();
      if (!missing && !submitting && !activeRunId) onSubmit();
    }
  };

  const attach = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f || !brand) return;
    if (f.size > ATTACHMENT_MAX_BYTES) { toast.error(new Error('Files can be up to 256 KB. Link larger documents in the Content library.')); return; }
    setUploading(true);
    try {
      const text = await f.text();
      const a = await api.post<{ id: string; filename: string }>('/api/assistant/attachments', { brand_id: brand.id, filename: f.name, mime: f.type || 'text/plain', text });
      const next: DraftTask = { ...task, attachments: [...task.attachments, { id: a.id, filename: a.filename }] };
      // A brief-type task without a source uses the new file as its source.
      if ((task.workflow === 'campaign_from_brief' || task.workflow === 'content_adaptation') && !task.inputs.source) next.inputs = { ...task.inputs, source: { kind: 'attachment', id: a.id } };
      onTask(next);
    } catch (e) { toast.error(e); } finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const knowledge = ctx.knowledge.filter((k) => k.brand_id === ctx.brand_id && k.available);
  const chips = [
    ...task.attachments.map((a) => ({ key: `a:${a.id}`, label: a.filename, remove: () => set({ attachments: task.attachments.filter((x) => x.id !== a.id), inputs: (task.inputs.source as { id?: string } | undefined)?.id === a.id ? { ...task.inputs, source: undefined } : task.inputs }) })),
    ...task.knowledge.map((kid) => ({ key: `k:${kid}`, label: knowledge.find((k) => k.id === kid)?.title ?? 'Knowledge', remove: () => set({ knowledge: task.knowledge.filter((x) => x !== kid) }) })),
  ];

  return (
    <form className={cn('rounded-2xl border border-border-strong bg-surface shadow-[var(--shadow)] focus-within:border-[color-mix(in_srgb,var(--accent)_55%,var(--border))]', compact ? 'p-2.5' : 'p-3 sm:p-4')}
      onSubmit={(e) => { e.preventDefault(); if (!missing && !submitting) onSubmit(); }} aria-label="Ask Relay AI" data-testid="ai-composer">
      {/* Context row: brand + task type + selected sources */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`${id}-brand`}>Brand</label>
        <Select id={`${id}-brand`} value={ctx.brand_id ?? ''} onChange={(e) => onBrand(e.target.value)} className="h-9 w-auto max-w-[200px] text-[13px]">
          {ctx.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </Select>
        <label className="sr-only" htmlFor={`${id}-wf`}>Task type</label>
        <Select id={`${id}-wf`} value={available.includes(task.workflow) ? task.workflow : ''} onChange={(e) => onTask({ ...task, workflow: e.target.value as AiWorkflow, chosen: true })}
          className="h-9 w-auto max-w-[220px] text-[13px]">
          {!available.includes(task.workflow) ? <option value="" disabled>Choose a task…</option> : null}
          {available.map((w) => <option key={w} value={w}>{WORKFLOW_LABEL[w]}</option>)}
        </Select>
        {chips.map((c) => (
          <span key={c.key} className="inline-flex max-w-full items-center gap-1 rounded-full bg-accent-soft py-1 pl-2.5 pr-1 text-xs text-accent-text">
            <span className="max-w-[180px] truncate">{c.label}</span>
            <button type="button" onClick={c.remove} className="inline-flex size-5 items-center justify-center rounded-full hover:bg-[color-mix(in_srgb,var(--accent)_20%,transparent)]" aria-label={`Remove ${c.label}`}><X aria-hidden className="size-3" /></button>
          </span>
        ))}
      </div>

      <label htmlFor={`${id}-text`} className="sr-only">Task</label>
      <textarea id={`${id}-text`} ref={ref} value={task.prompt} onChange={(e) => onText(e.target.value)} onKeyDown={onKey} rows={compact ? 1 : 3} maxLength={2000}
        placeholder={task.workflow === 'ask' ? 'Ask anything about your brand, or describe a task…' : `Anything to add? (${WORKFLOW_HINT[task.workflow].toLowerCase()})`}
        className="mt-2 block w-full resize-none bg-transparent px-1 py-1.5 text-[15px] leading-relaxed outline-none placeholder:text-subtle" />

      <TaskDetails ctx={ctx} task={task} setInput={setInput} />

      <div className="mt-2 flex items-center gap-1.5">
        <input ref={fileRef} type="file" accept=".txt,.md,.markdown,.csv,.json,text/plain,text/markdown,text/csv,application/json" className="sr-only" tabIndex={-1} aria-hidden
          onChange={(e) => void attach(e.target.files)} />
        <IconButton label={uploading ? 'Attaching…' : 'Attach a file (text, Markdown, CSV, JSON)'} variant="ghost" icon={<Paperclip className="size-4" />} onClick={() => fileRef.current?.click()} disabled={uploading || !brand} />
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" className="touch-target inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-muted hover:bg-raised hover:text-fg" aria-label={`Knowledge sources${task.knowledge.length ? `, ${task.knowledge.length} selected` : ''}`}>
              <BookCheck aria-hidden className="size-4" /><span className="max-sm:sr-only">Sources</span>{task.knowledge.length ? <Badge tone="accent" className="h-5 px-1.5 text-[11px]">{task.knowledge.length}</Badge> : null}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" label="Approved knowledge sources" className="w-[min(92vw,320px)]">
            <p className="mb-2 text-xs text-muted">Approved knowledge for {brand?.name ?? 'this brand'}. Only sources you can read are listed.</p>
            {knowledge.length ? (
              <div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
                {knowledge.map((k) => (
                  <Checkbox key={k.id} label={k.title} description={k.stale ? 'Past its review date' : k.topics.join(', ') || undefined} checked={task.knowledge.includes(k.id)}
                    onChange={(e) => set({ knowledge: e.target.checked ? [...task.knowledge, k.id].slice(0, 10) : task.knowledge.filter((x) => x !== k.id) })} />
                ))}
              </div>
            ) : <p className="text-[13px]">No approved knowledge yet. A brand manager can approve documents under Knowledge.</p>}
          </PopoverContent>
        </Popover>
        <span className="flex-1" />
        {activeRunId ? (
          <Button variant="secondary" icon={<Square aria-hidden className="size-3.5" />} onClick={onStop}>Stop</Button>
        ) : (
          <Button type="submit" variant="primary" loading={submitting} disabledReason={missing} icon={<ArrowUp aria-hidden className="size-4" />} aria-label="Start task">
            <span className="max-sm:sr-only">Start</span>
          </Button>
        )}
      </div>
    </form>
  );
}

function TaskDetails({ ctx, task, setInput }: { ctx: AiWorkspaceDto; task: DraftTask; setInput: (k: string, v: unknown) => void }) {
  const brand = ctx.brands.find((b) => b.id === ctx.brand_id);
  const ready = brand?.accounts.filter((a) => a.ready) ?? [];
  const docs = useMemo(() => ctx.documents.filter((d) => d.brand_id === ctx.brand_id), [ctx.documents, ctx.brand_id]);
  const id = useId();
  const i = withDefaults(task).inputs;
  const src = i.source as { kind: string; id: string } | undefined;
  const conns = (i.connection_ids as string[] | undefined) ?? [];
  const toggleConn = (cid: string, on: boolean) => setInput('connection_ids', on ? [...new Set([...conns, cid])] : conns.filter((x) => x !== cid));
  const docOptions = task.workflow === 'content_adaptation' ? [...docs.filter((d) => d.kind === 'post'), ...docs.filter((d) => d.kind !== 'post')] : docs.filter((d) => d.kind !== 'post').concat(docs.filter((d) => d.kind === 'post'));
  const attachmentsAsDocs = task.attachments.filter((a) => !docs.some((d) => d.id === a.id)).map((a) => ({ kind: 'attachment' as const, id: a.id, title: a.filename, brand_id: ctx.brand_id ?? '', updated_at: null, approved: false }));
  const allDocs = [...attachmentsAsDocs, ...docOptions];
  const KIND_LABEL: Record<string, string> = { knowledge: 'Approved knowledge', source_item: 'Content library', post: 'Post', attachment: 'Attached file' };

  if (task.workflow === 'ask') return null;
  return (
    <div className="mt-2 grid gap-3 rounded-xl bg-sunken p-3 text-[13px] sm:grid-cols-2" role="group" aria-label={`${WORKFLOW_LABEL[task.workflow]} details`}>
      {task.workflow === 'campaign_from_brief' || task.workflow === 'content_adaptation' ? (
        <div className="flex min-w-0 flex-col gap-1 sm:col-span-2">
          <label htmlFor={`${id}-src`} className="text-xs font-medium text-muted">{task.workflow === 'campaign_from_brief' ? 'Brief' : 'Source material'}</label>
          <Select id={`${id}-src`} value={src ? `${src.kind}:${src.id}` : ''} onChange={(e) => { const [kind, sid] = e.target.value.split(':'); setInput('source', kind && sid ? { kind, id: sid } : undefined); }}>
            <option value="">{allDocs.length ? 'Choose…' : 'Nothing yet — attach a file or link a document in the Content library'}</option>
            {allDocs.map((d) => <option key={`${d.kind}:${d.id}`} value={`${d.kind}:${d.id}`}>{KIND_LABEL[d.kind]} · {d.title}{d.kind === 'post' && d.approved ? ' (approved)' : ''}</option>)}
          </Select>
        </div>
      ) : null}
      {task.workflow === 'campaign_from_brief' || task.workflow === 'content_adaptation' || task.workflow === 'weekly_planning' ? (
        <fieldset className="flex min-w-0 flex-col gap-1.5">
          <legend className="mb-1 text-xs font-medium text-muted">Accounts{task.workflow !== 'content_adaptation' ? ' (all ready ones if none chosen)' : ''}</legend>
          {ready.length ? ready.map((a) => (
            <Checkbox key={a.id} label={`${a.provider} · ${a.display_name}`} description={a.simulated ? 'Simulated account' : undefined} checked={conns.includes(a.id)} onChange={(e) => toggleConn(a.id, e.target.checked)} />
          )) : <p className="text-muted">No account on this brand is ready. Connect one under Connections.</p>}
          {brand && brand.accounts.some((a) => !a.ready) ? <p className="text-xs text-subtle">Accounts that need attention are not offered.</p> : null}
        </fieldset>
      ) : null}
      {task.workflow === 'campaign_from_brief' ? (
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={`${id}-name`} className="text-xs font-medium text-muted">Campaign name (optional)</label>
          <Input id={`${id}-name`} value={String(i.campaign_name ?? '')} maxLength={120} onChange={(e) => setInput('campaign_name', e.target.value || undefined)} placeholder="Named after the brief" />
        </div>
      ) : null}
      {task.workflow === 'inbox_assistance' ? (
        <fieldset className="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
          <legend className="mb-1 text-xs font-medium text-muted">Conversations ({((i.conversation_ids as string[] | undefined) ?? []).length} of up to 10)</legend>
          {ctx.inbox?.conversations.length ? (
            <div className="grid max-h-48 gap-1.5 overflow-y-auto sm:grid-cols-2">
              {ctx.inbox.conversations.map((c) => {
                const sel = (i.conversation_ids as string[] | undefined) ?? [];
                return <Checkbox key={c.id} label={c.title} description={`${c.channel.replace(/_/g, ' ')}${c.waiting_since ? ` · waiting since ${new Date(c.waiting_since).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}` : ''}`}
                  checked={sel.includes(c.id)} disabled={!sel.includes(c.id) && sel.length >= 10}
                  onChange={(e) => setInput('conversation_ids', e.target.checked ? [...sel, c.id] : sel.filter((x) => x !== c.id))} />;
              })}
            </div>
          ) : <p className="text-muted">No unanswered conversations on this brand.</p>}
        </fieldset>
      ) : null}
      {task.workflow === 'performance_analysis' ? (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-medium text-muted" id={`${id}-range`}>Period</span>
          <Segmented label="Period" value={String(i.range_days ?? 28) as '7' | '28' | '90'} onChange={(v) => setInput('range_days', Number(v))}
            options={[{ value: '7', label: '7 days' }, { value: '28', label: '28 days' }, { value: '90', label: '90 days' }]} />
          {!ctx.analytics?.has_data ? <p className="text-xs text-subtle">No stored analytics yet for this brand: the report will say so.</p> : null}
        </div>
      ) : null}
      {task.workflow === 'weekly_planning' ? (
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={`${id}-week`} className="text-xs font-medium text-muted">Week</label>
          <Select id={`${id}-week`} value={String(i.week_start ?? '')} onChange={(e) => setInput('week_start', e.target.value)}>
            <option value="">Choose…</option>
            {mondays().map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
          </Select>
        </div>
      ) : null}
    </div>
  );
}
