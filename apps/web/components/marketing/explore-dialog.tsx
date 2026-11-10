'use client';
// "Explore …" inline preview (brief §3: Explore links open an accessible inline preview). The trigger is a plain button; the
// Base UI Dialog (focus trap, Esc, focus return to this button, labelled by its title) loads on first hover/focus/click so it
// is not part of the initial page JavaScript. Content is server-rendered and passed in.
import { useRef, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { ArrowRight } from 'lucide-react';

const load = () => import('./explore-panel');
const ExplorePanel = dynamic(load, { ssr: false });

export function ExploreDialog({ label, title, description, media, children, testId }: { label: string; title: string; description: string; media?: ReactNode; children: ReactNode; testId?: string }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={ref} type="button" aria-haspopup="dialog" aria-expanded={open} onPointerEnter={() => void load()} onFocus={() => void load()}
        onClick={() => { setMounted(true); setOpen(true); }}
        className="group inline-flex min-h-10 items-center gap-1.5 rounded-full text-[15px] font-semibold text-v5-primary-text outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v5-ring" data-testid={testId}>
        {label}<ArrowRight aria-hidden className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
      </button>
      {mounted ? <ExplorePanel open={open} onOpenChange={setOpen} returnFocus={ref} title={title} description={description} media={media}>{children}</ExplorePanel> : null}
    </>
  );
}
