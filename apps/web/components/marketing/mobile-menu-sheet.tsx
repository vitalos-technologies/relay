'use client';
// Mobile menu sheet body — loaded on first use of the menu button (keeps Base UI Dialog out of the initial page JavaScript).
// Section links close the sheet, then scroll to the section and move focus to its heading (scroll is locked while open).
import { useRef, type RefObject } from 'react';
import { MARKETING_SECTIONS } from '@social-lite/core/contracts/v5-marketing';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui-v5/sheet';
import { buttonVariants } from '@/components/ui-v5/button';
import { cn } from '@/components/ui-v5/cn';

export default function MobileMenuSheet({ open, onOpenChange, signedIn, trigger }: { open: boolean; onOpenChange: (o: boolean) => void; signedIn: boolean; trigger: RefObject<HTMLButtonElement | null> }) {
  const pending = useRef<string | null>(null);
  const navigating = useRef(false);
  const target = useRef<HTMLElement | null>(null);
  const go = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    pending.current = id;
    navigating.current = true;
    target.current = document.querySelector<HTMLElement>(`#${CSS.escape(id)} :is(h2, h3)[tabindex="-1"]`);
    onOpenChange(false);
  };
  const afterClose = (isOpen: boolean) => {
    if (isOpen || !pending.current) return;
    const id = pending.current;
    pending.current = null;
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    history.replaceState(null, '', `#${id}`);
    // Move focus to the section heading (without fighting the scroll), so keyboard and screen-reader users land there.
    requestAnimationFrame(() => { target.current?.focus({ preventScroll: true }); navigating.current = false; });
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange} onOpenChangeComplete={afterClose}>
      <SheetContent side="right" closeLabel="Close menu" className="mkt gap-6 pt-5" finalFocus={() => (navigating.current ? false : trigger.current ?? true)} data-testid="mkt-menu">
        <SheetTitle className="text-base">Menu</SheetTitle>
        <nav aria-label="Sections">
          <ul className="flex flex-col">
            {MARKETING_SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} onClick={go(s.id)} className="flex min-h-12 items-center rounded-lg px-2 text-[17px] font-semibold text-v5-fg outline-none hover:bg-v5-raised focus-visible:outline-2 focus-visible:outline-v5-ring">{s.label}</a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="mt-auto flex flex-col gap-3 border-t border-v5-border pt-5">
          {signedIn ? (
            <a href="/overview" className={cn(buttonVariants({ size: 'lg' }), 'w-full')}>Open dashboard</a>
          ) : (
            <>
              <a href="/signup" className={cn(buttonVariants({ size: 'lg' }), 'w-full')}>Start free trial</a>
              <a href="/login" className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'w-full')}>Log in</a>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
