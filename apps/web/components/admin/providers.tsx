'use client';
import type { ReactNode } from 'react';
import { SessionProvider } from '@/lib/client/session';
import { ErrorState, ToastProvider, TooltipProvider } from '@/components/ui';
import { ShellSkeleton } from '@/components/shell/shell-skeleton';
import { AdminShell } from './admin-shell';

export function AdminProviders({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <TooltipProvider>
        <SessionProvider
          requireWorkspace={false}
          fallback={<ShellSkeleton />}
          renderError={(e, retry) => (
            <div className="mx-auto max-w-lg px-6 py-24"><ErrorState error={e} onRetry={retry} title="We couldn’t load your session" /></div>
          )}
        >
          <AdminShell>{children}</AdminShell>
        </SessionProvider>
      </TooltipProvider>
    </ToastProvider>
  );
}
