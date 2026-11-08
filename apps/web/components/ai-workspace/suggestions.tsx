'use client';
// 4–6 context-aware suggestions below the composer (V5 §12). Each one comes from the server with the reason it is
// offered (real data) and a prefilled task; choosing it fills the composer and its short task-specific details.
import { m, useReducedMotion } from 'motion/react';
import { BarChart3, CalendarRange, FileText, MessageSquareReply, Repeat2, Sparkles } from 'lucide-react';
import type { AiWorkflow, SuggestionDto } from '@social-lite/core/contracts/v5-ai';

const ICON: Record<AiWorkflow, typeof Sparkles> = {
  inbox_assistance: MessageSquareReply, campaign_from_brief: FileText, weekly_planning: CalendarRange, performance_analysis: BarChart3, content_adaptation: Repeat2, ask: Sparkles,
};

export function Suggestions({ items, onPick }: { items: SuggestionDto[]; onPick: (s: SuggestionDto) => void }) {
  const reduce = useReducedMotion();
  if (!items.length) return null;
  return (
    <section aria-labelledby="ai-suggestions" className="mt-5">
      <h2 id="ai-suggestions" className="sr-only">Suggested tasks</h2>
      <ul className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3" data-testid="ai-suggestions">
        {items.map((s, i) => {
          const I = ICON[s.workflow];
          return (
            <m.li key={s.id} initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, delay: reduce ? 0 : i * 0.03 }}>
              <button type="button" onClick={() => onPick(s)} data-suggestion={s.id}
                className="group flex h-full w-full flex-col gap-1.5 rounded-xl border border-border bg-surface p-3.5 text-left transition-colors hover:border-[color-mix(in_srgb,var(--accent)_45%,var(--border))] hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]">
                <span className="flex items-center gap-2">
                  <I aria-hidden className="size-4 shrink-0 text-accent-text" />
                  <span className="text-[14px] font-medium leading-snug">{s.title}</span>
                </span>
                <span className="text-[13px] leading-snug text-muted">{s.description}</span>
                <span className="mt-auto pt-1 text-xs text-subtle">{s.reason}</span>
              </button>
            </m.li>
          );
        })}
      </ul>
    </section>
  );
}
