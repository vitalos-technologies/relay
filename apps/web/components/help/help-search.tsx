'use client';
// Help Centre search (HC). A plain GET form to /help?q= (works without JavaScript) enhanced into an ARIA combobox:
// suggestions as you type from /api/help/search (server-filtered to what this reader may open), ↑/↓ to move, Enter to
// open, Esc to close, "/" anywhere on a help page to focus.
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/components/ui/cn';

interface Result { slug: string; title: string; summary: string; href: string; sectionTitle: string; snippet: string }

export function HelpSearch({ initialQuery = '', autoFocus, className }: { initialQuery?: string; autoFocus?: boolean; className?: string }) {
  const router = useRouter();
  const id = useId();
  const listId = `${id}-list`;
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState(initialQuery);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // Last answer from the server, keyed by the term it answers; anything else is still loading.
  const [answer, setAnswer] = useState<{ term: string; results: Result[] }>({ term: '', results: [] });
  const term = q.trim();
  const results = term.length >= 2 && answer.term === term ? answer.results : [];
  const loading = term.length >= 2 && answer.term !== term;

  useEffect(() => {
    if (term.length < 2) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/help/search?q=${encodeURIComponent(term)}&limit=8`, { signal: ctl.signal, credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : { results: [] }))
        .then((d: { results: Result[] }) => { setAnswer({ term, results: d.results ?? [] }); setActive(-1); })
        .catch(() => undefined);
    }, 120);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [term]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const showList = open && q.trim().length >= 2;
  const go = (href: string) => { setOpen(false); router.push(href); };

  return (
    <form role="search" action="/help" method="get" className={cn('relative w-full', className)}
      onSubmit={(e) => {
        if (active >= 0 && results[active]) { e.preventDefault(); go(results[active].href); return; }
        if (!q.trim()) e.preventDefault();
        setOpen(false);
      }}>
      <label htmlFor={`${id}-q`} className="sr-only">Search help</label>
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 size-[18px] -translate-y-1/2 text-subtle" />
        <input
          ref={input}
          id={`${id}-q`}
          name="q"
          type="search"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && active >= 0 ? `${id}-opt-${active}` : undefined}
          autoComplete="off"
          enterKeyHint="search"
          autoFocus={autoFocus}
          placeholder="Search help"
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, results.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, -1)); }
            else if (e.key === 'Escape') { if (showList) { e.preventDefault(); setOpen(false); setActive(-1); } else if (q) { e.preventDefault(); setQ(''); } }
          }}
          className="h-12 w-full rounded-xl border border-border bg-surface pl-11 pr-11 text-[15px] text-fg shadow-sm transition-colors placeholder:text-subtle hover:border-border-strong focus:border-[var(--focus)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-soft)] [&::-webkit-search-cancel-button]:hidden"
        />
        {q ? (
          <button type="button" onClick={() => { setQ(''); input.current?.focus(); }}
            className="touch-target absolute right-1.5 top-1/2 inline-flex size-9 -translate-y-1/2 items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-fg">
            <X aria-hidden className="size-4" /><span className="sr-only">Clear search</span>
          </button>
        ) : (
          <kbd aria-hidden className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded border border-border px-1.5 text-[11px] text-subtle sm:block">/</kbd>
        )}
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {showList && !loading ? (results.length ? `${results.length} suggestion${results.length === 1 ? '' : 's'}` : 'No matching articles') : ''}
      </div>
      <ul
        id={listId}
        role="listbox"
        aria-label="Suggested articles"
        hidden={!showList}
        className="absolute inset-x-0 top-[calc(100%+6px)] z-40 max-h-[min(420px,60dvh)] overflow-y-auto rounded-xl border border-border bg-surface p-1.5 shadow-[var(--shadow)]"
      >
        {results.map((r, i) => (
          <li key={r.slug} id={`${id}-opt-${i}`} role="option" aria-selected={i === active}
            onMouseDown={(e) => { e.preventDefault(); go(r.href); }}
            onMouseEnter={() => setActive(i)}
            className={cn('cursor-pointer rounded-lg px-3 py-2.5', i === active ? 'bg-raised' : '')}>
            <span className="block text-[14px] font-medium text-fg">{r.title}</span>
            <span className="mt-0.5 block truncate text-[12.5px] text-muted">{r.sectionTitle} · {r.summary}</span>
          </li>
        ))}
        {!results.length && !loading ? <li role="presentation" className="px-3 py-2.5 text-[13px] text-muted">No matching articles. Press Enter to search all.</li> : null}
        {results.length ? (
          <li role="presentation" className="border-t border-border px-3 pb-1 pt-2 text-[12px] text-muted">Enter to see all results for “{q.trim()}”</li>
        ) : null}
      </ul>
    </form>
  );
}
