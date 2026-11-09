'use client';
import { Check, Circle, Users } from 'lucide-react';
import { cn, InfoTip } from '@/components/ui';
import type { StageProgress } from './types';

/** Sequential review stages with distinct-approver counts (never colour alone: text + icon). */
export function StageProgressList({ stages, current, compact }: { stages: StageProgress[]; current: number; compact?: boolean }) {
  if (!stages.length) return <p className="text-[13px] text-muted">No review required</p>;
  return (
    <ol className={cn('flex flex-col gap-2', compact && 'gap-1')} aria-label="Review stages">
      {stages.map((s) => {
        const active = !s.met && s.position === current;
        return (
          <li key={s.position} className="flex items-center gap-2 text-[13px]">
            <span aria-hidden className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border',
              s.met ? 'border-success bg-success-soft text-success' : active ? 'border-[var(--accent)] text-fg' : 'border-border text-subtle')}>
              {s.met ? <Check className="size-3" /> : <Circle className="size-2 fill-current" />}
            </span>
            <span className={cn('min-w-0 flex-1 truncate', active ? 'font-medium' : 'text-muted')}>{s.name}</span>
            {s.allow_guests ? <span title="Client (guest) reviewers allowed"><Users aria-label="Guests allowed" className="size-3.5 text-subtle" /></span> : null}
            <span className="tabular text-xs text-muted">{s.approvals}/{s.quorum}<span className="sr-only"> approvals{s.met ? ', complete' : active ? ', in progress' : ''}</span></span>
          </li>
        );
      })}
      {!compact ? (
        <li className="text-[11px] text-subtle">
          Distinct people<InfoTip label="About quorum" className="ml-1">Each person counts once, while still eligible. Any change to content, media, destinations, links, time or policy needs a new review.</InfoTip>
        </li>
      ) : null}
    </ol>
  );
}
