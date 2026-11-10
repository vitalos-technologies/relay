'use client';
// V5 Reveal: a brief entrance when a block first scrolls into view (Motion for React — `motion/react-mini` useAnimate, the
// WAAPI build, a few kB) driven by an IntersectionObserver. `effect` varies the motion per section (fade-up, scale-in,
// slide from either side, plain fade); transform/opacity only.
// Content is never hidden by default: the server renders it visible (no-JS and reduced-motion visitors simply see it), and
// only after hydration is a block that is still BELOW the viewport hidden, to be brought back in when it arrives.
// Print always shows it (globals.css `[data-reveal]`).
import { useEffect, type ReactNode } from 'react';
import { useAnimate } from 'motion/react-mini';
import { cn } from './cn';

export type RevealEffect = 'rise' | 'scale' | 'left' | 'right' | 'fade';
const HIDDEN: Record<RevealEffect, { opacity: number; transform: string }> = {
  rise: { opacity: 0, transform: 'translateY(18px)' },
  scale: { opacity: 0, transform: 'scale(0.94)' },
  left: { opacity: 0, transform: 'translateX(-28px)' },
  right: { opacity: 0, transform: 'translateX(28px)' },
  fade: { opacity: 0, transform: 'none' },
};
const SHOWN = { opacity: 1, transform: 'none' };

export function Reveal({ children, className, delay = 0, effect = 'rise', as: Tag = 'div', ...rest }: {
  children: ReactNode; className?: string; delay?: number; effect?: RevealEffect; as?: 'div' | 'li' | 'section';
} & Record<`data-${string}`, string>) {
  const [scope, animate] = useAnimate<HTMLElement>();
  useEffect(() => {
    const el = scope.current;
    if (!el || typeof window === 'undefined' || !('IntersectionObserver' in window)) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (el.getBoundingClientRect().top < window.innerHeight * 0.95) return; // already on screen: leave it alone
    animate(el, HIDDEN[effect], { duration: 0 });
    let shown = false;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      shown = true;
      animate(el, SHOWN, { duration: effect === 'scale' ? 0.5 : 0.55, delay, ease: [0.22, 1, 0.36, 1] });
    }, { rootMargin: '0px 0px -8% 0px' });
    io.observe(el);
    return () => { io.disconnect(); if (!shown) animate(el, SHOWN, { duration: 0 }); };
  }, [animate, delay, effect, scope]);
  return <Tag ref={scope as never} data-reveal="" className={cn(className)} {...rest}>{children}</Tag>;
}
