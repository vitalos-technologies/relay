'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { LogOut } from 'lucide-react';
import { api } from '@/lib/client/api';
import { SessionProvider, useSession } from '@/lib/client/session';
import { ErrorState, IconButton, Spinner, ToastProvider, TooltipProvider } from '@/components/ui';
import { RelayMark } from '@/components/brand/relay-mark';

export function ReviewProviders({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <TooltipProvider>
        <SessionProvider
          fallback={<div className="flex min-h-dvh items-center justify-center"><Spinner label="Loading" /></div>}
          renderError={(e, retry) => <div className="mx-auto max-w-lg px-6 py-24"><ErrorState error={e} onRetry={retry} title="We couldn’t load your session" /></div>}
        >
          <ReviewChrome>{children}</ReviewChrome>
        </SessionProvider>
      </TooltipProvider>
    </ToastProvider>
  );
}

function ReviewChrome({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const signOut = async () => {
    let next = '/login';
    try { const r = await api.post<{ logout_url?: string | null }>('/api/auth/logout', {}); if (r?.logout_url) next = r.logout_url; } catch { /* still leave */ }
    window.location.assign(next);
  };
  return (
    <div className="min-h-dvh bg-bg">
      <header className="sticky top-0 z-20 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[960px] items-center gap-3 px-4">
          <Link href="/review" className="inline-flex items-center rounded-md" aria-label="Reviews"><RelayMark size={24} /></Link>
          <span className="text-sm font-medium">Review</span>
          <span className="flex-1" />
          <span className="hidden truncate text-xs text-muted sm:block">{session.user.email}</span>
          <IconButton label="Sign out" icon={<LogOut aria-hidden className="size-4" />} onClick={() => void signOut()} />
        </div>
      </header>
      <main className="mx-auto max-w-[960px] px-4 py-6 pb-28">{children}</main>
    </div>
  );
}
