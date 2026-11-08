'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiFetch } from './api';

export interface UseApiResult<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  /** true while a background refresh runs and data is already shown */
  refreshing: boolean;
  refetch: () => Promise<T | undefined>;
  setData: (updater: T | ((prev: T | undefined) => T)) => void;
}

export interface UseApiOptions<T> {
  /** ms between polls, or a function of current data returning ms or false to stop. */
  poll?: number | false | ((data: T | undefined) => number | false);
  /** keep showing previous data while the key changes (filters). */
  keepPrevious?: boolean;
  redirectOn401?: boolean;
}

/**
 * Tiny data hook: GET `path` (null = skip), with refetch, optimistic setData and optional polling.
 * Polling pauses while the tab is hidden and resumes (with an immediate refresh) when visible.
 */
export function useApi<T>(path: string | null, opts: UseApiOptions<T> = {}): UseApiResult<T> {
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(path !== null);
  const [refreshing, setRefreshing] = useState(false);
  const seq = useRef(0);
  const dataRef = useRef<T | undefined>(undefined);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const load = useCallback(
    async (background: boolean): Promise<T | undefined> => {
      if (path === null) return undefined;
      const my = ++seq.current;
      if (background) setRefreshing(true);
      else setLoading(true);
      try {
        const d = await apiFetch<T>(path, { redirectOn401: optsRef.current.redirectOn401 });
        if (my !== seq.current) return d;
        dataRef.current = d;
        setDataState(d);
        setError(undefined);
        return d;
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return undefined;
        if (my !== seq.current) return undefined;
        setError(e instanceof ApiError ? e : new ApiError(0, 'internal', (e as Error)?.message ?? 'Failed', undefined, undefined, null));
        return undefined;
      } finally {
        if (my === seq.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [path],
  );

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }
    if (!optsRef.current.keepPrevious) {
      dataRef.current = undefined;
      setDataState(undefined);
    }
    setError(undefined);
    void load(dataRef.current !== undefined);
    return () => {
      seq.current++;
    };
  }, [path, load]);

  // Polling
  const pollSpec = opts.poll;
  const interval = typeof pollSpec === 'function' ? pollSpec(data) : pollSpec;
  useEffect(() => {
    if (!interval || path === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      timer = setTimeout(async () => {
        if (typeof document === 'undefined' || document.visibilityState === 'visible') await load(true);
        tick();
      }, interval);
    };
    tick();
    const onVis = () => {
      if (document.visibilityState === 'visible') void load(true);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [interval, path, load]);

  const setData = useCallback((updater: T | ((prev: T | undefined) => T)) => {
    setDataState((prev) => {
      const next = typeof updater === 'function' ? (updater as (p: T | undefined) => T)(prev) : updater;
      dataRef.current = next;
      return next;
    });
  }, []);

  const refetch = useCallback(() => load(dataRef.current !== undefined), [load]);

  return { data, error, loading: loading && data === undefined, refreshing: refreshing || (loading && data !== undefined), refetch, setData };
}
