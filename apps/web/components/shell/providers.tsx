'use client';
import type { ReactNode } from 'react';
import { SessionProvider } from '@/lib/client/session';
import { ErrorState, ToastProvider, TooltipProvider } from '@/components/ui';
import { AppShell } from './app-shell';
import { ShellSkeleton } from './shell-skeleton';

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <TooltipProvider>
        <SessionProvider
          fallback={<ShellSkeleton />}
          renderError={(e, retry) => (
            <div className="mx-auto max-w-lg px-6 py-24">
              <ErrorState error={e} onRetry={retry} title="Couldn’t load your session" />
            </div>
          )}
        >
          <AppShell>{children}</AppShell>
        </SessionProvider>
      </TooltipProvider>
    </ToastProvider>
  );
}

/** Minimal providers for pages outside the shell (onboarding). */
export function BareProviders({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <TooltipProvider>{children}</TooltipProvider>
    </ToastProvider>
  );
}
