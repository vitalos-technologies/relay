'use client';
// Comment body rendering + the mention-aware comment box.
//  - CommentBody renders the safe markup subset as React text nodes (never HTML). Mentions show the person's current name
//    (removed members: "Former member"); links are http(s) only, open in a new tab, rel=noopener noreferrer nofollow.
//  - MentionTextarea: type "@" to search people who can see this discussion (bounded server search). Keyboard: ↑/↓ to
//    move, Enter/Tab to pick, Escape to close. The box shows "@Name"; the stored body uses identity tokens "@[uuid]".
import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { tokenizeComment } from '@social-lite/core';
import { api } from '@/lib/client/api';
import { cn, Textarea } from '@/components/ui';
import type { People } from './types';

export function CommentBody({ body, people, className }: { body: string; people: People; className?: string }) {
  const tokens = useMemo(() => tokenizeComment(body), [body]);
  return (
    <p className={cn('whitespace-pre-wrap break-words text-[13px] leading-relaxed', className)}>
      {tokens.map((t, i) => {
        switch (t.t) {
          case 'bold': return <strong key={i} className="font-semibold">{t.v}</strong>;
          case 'italic': return <em key={i}>{t.v}</em>;
          case 'code': return <code key={i} className="rounded bg-sunken px-1 py-0.5 text-[12px]">{t.v}</code>;
          case 'link': return <a key={i} href={t.href} target="_blank" rel="noopener noreferrer nofollow" className="text-[var(--accent-text)] underline underline-offset-2">{t.v}</a>;
          case 'br': return <br key={i} />;
          case 'mention': {
            const p = people[t.id];
            return (
              <span key={i} className={cn('rounded px-0.5 font-medium', p?.active === false ? 'text-muted line-through decoration-1' : 'bg-[var(--accent-soft,transparent)] text-[var(--accent-text)]')}
                title={p?.email ?? undefined}>
                @{p?.name ?? 'someone'}
              </span>
            );
          }
          default: return <span key={i}>{t.v}</span>;
        }
      })}
    </p>
  );
}

export interface MentionCandidate { id: string; name: string | null; email: string; guest: boolean }

/** Convert "@Name" labels picked from the menu into identity tokens; labels the user deleted are dropped. */
export function encodeMentions(text: string, picked: Map<string, string>): string {
  let out = text;
  for (const [label, id] of [...picked.entries()].sort((a, b) => b[0].length - a[0].length)) {
    out = out.split(`@${label}`).join(`@[${id}]`);
  }
  return out;
}

/** Tokens → "@Name" for editing; returns the label map so they are re-encoded on save. */
export function decodeMentions(body: string, people: People): { text: string; picked: Map<string, string> } {
  const picked = new Map<string, string>();
  const text = body.replace(/@\[([0-9a-f-]{36})\]/gi, (_m, id: string) => {
    const name = people[id.toLowerCase()]?.name ?? 'someone';
    picked.set(name, id.toLowerCase());
    return `@${name}`;
  });
  return { text, picked };
}

export interface MentionTextareaHandle { focus: () => void }

export const MentionTextarea = forwardRef<MentionTextareaHandle, {
  value: string; onChange: (v: string) => void; picked: Map<string, string>; onPick: (label: string, id: string) => void;
  searchUrl: string; label: string; placeholder?: string; rows?: number; onSubmit?: () => void; disabled?: boolean; id?: string;
}>(function MentionTextarea({ value, onChange, picked, onPick, searchUrl, label, placeholder, rows = 3, onSubmit, disabled, id }, ref) {
  const ta = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => ta.current?.focus() }));
  const listId = useId();
  const [query, setQuery] = useState<string | null>(null);
  const [items, setItems] = useState<MentionCandidate[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  // Search (debounced, bounded on the server: ≤ 8 people who can see this discussion).
  useEffect(() => {
    if (query === null) return;
    const my = ++seq.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await api.get<{ items: MentionCandidate[] }>(`${searchUrl}${searchUrl.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}`);
        if (my === seq.current) { setItems(r.items); setActive(0); }
      } catch { if (my === seq.current) setItems([]); } finally { if (my === seq.current) setLoading(false); }
    }, 150);
    return () => clearTimeout(t);
  }, [query, searchUrl]);

  const detect = useCallback((v: string, caret: number) => {
    const before = v.slice(0, caret);
    const m = /(^|\s)@([\p{L}\p{N}._-]{0,30})$/u.exec(before);
    setQuery(m ? m[2]! : null);
  }, []);

  const pick = (c: MentionCandidate) => {
    const el = ta.current;
    if (!el) return;
    const caret = el.selectionStart ?? value.length;
    const before = value.slice(0, caret).replace(/@([\p{L}\p{N}._-]{0,30})$/u, '');
    let label = (c.name || c.email.split('@')[0]!).trim();
    if (picked.has(label) && picked.get(label) !== c.id) label = `${label} (${c.email.split('@')[0]})`;
    const next = `${before}@${label} ${value.slice(caret)}`;
    onPick(label, c.id);
    onChange(next);
    setQuery(null);
    requestAnimationFrame(() => { const pos = before.length + label.length + 2; el.focus(); el.setSelectionRange(pos, pos); });
  };

  const open = query !== null && (items.length > 0 || loading);
  return (
    <div className="relative">
      <label htmlFor={id} className="sr-only">{label}</label>
      <Textarea
        id={id} ref={ta} value={value} rows={rows} maxLength={5000} disabled={disabled} placeholder={placeholder}
        role="combobox" aria-expanded={open} aria-controls={open ? listId : undefined} aria-autocomplete="list"
        aria-activedescendant={open && items[active] ? `${listId}-${items[active]!.id}` : undefined}
        onChange={(e) => { onChange(e.target.value); detect(e.target.value, e.target.selectionStart ?? e.target.value.length); }}
        onKeyDown={(e) => {
          if (open && items.length) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % items.length); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + items.length) % items.length); return; }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(items[active]!); return; }
          }
          if (e.key === 'Escape' && query !== null) { e.preventDefault(); setQuery(null); return; }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && onSubmit) { e.preventDefault(); onSubmit(); }
        }}
        onBlur={() => setTimeout(() => setQuery(null), 150)}
      />
      {open ? (
        <ul id={listId} role="listbox" aria-label="People who can see this" className="absolute inset-x-0 bottom-full z-30 mb-1 max-h-56 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-[var(--shadow)]">
          {loading && !items.length ? <li className="px-2 py-1.5 text-xs text-muted">Searching…</li> : null}
          {items.map((c, i) => (
            <li key={c.id} id={`${listId}-${c.id}`} role="option" aria-selected={i === active}
              onMouseDown={(e) => { e.preventDefault(); pick(c); }}
              className={cn('flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px]', i === active && 'bg-raised')}>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium">{c.name || c.email.split('@')[0]}</span>
                <span className="truncate text-xs text-muted">{c.email}</span>
              </span>
              {c.guest ? <span className="shrink-0 rounded bg-info-soft px-1.5 text-[11px] text-info">Client</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {query !== null && !loading && !items.length ? <p className="mt-1 text-xs text-muted" role="status">Nobody matching can see this discussion</p> : null}
    </div>
  );
});
