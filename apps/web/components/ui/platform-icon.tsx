import { siBluesky, siFacebook, siInstagram, siPinterest, siTelegram, siThreads, siTiktok, siX, siYoutube } from 'simple-icons';
import { PROVIDER_LABEL, type Provider } from '@social-lite/core/types'; // subpath: keeps the core barrel (zod, twitter-text) out of client bundles
import { cn } from './cn';

const ICONS: Record<Provider, { path: string; bg: string }> = {
  instagram: { path: siInstagram.path, bg: 'linear-gradient(135deg,#F58529 0%,#DD2A7B 45%,#8134AF 75%,#515BD4 100%)' },
  facebook: { path: siFacebook.path, bg: `#${siFacebook.hex}` },
  telegram: { path: siTelegram.path, bg: `#${siTelegram.hex}` },
  x: { path: siX.path, bg: '#000000' },
  tiktok: { path: siTiktok.path, bg: '#000000' },
  youtube: { path: siYoutube.path, bg: `#${siYoutube.hex}` },
  // LinkedIn is not in simple-icons: a plain "in" glyph drawn here (same tile treatment as the other networks).
  linkedin: { path: 'M4.2 9.2h3.4V20H4.2zM5.9 3.8a1.95 1.95 0 1 1 0 3.9 1.95 1.95 0 0 1 0-3.9zM9.7 9.2h3.25v1.5h.05c.45-.86 1.56-1.76 3.21-1.76 3.43 0 4.06 2.26 4.06 5.2V20h-3.38v-5.2c0-1.24-.02-2.84-1.73-2.84-1.73 0-2 1.35-2 2.75V20H9.7z', bg: '#0A66C2' },
  threads: { path: siThreads.path, bg: '#000000' },
  pinterest: { path: siPinterest.path, bg: `#${siPinterest.hex}` },
  bluesky: { path: siBluesky.path, bg: `#${siBluesky.hex}` },
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
      className={cn('inline-flex shrink-0 items-center justify-center text-white shadow-[0_0_0_1px_rgba(255,255,255,0.08)_inset]', SIZES[size], (provider === 'x' || provider === 'tiktok' || provider === 'threads') && 'ring-1 ring-[var(--border-strong)]', className)}
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
