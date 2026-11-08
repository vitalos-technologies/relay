'use client';
// Shared labels + the run polling hook for the V5 AI workspace. Progress is read back from the server (refresh-safe):
// while a run is active the page asks only for events after the last one it has (?after=<seq>), so updates are small
// and typing/scrolling stay responsive.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ACTIVE_STATUSES, type AiWorkflow, type WorkflowRunDto, type WorkflowStatus } from '@social-lite/core/contracts/v5-ai';
import { api } from '@/lib/client/api';

export const STATUS_LABEL: Record<WorkflowStatus, string> = {
  preparing: 'Preparing', working: 'Working', needs_input: 'Needs your input', needs_review: 'Ready for review',
  completed: 'Completed', partially_completed: 'Partly done', failed: 'Failed', cancelled: 'Stopped',
};
export const STATUS_TONE: Record<WorkflowStatus, 'info' | 'warn' | 'success' | 'danger' | 'neutral' | 'accent'> = {
  preparing: 'info', working: 'info', needs_input: 'accent', needs_review: 'accent', completed: 'success', partially_completed: 'warn', failed: 'danger', cancelled: 'neutral',
};

export const WORKFLOW_HINT: Record<AiWorkflow, string> = {
  campaign_from_brief: 'Outline a campaign from a document and save channel drafts.',
  inbox_assistance: 'Summarise conversations and prepare replies for review.',
  performance_analysis: 'Explain stored analytics with dates, coverage and evidence.',
  weekly_planning: 'Check the calendar and prepare a schedule for review.',
  content_adaptation: 'Turn approved material into versions for each account.',
  ask: 'Ask a question or get copy in your brand voice.',
};

export const isActive = (s: WorkflowStatus) => (ACTIVE_STATUSES as readonly string[]).includes(s);

export const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^A-Za-z0-9]/g, '').slice(0, 32);

export function relTime(iso: string, now = Date.now()): string {
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** One run, kept current: polls while preparing/working, appending events after the last seen sequence number. */
export function useRun(initial: WorkflowRunDto, onSettled?: (r: WorkflowRunDto) => void) {
  const [run, setRun] = useState(initial);
  const seq = useRef(initial.last_event_seq);
  const settled = useRef(onSettled);
  settled.current = onSettled;

  useEffect(() => { setRun(initial); seq.current = initial.last_event_seq; }, [initial]);

  const refresh = useCallback(async () => {
    const r = await api.get<WorkflowRunDto>(`/api/assistant/workflows/${initial.id}`);
    seq.current = r.last_event_seq;
    setRun(r);
    return r;
  }, [initial.id]);

  useEffect(() => {
    if (!isActive(run.status)) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async (delay: number) => {
      timer = setTimeout(async () => {
        if (stop) return;
        if (typeof document !== 'undefined' && document.hidden) { void tick(2000); return; }
        try {
          const r = await api.get<WorkflowRunDto>(`/api/assistant/workflows/${initial.id}`, { after: seq.current });
          if (stop) return;
          seq.current = Math.max(seq.current, r.last_event_seq);
          setRun((prev) => {
            const known = new Set(prev.events.map((e) => e.seq));
            return { ...r, events: [...prev.events, ...r.events.filter((e) => !known.has(e.seq))] };
          });
          if (isActive(r.status)) void tick(1000);
          else settled.current?.(r);
        } catch {
          if (!stop) void tick(3000);
        }
      }, delay);
    };
    void tick(800);
    return () => { stop = true; clearTimeout(timer); };
  }, [run.status, initial.id]);

  return { run, setRun, refresh };
}
