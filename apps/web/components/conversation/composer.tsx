'use client';
// Generic reply composer (reusable in V4 support tickets). Modes are explicit and visually distinct:
//  - customer-facing modes ("Public reply", "Private message") use the normal frame + a visibility line;
//  - the internal mode ("Internal note") switches to a dashed amber frame + lock and its own submit label.
// Switching modes never sends and never clears the text. The keyboard-open layout keeps the box + button visible
// (sticky bottom, max height, internal scroll).
import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Globe, Lock, MessageSquare, Send } from 'lucide-react';
import { Button, cn, Segmented, Textarea } from '@/components/ui';

export type ComposerAudience = 'public' | 'private' | 'internal';
export interface ComposerMode<T extends string> { value: T; label: string; audience: ComposerAudience; disabled?: boolean; reason?: string | null }
/** @mentions in INTERNAL mode only: options are people who may be notified; ids of mentions still in the text are reported. */
export interface ComposerMentions { options: Array<{ id: string; label: string }>; onChange: (ids: string[]) => void }

const AUDIENCE_LINE: Record<ComposerAudience, { icon: ReactNode; text: string }> = {
  public: { icon: <Globe aria-hidden className="size-3.5" />, text: 'Public — anyone can see this reply' },
  private: { icon: <MessageSquare aria-hidden className="size-3.5" />, text: 'Private — sent to the customer' },
  internal: { icon: <Lock aria-hidden className="size-3.5" />, text: 'Internal — only your team sees this' },
};

