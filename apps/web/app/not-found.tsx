import Link from 'next/link';
import { AppProviders } from '@/components/shell/providers';
import { GuestRedirect } from '@/components/collab/guest-redirect';
import { HelpNotFoundBody } from '@/components/help/help-not-found';
import { PublicHelpShell } from '@/components/help/public-help-shell';
import { getHelpViewer, requestPathname } from '@/lib/help-server';

export const metadata = { title: 'Not found' };

export default async function NotFound() {
  // Help Centre paths keep the Help Centre 404 inside the reader's shell (the (help) layout raises it for signed-in
  // readers so the status is a real 404 — M18).
  const path = await requestPathname();
  if (path === '/help' || path?.startsWith('/help/')) {
    const viewer = await getHelpViewer();
    return viewer.signedIn
      ? <AppProviders><GuestRedirect /><HelpNotFoundBody /></AppProviders>
      : <PublicHelpShell><HelpNotFoundBody /></PublicHelpShell>;
  }
  return (
    <main className="flex min-h-[70dvh] items-center justify-center px-4 py-16">
      <div className="max-w-md text-center">
        <p className="font-mono text-xs uppercase tracking-[0.12em] text-subtle">404</p>
        <h1 className="mt-2 text-[24px] font-semibold">Page not found</h1>
        <Link href="/" className="touch-target mt-6 inline-flex h-10 items-center rounded-lg bg-accent px-4 text-sm font-medium text-on-accent hover:bg-accent-hover">Home</Link>
      </div>
    </main>
  );
}
