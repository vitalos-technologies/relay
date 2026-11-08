'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Action, Permission } from '@social-lite/core';
import { ApiError, apiFetch, setCsrfRefresher, setCsrfToken, setExpectedWorkspace } from './api';
import { onWorkspaceChangedElsewhere } from './workspace-sync';
import type { SessionInfo } from './types';

interface SessionContextValue {
  session: SessionInfo;
  refresh: () => Promise<SessionInfo | null>;
  can: (a: Action) => boolean;
  /** V2 permission held on some scope (UI convenience; the server re-checks every request). */
  canV2: (p: Permission) => boolean;
  /** V2 permission on a specific brand. */
  canOn: (brandId: string, p: Permission) => boolean;
}

const SessionContext = createContext<SessionContextValue | null>(null);

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; session: SessionInfo }
  | { kind: 'error'; error: ApiError };

export function SessionProvider({
  children,
  fallback,
  renderError,
  requireWorkspace = true,
}: {
  children: ReactNode;
  fallback: ReactNode;
  renderError: (e: ApiError, retry: () => void) => ReactNode;
  /** When true and the user has no active workspace, send them to /onboarding. */
  requireWorkspace?: boolean;
}) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const refresh = useCallback(async (): Promise<SessionInfo | null> => {
    try {
      const s = await apiFetch<SessionInfo>('/api/session');
      setCsrfToken(s.csrf_token);
      setExpectedWorkspace(s.workspace?.id ?? null);
      setState({ kind: 'ready', session: s });
      return s;
    } catch (e) {
      if (e instanceof ApiError) {
        // 401 already redirects to /login in apiFetch.
        if (e.status !== 401) setState({ kind: 'error', error: e });
      }
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
    setCsrfRefresher(async () => (await refresh())?.csrf_token ?? null);
    return () => setCsrfRefresher(null);
  }, [refresh]);

  const ready = state.kind === 'ready' ? state.session : null;
  // Another tab switched workspace: this tab's data belongs to the old one — reload.
  const activeId = ready?.workspace?.id ?? null;
  useEffect(() => (activeId ? onWorkspaceChangedElsewhere(activeId, () => window.location.replace('/')) : undefined), [activeId]);
  useEffect(() => {
    if (ready && requireWorkspace && !ready.workspace && !window.location.pathname.startsWith('/onboarding')) {
      window.location.replace('/onboarding');
    }
  }, [ready, requireWorkspace]);

  const value = useMemo<SessionContextValue | null>(() => {
    if (!ready) return null;
    return {
      session: ready, refresh, can: (a: Action) => ready.permissions?.[a] === true,
      canV2: (p: Permission) => ready.v2?.permissions?.[p] === true,
      canOn: (brandId: string, p: Permission) => ready.v2?.brands?.[brandId]?.includes(p) === true,
    };
  }, [ready, refresh]);

  if (state.kind === 'error') return <>{renderError(state.error, () => { setState({ kind: 'loading' }); void refresh(); })}</>;
  if (!value || (requireWorkspace && !value.session.workspace)) return <>{fallback}</>;
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession must be used inside <SessionProvider>');
  return v;
}

/** Brand lookup helpers from the session. */
export function useBrands() {
  const { session } = useSession();
  return session.brands;
}
