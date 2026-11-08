'use client';
export type Theme = 'system' | 'light' | 'dark';

/** Apply and remember the theme choice (the root layout boots it before first paint). */
export function applyTheme(t: Theme) {
  const el = document.documentElement;
  if (t === 'system') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', t);
  try {
    if (t === 'system') localStorage.removeItem('sl-theme');
    else localStorage.setItem('sl-theme', t);
  } catch {
    /* storage unavailable */
  }
}

export function currentTheme(): Theme {
  const a = document.documentElement.getAttribute('data-theme');
  return a === 'light' || a === 'dark' ? a : 'system';
}
