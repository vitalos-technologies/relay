'use client';
// Integrations marquee control (client island, no library). The rows move with CSS only (marketing.css `.mkt-marquee`);
// this adds what CSS cannot:
//  - a Pause / Play button, so anyone can stop the moving logos (WCAG 2.2.2 Pause, Stop, Hide; hover and focus inside the
//    section also pause them, in CSS),
//  - pausing while the rows are off screen, so the animation does not keep the compositor busy.
// It only toggles data attributes on the marquee element; with reduced motion the rows never move and the button is hidden.
import { useEffect, useState } from 'react';
import { Pause, Play } from 'lucide-react';

export function MarqueeControl({ target }: { target: string }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    document.getElementById(target)?.toggleAttribute('data-paused', paused);
  }, [paused, target]);
  useEffect(() => {
    const el = document.getElementById(target);
    if (!el || !('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver(([e]) => el.toggleAttribute('data-offscreen', !e?.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, [target]);
  return (
    <button
      type="button"
      aria-pressed={paused}
      onClick={() => setPaused((p) => !p)}
      className="inline-flex size-11 items-center justify-center rounded-full text-v5-muted outline-none transition-colors hover:bg-v5-raised hover:text-v5-fg focus-visible:outline-2 focus-visible:outline-v5-ring motion-reduce:hidden"
      data-testid="mkt-marquee-toggle"
    >
      {paused ? <Play aria-hidden className="size-4" /> : <Pause aria-hidden className="size-4" />}
      <span className="sr-only">Pause the moving logos</span>
    </button>
  );
}
