'use client';
// Marketing mobile menu button (< lg). The sheet (Base UI Dialog) loads on first hover/focus/tap of this button.
import { useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Menu } from 'lucide-react';

const load = () => import('./mobile-menu-sheet');
const MobileMenuSheet = dynamic(load, { ssr: false });

export function MobileMenu({ signedIn }: { signedIn: boolean }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={ref} type="button" aria-haspopup="dialog" aria-expanded={open} aria-label="Open menu" data-testid="mkt-menu-open"
        onPointerEnter={() => void load()} onFocus={() => void load()} onTouchStart={() => void load()} onClick={() => { setMounted(true); setOpen(true); }}
        className="inline-flex size-11 items-center justify-center rounded-full text-v5-fg outline-none hover:bg-v5-raised focus-visible:outline-2 focus-visible:outline-v5-ring lg:hidden">
        <Menu aria-hidden className="size-5" />
      </button>
      {mounted ? <MobileMenuSheet open={open} onOpenChange={setOpen} signedIn={signedIn} trigger={ref} /> : null}
    </>
  );
}
