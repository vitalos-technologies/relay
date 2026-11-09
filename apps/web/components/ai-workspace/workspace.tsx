'use client';
// V5 Relay AI workspace (/assistant): collapsible conversation history on the left (a sheet on small screens), a
// spacious composer with brand context, a short welcome and 4–6 suggestions from real data, and a working area where
// runs show their progress and result cards. State lives in the URL (?t=<conversation>&brand=) and on the server, so a
// refresh or a dropped connection never loses a run.
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { LazyMotion, MotionConfig, domAnimation } from 'motion/react';
import { BookCheck, History, PanelLeftClose, PanelLeftOpen, Workflow } from 'lucide-react';
import { WORKFLOW_FEATURE, type AiWorkspaceDto, type SuggestionDto, type ThreadDetailDto, type ThreadDto, type WorkflowRunDto } from '@social-lite/core/contracts/v5-ai';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { Banner, Button, Dialog, ErrorState, IconButton, SkeletonRows, useToast } from '@/components/ui';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui-v5/sheet';
import { Knowledge, RunHistory } from '@/components/assistant/assistant-app';
import { Composer, EMPTY_TASK, withDefaults, type DraftTask } from './composer';
import { Suggestions } from './suggestions';
import { HistoryList } from './history';
import { RunCard } from './run-card';
import { isActive, newKey } from './shared';

const SIDEBAR_KEY = 'relay.ai.sidebar';

function readPref(): boolean {
  try { return window.localStorage.getItem(SIDEBAR_KEY) !== 'closed'; } catch { return true; }
}

