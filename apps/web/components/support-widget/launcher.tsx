'use client';
// V5 support widget — launcher (the only part in the page's initial JavaScript). Deliberately tiny: no icon library, no
// dialog library, no data fetching on load. The conversation panel (./panel) is code-split and loaded only after the
// person interacts (click, #support link, `relay:open-support` event) or after the page is idle — never before the hero.
//  * Shown when the widget is enabled in Platform → Marketing, or when this browser already has a widget conversation
//    (non-secret hint cookie), or when a one-time link (#support-verify=…) was opened — so replies stay reachable.
//  * Never covers pricing actions, cookie controls or navigation: while it would overlap such an element (pricing
//    links/buttons, [data-support-widget-avoid], [data-cookie-controls]) it steps out of the way (hidden + not focusable);
//    footer "Support" links (#support) still open it.
//  * Unread badge only from real data (staff replies newer than this browser last read), fetched after idle.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ComponentType } from 'react';
import type { SupportPanelProps } from './panel';

const AVOID = '[data-support-widget-avoid], #pricing a, #pricing button, [data-cookie-controls]';
const HINT = 'relay_widget_hint=';
const VERIFY_RE = /^#support-verify=([A-Za-z0-9_-]{20,200})$/;
const readHint = () => document.cookie.split('; ').some((c) => c.startsWith(HINT) && c.length > HINT.length);
const noSubscribe = () => () => undefined;

export interface SupportLauncherProps {
  /** Platform → Marketing "widget on". */
  enabled: boolean;
  /** "Send us a message" unless staffed chat is configured ("Chat with Relay support"). */
  label: string;
  /** Token scope class for the portal-rendered panel (e.g. 'mkt' on the marketing page). */
  scopeClass?: string;
}

export function SupportLauncher({ enabled, label, scopeClass }: SupportLauncherProps) {
  const [Panel, setPanel] = useState<ComponentType<SupportPanelProps> | null>(null);
  const [open, setOpen] = useState(false);
  const [forced, setForced] = useState(false);
  // Non-secret hint cookie: this browser has a widget conversation (read on the client only; false during SSR).
  const hasHint = useSyncExternalStore(noSubscribe, readHint, () => false);
  const visible = enabled || hasHint || forced;
  const [verifyToken, setVerifyToken] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [blocked, setBlocked] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);

  const load = useCallback(() => import('./panel').then((m) => setPanel(() => m.SupportPanel)), []);
  const openPanel = useCallback(() => { setForced(true); setOpen(true); void load(); }, [load]);

  useEffect(() => {
    const takeHash = () => {
      const m = VERIFY_RE.exec(window.location.hash);
      if (m) {
        setVerifyToken(m[1]!);
        history.replaceState(null, '', window.location.pathname + window.location.search); // token never stays in the URL
        openPanel();
      } else if (window.location.hash === '#support' && (enabled || hasHint)) {
        history.replaceState(null, '', window.location.pathname + window.location.search);
        openPanel();
      }
    };
    takeHash();
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[href="#support"]');
      if (a && (enabled || hasHint)) { e.preventDefault(); openPanel(); }
    };
    const onEvent = () => openPanel();
    window.addEventListener('hashchange', takeHash);
    document.addEventListener('click', onClick);
    window.addEventListener('relay:open-support', onEvent);
    // Idle: fetch the panel chunk ahead of a click, and the unread count when this browser has a conversation.
    const idle = () => {
      if (enabled || hasHint) void load();
      if (hasHint) {
        fetch('/api/widget/session', { credentials: 'same-origin', cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((d: { conversations?: Array<{ unread: boolean }> } | null) => setUnread(d?.conversations?.filter((c) => c.unread).length ?? 0))
          .catch(() => undefined);
      }
    };
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (h: number) => void };
    let handle: number | undefined;
    const schedule = () => { handle = w.requestIdleCallback ? w.requestIdleCallback(idle, { timeout: 8000 }) : window.setTimeout(idle, 3000); };
    if (document.readyState === 'complete') schedule(); else window.addEventListener('load', schedule, { once: true });
    return () => {
      window.removeEventListener('hashchange', takeHash);
      document.removeEventListener('click', onClick);
      window.removeEventListener('relay:open-support', onEvent);
      window.removeEventListener('load', schedule);
      if (handle !== undefined) { if (w.cancelIdleCallback) w.cancelIdleCallback(handle); else window.clearTimeout(handle); }
    };
  }, [enabled, hasHint, load, openPanel]);

  // Step aside while overlapping pricing actions, cookie controls or marked navigation.
  useEffect(() => {
    if (!visible) return;
    let raf = 0;
    const check = () => {
      raf = 0;
      const b = btn.current;
      if (!b) return;
      const r = b.getBoundingClientRect();
      const pad = 8;
      let hit = false;
      for (const el of document.querySelectorAll(AVOID)) {
        if (b.contains(el)) continue;
        const o = el.getBoundingClientRect();
        if (o.width && o.height && o.left < r.right + pad && o.right > r.left - pad && o.top < r.bottom + pad && o.bottom > r.top - pad) { hit = true; break; }
      }
      setBlocked(hit);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(check); };
    check();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => { window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); if (raf) cancelAnimationFrame(raf); };
  }, [visible]);

  return (
    <>
      {visible ? (
        <button
          ref={btn}
          type="button"
          onClick={openPanel}
          onPointerEnter={() => void load()}
          onFocus={() => void load()}
          aria-label={`${label}${unread ? `, ${unread} unread ${unread === 1 ? 'reply' : 'replies'}` : ''}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-hidden={blocked && !open ? true : undefined}
          tabIndex={blocked && !open ? -1 : 0}
          data-testid="support-launcher"
          data-state={blocked ? 'stepped-aside' : 'shown'}
          className={`fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-40 inline-flex h-12 items-center gap-2 rounded-full bg-v5-primary px-4 text-sm font-semibold text-v5-on-primary shadow-[0_8px_24px_-8px_rgb(15_15_45/0.45)] outline-none transition-[opacity,transform] duration-150 hover:bg-v5-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v5-ring motion-reduce:transition-none sm:right-6 ${blocked && !open ? 'pointer-events-none translate-y-2 opacity-0' : 'opacity-100'}`}
        >
          <svg aria-hidden viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12Z" />
          </svg>
          <span aria-hidden className="max-[360px]:hidden">{label === 'Send us a message' ? 'Message us' : 'Chat'}</span>
          {unread ? <span aria-hidden className="absolute -right-0.5 -top-0.5 size-3 rounded-full border-2 border-v5-surface bg-[#c026d3]" /> : null}
        </button>
      ) : null}
      {Panel ? (
        <Panel open={open} onOpenChange={setOpen} verifyToken={verifyToken} onVerifyHandled={() => setVerifyToken(null)} scopeClass={scopeClass} onUnread={setUnread} />
      ) : null}
    </>
  );
}
