'use client';
// Admin change feed client (V3.1 Admin §5, docs/admin/SYNC_AND_EVENT_MODEL.md). Polls /api/admin/changes while the tab
// is visible (10 s), backs off to 60 s on failures and shows the state (Live / Reconnecting / Paused). Views subscribe to
// topics with useAdminTopics(); when a topic marker changes they refetch their own authorized data. A changed policy
// version also refreshes the session, so revoked permissions disappear from navigation without signing in again.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { CircleDot, CloudOff, Pause } from 'lucide-react';
import { ADMIN_SYNC, type AdminChanges, type AdminTopic } from '@social-lite/core/contracts/v31-admin';
import { apiFetch } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { cn, Tooltip } from '@/components/ui';

type Listener = (changed: Set<AdminTopic>) => void;
interface SyncValue { status: 'live' | 'reconnecting' | 'paused' | 'off'; at: string | null; subscribe: (l: Listener) => () => void; poke: () => void }
const SyncCtx = createContext<SyncValue>({ status: 'off', at: null, subscribe: () => () => undefined, poke: () => undefined });

export function AdminSyncProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const { refresh, session } = useSession();
  const [status, setStatus] = useState<SyncValue['status']>(enabled ? 'live' : 'off');
  const [at, setAt] = useState<string | null>(null);
  const last = useRef<AdminChanges | null>(null);
  const listeners = useRef(new Set<Listener>());
  const failures = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const policy = session.v2?.policy_version ?? 0;
  const policyRef = useRef(policy);
  policyRef.current = policy;

  const tick = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    if (!enabled) return;
    if (document.visibilityState !== 'visible') { setStatus('paused'); return; }
    try {
      const c = await apiFetch<AdminChanges>('/api/admin/changes', { redirectOn401: true });
      failures.current = 0;
      setStatus('live');
      setAt(c.at);
      const prev = last.current;
      last.current = c;
      if (prev && prev.workspace_id === c.workspace_id) {
        const changed = new Set((Object.keys(c.topics) as AdminTopic[]).filter((t) => c.topics[t] !== prev.topics[t]));
        if (changed.size) listeners.current.forEach((l) => l(changed));
      }
      if (c.policy_version !== policyRef.current) void refresh();
      timer.current = setTimeout(() => void tick(), c.poll_ms || ADMIN_SYNC.poll_ms);
    } catch {
      failures.current += 1;
      setStatus('reconnecting');
      const wait = Math.min(ADMIN_SYNC.poll_ms * 2 ** failures.current, ADMIN_SYNC.max_backoff_ms);
      timer.current = setTimeout(() => void tick(), wait);
    }
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return;
    void tick();
    const onVis = () => { if (document.visibilityState === 'visible') void tick(); else setStatus('paused'); };
    const onOnline = () => void tick();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', onOnline);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('online', onOnline);
    };
  }, [enabled, tick]);

  const subscribe = useCallback((l: Listener) => { listeners.current.add(l); return () => { listeners.current.delete(l); }; }, []);
  const poke = useCallback(() => { void tick(); }, [tick]);
  return <SyncCtx.Provider value={{ status, at, subscribe, poke }}>{children}</SyncCtx.Provider>;
}

export function useAdminSync() {
  return useContext(SyncCtx);
}

/**
 * Refetch when any of `topics` changes, and as a safety net every ADMIN_SYNC.safety_refetch_ms while visible
 * (a missed marker can delay a view by at most that bound).
 */
export function useAdminTopics(topics: AdminTopic[], refetch: () => unknown) {
  const { subscribe } = useAdminSync();
  const ref = useRef(refetch);
  ref.current = refetch;
  const key = topics.join(',');
  useEffect(() => subscribe((changed) => { if (key.split(',').some((t) => changed.has(t as AdminTopic))) void ref.current(); }), [subscribe, key]);
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === 'visible') void ref.current(); }, ADMIN_SYNC.safety_refetch_ms);
    return () => clearInterval(id);
  }, []);
}

export function SyncIndicator({ className }: { className?: string }) {
  const { status, at } = useAdminSync();
  const [, force] = useState(0);
  useEffect(() => { const id = setInterval(() => force((n) => n + 1), 5000); return () => clearInterval(id); }, []);
  if (status === 'off') return null;
  const age = at ? Math.max(0, Math.round((Date.now() - Date.parse(at)) / 1000)) : null;
  const label = status === 'live' ? 'Live' : status === 'reconnecting' ? 'Reconnecting' : 'Paused';
  const Icon = status === 'live' ? CircleDot : status === 'reconnecting' ? CloudOff : Pause;
  return (
    <Tooltip content={status === 'live' ? `Updated ${age ?? 0}s ago · checks every 10 s` : status === 'reconnecting' ? 'Retrying with backoff; showing last loaded data' : 'Paused while this tab is hidden'}>
      <span role="status" aria-live="polite" className={cn('inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium',
        status === 'live' ? 'text-success' : status === 'reconnecting' ? 'bg-warn-soft text-warn' : 'text-muted', className)}>
        <Icon aria-hidden className="size-3.5" /><span className="max-sm:sr-only">{label}</span>
      </span>
    </Tooltip>
  );
}
