'use client';
import { useEffect } from 'react';

/** Keeps `data-theme="light"` while mounted; on unmount puts back the saved app theme (same rule as the root THEME_BOOT). */
export function RestoreAppTheme() {
  useEffect(() => {
    const el = document.documentElement;
    el.setAttribute('data-theme', 'light');
    return () => {
      let t: string | null = null;
      try { t = localStorage.getItem('sl-theme'); } catch { /* storage unavailable */ }
      if (t === 'light' || t === 'dark') el.setAttribute('data-theme', t);
      else el.removeAttribute('data-theme');
    };
  }, []);
  return null;
}
