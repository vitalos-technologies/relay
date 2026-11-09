// Help Centre (HC) route group: /help, /help/<section>, /help/<section>/<slug>. Readable without signing in (public
// articles only). Signed-in readers get the app shell; what each reader may open is decided on the server per request.
// V4's Contact support and My requests stay in app/(app)/help/{contact,requests}.
import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { AppProviders } from '@/components/shell/providers';
import { GuestRedirect } from '@/components/collab/guest-redirect';
import { PublicHelpShell } from '@/components/help/public-help-shell';
import { enforceHelpPath, getHelpViewer } from '@/lib/help-server';
import '@/components/help/help-prose.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: { template: '%s · Relay Help', default: 'Help Centre' } };

export default async function HelpCentreLayout({ children }: { children: ReactNode }) {
  const viewer = await getHelpViewer();
  if (!viewer.signedIn) return <PublicHelpShell>{children}</PublicHelpShell>;
  // Signed in, pages render inside the client app shell, which streams first: decide 404s and redirects here so the
  // status code is real (M18). The root not-found page renders the Help Centre variant for /help paths.
  await enforceHelpPath(viewer);
  return <AppProviders><GuestRedirect />{children}</AppProviders>;
}
