'use client';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

function subscribeOnline(cb: () => void) {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
}

/** Global brand filter persisted in the URL as ?brand=<id>. '' = all brands. */
export function useBrandFilter(): [string, (id: string) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const brand = params.get('brand') ?? '';
  const set = useCallback(
    (id: string) => {
      const next = new URLSearchParams(params.toString());
      if (id) next.set('brand', id);
      else next.delete('brand');
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, router, pathname],
  );
  return [brand, set];
}

/** Read/write a set of URL query params (filters) while preserving the rest. */
export function useQueryState(): [URLSearchParams, (patch: Record<string, string | null>) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const set = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === '') next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, router, pathname],
  );
  return [params, set];
}

/** Link helper that keeps the global ?brand= filter. */
export function useHrefWithBrand() {
  const params = useSearchParams();
  const brand = params.get('brand');
  return useCallback((href: string) => {
    if (!brand || href.includes('brand=')) return href;
    return `${href}${href.includes('?') ? '&' : '?'}brand=${encodeURIComponent(brand)}`;
  }, [brand]);
}

export function useDebouncedValue<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useMediaQuery(q: string, serverDefault = false): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(q);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia(q).matches,
    () => serverDefault,
  );
}

/** Stable callback ref (latest closure). */
export function useLatest<T>(value: T) {
  const r = useRef(value);
  r.current = value;
  return r;
}

export function useBrowserTimeZone(): string | null {
  return useSyncExternalStore(
    () => () => {},
    () => Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
    () => null,
  );
}
