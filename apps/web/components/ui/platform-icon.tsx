import { siFacebook, siInstagram, siTelegram, siX } from 'simple-icons';
import { PROVIDER_LABEL, type Provider } from '@social-lite/core';
import { cn } from './cn';

const ICONS: Record<Provider, { path: string; bg: string }> = {
  instagram: { path: siInstagram.path, bg: 'linear-gradient(135deg,#F58529 0%,#DD2A7B 45%,#8134AF 75%,#515BD4 100%)' },
  facebook: { path: siFacebook.path, bg: `#${siFacebook.hex}` },
  telegram: { path: siTelegram.path, bg: `#${siTelegram.hex}` },
  x: { path: siX.path, bg: '#000000' },
};

const SIZES = { xs: 'size-5 rounded-[5px] [&>svg]:size-3', sm: 'size-7 rounded-md [&>svg]:size-[15px]', md: 'size-9 rounded-lg [&>svg]:size-[18px]', lg: 'size-10 rounded-[10px] [&>svg]:size-5' };

/**
 * Platform glyph as a brand-tinted tile with a white mark. Labelled for assistive tech unless decorative.
 */
export function PlatformIcon({ provider, size = 'md', decorative, className }: { provider: Provider; size?: keyof typeof SIZES; decorative?: boolean; className?: string }) {
  const i = ICONS[provider];
  if (!i) return null;
  return (
    <span
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : PROVIDER_LABEL[provider]}
      aria-hidden={decorative || undefined}
      title={decorative ? undefined : PROVIDER_LABEL[provider]}
      className={cn('inline-flex shrink-0 items-center justify-center text-white shadow-[0_0_0_1px_rgba(255,255,255,0.08)_inset]', SIZES[size], provider === 'x' && 'ring-1 ring-[var(--border-strong)]', className)}
      style={{ background: i.bg }}
    >
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden focusable="false">
        <path d={i.path} />
      </svg>
    </span>
  );
}

/** Overlapping stack of platform tiles for compact rows. */
export function PlatformStack({ providers, size = 'xs' }: { providers: Provider[]; size?: 'xs' | 'sm' }) {
  return (
    <span className="inline-flex items-center -space-x-1">
      {providers.map((p, i) => (
        <PlatformIcon key={`${p}-${i}`} provider={p} size={size} className="ring-2 ring-[var(--surface)]" />
      ))}
    </span>
  );
}
