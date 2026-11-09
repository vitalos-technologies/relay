// Help Centre shell for signed-out readers (HC): public articles only. Signed-in readers get the app shell instead.
import Link from 'next/link';
import type { ReactNode } from 'react';
import { RelayWordmark } from '@/components/brand/relay-mark';
import { SignInLink } from './sign-in-link';

export function PublicHelpShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <a href="#main" className="sr-only-focusable fixed left-3 top-3 z-[80] rounded-lg bg-accent px-3 py-2 text-on-accent">Skip to content</a>
      <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-[1200px] items-center gap-3 px-4 sm:px-6">
          <Link href="/" aria-label="Relay home" className="inline-flex items-center rounded-md"><RelayWordmark size={22} /></Link>
          <span aria-hidden className="h-5 w-px bg-border" />
          <Link href="/help" className="text-[14px] font-medium text-muted hover:text-fg">Help Centre</Link>
          <div className="ml-auto"><SignInLink /></div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1200px] flex-1 px-4 pb-16 pt-6 focus:outline-none sm:px-6 md:pt-8">{children}</main>
    </div>
  );
}
