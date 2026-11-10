'use client';
// Scroll-linked depth for the marketing page (user request 2026-11-10), Motion's `scroll()` driving WAAPI animations from
// `motion/mini` (native ScrollTimeline where the browser has it, so the work stays off the main thread). Transform and
// opacity only. Nothing here changes layout or hides content: with reduced motion, no JS, or before hydration the page is
// the static server render. Both islands find their layers through data attributes, so the sections stay server components.
//  - HeroMotion: layers marked `data-depth="<px>"` inside #top drift at different speeds while the hero scrolls away, and the
//    preview tilts slightly with the pointer on desktop (`data-tilt`).
//  - StackMotion: the product cards (`.mkt-stack > li`) are sticky on wide, tall viewports (CSS); as each next card slides
//    over, the one beneath scales down a little and dims (`[data-shade]`). Focus inside a covered card scrolls it back on top.
import { useEffect } from 'react';
import { scroll } from 'motion';
import { animate } from 'motion/mini';

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function HeroMotion() {
  useEffect(() => {
    if (reduced()) return;
    const hero = document.getElementById('top');
    if (!hero) return;
    const stops: Array<() => void> = [];
    for (const el of hero.querySelectorAll<HTMLElement>('[data-depth]')) {
      const px = Number(el.dataset.depth) || 0;
      stops.push(scroll(animate(el, { transform: ['translate3d(0,0,0)', `translate3d(0,${px}px,0)`] }, { ease: 'linear' }), { target: hero, offset: ['start start', 'end start'] }));
    }
    // Pointer tilt (fine pointers only): a few degrees on the preview, more travel on the floating cards (z-depth).
    const tilt = hero.querySelector<HTMLElement>('[data-tilt]');
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    let frame = 0;
    const move = (e: PointerEvent) => {
      if (!tilt) return;
      const r = tilt.getBoundingClientRect();
      const x = Math.max(-1, Math.min(1, (e.clientX - r.left) / r.width * 2 - 1));
      const y = Math.max(-1, Math.min(1, (e.clientY - r.top) / r.height * 2 - 1));
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { tilt.style.setProperty('--tx', x.toFixed(3)); tilt.style.setProperty('--ty', y.toFixed(3)); });
    };
    const leave = () => { cancelAnimationFrame(frame); tilt?.style.setProperty('--tx', '0'); tilt?.style.setProperty('--ty', '0'); };
    if (tilt && fine) {
      tilt.dataset.tiltOn = '';
      hero.addEventListener('pointermove', move, { passive: true });
      hero.addEventListener('pointerleave', leave);
    }
    return () => {
      for (const s of stops) s();
      cancelAnimationFrame(frame);
      hero.removeEventListener('pointermove', move);
      hero.removeEventListener('pointerleave', leave);
      if (tilt) delete tilt.dataset.tiltOn;
    };
  }, []);
  return null;
}

/** Sticky cards are on only where the CSS media query in marketing.css turns them on. */
const STACK_QUERY = '(min-width: 768px) and (min-height: 700px) and (prefers-reduced-motion: no-preference)';

export function StackMotion() {
  useEffect(() => {
    const list = document.querySelector<HTMLElement>('.mkt-stack');
    if (!list) return;
    const mq = window.matchMedia(STACK_QUERY);
    let stops: Array<() => void> = [];
    const items = () => [...list.querySelectorAll<HTMLElement>(':scope > li')];
    const setup = () => {
      for (const s of stops) s();
      stops = [];
      if (!mq.matches) return;
      const li = items();
      li.forEach((card, i) => {
        const next = li[i + 1];
        if (!next) return;
        const body = card.querySelector<HTMLElement>('[data-stack-card]');
        const shade = card.querySelector<HTMLElement>('[data-shade]');
        const offset = ['start end', 'start start'] as const;
        if (body) stops.push(scroll(animate(body, { transform: ['scale(1)', 'scale(0.94)'] }, { ease: 'linear' }), { target: next, offset: [...offset] }));
        if (shade) stops.push(scroll(animate(shade, { opacity: [0, 0.32] }, { ease: 'linear' }), { target: next, offset: [...offset] }));
      });
    };
    // Keyboard: focus moving into a card that a later card covers scrolls the page so that card is on top again.
    const focusIn = (e: FocusEvent) => {
      if (!mq.matches) return;
      const li = items();
      const i = li.findIndex((c) => c.contains(e.target as Node));
      if (i < 0 || i === li.length - 1) return;
      const nextTop = li[i + 1]!.getBoundingClientRect().top;
      const myTop = li[i]!.getBoundingClientRect().top;
      if (nextTop - myTop >= li[i]!.offsetHeight) return; // not covered
      let y = list.getBoundingClientRect().top + window.scrollY;
      const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
      for (let k = 0; k < i; k++) y += li[k]!.offsetHeight + gap;
      window.scrollTo({ top: y - parseFloat(getComputedStyle(li[i]!).top || '0'), behavior: 'instant' as ScrollBehavior });
    };
    setup();
    mq.addEventListener('change', setup);
    list.addEventListener('focusin', focusIn);
    return () => { for (const s of stops) s(); mq.removeEventListener('change', setup); list.removeEventListener('focusin', focusIn); };
  }, []);
  return null;
}
