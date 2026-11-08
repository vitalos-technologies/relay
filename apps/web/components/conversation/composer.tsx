'use client';
// Generic reply composer (reusable in V4 support tickets). Modes are explicit and visually distinct:
//  - customer-facing modes ("Public reply", "Private message") use the normal frame + a visibility line;
//  - the internal mode ("Internal note") switches to a dashed amber frame + lock and its own submit label.
// Switching modes never sends and never clears the text. The keyboard-open layout keeps the box + button visible
// (sticky bottom, max height, internal scroll).
import { useId, type ReactNode } from 'react';
import { Globe, Lock, MessageSquare, Send } from 'lucide-react';
import { Button, cn, Segmented, Textarea } from '@/components/ui';

export type ComposerAudience = 'public' | 'private' | 'internal';
export interface ComposerMode<T extends string> { value: T; label: string; audience: ComposerAudience; disabled?: boolean; reason?: string | null }

const AUDIENCE_LINE: Record<ComposerAudience, { icon: ReactNode; text: string }> = {
  public: { icon: <Globe aria-hidden className="size-3.5" />, text: 'Public — anyone can see this reply' },
  private: { icon: <MessageSquare aria-hidden className="size-3.5" />, text: 'Private — sent to the customer' },
  internal: { icon: <Lock aria-hidden className="size-3.5" />, text: 'Internal — only your team sees this' },
};

export function ConversationComposer<T extends string>({
  modes, mode, onModeChange, body, onBodyChange, onSubmit, busy, banner, toolbar, maxLength = 2000, placeholder, className,
}: {
  modes: Array<ComposerMode<T>>; mode: T; onModeChange: (m: T) => void; body: string; onBodyChange: (v: string) => void;
  onSubmit: () => void; busy?: boolean; banner?: ReactNode; toolbar?: ReactNode; maxLength?: number; placeholder?: string; className?: string;
}) {
  const id = useId();
  const cur = modes.find((m) => m.value === mode) ?? modes[0]!;
  const internal = cur.audience === 'internal';
  const blocked = cur.disabled ? (cur.reason ?? 'Not available') : null;
  const over = body.length > maxLength;
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented label="Reply type" size="sm" value={mode} onChange={onModeChange}
          options={modes.map((m) => ({ value: m.value, label: m.label, icon: m.audience === 'internal' ? <Lock aria-hidden className="size-3.5" /> : undefined }))} />
        {toolbar}
      </div>
      {banner}
      <div className={cn('rounded-xl border bg-surface transition-colors focus-within:border-[var(--accent-text)]',
        internal ? 'border-dashed border-[color-mix(in_srgb,var(--warn)_60%,var(--border))] bg-[var(--warn-soft)]' : 'border-border')}>
        <label htmlFor={id} className="sr-only">{cur.label}</label>
        <Textarea id={id} value={body} onChange={(e) => onBodyChange(e.target.value)} rows={3} placeholder={placeholder ?? (internal ? 'Note for your team…' : 'Write a reply…')}
          className="max-h-[40dvh] min-h-[84px] resize-y border-0 bg-transparent focus:ring-0 focus-visible:outline-none"
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !blocked && body.trim() && !over) { e.preventDefault(); onSubmit(); } }} />
        <div className="flex flex-wrap items-center gap-2 border-t border-border/70 px-3 py-2">
          <span className={cn('flex min-w-0 flex-1 items-center gap-1.5 text-xs', internal ? 'text-warn' : 'text-muted')}>
            {AUDIENCE_LINE[cur.audience].icon}<span className="truncate">{blocked ?? AUDIENCE_LINE[cur.audience].text}</span>
          </span>
          <span className={cn('tabular text-xs', over ? 'text-danger' : 'text-subtle')}>{body.length}/{maxLength}</span>
          <Button variant={internal ? 'secondary' : 'primary'} size="sm" loading={busy} onClick={onSubmit}
            icon={internal ? <Lock aria-hidden className="size-4" /> : <Send aria-hidden className="size-4" />}
            disabledReason={blocked ?? (over ? 'Too long' : !body.trim() ? 'Write something first' : null)}>
            {internal ? 'Add note' : 'Send'}
          </Button>
        </div>
      </div>
    </div>
  );
}
