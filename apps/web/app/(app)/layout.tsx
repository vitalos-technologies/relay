import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { AppProviders } from '@/components/shell/providers';
import { RedirectToLogin } from '@/components/shell/redirect-to-login';

export const dynamic = 'force-dynamic';

const SESSION_COOKIES = ['sl_session', '__Host-sl_session'];

/** Cheap gate: a session cookie must exist. Validity is checked by GET /api/session on the client. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  if (!SESSION_COOKIES.some((n) => jar.has(n))) return <RedirectToLogin />;
  return <AppProviders>{children}</AppProviders>;
}
