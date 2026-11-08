import { useId } from 'react';
import { BRAND } from '@social-lite/core';

/** Relay "R" mark — vector redraw of the brand kit (orange→red ribbon). Decorative unless `title` is given. */
export function RelayMark({ size = 28, title, className }: { size?: number; title?: string; className?: string }) {
  const id = useId().replace(/:/g, '');
  const c = BRAND.colors;
  return (
    <svg viewBox="0 0 74 64" width={size * (74 / 64)} height={size} className={className} role={title ? 'img' : undefined} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      <defs>
        <linearGradient id={`${id}a`} x1="12" y1="4" x2="58" y2="60" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FD8A1F" /><stop offset=".55" stopColor="#F65A1A" /><stop offset="1" stopColor={c.gradientTo} />
        </linearGradient>
        <linearGradient id={`${id}b`} x1="42" y1="28" x2="6" y2="61" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#F7701A" /><stop offset="1" stopColor="#FE9420" />
        </linearGradient>
        <linearGradient id={`${id}s`} x1="36" y1="30" x2="48" y2="46" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7A1A08" stopOpacity=".3" /><stop offset="1" stopColor="#7A1A08" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g transform="matrix(1.16 0 0 1 -0.5 0)">
        <path fill={`url(#${id}a)`} d="M13 4H41c11.6 0 19 7.2 19 16.8 0 7.2-4 12.4-10.2 14.5l9 22.7c.6 1.5-.4 3-2 3H46.3c-.9 0-1.7-.5-2.1-1.4L40 30c.6-1.3 1.6-2 3-2h3a3 3 0 0 0 0-6H21.6c-1 0-1.8-.5-2.3-1.2z" />
        <path fill={`url(#${id}s)`} d="M38 28h8l3.8 7.3L44 41z" />
        <path fill={`url(#${id}b)`} d="M24.5 28H41.6c1.2 0 2 1.3 1.3 2.3L25.6 59a4.2 4.2 0 0 1-3.5 2H7.4c-1.2 0-2-1.3-1.4-2.4z" />
      </g>
    </svg>
  );
}

/** Mark + "Relay" wordmark (Inter Bold). */
export function RelayWordmark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      <RelayMark size={size} />
      <span className="font-bold tracking-[-0.02em]" style={{ fontSize: Math.round(size * 0.78) }}>{BRAND.name}</span>
    </span>
  );
}
