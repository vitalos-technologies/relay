'use client';
// V5 Reveal: a brief fade/rise when a block first scrolls into view (Motion for React — `motion/react-mini` useAnimate, the
// WAAPI build, a few kB) driven by an IntersectionObserver.
// Content is never hidden by default: the server renders it visible (no-JS and reduced-motion visitors simply see it), and
// only after hydration is a block that is still BELOW the viewport faded out, to be faded back in when it arrives.
// Print always shows it (globals.css `[data-reveal]`).
import { useEffect, type ReactNode } from 'react';
import { useAnimate } from 'motion/react-mini';
import { cn } from './cn';

const HIDDEN = { opacity: 0, transform: 'translateY(14px)' };
const SHOWN = { opacity: 1, transform: 'translateY(0px)' };

export function Reveal({ children, className, delay = 0, as: Tag = 'div', ...rest }: { children: ReactNode; className?: string; delay?: number; as?: 'div' | 'li' | 'section' } & Record<`data-${string}`, string>) {
  const [scope, animate] = useAnimate<HTMLElement>();
  useEffect(() => {
    const el = scope.current;
    if (!el || typeof window === 'undefined' || !('IntersectionObserver' in window)) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (el.getBoundingClientRect().top < window.innerHeight * 0.95) return; // already on screen: leave it alone
    animate(el, HIDDEN, { duration: 0 });
    let shown = false;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      shown = true;
      animate(el, SHOWN, { duration: 0.45, delay, ease: [0.22, 1, 0.36, 1] });
    }, { rootMargin: '0px 0px -8% 0px' });
    io.observe(el);
    return () => { io.disconnect(); if (!shown) animate(el, SHOWN, { duration: 0 }); };
  }, [animate, delay, scope]);
  return <Tag ref={scope as never} data-reveal="" className={cn(className)} {...rest}>{children}</Tag>;
}
