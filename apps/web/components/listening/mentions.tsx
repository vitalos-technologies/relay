'use client';
// Mention rows (search results, alert evidence) with the insight actions: open the conversation, create a task / case /
// content draft, correct the inferred sentiment, exclude. Each action is shown only when the person's permissions allow it;
// the server re-checks every one.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Ellipsis, ExternalLink } from 'lucide-react';
import type { ObservationDto, SentimentLabel } from '@social-lite/core/contracts/v35-listening';
import { api } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { Badge, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, useToast, cn } from '@/components/ui';
import { KIND_LABEL, SENTIMENT_LABEL, SentimentChip, fmtWhen, langTag } from './shared';

export interface InsightRef { observation_id?: string; alert_id?: string; search_id?: string }

/** Create a task / case / draft from an insight (idempotent per click). Returns the link to the new record. */
export function useInsightAction() {
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (action: 'task' | 'case' | 'draft', ref: InsightRef) => {
    setBusy(action);
    try {
      const r = await api.post<{ href: string; existing: boolean }>('/api/listening/actions', { action, ...ref, idempotency_key: crypto.randomUUID() });
      const what = action === 'task' ? 'Task' : action === 'case' ? 'Case' : 'Draft';
      toast.show({ tone: 'success', title: r.existing ? `${what} already exists` : `${what} created`, action: { label: 'Open', onClick: () => router.push(r.href) } });
    } catch (e) { toast.error(e); } finally { setBusy(null); }
  };
  return { run, busy };
}

export function MentionRow({ m, onChanged, compact, hideTopics }: { m: ObservationDto; onChanged?: () => void; compact?: boolean; hideTopics?: string[] }) {
  const { canOn, can } = useSession();
  const toast = useToast();
  const { run } = useInsightAction();
  const router = useRouter();
  const manage = canOn(m.brand_id, 'listening.manage');
  const correct = async (label: SentimentLabel | null) => {
    try { await api.patch(`/api/listening/mentions/${m.id}`, { sentiment: label }); toast.success(label ? `Marked ${SENTIMENT_LABEL[label].toLowerCase()}` : 'Correction removed'); onChanged?.(); } catch (e) { toast.error(e); }
  };
  const exclude = async () => {
    try { await api.patch(`/api/listening/mentions/${m.id}`, { excluded: true, reason: 'Not relevant' }); toast.success('Excluded from listening'); onChanged?.(); } catch (e) { toast.error(e); }
  };
  const removed = m.removed_at_source || m.text === null;
  return (
    <article className={cn('flex gap-3 border-b border-border px-4 py-3 last:border-b-0', removed && 'opacity-70')} aria-label={`Mention ${fmtWhen(m.occurred_at)}`}>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <span className="font-medium text-fg">{m.author ?? 'Unknown author'}</span>
          <span>{KIND_LABEL[m.kind]} · {m.source.channel_name ?? m.source.label}</span>
          <time dateTime={m.occurred_at}>{fmtWhen(m.occurred_at)}</time>
          <span title="Language">{langTag(m.language)}</span>
          {m.is_simulated ? <Badge tone="info" className="h-5 px-1.5 text-[11px]">Simulated</Badge> : null}
          {m.duplicates ? <span title="Identical repeats collapsed into this mention">+{m.duplicates} repeat{m.duplicates > 1 ? 's' : ''}</span> : null}
        </div>
        {removed ? <p className="text-[13px] italic text-muted">Removed at the source</p> : (
          <p className={cn('whitespace-pre-wrap break-words text-[14px] leading-relaxed', compact && 'line-clamp-3')}>{m.text}</p>
        )}
        {!removed ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <SentimentChip s={m.sentiment} />
            {m.topics.filter((t) => !hideTopics?.some((h) => t.split(' ').includes(h))).slice(0, compact ? 2 : 4).map((t) => <span key={t} className="rounded-full bg-raised px-2 py-0.5 text-[11px] text-muted">{t}</span>)}
            {m.links.case_id ? <Badge tone="accent" className="h-5 px-1.5 text-[11px]">Case</Badge> : null}
          </div>
        ) : null}
      </div>
      {!removed ? (
        <Menu>
          <MenuTrigger asChild>
            <button type="button" aria-label="Mention actions" className="touch-target -mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg">
              <Ellipsis aria-hidden className="size-4" />
            </button>
          </MenuTrigger>
          <MenuContent>
            <MenuItem onSelect={() => router.push(`/listening/mentions/${m.id}`)}>Details</MenuItem>
            {m.links.conversation_id && canOn(m.brand_id, 'inbox.read') ? (
              <MenuItem icon={<ExternalLink aria-hidden className="size-4" />} onSelect={() => router.push(`/inbox?c=${m.links.conversation_id}`)}>Open in inbox</MenuItem>
            ) : null}
            <MenuSeparator />
            <MenuLabel>Create</MenuLabel>
            <MenuItem onSelect={() => run('task', { observation_id: m.id })}>Task</MenuItem>
            {m.links.conversation_id && canOn(m.brand_id, 'cases.manage') ? <MenuItem onSelect={() => run('case', { observation_id: m.id })}>{m.links.case_id ? 'Open case' : 'Case'}</MenuItem> : null}
            {can('drafts.edit') ? <MenuItem onSelect={() => run('draft', { observation_id: m.id })}>Content draft</MenuItem> : null}
            {manage ? (
              <>
                <MenuSeparator />
                <MenuLabel>Sentiment</MenuLabel>
                {(['positive', 'neutral', 'negative', 'mixed'] as const).map((l) => (
                  <MenuItem key={l} disabled={m.sentiment.effective === l && !!m.sentiment.corrected} onSelect={() => correct(l)}>Mark {SENTIMENT_LABEL[l].toLowerCase()}</MenuItem>
                ))}
                {m.sentiment.corrected ? <MenuItem onSelect={() => correct(null)}>Undo correction</MenuItem> : null}
                <MenuSeparator />
                <MenuItem danger onSelect={exclude}>Exclude from listening</MenuItem>
              </>
            ) : null}
          </MenuContent>
        </Menu>
      ) : null}
    </article>
  );
}

export function MentionList({ items, onChanged, empty, compact, hideTopics }: { items: ObservationDto[]; onChanged?: () => void; empty?: string; compact?: boolean; hideTopics?: string[] }) {
  if (!items.length) return <p className="px-4 py-8 text-center text-[13px] text-muted">{empty ?? 'No mentions'}</p>;
  return <div>{items.map((m) => <MentionRow key={m.id} m={m} onChanged={onChanged} compact={compact} hideTopics={hideTopics} />)}</div>;
}

export function MentionLink({ id, children }: { id: string; children: React.ReactNode }) {
  return <Link href={`/listening/mentions/${id}`} className="underline-offset-2 hover:underline">{children}</Link>;
}