export function ConversationComposer<T extends string>({
  modes, mode, onModeChange, body, onBodyChange, onSubmit, busy, banner, toolbar, maxLength = 2000, placeholder, className, mentions, footnote, audienceText, below, submitDisabledReason,
}: {
  modes: Array<ComposerMode<T>>; mode: T; onModeChange: (m: T) => void; body: string; onBodyChange: (v: string) => void;
  onSubmit: () => void; busy?: boolean; banner?: ReactNode; toolbar?: ReactNode; maxLength?: number; placeholder?: string; className?: string;
  mentions?: ComposerMentions; footnote?: ReactNode;
  /** Override the visibility line per audience (e.g. support tickets: "Sent to the customer"). */
  audienceText?: Partial<Record<ComposerAudience, string>>;
  /** Extra row inside the frame, above the footer (e.g. attachments). */
  below?: ReactNode;
  /** Extra reason to block sending (e.g. uploads still being checked). */
  submitDisabledReason?: string | null;
}) {
  const id = useId();
  const cur = modes.find((m) => m.value === mode) ?? modes[0]!;
  const internal = cur.audience === 'internal';
  const ta = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<{ q: string; start: number } | null>(null);
  const [active, setActive] = useState(0);
  const matches = useMemo(() => (internal && mentions && query ? mentions.options.filter((o) => o.label.toLowerCase().includes(query.q.toLowerCase())).slice(0, 6) : []), [internal, mentions, query]);
  const report = (text: string) => { if (mentions) mentions.onChange(mentions.options.filter((o) => text.includes(`@${o.label}`)).map((o) => o.id)); };
  const change = (text: string, caret: number) => {
    onBodyChange(text);
    report(text);
    const m = internal && mentions ? /(^|\s)@([^\s@]{0,30})$/.exec(text.slice(0, caret)) : null;
    setQuery(m ? { q: m[2]!, start: caret - m[2]!.length - 1 } : null);
    setActive(0);
  };
  const pick = (o: { label: string }) => {
    if (!query) return;
    const caret = ta.current?.selectionStart ?? body.length;
    const next = `${body.slice(0, query.start)}@${o.label} ${body.slice(caret)}`;
    onBodyChange(next);
    report(next);
    setQuery(null);
    requestAnimationFrame(() => { const el = ta.current; if (el) { const pos = query.start + o.label.length + 2; el.focus(); el.setSelectionRange(pos, pos); } });
  };
  const blocked = cur.disabled ? (cur.reason ?? 'Not available') : null;
  const over = body.length > maxLength;
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {modes.length > 1 ? (
          <Segmented label="Reply type" size="sm" value={mode} onChange={onModeChange}
            options={modes.map((m) => ({ value: m.value, label: m.label, icon: m.audience === 'internal' ? <Lock aria-hidden className="size-3.5" /> : undefined }))} />
        ) : <span />}
        {toolbar}
      </div>
      {banner}
      <div className={cn('rounded-xl border bg-surface transition-colors focus-within:border-[var(--accent-text)]',
        internal ? 'border-dashed border-[color-mix(in_srgb,var(--warn)_60%,var(--border))] bg-[var(--warn-soft)]' : 'border-border')}>
        <label htmlFor={id} className="sr-only">{cur.label}</label>
        <div className="relative">
          <Textarea ref={ta} id={id} value={body} onChange={(e) => change(e.target.value, e.target.selectionStart ?? e.target.value.length)} rows={3} placeholder={placeholder ?? (internal ? (mentions ? 'Note for your team… type @ to mention' : 'Note for your team…') : 'Write a reply…')}
            className="max-h-[40dvh] min-h-[84px] resize-y border-0 bg-transparent focus:ring-0 focus-visible:outline-none"
            role={matches.length ? 'combobox' : undefined} aria-expanded={matches.length ? true : undefined} aria-controls={matches.length ? `${id}-mentions` : undefined}
            aria-activedescendant={matches.length ? `${id}-m${active}` : undefined}
            onBlur={() => setTimeout(() => setQuery(null), 150)}
            onKeyDown={(e) => {
              if (matches.length) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % matches.length); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + matches.length) % matches.length); return; }
                if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(matches[active]!); return; }
                if (e.key === 'Escape') { e.preventDefault(); setQuery(null); return; }
              }
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !blocked && body.trim() && !over && !submitDisabledReason) { e.preventDefault(); onSubmit(); }
            }} />
          {matches.length ? (
            <ul id={`${id}-mentions`} role="listbox" aria-label="Mention a teammate" className="absolute bottom-full left-2 z-20 mb-1 w-64 max-w-[calc(100%-1rem)] overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-lg">
              {matches.map((o, i) => (
                <li key={o.id} id={`${id}-m${i}`} role="option" aria-selected={i === active}
                  onMouseDown={(e) => { e.preventDefault(); pick(o); }}
                  className={cn('cursor-pointer truncate px-3 py-1.5 text-[13px]', i === active ? 'bg-raised text-fg' : 'text-muted')}>@{o.label}</li>
              ))}
            </ul>
          ) : null}
        </div>
        {below ? <div className="px-3 pb-2">{below}</div> : null}
        <div className="flex flex-wrap items-center gap-2 border-t border-border/70 px-3 py-2">
          <span className={cn('flex min-w-0 flex-1 items-center gap-1.5 text-xs', internal ? 'text-warn' : 'text-muted')}>
            {AUDIENCE_LINE[cur.audience].icon}<span className="truncate">{blocked ?? audienceText?.[cur.audience] ?? AUDIENCE_LINE[cur.audience].text}</span>
          </span>
          <span className={cn('tabular text-xs', over ? 'text-danger' : 'text-subtle')}>{body.length}/{maxLength}</span>
          <Button variant={internal ? 'secondary' : 'primary'} size="sm" loading={busy} onClick={onSubmit}
            icon={internal ? <Lock aria-hidden className="size-4" /> : <Send aria-hidden className="size-4" />}
            disabledReason={blocked ?? (over ? 'Too long' : !body.trim() ? 'Write something first' : submitDisabledReason ?? null)}>
            {internal ? 'Add note' : 'Send'}
          </Button>
        </div>
      </div>
      {footnote ? <div className="text-xs text-muted">{footnote}</div> : null}
    </div>
  );
}