export function AiWorkspace() {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const { canV2 } = useSession();
  const threadId = search.get('t');
  const [brandId, setBrandId] = useState<string>(search.get('brand') ?? '');
  const ctx = useApi<AiWorkspaceDto>(`/api/assistant/workspace${brandId ? `?brand_id=${brandId}` : ''}`, { keepPrevious: true });
  const thread = useApi<ThreadDetailDto>(threadId ? `/api/assistant/threads/${threadId}` : null);
  const [task, setTask] = useState<DraftTask>(EMPTY_TASK);
  const [submitting, setSubmitting] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [sheet, setSheet] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);
  const [panel, setPanel] = useState<'knowledge' | 'earlier' | null>(null);
  const [newRuns, setNewRuns] = useState<WorkflowRunDto[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setSidebar(readPref()); }, []);
  useEffect(() => { setNewRuns([]); }, [threadId]);
  const c = ctx.data;
  const effectiveBrand = c?.brand_id ?? '';

  const go = useCallback((params: Record<string, string | null>) => {
    const next = new URLSearchParams(search.toString());
    for (const [k, v] of Object.entries(params)) { if (v) next.set(k, v); else next.delete(k); }
    const qs = next.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [pathname, router, search]);

  const toggleSidebar = () => setSidebar((v) => { try { window.localStorage.setItem(SIDEBAR_KEY, v ? 'closed' : 'open'); } catch { /* per-viewer convenience only */ } return !v; });
  const changeBrand = (id: string) => { setBrandId(id); setTask((t) => ({ ...EMPTY_TASK, prompt: t.prompt })); go({ brand: id, t: null }); };
  const openThread = (t: ThreadDto) => { setSheet(false); if (t.brand_id !== effectiveBrand) setBrandId(t.brand_id); go({ t: t.id, brand: t.brand_id }); };
  const newTask = () => { setSheet(false); setTask(EMPTY_TASK); go({ t: null }); };

  const pick = (s: SuggestionDto) => {
    setTask({ ...EMPTY_TASK, workflow: s.workflow, chosen: true, prompt: s.prefill.prompt, inputs: s.prefill.inputs });
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-testid="ai-composer"] textarea')?.focus({ preventScroll: true }));
  };

  const runs = [...(thread.data?.runs ?? []), ...newRuns.filter((r) => !thread.data?.runs.some((x) => x.id === r.id))];
  const activeRun = runs.find((r) => isActive(r.status)) ?? null;

  const submit = async () => {
    if (!c?.brand_id) return;
    const t = withDefaults(task);
    setSubmitting(true);
    try {
      const run = await api.post<WorkflowRunDto>('/api/assistant/workflows', {
        workflow: t.workflow, thread_id: threadId, prompt: t.prompt.trim() || null, idempotency_key: newKey(),
        inputs: { ...t.inputs, brand_id: c.brand_id, ...(t.knowledge.length ? { knowledge_ids: t.knowledge } : {}), ...(t.attachments.length ? { attachment_ids: t.attachments.map((a) => a.id) } : {}) },
      });
      setTask(EMPTY_TASK);
      setNewRuns((r) => [...r, run]);
      setHistoryKey((k) => k + 1);
      if (run.thread_id !== threadId) go({ t: run.thread_id, brand: c.brand_id });
      requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'end' }));
    } catch (e) { toast.error(e); } finally { setSubmitting(false); }
  };
  const stop = async () => {
    if (!activeRun) return;
    try { await api.post(`/api/assistant/workflows/${activeRun.id}/cancel`); void thread.refetch(); } catch (e) { toast.error(e); }
  };

  if (ctx.error && !c) return <ErrorState error={ctx.error} onRetry={() => void ctx.refetch()} />;

  const brand = c?.brands.find((b) => b.id === c.brand_id);
  const sideNav = <HistoryList activeId={threadId} onOpen={openThread} onNew={newTask} refreshKey={historyKey} />;
  const footer = (
    <div className="mt-3 flex flex-col gap-0.5 border-t border-border pt-3">
      <button type="button" className="flex items-center gap-2 rounded-lg px-2 py-2 text-[13px] text-muted hover:bg-raised hover:text-fg" onClick={() => { setSheet(false); setPanel('knowledge'); }}><BookCheck aria-hidden className="size-4" />Knowledge sources</button>
      <button type="button" className="flex items-center gap-2 rounded-lg px-2 py-2 text-[13px] text-muted hover:bg-raised hover:text-fg" onClick={() => { setSheet(false); setPanel('earlier'); }}><History aria-hidden className="size-4" />Quick results from other pages</button>
      {canV2('automation.manage') ? <a href="/automation" className="flex items-center gap-2 rounded-lg px-2 py-2 text-[13px] text-muted hover:bg-raised hover:text-fg"><Workflow aria-hidden className="size-4" />Automation</a> : null}
    </div>
  );

  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={domAnimation} strict>
        <div className={sidebar ? 'lg:grid lg:grid-cols-[248px_minmax(0,1fr)] lg:gap-8' : ''} data-testid="ai-workspace">
          {sidebar ? (
            <aside className="sticky top-[4.5rem] hidden max-h-[calc(100dvh-6rem)] min-h-0 flex-col lg:flex" aria-label="Assistant">
              <div className="mb-2 flex items-center justify-between">
                <p className="px-2 text-[15px] font-semibold" aria-hidden>Assistant</p>
                <IconButton label="Hide history" variant="ghost" icon={<PanelLeftClose className="size-4" />} onClick={toggleSidebar} />
              </div>
              {sideNav}
              {footer}
            </aside>
          ) : null}

          <div className="min-w-0">
            <div className="mb-4 flex items-center gap-2">
              {!sidebar ? <IconButton className="max-lg:hidden" label="Show history" variant="ghost" icon={<PanelLeftOpen className="size-4" />} onClick={toggleSidebar} /> : null}
              <Button className="lg:hidden" variant="secondary" size="sm" icon={<History aria-hidden className="size-4" />} onClick={() => setSheet(true)}>History</Button>
              <h1 className={sidebar ? 'text-[15px] font-semibold lg:sr-only' : 'text-[15px] font-semibold'}>{threadId && thread.data ? thread.data.title : 'Assistant'}</h1>
              <span className="flex-1" />
              {c && c.status.configured ? <span className="text-xs text-muted tabular">{c.status.budget.remaining.toLocaleString()} AI tokens left</span> : null}
            </div>

            {!c ? <SkeletonRows rows={5} /> : !c.brands.length ? (
              <Banner tone="info" title="No brand available">You need access to a brand with the assistant enabled. Ask an owner for access.</Banner>
            ) : threadId ? (
              <div className="flex flex-col gap-8 pb-6">
                {thread.error && !thread.data ? <ErrorState error={thread.error} onRetry={() => void thread.refetch()} /> : !thread.data ? <SkeletonRows rows={4} /> : null}
                {runs.map((r) => <RunCard key={r.id} initial={r} onSettled={() => { setHistoryKey((k) => k + 1); void thread.refetch().then(() => setNewRuns([])); }} />)}
                <div ref={endRef} />
                <div className="md:sticky md:bottom-4 md:z-10">
                  <Composer ctx={c} task={task} onTask={setTask} onBrand={changeBrand} onSubmit={() => void submit()} submitting={submitting} activeRunId={activeRun?.id ?? null} onStop={() => void stop()} compact />
                </div>
              </div>
            ) : (
              <div className="mx-auto flex max-w-[760px] flex-col pb-8 pt-2 sm:pt-8">
                <h2 className="text-balance text-[26px] font-semibold leading-tight tracking-[-0.01em] sm:text-[30px]">What should we work on{brand ? ` for ${brand.name}` : ''}?</h2>
                {!c.status.configured ? (
                  <Banner className="mt-5" tone="info" title="AI is not set up">Data steps (reading, checks, plans, reports) still run; AI-written parts are skipped. An owner can set the provider key and model in Setup.</Banner>
                ) : null}
                {!c.features.ai_workflows ? (
                  <Banner className="mt-5" tone="info" title="Multi-step tasks are on the Professional plan">Your plan includes AI drafting help. <a className="underline" href="/settings/workspace/billing">See plans</a></Banner>
                ) : null}
                <div className="mt-6">
                  <Composer ctx={c} task={task} onTask={setTask} onBrand={changeBrand} onSubmit={() => void submit()} submitting={submitting} activeRunId={null} onStop={() => undefined} autoFocus />
                </div>
                <Suggestions items={c.suggestions.filter((s) => WORKFLOW_FEATURE[s.workflow] === 'ai_drafting' || c.features.ai_workflows)} onPick={pick} />
                {!c.suggestions.length ? <p className="mt-5 text-[13px] text-muted">Connect an account, link a document or approve knowledge to get suggestions here.</p> : null}
              </div>
            )}
          </div>
        </div>

        <Sheet open={sheet} onOpenChange={setSheet}>
          <SheetContent side="left" closeLabel="Close history" className="gap-2 p-4 pt-14">
            <SheetTitle className="sr-only">Conversation history</SheetTitle>
            {sideNav}
            {footer}
          </SheetContent>
        </Sheet>

        <Dialog open={panel === 'knowledge'} onOpenChange={(v) => { if (!v) setPanel(null); }} title="Knowledge sources" size="lg">
          {panel === 'knowledge' ? <Knowledge /> : null}
        </Dialog>
        <Dialog open={panel === 'earlier'} onOpenChange={(v) => { if (!v) setPanel(null); }} title="Quick results from other pages" description="Single answers requested from the inbox, composer or analytics." size="lg">
          {panel === 'earlier' ? <RunHistory /> : null}
        </Dialog>
      </LazyMotion>
    </MotionConfig>
  );
}
