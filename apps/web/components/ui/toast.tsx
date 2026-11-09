'use client';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from './cn';
import { ToneIcon, type Tone } from './feedback';
import { isApiError } from '@/lib/client/api';

interface ToastItem {
  id: number; tone: Tone; title: string; body?: string; ref?: string | null;
  /** One inline action (e.g. Undo). The toast closes when it is used. */
  action?: { label: string; onClick: () => void | Promise<void> };
  /** ms before auto-dismiss (default 6000; errors stay). */
  duration?: number;
}
interface ToastApi {
  show: (t: Omit<ToastItem, 'id'>) => void;
  success: (title: string, body?: string) => void;
  error: (e: unknown, title?: string) => void;
  info: (title: string, body?: string) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const n = useRef(0);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const show = useCallback((t: Omit<ToastItem, 'id'>) => {
    const id = ++n.current;
    setItems((xs) => [...xs.slice(-3), { ...t, id }]);
    // Errors stay until dismissed so they can be read and the reference copied.
    if (t.tone !== 'danger') setTimeout(() => dismiss(id), t.duration ?? (t.action ? 10_000 : 6000));
  }, [dismiss]);
  const api = useMemo<ToastApi>(() => ({
    show,
    success: (title, body) => show({ tone: 'success', title, body }),
    info: (title, body) => show({ tone: 'info', title, body }),
    error: (e, title) => show({
      tone: 'danger',
      title: title ?? (isApiError(e) ? e.message : 'Something went wrong. Try again.'),
      body: title ? (isApiError(e) ? e.message : e instanceof Error ? e.message : undefined) : undefined,
      ref: isApiError(e) ? e.correlationId : null,
    }),
  }), [show]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div aria-live="polite" aria-relevant="additions" className="pointer-events-none fixed inset-x-3 bottom-[76px] z-[70] flex flex-col items-end gap-2 md:bottom-5 md:right-5 md:left-auto">
        {items.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'danger' ? 'alert' : 'status'}
            className={cn('anim-pop pointer-events-auto flex w-full max-w-[400px] items-start gap-3 rounded-xl border border-border bg-raised px-4 py-3 shadow-[var(--shadow)]')}
          >
            <span className="mt-0.5"><ToneIcon tone={t.tone} /></span>
            <div className="min-w-0 flex-1 text-[13px]">
              <p className="font-medium">{t.title}</p>
              {t.body ? <p className="mt-0.5 text-muted">{t.body}</p> : null}
              {t.ref ? <p className="mt-1 font-mono text-[11px] text-subtle">Reference {t.ref}</p> : null}
            </div>
            {t.action ? (
              <button
                type="button"
                onClick={() => { dismiss(t.id); void t.action!.onClick(); }}
                className="touch-target -my-1 shrink-0 rounded-md px-2 py-1 text-[13px] font-semibold text-accent-text hover:bg-surface"
              >
                {t.action.label}
              </button>
            ) : null}
            <button type="button" aria-label="Dismiss notification" onClick={() => dismiss(t.id)} className="touch-target -mr-1 inline-flex size-7 items-center justify-center rounded-md text-muted hover:bg-surface hover:text-fg">
              <X aria-hidden className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const c = useContext(Ctx);
  if (!c) throw new Error('useToast outside ToastProvider');
  return c;
}
