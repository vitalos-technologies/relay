'use client';
// Generic conversation timeline (reusable: social inbox now, Relay support tickets in V4). Knows nothing about inbox
// types or authorization — callers map their records to entries. Customer-visible messages and internal notes are
// visually unmistakable: notes are full-width, dashed amber, labelled "Internal note" with a lock.
import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { cn } from '@/components/ui';

export type TimelineSide = 'them' | 'us';
export type TimelineEntryView =
  | { key: string; kind: 'message'; side: TimelineSide; author: string; body: string | null; at: string; meta?: ReactNode; edited?: boolean; deleted?: boolean; attachments?: ReactNode[];
      /** Above the text (e.g. a rating or a "hidden" state) and an actions slot after the meta line. */
      header?: ReactNode; actions?: ReactNode; muted?: boolean }
  | { key: string; kind: 'note'; author: string; body: string; at: string }
  | { key: string; kind: 'pending'; author: string; body: string; at: string; status: ReactNode; actions?: ReactNode }
  | { key: string; kind: 'system'; text: string; at: string };

const time = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function ConversationTimeline({ entries, empty, className }: { entries: TimelineEntryView[]; empty?: ReactNode; className?: string }) {
  if (!entries.length) return <div className={cn('py-10 text-center text-[13px] text-muted', className)}>{empty ?? 'No messages yet'}</div>;
  return (
    <ol className={cn('flex flex-col gap-3', className)} aria-label="Conversation">
      {entries.map((e) => {
        if (e.kind === 'system') {
          return <li key={e.key} className="text-center text-xs text-subtle"><span>{e.text}</span> · <time dateTime={e.at}>{time(e.at)}</time></li>;
        }
        if (e.kind === 'note') {
          return (
            <li key={e.key} className="rounded-lg border border-dashed border-[color-mix(in_srgb,var(--warn)_55%,var(--border))] bg-[var(--warn-soft)] px-3 py-2">
              <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-[var(--warn)]">
                <Lock aria-hidden className="size-3.5" />Internal note · {e.author} · <time dateTime={e.at} className="font-normal">{time(e.at)}</time>
              </p>
              <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{e.body}</p>
            </li>
          );
        }
        if (e.kind === 'pending') {
          return (
            <li key={e.key} className="ml-auto flex max-w-[85%] flex-col items-end gap-1">
              <div className="rounded-2xl rounded-br-md border border-dashed border-border-strong bg-surface px-3 py-2 text-[13px] text-muted"><p className="whitespace-pre-wrap break-words">{e.body}</p></div>
              <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-muted">{e.status}{e.actions}</div>
            </li>
          );
        }
        const us = e.side === 'us';
        return (
          <li key={e.key} className={cn('flex max-w-[85%] flex-col gap-1', us ? 'ml-auto items-end' : 'items-start')}>
            <div className={cn('rounded-2xl px-3 py-2 text-[13px] leading-relaxed', us ? 'rounded-br-md bg-[var(--accent-soft)]' : 'rounded-bl-md bg-raised', e.muted && 'opacity-60')}>
              {e.header ? <div className="mb-1">{e.header}</div> : null}
              {e.deleted ? <p className="italic text-muted">Deleted by the sender</p> : <p className="whitespace-pre-wrap break-words">{e.body}</p>}
              {e.attachments?.length ? <p className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted">{e.attachments.map((a, i) => <span key={i}>{a}</span>)}</p> : null}
            </div>
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
              <span>{e.author}</span>·<time dateTime={e.at}>{time(e.at)}</time>{e.edited ? <span>· edited</span> : null}{e.meta}{e.actions}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
