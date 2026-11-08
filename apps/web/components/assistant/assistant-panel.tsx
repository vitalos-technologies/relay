'use client';
// Contextual assistant entry point used by Composer, Inbox, Listening, Analytics, Planner and Content Hub. Opens a
// side drawer: pick a task, add a request, run. The run is queued server-side (pages never wait on generation) and
// polled. When AI is not set up the drawer says so and nothing runs — no placeholder output.
import { useMemo, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { SURFACE_TASKS, TASK_LABEL, type AssistantContextRef, type AssistantRunDto, type AssistantStatusDto, type AssistantSurface, type AssistantTask } from '@social-lite/core/contracts/v35-ai';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { Banner, Button, Drawer, ErrorNotice, Field, IconButton, LinkButton, Select, Textarea } from '@/components/ui';
import { RunView } from './run-view';

const LANGS: Array<[string, string]> = [['en', 'English'], ['de', 'German'], ['fr', 'French'], ['es', 'Spanish'], ['it', 'Italian'], ['nl', 'Dutch'], ['pt', 'Portuguese'], ['pl', 'Polish'], ['sv', 'Swedish'], ['ja', 'Japanese']];
const NEEDS_PROMPT: ReadonlySet<AssistantTask> = new Set(['answer_question', 'campaign_brief']);
const PROMPT_LABEL: Partial<Record<AssistantTask, string>> = { translate: 'Text to translate (optional)', answer_question: 'Question', campaign_brief: 'Brief', draft_copy: 'What to write (optional)', suggest_reply: 'Guidance (optional)', insight_to_draft: 'Angle (optional)' };
const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^A-Za-z0-9]/g, '').slice(0, 32);

export interface AssistantButtonProps {
  surface: AssistantSurface;
  /** Concrete context (conversation, post, …). Omit for brand-level surfaces: the drawer asks for a brand when needed. */
  context?: AssistantContextRef | null;
  brandId?: string | null;
  onUseText?: (text: string, kind: string) => void;
  iconOnly?: boolean;
  size?: 'sm' | 'md';
}

export function AssistantButton({ surface, context, brandId, onUseText, iconOnly, size = 'sm' }: AssistantButtonProps) {
  const [open, setOpen] = useState(false);
  const { canV2 } = useSession();
  if (!canV2('ai.use')) return null;
  return (
    <>
      {iconOnly
        ? <IconButton label="Assistant" icon={<Sparkles className="size-4" />} variant="ghost" onClick={() => setOpen(true)} />
        : <Button size={size} variant="ghost" icon={<Sparkles aria-hidden className="size-4" />} onClick={() => setOpen(true)}>Assistant</Button>}
      {open ? <AssistantDrawer open={open} onOpenChange={setOpen} surface={surface} context={context ?? null} brandId={brandId ?? null} onUseText={onUseText} /> : null}
    </>
  );
}

function AssistantDrawer({ open, onOpenChange, surface, context, brandId, onUseText }: { open: boolean; onOpenChange: (v: boolean) => void; surface: AssistantSurface; context: AssistantContextRef | null; brandId: string | null; onUseText?: AssistantButtonProps['onUseText'] }) {
  const { session, can } = useSession();
  const status = useApi<AssistantStatusDto>('/api/assistant/status');
  const tasks = SURFACE_TASKS[surface].filter((t) => context || ['answer_question', 'campaign_brief', 'draft_copy', 'explain_analytics', 'insight_to_draft'].includes(t));
  const [task, setTask] = useState<AssistantTask>(tasks[0] ?? 'answer_question');
  const [prompt, setPrompt] = useState('');
  const [lang, setLang] = useState('en');
  const [brand, setBrand] = useState(brandId ?? session.brands[0]?.id ?? '');
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const run = useApi<AssistantRunDto>(runId ? `/api/assistant/runs/${runId}` : null, { poll: (d) => (!d || d.status === 'queued' || d.status === 'running' ? 1500 : false) });

  const ctx: AssistantContextRef | null = useMemo(() => {
    if (surface === 'analytics' || task === 'explain_analytics') return brand ? { type: 'analytics', brand_id: brand, range_days: 28 } : null;
    if (context && context.type !== 'brand') return context;
    return brand ? { type: 'brand', id: brand } : null;
  }, [context, brand, surface, task]);
  const needsBrand = !context || context.type === 'brand' || surface === 'analytics';
  const s = status.data;

  const start = async () => {
    if (!ctx) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<AssistantRunDto>('/api/assistant/runs', { surface, task, context: ctx, prompt: prompt.trim() || null, target_language: task === 'translate' ? lang : null, idempotency_key: newKey() });
      setRunId(r.id);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange} title="Assistant" description="Reads only what you can access. Suggests; you decide."
      footer={s?.configured ? <>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
        <Button variant="primary" loading={busy || run.data?.status === 'queued' || run.data?.status === 'running'} icon={<Sparkles aria-hidden className="size-4" />} onClick={() => void start()}
          disabledReason={!s.can_use ? (s.remaining <= 0 ? 'Monthly AI budget used up' : 'You can’t use the assistant here') : !ctx ? 'Choose a brand' : NEEDS_PROMPT.has(task) && !prompt.trim() ? 'Write something first' : null}>
          {runId ? 'Run again' : 'Run'}
        </Button>
      </> : undefined}>
      {!s ? <p className="text-[13px] text-muted">Loading…</p> : !s.configured ? (
        <Banner tone="info" title="AI is not set up">
          No AI provider is configured, so the assistant is off. An owner can add a provider key in Setup.
          {can('setup.manage') ? <div className="mt-2"><LinkButton href="/setup" size="sm" variant="secondary">Open Setup</LinkButton></div> : null}
        </Banner>
      ) : (
        <div className="flex flex-col gap-4">
          <Field label="Task">
            <Select value={task} onChange={(e) => { setTask(e.target.value as AssistantTask); setRunId(null); }}>
              {tasks.map((t) => <option key={t} value={t}>{TASK_LABEL[t]}</option>)}
            </Select>
          </Field>
          {needsBrand && session.brands.length > 1 ? (
            <Field label="Brand">
              <Select value={brand} onChange={(e) => setBrand(e.target.value)}>
                {session.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            </Field>
          ) : null}
          {task === 'translate' ? (
            <Field label="Into">
              <Select value={lang} onChange={(e) => setLang(e.target.value)}>{LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
            </Field>
          ) : null}
          {task in PROMPT_LABEL ? (
            <Field label={PROMPT_LABEL[task]!}>
              <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} maxLength={2000} />
            </Field>
          ) : null}
          <p className="text-xs text-subtle">{s.remaining.toLocaleString()} of {s.cap.toLocaleString()} tokens left this month</p>
          {error ? <ErrorNotice error={error} /> : null}
          {run.error ? <ErrorNotice error={run.error} /> : null}
          {run.data ? <div className="border-t border-border pt-4"><RunView run={run.data} onUseText={onUseText} onChanged={() => void run.refetch()} /></div> : null}
        </div>
      )}
    </Drawer>
  );
}
